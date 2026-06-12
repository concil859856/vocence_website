"""Unit tests for the agent-turn buffer + trim logic in CallRecorder.

The bug being fixed: TTS streams faster than real-time, so push_agent
runs ahead of the actual user-audible playback. On barge-in the
recorder would naively keep the full buffered audio and the WAV would
contain agent speech the user never actually heard.

The fix (server-driven turn lifecycle, not client per-chunk signals):

  * ``push_agent`` opens a turn on its first call by anchoring
    ``_agent_turn_start_ms`` at the recorder offset, and resets the
    "client settled" flag so a stale signal can't survive a new push.
  * ``mark_agent_barge_in`` trims the buffer to
    ``(now - turn_start) × BYTES_PER_MS`` bytes — the upper bound on
    what the speakers could have produced in the elapsed wall-clock.
  * ``notify_agent_tts_done`` + ``notify_agent_client_settled`` are
    order-independent half-completion signals. The turn commits its
    full buffer once BOTH have fired (the user heard it all). A
    mid-turn settled (queue drains briefly between sentences while
    TTS is still streaming) does NOT commit on its own.

Tests cover:
  1. Normal turn (push → tts_done → settled, in either order) commits
     ALL bytes — nothing dropped because the user heard the whole thing.
  2. TTS overflows + barge-in: pushed bytes worth 5s, mark_barge_in
     after 1s of real-time → only ~1s of audio survives.
  3. Multiple turns interleaved — segments accumulate independently
     and a settled from turn 1 doesn't leak into turn 2.
  4. Mid-turn settled (queue drained between sentences) is ignored —
     a later push extends the buffer, and only the FINAL settled
     after TTS done commits.
  5. close() flushes a still-open turn so the LAST utterance of a
     session ended mid-playback isn't silently dropped from the WAV.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from call_recorder import CallRecorder, BYTES_PER_MS


def _make_recorder(monkeypatch, *, t0: float = 1000.0) -> CallRecorder:
    """Build a started CallRecorder whose clock we control via
    monkeypatching ``time.monotonic`` (the recorder uses it for
    every timestamp)."""
    rec = CallRecorder(user_id="u", session_id="s")
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: t0)
    rec.start()
    return rec


def _advance(monkeypatch, *, to_seconds: float) -> None:
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: to_seconds)


def _fake_24k_frame(ms: int) -> bytes:
    """Return ``ms`` of 24 kHz mono s16le PCM filled with a non-zero
    byte pattern. 24 kHz × 2 bytes/sample × ms/1000 = 48 × ms bytes."""
    n_samples = 24 * ms
    return b"\x01\x02" * n_samples


def _segment_bytes(rec: CallRecorder) -> bytes:
    return b"".join(seg[1] for seg in rec._agent_segments)


def _approx_ms(byte_count: int, expected_ms: int, tolerance_ms: int = 2) -> bool:
    """Floating-point conversion between seconds and ms can land us
    1 ms either side of the target. ±2 ms tolerance keeps the
    assertions stable without hiding real off-by-many-frames bugs."""
    actual_ms = byte_count // BYTES_PER_MS
    return abs(actual_ms - expected_ms) <= tolerance_ms


def test_normal_turn_commits_all_bytes(monkeypatch):
    """Agent spoke ~1 second, user heard the whole thing. Recording
    should contain the full audio with no trim."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(1000))

    # TTS pipeline done + client settled (either order). 1s wall-clock
    # has elapsed during playback.
    _advance(monkeypatch, to_seconds=1001.0)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()

    seg = _segment_bytes(rec)
    # 1000 ms × BYTES_PER_MS (32) = 32000 bytes kept — NO trim, full audio.
    assert _approx_ms(len(seg), 1000)
    assert len(rec._agent_segments) == 1
    assert rec._agent_segments[0][0] == 0  # turn anchored at 0 ms


def test_settled_then_tts_done_also_commits(monkeypatch):
    """Order-independence: client signals settled BEFORE TTS finishes
    pushing (e.g. last chunk drained while pipeline is still wrapping
    up). The turn should still commit once tts_done arrives."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(800))
    _advance(monkeypatch, to_seconds=1000.8)
    rec.notify_agent_client_settled()
    # Buffer still uncommitted — TTS hasn't signalled done yet.
    assert len(rec._agent_segments) == 0
    rec.notify_agent_tts_done()
    # Now both signals are in — commit.
    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 800)


def test_barge_in_drops_unplayed_audio(monkeypatch):
    """TTS streamed 5 seconds of audio in milliseconds (faster than
    real-time), but the user barged in after 1 second of real-time.
    The recording should contain ~1 second of agent audio, NOT 5."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(5000))

    _advance(monkeypatch, to_seconds=1001.0)
    rec.mark_agent_barge_in()

    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1000), (
        f"expected 1s of audio, got {len(seg) / BYTES_PER_MS:.0f}ms"
    )


