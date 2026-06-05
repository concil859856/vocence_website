"""LanceDB-backed per-agent vector store.

One table per agent: ``agent_<sanitized_id>``. The schema is fixed:
chunk_id, source_id, source_title, text, embedding, metadata_json,
ingested_at. We don't version it — when we eventually need to add a
column we'll write a one-shot migration that adds it with a default.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import lancedb
import numpy as np
import pyarrow as pa

from ..config import CONFIG


# ``agent_id`` from the dashboard backend is an opaque string — we
# don't want it leaking into the SQL-style table name verbatim
# (LanceDB doesn't actually accept arbitrary characters in table
# names). Sanitise to ``[a-zA-Z0-9_]``.
_SAFE_RE = re.compile(r"[^a-zA-Z0-9_]")

# Table-name prefix. Keeps per-agent tables namespaced so a future
# co-tenant store (e.g. system-wide knowledge) doesn't collide.
_TABLE_PREFIX = "agent_"


def _table_name(agent_id: str) -> str:
    """Convert an agent_id into a safe LanceDB table name. The mapping
    is deterministic so the same agent_id always lands at the same
    table, and the sanitisation is conservative — we strip everything
    that isn't a letter, digit, or underscore."""
    cleaned = _SAFE_RE.sub("_", agent_id.strip())[:120]
    if not cleaned:
        # If sanitisation produces an empty string (a really weird id),
        # fall back to a hash so we never write to a colliding empty
        # table. Tested: ``_TABLE_PREFIX + ""`` would create a single
        # "agent_" table for every weird id.
        cleaned = f"x{abs(hash(agent_id)) & 0xFFFFFFFF:08x}"
    return _TABLE_PREFIX + cleaned


@dataclass
class StoredChunk:
    """One row as returned from a query (or inserted)."""
    chunk_id: str
    source_id: str
    source_title: str
    text: str
    metadata: dict[str, Any]
    score: float | None = None


# Singleton DB connection. LanceDB connections are cheap but holding
# one open avoids the per-call open-close churn for the hot query path.
_db: lancedb.DBConnection | None = None
_db_lock = threading.Lock()


def connect() -> lancedb.DBConnection:
    """Open (or return the cached) connection to the LanceDB store
    rooted at ``CONFIG.data_dir``."""
    global _db
    with _db_lock:
        if _db is None:
            _db = lancedb.connect(str(CONFIG.data_dir))
        return _db


def _list_table_names(db: lancedb.DBConnection) -> list[str]:
    """Return a list of plain string table names.

    LanceDB's API changed between releases: older versions returned a
    list of strings from ``table_names()``; newer ones return a Pydantic
    ``ListTablesResponse`` from ``list_tables()`` whose actual list
    lives at ``.tables``. We try the newer API first and fall back so
    the pod works against either release.
    """
    if hasattr(db, "list_tables"):
        try:
            # NOTE: explicitly call the underlying ``list_tables``
            # attribute on the connection — don't refactor this to use
            # the helper name (the sed-replacement of all ``db.list_tables()``
            # callsites would self-recurse here).
            resp = db.list_tables()
            tables = getattr(resp, "tables", None)
            if tables is not None:
                return list(tables)
            # Older list_tables() returned a list directly.
            if isinstance(resp, (list, tuple)):
                return list(resp)
        except Exception:  # noqa: BLE001
            pass
    # Fallback to the deprecated API name — still works on every released
    # version we support.
    return list(db.table_names())


def _schema(embedding_dim: int) -> pa.Schema:
    """Schema for an agent's vector table. ``metadata_json`` is the
    flexible per-chunk metadata serialised as a JSON string — gives us
    free-form key/value without paying per-key column overhead."""
    return pa.schema([
        pa.field("chunk_id", pa.string()),
        pa.field("source_id", pa.string()),
        pa.field("source_title", pa.string()),
        pa.field("text", pa.string()),
        pa.field("embedding", pa.list_(pa.float32(), embedding_dim)),
        pa.field("metadata_json", pa.string()),
        pa.field("ingested_at", pa.string()),
    ])


def get_or_create_table(agent_id: str, embedding_dim: int) -> lancedb.table.Table:
    """Open the agent's table, creating it on first use."""
    db = connect()
    name = _table_name(agent_id)
    if name in _list_table_names(db):
        return db.open_table(name)
    return db.create_table(name, schema=_schema(embedding_dim))


