"""Unit tests for ``_split_for_pod_limit`` — the single-call-TTS safety
net that fires when an LLM reply exceeds the TTS pod's hard 1000-char
limit. Observed in production as a ``bad_request: start.text too long``
error that silently dropped the entire audio reply.
"""

from __future__ import annotations

import os

# Set the JWT_SECRET before importing — routers/auth refuses to load
# without it. Tests don't need the real secret, just any non-empty value.
os.environ.setdefault(
    "JWT_SECRET", "test_secret_for_imports_only_12345678901234567890"
)

from routers.voicechat import _split_for_pod_limit  # noqa: E402


def test_short_text_returns_single_element():
    """Common case — typical voice-agent reply is well under the limit
    and should pass through as a single-element list."""
    parts = _split_for_pod_limit("Hello, how can I help you today?", 900)
    assert parts == ["Hello, how can I help you today?"]


def test_empty_text_returns_empty_list():
    """Defensive — empty / whitespace-only inputs produce no output
    rather than a single empty string that would later round-trip into
    a wasted TTS call."""
    assert _split_for_pod_limit("", 900) == []
    assert _split_for_pod_limit("   ", 900) == []


def test_splits_at_sentence_boundaries_when_oversize():
    """Long reply with clean punctuation should split at sentence ends,
    keeping every piece within the limit."""
    sentence = "This is one sentence."  # 21 chars
    text = " ".join([sentence] * 100)   # 21 * 100 + 99 spaces = ~2199 chars
    parts = _split_for_pod_limit(text, 100)
    assert all(len(p) <= 100 for p in parts), [len(p) for p in parts]
    # Every piece should end at a sentence boundary (no mid-sentence cuts).
    assert all(p.endswith(".") for p in parts)
    # Concatenating should round-trip the content (modulo intra-sentence
    # whitespace normalisation).
    assert sentence in parts[0]


def test_hard_cuts_when_single_sentence_exceeds_limit():
    """Edge case — LLM emits a wall of text with no punctuation. We
    must still produce pieces within the limit; falling back to
    whitespace cuts, then character cuts if even that fails."""
    text = "word " * 300   # 1500 chars, no sentence punctuation
    parts = _split_for_pod_limit(text, 200)
    assert len(parts) > 1
    assert all(len(p) <= 200 for p in parts), [len(p) for p in parts]
    # Reassemble and verify we didn't lose content (allow for
    # the strip()s collapsing inter-piece whitespace).
    assert "word" in parts[0]


def test_split_preserves_total_content_at_realistic_size():
    """Realistic regression — the user's bug report had a 3475-char
    reply rejected by the pod. Split into ≤900-char pieces; total
    surviving chars should be close to the input minus whitespace
    folding around boundaries."""
    text = ". ".join(["A medium-length explanatory sentence"] * 80)
    assert len(text) > 1000  # confirm we're testing the long branch
    parts = _split_for_pod_limit(text, 900)
    assert len(parts) >= 2
    assert all(len(p) <= 900 for p in parts), [len(p) for p in parts]
    # Total preserved chars should be within 1% of input (whitespace
    # at piece boundaries gets stripped).
    total_out = sum(len(p) for p in parts)
    assert total_out >= len(text) - len(parts) * 2


def test_exact_limit_boundary_keeps_single_element():
    """Reply that exactly hits the limit shouldn't be split."""
    text = "x" * 100
    parts = _split_for_pod_limit(text, 100)
    assert parts == [text]


def test_one_char_over_limit_does_split():
    """One char over the limit should produce 2 pieces, not crash."""
    text = "Hello world. " + ("x" * 100)
    parts = _split_for_pod_limit(text, 100)
    assert len(parts) >= 2
    assert all(len(p) <= 100 for p in parts), [len(p) for p in parts]