def test_mid_turn_settled_does_not_commit(monkeypatch):
    """Reproduces the bug the user reported: the client's audio queue
    briefly drains between sentences in the same turn (TTS pipeline
    pauses while waiting for the next LLM token), fires settled. With
    the OLD design that closed the playback window and the next push
    started orphan-anchored. With the new design the settled is just a
    half-signal — buffer keeps accumulating and only commits once TTS
    actually finishes."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    # Sentence 1: 500ms of audio.
    rec.push_agent(_fake_24k_frame(500))
    _advance(monkeypatch, to_seconds=1000.5)
    rec.notify_agent_client_settled()  # Queue drained between sentences.

    # No commit yet — TTS still streaming for this turn.
    assert len(rec._agent_segments) == 0
    # client_settled flag is set, awaiting tts_done...
    assert rec._agent_client_settled is True

    # Sentence 2 pushes. The push should reset the settled flag so the
    # earlier (stale) settled can't survive into the post-tts-done check.
    rec.push_agent(_fake_24k_frame(700))
    assert rec._agent_client_settled is False

    # Sentence 2 plays out, queue drains, settled fires again.
    _advance(monkeypatch, to_seconds=1001.2)
    rec.notify_agent_client_settled()
    rec.notify_agent_tts_done()

    # Now both signals are in for the latest state — commit ALL of
    # sentence 1 AND sentence 2 (1200 ms total). NOT cut by the
    # mid-turn settled.
    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1200), (
        f"expected 1200ms (sentence 1 + sentence 2), got {len(seg) / BYTES_PER_MS:.0f}ms"
    )
    assert len(rec._agent_segments) == 1


def test_multiple_turns_accumulate_independently(monkeypatch):
    """Two agent turns separated by user speech. Each turn's segment
    should be independent — second turn's buffer doesn't re-include
    bytes from the first."""
    rec = _make_recorder(monkeypatch, t0=1000.0)

    # Turn 1.
    rec.push_agent(_fake_24k_frame(500))
    _advance(monkeypatch, to_seconds=1000.5)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()

    # User speech happens during 1000.5–2000.
    _advance(monkeypatch, to_seconds=2000.0)

    # Turn 2.
    rec.push_agent(_fake_24k_frame(800))
    _advance(monkeypatch, to_seconds=2000.8)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()

    assert len(rec._agent_segments) == 2
    assert rec._agent_segments[0][0] == 0
    assert rec._agent_segments[1][0] == 1000_000  # turn 2 at 1000s
    assert _approx_ms(len(rec._agent_segments[0][1]), 500)
    assert _approx_ms(len(rec._agent_segments[1][1]), 800)


def test_signals_without_open_turn_are_noop(monkeypatch):
    """Defensive: if tts_done / client_settled / barge_in fire with no
    open turn (no push_agent since last commit), they're no-ops."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()
    rec.mark_agent_barge_in()
    assert rec._agent_segments == []
    # Internal flags shouldn't have flipped if there was no turn open
    # — there's nothing to commit when push_agent eventually fires.
    assert rec._agent_tts_done is False
    assert rec._agent_client_settled is False


def test_close_flushes_open_turn(monkeypatch, tmp_path):
    """If the session ends mid-utterance (WS closed before either
    tts_done or settled arrived), close() must flush the still-open
    turn. Without it the last utterance of the session would be
    silently dropped from the WAV.

    We patch the upload step so this test doesn't try to push bytes
    to R2 / Hippius — only the in-process behaviour matters."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(300))
    # Push user audio so close() doesn't bail early on "nothing captured".
    rec._user_chunks.append((0, b"\x00" * 100))
    rec._user_total_bytes = 100

    _advance(monkeypatch, to_seconds=1000.3)

    # No tts_done / settled — straight to close, mimicking a WS
    # disconnect mid-playback. Sync wrapper around the async close()
    # avoids tangling the test-file's event loop policy with
    # pytest-asyncio's per-test loop.
    with patch(
        "call_recorder.CallRecorder._build_wav_bytes",
        return_value=b"\x00" * 1024,
    ), patch(
        "studio_tts_service.upload_call_recording_wav",
        return_value=("test_bucket", "test_key"),
    ):
        bucket, key, size = asyncio.new_event_loop().run_until_complete(rec.close())

    assert len(rec._agent_segments) == 1
    assert _approx_ms(len(rec._agent_segments[0][1]), 300)
    assert bucket == "test_bucket"
    assert key == "test_key"
