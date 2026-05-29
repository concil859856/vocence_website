"""Recursive character splitter for text chunking.

The same idea as langchain's RecursiveCharacterTextSplitter but
self-contained (we don't want langchain's transitive dependency
graph for one ~50-line algorithm).

Strategy:
  • Target ~512 tokens per chunk with 64 tokens of overlap. Token
    counts are approximated as ``chars / 4`` — close enough for BGE-
    small's 512-token window. Being slightly under is safer than
    slightly over (the embedder truncates silently).
  • Split on natural boundaries first (double newline, single newline,
    sentence terminator, then word boundary, then char). At each level
    we accept fragments that fit and recurse into ones that don't.
  • Overlap is appended from the END of the previous chunk to the
    START of the next so context is preserved across boundaries.

We don't apply any abbreviation handling here — chunks aren't sentences,
they're context windows, so a chunk that happens to start mid-sentence
is fine. The embedder is robust to that.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


# 4 chars ≈ 1 token for English BPE; a useful approximation that
# avoids loading a tokenizer at chunk time.
_CHARS_PER_TOKEN = 4


@dataclass(frozen=True)
class ChunkerConfig:
    target_tokens: int = 512
    overlap_tokens: int = 64

    @property
    def target_chars(self) -> int:
        return self.target_tokens * _CHARS_PER_TOKEN

    @property
    def overlap_chars(self) -> int:
        return self.overlap_tokens * _CHARS_PER_TOKEN


_DEFAULT = ChunkerConfig()


# Separators ordered by "preferred to split here". The recursion takes
# the first one whose pieces fit; if none fit, falls through to
# character-level splitting.
_SEPARATORS: tuple[str, ...] = (
    "\n\n",     # paragraph
    "\n",       # line
    ". ",       # sentence
    "! ",
    "? ",
    "; ",
    ", ",
    " ",        # word
    "",         # character (always splits)
)


def split_text(text: str, config: ChunkerConfig = _DEFAULT) -> list[str]:
    """Split a long string into a list of chunks under the target
    size, with overlap between consecutive chunks."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= config.target_chars:
        return [text]
    raw = _split_recursive(text, config.target_chars, _SEPARATORS)
    return _add_overlap(raw, config.overlap_chars)


def _split_recursive(
    text: str, max_chars: int, separators: tuple[str, ...]
) -> list[str]:
    """Split ``text`` into pieces no larger than ``max_chars``, using
    the first separator that produces a clean break. Pieces still too
    big are recursively split using the next separator."""
    if len(text) <= max_chars:
        return [text]
    # Try each separator in order; first one that yields multi-piece
    # output where at least one piece is under max_chars wins.
    for i, sep in enumerate(separators):
        if sep == "":
            # Character-level fallback — always splits.
            return _chunk_by_length(text, max_chars)
        pieces = text.split(sep)
        if len(pieces) == 1:
            continue
        # Re-glue the separator back onto each piece (except the
        # last) so the chunked text preserves the original characters.
        rejoined = [p + sep for p in pieces[:-1]] + [pieces[-1]]
        result: list[str] = []
        for p in rejoined:
            if len(p) <= max_chars:
                result.append(p)
            else:
                # Recurse with the rest of the separator list — we
                # never try a separator we've already tried for a
                # given piece (avoids quadratic blowup on pathological
                # input).
                result.extend(_split_recursive(p, max_chars, separators[i + 1:]))
        # Merge greedy: combine adjacent small pieces under the limit
        # so we don't emit lots of tiny chunks that hurt retrieval.
        return _merge(result, max_chars)
    return _chunk_by_length(text, max_chars)


def _chunk_by_length(text: str, max_chars: int) -> list[str]:
    """Last-resort: cut every ``max_chars`` regardless of boundary."""
    return [text[i : i + max_chars] for i in range(0, len(text), max_chars)]


def _merge(pieces: list[str], max_chars: int) -> list[str]:
    """Combine adjacent pieces under the limit. This is what makes the
    chunker produce nicely-sized chunks rather than a stream of
    micro-fragments after sentence splitting."""
    out: list[str] = []
    current = ""
    for p in pieces:
        if not current:
            current = p
            continue
        if len(current) + len(p) <= max_chars:
            current += p
        else:
            out.append(current)
            current = p
    if current:
        out.append(current)
    return out


def _add_overlap(chunks: list[str], overlap: int) -> list[str]:
    """Prepend ``overlap`` characters from the previous chunk's tail to
    the start of each subsequent chunk. The first chunk is unmodified."""
    if overlap <= 0 or len(chunks) < 2:
        return chunks
    out: list[str] = [chunks[0]]
    for i in range(1, len(chunks)):
        prev_tail = chunks[i - 1][-overlap:]
        # Don't double-overlap if the chunk already starts with it (can
        # happen on small inputs where the recursive splitter handed us
        # heavily-overlapping pieces).
        if chunks[i].startswith(prev_tail):
            out.append(chunks[i])
        else:
            out.append(prev_tail + chunks[i])
    return out


# Convenience pre-compiled regex for line-ish normalization used by
# the various source parsers. Strips excessive blank lines that would
# otherwise inflate chunk sizes without carrying real content.
_MULTI_BLANK = re.compile(r"\n{3,}")


def normalize_whitespace(text: str) -> str:
    """Collapse 3+ consecutive newlines down to 2 (one blank line) and
    strip leading/trailing whitespace. Called by every parser before
    handing text to ``split_text``."""
    return _MULTI_BLANK.sub("\n\n", text).strip()
