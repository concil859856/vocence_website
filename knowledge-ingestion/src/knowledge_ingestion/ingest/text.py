"""Plain-text / Markdown parsers.

Markdown gets slightly fancier treatment: we extract heading paths
(``## Billing > ### Cancellations``) and stash them in chunk metadata
so the LLM can cite which section a chunk came from.
"""

from __future__ import annotations

import re

from . import ChunkInput
from .chunker import normalize_whitespace, split_text


def parse_text(content: str, title: str | None) -> list[ChunkInput]:
    """Plain text — just normalize whitespace and chunk."""
    normalized = normalize_whitespace(content)
    if not normalized:
        return []
    md = {"source_title": title} if title else {}
    return [ChunkInput(text=c, metadata=md) for c in split_text(normalized)]


# Markdown ATX headings: ``#`` through ``######``. We track the running
# heading path so each chunk can carry it as metadata.
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def parse_markdown(content: str, title: str | None) -> list[ChunkInput]:
    """Markdown — strip nothing, chunk by section.

    We split the document at heading boundaries, track the running
    heading path per section, then apply the recursive chunker within
    each section. That way a chunk knows ``"Billing > Cancellations"``
    rather than just "page 17 of plain text."
    """
    sections = _split_by_headings(content)
    out: list[ChunkInput] = []
    for path, body in sections:
        body = normalize_whitespace(body)
        if not body:
            continue
        section_label = " > ".join(path) if path else None
        for piece in split_text(body):
            md: dict = {}
            if title:
                md["source_title"] = title
            if section_label:
                md["section"] = section_label
            out.append(ChunkInput(text=piece, metadata=md))
    return out


def _split_by_headings(md_text: str) -> list[tuple[list[str], str]]:
    """Return ``[(heading_path, body_text), ...]``.

    The first item's path is empty (content before any heading);
    subsequent items have the heading stack at their depth.
    """
    pieces: list[tuple[list[str], str]] = []
    last_idx = 0
    stack: list[str] = []
    last_path: list[str] = []
    for m in _HEADING_RE.finditer(md_text):
        body_before = md_text[last_idx : m.start()]
        if body_before.strip():
            pieces.append((list(last_path), body_before))
        depth = len(m.group(1))
        heading = m.group(2)
        # Pop stack down to the right depth, then push the new heading.
        stack = stack[: depth - 1] + [heading]
        last_path = list(stack)
        last_idx = m.end()
    # Trailing content after the last heading.
    tail = md_text[last_idx:]
    if tail.strip():
        pieces.append((list(last_path), tail))
    return pieces
