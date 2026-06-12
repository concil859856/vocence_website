"""Unit tests for the agent-playback-window truncation in
CallRecorder. The bug being fixed: TTS streams faster than
real-time, so push_agent runs ahead of the actual user-audible
playback. On barge-in, the recorder would naively keep the full
buffered audio and the WAV would contain agent speech the user
never actually heard.

The fix: notify_agent_playback_started / notify_agent_playback_stopped
bracket the wall-clock window the user was actually hearing
audio for. On stop, the buffered PCM is trimmed to
``(now - start) × BYTES_PER_MS`` bytes — anything past that
is discarded.

Tests cover:
  1. Normal playback (started → push frames → settled) keeps all
     the bytes (assuming TTS didn't run ahead).
  2. TTS overflows + barge-in: pushed bytes worth 5s, stop after
     1s of real-time → only 1s of audio survives.
  3. Multiple turns interleaved → segments accumulate
     independently.
  4. Stop without start is a no-op (no crash, no stale data).
  5. close() flushes a still-open window so the LAST utterance
     of a session that ended mid-playback isn't silently dropped.
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
    # Anchor the recorder's t0 at the controlled clock value.
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: t0)
    rec.start()
    return rec


def _advance(monkeypatch, *, to_seconds: float) -> None:
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: to_seconds)


def _fake_24k_frame(ms: int) -> bytes:
    """Return ``ms`` of 24 kHz mono s16le PCM filled with a
    non-zero byte pattern so we can tell silence from data in
    assertions. 24 kHz × 2 bytes/sample × ms/1000 = 48 × ms bytes."""
    n_samples = 24 * ms
    # struct.pack would be cleaner but bytes(n) is faster and the
    # values just need to be non-zero.
    return b"\x01\x02" * n_samples


def _segment_bytes(rec: CallRecorder) -> bytes:
    """Concatenated agent-segment PCM, for length assertions."""
    return b"".join(seg[1] for seg in rec._agent_segments)


def _approx_ms(byte_count: int, expected_ms: int, tolerance_ms: int = 2) -> bool:
    """Floating-point conversion between seconds and ms can land us
    1 ms either side of the target. ±2 ms tolerance keeps the
    assertions stable without hiding real off-by-many-frames bugs."""
    actual_ms = byte_count // BYTES_PER_MS
    return abs(actual_ms - expected_ms) <= tolerance_ms


def test_normal_playback_keeps_all_bytes(monkeypatch):
    """User started playback, agent spoke for ~1 second of
    real-time, user heard the whole thing. Recording should
    contain the full audio."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_playback_started()

    # Push 1s of agent audio (24 kHz source → decimated to 16 kHz
    # at ingest, so 1000ms × 32 bytes/ms = 32000 bytes after
    # decimation).
    rec.push_agent(_fake_24k_frame(1000))

    # 1 second of real-time passes, then settled fires.
    _advance(monkeypatch, to_seconds=1001.0)
    rec.notify_agent_playback_stopped()

    # 1000 ms × BYTES_PER_MS (32) = 32000 max bytes kept.
    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1000)
    # Single segment, anchored at the original playback start.
    assert len(rec._agent_segments) == 1
    assert rec._agent_segments[0][0] == 0  # 0 ms from session start


