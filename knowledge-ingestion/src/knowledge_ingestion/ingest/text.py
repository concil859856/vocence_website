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

    Stack semantics: ``stack[i]`` is the heading at level ``i+1``. So
    an H2 lives at index 1 even if no H1 came before it — we pad with
    empty slots and skip them when joining the display path. This way
    two sibling H2s correctly truncate each other's stack instead of
    accumulating.
    """
    pieces: list[tuple[list[str], str]] = []
    last_idx = 0
    stack: list[str] = []   # stack[depth-1] = heading at that depth
    last_path: list[str] = []
    for m in _HEADING_RE.finditer(md_text):
        body_before = md_text[last_idx : m.start()]
        if body_before.strip():
            pieces.append((_visible_path(last_path), body_before))
        depth = len(m.group(1))
        heading = m.group(2)
        # Truncate to ancestors only (everything above this depth),
        # then pad to depth-1 in case higher levels were skipped, then
        # push the new heading at index depth-1.
        stack = stack[: depth - 1]
        while len(stack) < depth - 1:
            stack.append("")
        stack.append(heading)
        last_path = list(stack)
        last_idx = m.end()
    # Trailing content after the last heading.
    tail = md_text[last_idx:]
    if tail.strip():
        pieces.append((_visible_path(last_path), tail))
    return pieces


def _visible_path(stack: list[str]) -> list[str]:
    """Drop empty stack slots so the rendered ``"A > B"`` display
    string doesn't carry blank levels from skipped headings."""
    return [s for s in stack if s]