def insert_chunks(
    agent_id: str,
    *,
    source_id: str,
    source_title: str,
    texts: list[str],
    embeddings: list[np.ndarray],
    per_chunk_metadata: list[dict[str, Any]],
    embedding_dim: int,
) -> list[str]:
    """Insert N chunks atomically for one source. Returns the
    generated chunk_ids in insertion order."""
    if len(texts) != len(embeddings) or len(texts) != len(per_chunk_metadata):
        raise ValueError(
            "insert_chunks: texts / embeddings / per_chunk_metadata length mismatch"
        )
    if not texts:
        return []

    ingested_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    chunk_ids: list[str] = []
    rows = []
    for text, vec, meta in zip(texts, embeddings, per_chunk_metadata, strict=False):
        cid = f"c_{uuid.uuid4().hex[:16]}"
        chunk_ids.append(cid)
        if vec.shape[0] != embedding_dim:
            raise ValueError(
                f"embedding dim mismatch: vector {vec.shape[0]}, "
                f"schema {embedding_dim}"
            )
        rows.append({
            "chunk_id": cid,
            "source_id": source_id,
            "source_title": source_title,
            "text": text,
            "embedding": vec.tolist(),
            "metadata_json": json.dumps(meta),
            "ingested_at": ingested_at,
        })
    table = get_or_create_table(agent_id, embedding_dim)
    table.add(rows)
    return chunk_ids


def delete_source(agent_id: str, source_id: str) -> int:
    """Remove every chunk belonging to one source. Returns the count
    removed. If the agent's table doesn't exist, returns 0."""
    db = connect()
    name = _table_name(agent_id)
    if name not in _list_table_names(db):
        return 0
    table = db.open_table(name)
    # Count before delete — LanceDB doesn't return a count from .delete().
    before = table.count_rows()
    table.delete(f"source_id = '{source_id}'")
    return before - table.count_rows()


def query(
    agent_id: str,
    query_vec: np.ndarray,
    *,
    top_k: int,
    min_score: float,
) -> list[StoredChunk]:
    """Top-K cosine-similarity search over one agent's chunks.

    ``min_score`` is a similarity threshold (higher = stricter). Lance
    returns L2 distance by default; we normalise it back to a 0..1
    similarity for callers — see ``_distance_to_similarity`` below.

    If the agent has no table yet, returns an empty list (not an
    error — a never-ingested agent simply has no knowledge).
    """
    db = connect()
    name = _table_name(agent_id)
    if name not in _list_table_names(db):
        return []
    table = db.open_table(name)
    rows = table.search(query_vec.tolist()).limit(top_k).to_list()
    out: list[StoredChunk] = []
    for row in rows:
        # LanceDB's default search returns L2 distance in ``_distance``.
        # Bge embeddings are already L2-normalised, so L2 distance
        # between two unit vectors is in [0, 2] and a smaller distance
        # is more similar. Convert: similarity = 1 - distance/2.
        dist = float(row.get("_distance", 0.0))
        sim = max(0.0, 1.0 - dist / 2.0)
        if sim < min_score:
            continue
        try:
            metadata = json.loads(row.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            metadata = {}
        out.append(StoredChunk(
            chunk_id=row["chunk_id"],
            source_id=row["source_id"],
            source_title=row["source_title"],
            text=row["text"],
            metadata=metadata,
            score=round(sim, 4),
        ))
    return out


def list_sources(agent_id: str) -> list[dict[str, Any]]:
    """List sources attached to one agent. Aggregates by source_id and
    returns counts + display metadata.

    Implemented in pure pyarrow + Python to avoid a pandas dependency —
    pyarrow is already in the install (LanceDB requires it) and this
    aggregation is fast enough for tables in the 100k-row range.
    """
    db = connect()
    name = _table_name(agent_id)
    if name not in _list_table_names(db):
        return []
    table = db.open_table(name)
    # Pull only the columns we need. Materialise as a pyarrow Table
    # then iterate columnar — way faster than scanning row-at-a-time
    # for large tables.
    arrow_tbl = table.search().select(
        ["source_id", "source_title", "ingested_at"]
    ).limit(2_000_000).to_arrow()
    source_ids = arrow_tbl.column("source_id").to_pylist()
    source_titles = arrow_tbl.column("source_title").to_pylist()
    ingested_ats = arrow_tbl.column("ingested_at").to_pylist()
    agg: dict[tuple[str, str], dict[str, Any]] = {}
    for sid, stitle, ts in zip(source_ids, source_titles, ingested_ats, strict=False):
        key = (sid, stitle)
        cur = agg.get(key)
        if cur is None:
            agg[key] = {
                "source_id": sid,
                "source_title": stitle,
                "chunks": 1,
                "ingested_at": ts,
            }
        else:
            cur["chunks"] += 1
            if ts and (not cur["ingested_at"] or ts > cur["ingested_at"]):
                cur["ingested_at"] = ts
    return list(agg.values())


def total_chunks() -> int:
    """Sum of chunks across every agent's table. Used by /healthz to
    surface store size."""
    db = connect()
    total = 0
    for name in _list_table_names(db):
        if not name.startswith(_TABLE_PREFIX):
            continue
        try:
            total += db.open_table(name).count_rows()
        except Exception:  # noqa: BLE001
            continue
    return total


def total_agents() -> int:
    db = connect()
    return sum(1 for n in _list_table_names(db) if n.startswith(_TABLE_PREFIX))


def store_size_mib() -> int:
    """Approximate on-disk size of the LanceDB store, in mebibytes."""
    root = Path(CONFIG.data_dir)
    if not root.exists():
        return 0
    total = 0
    for p in root.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                continue
    return int(total / (1024 * 1024))