def test_barge_in_drops_unplayed_audio(monkeypatch):
    """TTS streamed 5 seconds of audio in milliseconds (faster
    than real-time), but the user barged in after 1 second of
    real-time. The recording should contain ~1 second of agent
    audio, NOT 5."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_playback_started()

    # 5 seconds of audio land in the buffer near-instantly (TTS
    # is way faster than real-time).
    rec.push_agent(_fake_24k_frame(5000))

    # Only 1 second of real-time passes before the user barges
    # in. The router would call notify_agent_playback_stopped()
    # on receipt of the ``cancel`` message.
    _advance(monkeypatch, to_seconds=1001.0)
    rec.notify_agent_playback_stopped()

    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1000), (
        f"expected 1s of audio, got {len(seg) / BYTES_PER_MS:.0f}ms"
    )


def test_multiple_turns_accumulate_independently(monkeypatch):
    """Two agent turns separated by user speech. Each turn's
    segment should be independent — second turn's pushes shouldn't
    re-include bytes from the first."""
    rec = _make_recorder(monkeypatch, t0=1000.0)

    # Turn 1: started at t0, 500ms of audio, stopped 500ms later.
    rec.notify_agent_playback_started()
    rec.push_agent(_fake_24k_frame(500))
    _advance(monkeypatch, to_seconds=1000.5)
    rec.notify_agent_playback_stopped()

    # User speech happens during 1000.5–2000.
    _advance(monkeypatch, to_seconds=2000.0)

    # Turn 2: started at t+1000, 800ms of audio, stopped 800ms later.
    rec.notify_agent_playback_started()
    rec.push_agent(_fake_24k_frame(800))
    _advance(monkeypatch, to_seconds=2000.8)
    rec.notify_agent_playback_stopped()

    # Two segments, each with its own offset_ms and bytes.
    assert len(rec._agent_segments) == 2
    assert rec._agent_segments[0][0] == 0  # turn 1 anchored at 0 ms
    assert rec._agent_segments[1][0] == 1000_000  # turn 2 at 1000s
    assert _approx_ms(len(rec._agent_segments[0][1]), 500)
    assert _approx_ms(len(rec._agent_segments[1][1]), 800)


def test_stop_without_start_is_noop(monkeypatch):
    """Defensive: if notify_stopped fires without a prior
    notify_started (e.g. the client sent client_audio_settled
    spuriously), we don't crash and don't create a segment."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(100))  # bytes buffered, no playback
    rec.notify_agent_playback_stopped()   # should be a no-op
    assert rec._agent_segments == []


def test_started_is_idempotent(monkeypatch):
    """A flapping client (audio_started fires twice in a row
    because of a worklet hiccup) shouldn't reset the playback
    anchor mid-utterance. The original start time stays."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_playback_started()
    rec.push_agent(_fake_24k_frame(500))

    _advance(monkeypatch, to_seconds=1000.2)
    # Spurious second start — should be ignored.
    rec.notify_agent_playback_started()

    _advance(monkeypatch, to_seconds=1000.5)
    rec.notify_agent_playback_stopped()

    seg = _segment_bytes(rec)
    # 500 ms elapsed since the FIRST started, not the second.
    assert len(seg) == 500 * BYTES_PER_MS


def test_close_flushes_open_playback_window(monkeypatch, tmp_path):
    """If the session ends mid-utterance — i.e. WS closed before
    client_audio_settled arrived — close() must flush the still-
    open playback window. Without it the last utterance of the
    session would be silently dropped from the WAV.

    We intercept the upload step so this test doesn't try to push
    bytes to R2 / Hippius — only the in-process behaviour matters.
    """
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_playback_started()
    rec.push_agent(_fake_24k_frame(300))
    # ALSO push user audio so close() doesn't bail early on
    # "nothing captured".
    rec._user_chunks.append((0, b"\x00" * 100))
    rec._user_total_bytes = 100

    _advance(monkeypatch, to_seconds=1000.3)

    # No notify_stopped — we go straight to close, mimicking a
    # WS disconnect with no settled signal. Sync wrapper around
    # the async close() avoids tangling the test-file's event
    # loop policy with pytest-asyncio's per-test loop (which was
    # breaking unrelated tests in the suite).
    with patch(
        "call_recorder.CallRecorder._build_wav_bytes",
        return_value=b"\x00" * 1024,
    ), patch(
        "studio_tts_service.upload_call_recording_wav",
        return_value=("test_bucket", "test_key"),
    ):
        bucket, key, size = asyncio.new_event_loop().run_until_complete(rec.close())

    # Flush at close should have produced a segment.
    assert len(rec._agent_segments) == 1
    assert _approx_ms(len(rec._agent_segments[0][1]), 300)
    # And the upload happened.
    assert bucket == "test_bucket"
    assert key == "test_key"
