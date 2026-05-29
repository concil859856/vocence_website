"""Source-type parsers + chunker.

Each parser exposes a single function ``parse_<type>(...)`` that returns
``list[Chunk]``. Chunks are then embedded in batches and inserted into
the per-agent LanceDB table.

All parsers MUST:
  • Be deterministic (same input → same chunks) so the same source can
    be re-ingested without duplication-by-chance.
  • Yield ``ChunkInput`` objects (not finished ``Chunk`` rows) — the
    job runner attaches the source_id / chunk_id / embedding fields.
  • Preserve enough structural metadata (page, section, url) that the
    LLM can cite back to the source meaningfully.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class ChunkInput:
    """A parser's per-chunk output, pre-embedding.

    The ``metadata`` field is the per-chunk structural context the
    LLM uses to cite sources: page number for PDFs, URL for web pages,
    heading path for markdown. Free-form JSON so we don't have to add
    a column every time a new source type wants to track something.
    """
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
