"""Index the Vocence Assistant's knowledge base into the same FTS5 store
that powers per-agent RAG, under a synthetic agent_id sentinel.

The knowledge lives in topic .md files at
``vocence_assistant_knowledge/`` next to this module. On startup we hash
the concatenated content; if the hash differs from the last-seen hash we
re-chunk and re-index. Otherwise we skip — re-indexing on every boot is
fine but wasteful.

The voicechat router calls ``search_assistant_knowledge`` per user turn
when there is no agent_ctx (i.e. the floating Vocence Assistant), and
injects the matched chunks as a transient system message just like the
agent path does.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from pathlib import Path

import agent_knowledge


_log = logging.getLogger(__name__)


# Synthetic agent id — namespaced so it can never collide with a real
# user-created agent (those are UUIDs).
ASSISTANT_AGENT_ID = "__vocence_assistant__"

_KNOWLEDGE_DIR = Path(__file__).resolve().parent / "vocence_assistant_knowledge"
_HASH_FILE = _KNOWLEDGE_DIR / ".last_indexed_hash"


def _read_concatenated() -> str:
    """Read every .md file under the knowledge dir in alphabetical order
    and join them with blank-line separators. Files starting with ``_`` or
    ``.`` are skipped so e.g. .last_indexed_hash isn't pulled in."""
    if not _KNOWLEDGE_DIR.is_dir():
        return ""
    parts: list[str] = []
    for path in sorted(_KNOWLEDGE_DIR.glob("*.md")):
        if path.name.startswith((".", "_")):
            continue
        try:
            text = path.read_text(encoding="utf-8").strip()
        except Exception as exc:  # noqa: BLE001
            _log.warning("could not read %s: %s — skipping", path.name, exc)
            continue
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_last_hash() -> str | None:
    try:
        return _HASH_FILE.read_text(encoding="utf-8").strip() or None
    except FileNotFoundError:
        return None
    except Exception:
        return None


def _save_last_hash(h: str) -> None:
    try:
        _HASH_FILE.write_text(h + "\n", encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        _log.warning("could not persist assistant knowledge hash: %s", exc)


_INDEX_LOCK = asyncio.Lock()
_INDEXED_THIS_PROCESS = False


async def index_assistant_knowledge_at_startup(*, force: bool = False) -> int:
    """Index (or re-index) the assistant's knowledge into FTS5.

    Returns the number of chunks now indexed (or 0 if knowledge dir is
    empty). Cheap on subsequent calls — only re-indexes when the on-disk
    content hash has changed since the last run.
    """
    global _INDEXED_THIS_PROCESS
    async with _INDEX_LOCK:
        text = _read_concatenated()
        if not text:
            _log.warning("assistant knowledge dir is empty: %s", _KNOWLEDGE_DIR)
            return 0
        new_hash = _content_hash(text)
        last_hash = _load_last_hash()
        if not force and last_hash == new_hash and _INDEXED_THIS_PROCESS:
            return -1  # already up to date in this process
        n = await agent_knowledge.index_agent_knowledge(ASSISTANT_AGENT_ID, text)
        _save_last_hash(new_hash)
        _INDEXED_THIS_PROCESS = True
        if last_hash != new_hash:
            _log.info(
                "indexed Vocence Assistant knowledge: %d chunks (%d chars, hash %s…)",
                n, len(text), new_hash[:8],
            )
        return n


async def search_assistant_knowledge(user_text: str, *, top_k: int = 5) -> list[str]:
    """Search the assistant's knowledge base for chunks relevant to a user
    message. Thin wrapper over ``agent_knowledge.search_agent_knowledge``
    with the synthetic agent id baked in."""
    return await agent_knowledge.search_agent_knowledge(
        ASSISTANT_AGENT_ID, user_text, top_k=top_k,
    )
