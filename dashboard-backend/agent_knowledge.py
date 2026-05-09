"""Agent knowledge RAG — keyword retrieval over per-agent chunked knowledge.

Backed by SQLite FTS5 (already in stdlib). Zero new infra.

Usage flow:
  - On agent create / knowledge update:  ``index_agent_knowledge(id, text)``
  - On agent delete or knowledge cleared: ``delete_agent_knowledge(id)``
  - On each LLM turn (only when knowledge is large):
        chunks = await search_agent_knowledge(id, user_text, top_k=5)

Threshold: when knowledge text is short (≤ ``RAG_DUMP_BELOW_CHARS``) we just
dump the whole thing into the system prompt — RAG isn't worth the
complexity for small bodies. Above the threshold we chunk + retrieve.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Iterable

from local_db import get_connection


_log = logging.getLogger(__name__)


# Knowledge bodies smaller than this go into the system prompt verbatim.
# Above this we chunk + retrieve. ~1500 tokens worth of English.
RAG_DUMP_BELOW_CHARS = int(os.environ.get("AGENT_RAG_DUMP_BELOW_CHARS") or "6000")

# Chunking parameters. Smaller chunks → more discriminating retrieval.
# At ~700 chars (~175 tokens) each chunk maps to roughly one section/topic.
RAG_CHUNK_MAX_CHARS = int(os.environ.get("AGENT_RAG_CHUNK_MAX_CHARS") or "400")
RAG_CHUNK_OVERLAP_CHARS = int(os.environ.get("AGENT_RAG_CHUNK_OVERLAP_CHARS") or "120")

# Stopwords that shouldn't drive retrieval
_STOPWORDS = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "doing", "i", "you", "me",
    "my", "we", "us", "our", "they", "them", "their", "and", "or", "but",
    "if", "of", "to", "in", "on", "at", "by", "for", "with", "about",
    "as", "into", "than", "then", "so", "no", "not", "this", "that",
    "these", "those", "it", "its", "what", "how", "why", "when", "where",
    "who", "which", "can", "could", "would", "should", "will", "won't",
    "doesn't", "isn't", "aren't", "want", "wants", "wanted",
})


# ---------------------------------------------------------------------------
# Chunking
# ---------------------------------------------------------------------------


def chunk_text(
    text: str,
    *,
    max_chars: int = RAG_CHUNK_MAX_CHARS,
    overlap: int = RAG_CHUNK_OVERLAP_CHARS,  # noqa: ARG001  (paragraph path doesn't need overlap)
) -> list[str]:
    """Split text into discrete topic-sized chunks.

    Strategy:
      1. Split the text on blank-line paragraph breaks (``\\n\\n``).
      2. Pack consecutive small paragraphs into the same chunk while the
         combined length stays under ``max_chars``.
      3. If a single paragraph exceeds ``max_chars``, fall back to splitting
         it on sentence boundaries and pack those instead.

    Why not a sliding window? On real knowledge bases (FAQ, product docs,
    handbooks) paragraphs map almost perfectly to topics — splitting on
    them gives one-section-per-chunk retrieval which BM25 ranks correctly.
    A sliding window tends to merge multiple sections into single
    chunks, making nearly every chunk match nearly every query.
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [text]

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if not paragraphs:
        # Single huge paragraph — fall back to sentence-level
        paragraphs = [text]

    # Default: one chunk per paragraph. Only merge when *both* the current
    # buffer and the next paragraph are tiny (likely a heading + a short
    # blurb that should travel together). Topics stay separate, so BM25
    # has clear winners per query.
    SMALL_PARA_CHARS = max_chars // 4

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        # Oversized single paragraph → split on sentence boundaries
        if len(para) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            sentences = re.split(r"(?<=[\.\!\?])\s+", para)
            sub = ""
            for s in sentences:
                s = s.strip()
                if not s:
                    continue
                if not sub:
                    sub = s
                elif len(sub) + len(s) + 1 <= max_chars:
                    sub = f"{sub} {s}"
                else:
                    chunks.append(sub)
                    sub = s
            if sub:
                chunks.append(sub)
            continue

        if not current:
            current = para
            continue
        # Merge only if both pieces are small AND combined still fits
        if (
            len(current) < SMALL_PARA_CHARS
            and len(para) < SMALL_PARA_CHARS
            and len(current) + len(para) + 2 <= max_chars
        ):
            current = f"{current}\n\n{para}"
        else:
            chunks.append(current)
            current = para
    if current:
        chunks.append(current)
    return chunks


