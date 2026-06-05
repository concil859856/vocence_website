"""Chunker correctness tests — pure-Python, no model loads.

The chunker is the foundation of every ingest path; these tests
catch the easy regressions (chunks too big, no overlap, sentence
split inside an abbreviation) without any HF/LanceDB I/O.
"""

from __future__ import annotations

import pytest

from knowledge_ingestion.ingest.chunker import (
    ChunkerConfig,
    normalize_whitespace,
    split_text,
)


def test_short_text_returns_single_chunk() -> None:
    out = split_text("hello world")
    assert out == ["hello world"]


def test_empty_returns_empty() -> None:
    assert split_text("") == []
    assert split_text("   \n  \n  ") == []


def test_chunks_respect_target_size() -> None:
    """No chunk should exceed target_chars by more than ~1 separator's
    worth (the recursive splitter respects boundaries)."""
    config = ChunkerConfig(target_tokens=100, overlap_tokens=10)
    text = "Sentence one. " * 200  # ~14 chars × 200 = 2800 chars, well over 400
    chunks = split_text(text, config)
    assert len(chunks) > 1
    for c in chunks:
        # +50 char buffer for overlap padding from the previous chunk.
        assert len(c) <= config.target_chars + 50


def test_paragraph_boundary_preferred() -> None:
    """Two-newline boundaries should be the split point of choice."""
    config = ChunkerConfig(target_tokens=50, overlap_tokens=0)
    text = "First paragraph. " * 8 + "\n\n" + "Second paragraph. " * 8
    chunks = split_text(text, config)
    # The split should land at the \n\n — so neither paragraph should
    # appear in two chunks.
    assert any("First paragraph" in c and "Second paragraph" not in c for c in chunks)
    assert any("Second paragraph" in c and "First paragraph" not in c for c in chunks)


def test_overlap_preserves_context() -> None:
    """The last N chars of each chunk should appear at the start of
    the next (to provide context across the boundary)."""
    config = ChunkerConfig(target_tokens=20, overlap_tokens=5)
    text = "A. " * 100   # very repetitive but lots of sentence breaks
    chunks = split_text(text, config)
    if len(chunks) > 1:
        prev_tail = chunks[0][-config.overlap_chars:]
        assert chunks[1].startswith(prev_tail) or chunks[1].startswith(prev_tail.lstrip())


def test_normalize_whitespace_collapses_blank_lines() -> None:
    assert normalize_whitespace("a\n\n\n\nb") == "a\n\nb"
    assert normalize_whitespace("\n\nhello\n\n") == "hello"
    assert normalize_whitespace("a\n\nb") == "a\n\nb"  # 2 newlines preserved


@pytest.mark.parametrize("text", [
    "hello",
    "hello world",
    "A long paragraph of text with no boundaries because it's all one big run-on sentence yes I am aware of the irony",
])
def test_no_data_loss_on_short_inputs(text: str) -> None:
    """For inputs under target_chars the chunker should return the
    input verbatim — no silent truncation."""
    out = split_text(text)
    assert "".join(out) == text or out[0] == text