def should_use_rag(text: str | None) -> bool:
    """True if the knowledge text is large enough to be worth chunked retrieval."""
    return bool(text) and len(text) > RAG_DUMP_BELOW_CHARS


# ---------------------------------------------------------------------------
# DB helpers — index, delete, search
# ---------------------------------------------------------------------------


async def delete_agent_knowledge(agent_id: str) -> None:
    """Drop all chunks for one agent."""
    conn = await get_connection()
    try:
        await conn.execute(
            "DELETE FROM agent_knowledge_chunks WHERE agent_id = ?",
            (agent_id,),
        )
        await conn.commit()
    finally:
        await conn.close()


async def index_agent_knowledge(agent_id: str, knowledge_text: str | None) -> int:
    """Re-index an agent's knowledge: drop old chunks, insert fresh ones.

    Returns the number of chunks indexed (0 if knowledge is empty or short
    enough to skip RAG)."""
    text = (knowledge_text or "").strip()
    conn = await get_connection()
    try:
        # Always wipe old chunks first — the knowledge may have shrunk past
        # the RAG threshold, in which case we want NO chunks indexed.
        await conn.execute(
            "DELETE FROM agent_knowledge_chunks WHERE agent_id = ?",
            (agent_id,),
        )
        if not text or not should_use_rag(text):
            await conn.commit()
            return 0
        chunks = chunk_text(text)
        for idx, chunk in enumerate(chunks):
            await conn.execute(
                "INSERT INTO agent_knowledge_chunks (agent_id, chunk_idx, content) VALUES (?, ?, ?)",
                (agent_id, idx, chunk),
            )
        await conn.commit()
        _log.info("indexed %d chunks for agent %s (%d chars)", len(chunks), agent_id, len(text))
        return len(chunks)
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Query construction + retrieval
# ---------------------------------------------------------------------------


def _to_fts5_match_query(user_text: str) -> str | None:
    """Turn a free-text user message into a safe FTS5 MATCH query.

    Each surviving token is wrapped in double quotes (so FTS5 treats it as
    a literal phrase, never as syntax) and joined with OR — we want chunks
    that match *any* salient keyword from the question."""
    if not user_text:
        return None
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9_-]+", user_text)
    cleaned: list[str] = []
    seen: set[str] = set()
    for tok in tokens:
        low = tok.lower()
        if len(low) < 3 or low in _STOPWORDS:
            continue
        if low in seen:
            continue
        seen.add(low)
        cleaned.append(low)
        if len(cleaned) >= 12:
            break
    if not cleaned:
        return None
    # FTS5 phrase quoting: wrap each token in "..." (escape any embedded ")
    quoted = ['"' + t.replace('"', '""') + '"' for t in cleaned]
    return " OR ".join(quoted)


async def search_agent_knowledge(
    agent_id: str,
    user_text: str,
    *,
    top_k: int = 5,
) -> list[str]:
    """Return up to ``top_k`` knowledge chunks ranked by BM25 relevance to
    the user's message. Returns an empty list when nothing useful matches
    (no extractable keywords, or no agent chunks indexed)."""
    query = _to_fts5_match_query(user_text)
    if not query:
        return []
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT content
            FROM agent_knowledge_chunks
            WHERE agent_id = ? AND content MATCH ?
            ORDER BY bm25(agent_knowledge_chunks)
            LIMIT ?
            """,
            (agent_id, query, top_k),
        )
        rows = await cursor.fetchall()
        return [row["content"] for row in rows if row["content"]]
    except Exception as exc:  # noqa: BLE001
        _log.warning("knowledge search failed for agent %s: %s", agent_id, exc)
        return []
    finally:
        await conn.close()


def format_chunks_for_prompt(chunks: Iterable[str]) -> str:
    """Render retrieved chunks as a single text block for the system prompt."""
    parts = [c.strip() for c in chunks if c and c.strip()]
    if not parts:
        return ""
    return "\n\n---\n\n".join(parts)
