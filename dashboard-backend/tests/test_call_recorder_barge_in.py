"""Unit tests for the agent-turn gate + barge-in trim in CallRecorder.

The bugs being fixed:

A) TTS streams faster than real-time, so push_agent runs ahead of
   actual user-audible playback. On barge-in the recorder would naively
   keep the full buffered audio and the WAV would contain agent speech
   the user never heard.

B) The previous turn's TTS task has up to 1 s of cooperative-
   cancellation grace after ``cancel`` — during that grace window it
   emits one or two more chunks that hit push_agent AFTER
   mark_agent_barge_in has already trimmed and committed. With no
   gate those orphan chunks opened a phantom turn at the barge-in
   moment AND/OR bled into the NEXT real turn's buffer; the recording
   then had agent audio overlapping the user's interruption ("in the
   recording both agent and my interruption are playing together" —
   the user-reported regression).

Design (server-driven turn lifecycle):
  * ``notify_agent_turn_started`` (router → recorder, before TTS
    pipeline starts) opens the gate. Until then push_agent is a no-op.
  * ``push_agent`` only buffers when the gate is open. First push of
    an open turn anchors ``_agent_turn_start_ms`` at ``_now_ms()``.
  * ``mark_agent_barge_in`` trims to ``(now - turn_start) × BYTES_PER_MS``
    bytes, commits the segment, and CLOSES the gate. Subsequent
    push_agent calls from the cancelled task are dropped.
  * ``notify_agent_tts_done`` + ``notify_agent_client_settled`` are
    order-independent half-completion signals; once both have fired
    the buffer commits whole and the gate closes.

Tests cover:
  1. Normal turn (started → push → tts_done → settled) commits ALL
     bytes; gate ends closed.
  2. push_agent before notify_agent_turn_started is silently dropped.
  3. Barge-in trim works; subsequent orphan pushes are dropped.
  4. Multi-turn flow: started → push → barge → started → push → done
     produces two distinct segments at different anchors.
  5. Mid-turn settled is ignored; only post-tts_done settled commits.
  6. close() flushes a still-open turn.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

from call_recorder import CallRecorder, BYTES_PER_MS


def _make_recorder(monkeypatch, *, t0: float = 1000.0) -> CallRecorder:
    rec = CallRecorder(user_id="u", session_id="s")
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: t0)
    rec.start()
    return rec


def _advance(monkeypatch, *, to_seconds: float) -> None:
    monkeypatch.setattr("call_recorder.time.monotonic", lambda: to_seconds)


def _fake_24k_frame(ms: int) -> bytes:
    n_samples = 24 * ms
    return b"\x01\x02" * n_samples


def _segment_bytes(rec: CallRecorder) -> bytes:
    return b"".join(seg[1] for seg in rec._agent_segments)


def _approx_ms(byte_count: int, expected_ms: int, tolerance_ms: int = 2) -> bool:
    actual_ms = byte_count // BYTES_PER_MS
    return abs(actual_ms - expected_ms) <= tolerance_ms


def test_normal_turn_commits_all_bytes(monkeypatch):
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(1000))

    _advance(monkeypatch, to_seconds=1001.0)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()

    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1000)
    assert len(rec._agent_segments) == 1
    assert rec._agent_segments[0][0] == 0
    # Gate closed after natural completion.
    assert rec._agent_turn_open is False


def test_push_before_turn_started_is_dropped(monkeypatch):
    """Defensive: any push that arrives before the router has signalled
    the start of an agent reply is rejected — there's no turn it could
    belong to. The session-open state has the gate closed."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.push_agent(_fake_24k_frame(500))  # gate closed → dropped

    # Recorder buffer is empty, no segment was committed.
    assert rec._agent_buffer == bytearray()
    assert rec._agent_segments == []
    assert rec._agent_turn_start_ms is None


def test_barge_in_drops_unplayed_audio_and_blocks_orphan_pushes(monkeypatch):
    """The core regression fix. TTS streamed 5 seconds in milliseconds,
    user barged in after 1 second of real-time. Recording should
    contain ~1 second of agent audio. AND any push_agent calls that
    arrive AFTER mark_agent_barge_in — from the still-running TTS
    task's cancellation grace window — must be dropped, not opened
    as a phantom turn that overlaps the user's interruption."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(5000))

    _advance(monkeypatch, to_seconds=1001.0)
    rec.mark_agent_barge_in()

    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1000), (
        f"expected 1s of audio, got {len(seg) / BYTES_PER_MS:.0f}ms"
    )
    # Gate is now CLOSED — the bug-fix invariant.
    assert rec._agent_turn_open is False

    # Simulate the cancelled TTS task continuing to push for ~600 ms
    # before its cancellation actually lands. These must be silently
    # dropped — neither extending the existing segment nor creating
    # a new one.
    _advance(monkeypatch, to_seconds=1001.1)
    rec.push_agent(_fake_24k_frame(50))
    _advance(monkeypatch, to_seconds=1001.3)
    rec.push_agent(_fake_24k_frame(200))
    _advance(monkeypatch, to_seconds=1001.6)
    rec.push_agent(_fake_24k_frame(300))

    # Still only the one segment, still ~1 second of audio.
    assert len(rec._agent_segments) == 1
    assert _approx_ms(len(_segment_bytes(rec)), 1000)
    assert rec._agent_buffer == bytearray()


def test_next_turn_after_barge_in_is_independent(monkeypatch):
    """After barge-in, the NEXT real turn must:
       1. Re-open the gate (via notify_agent_turn_started)
       2. Anchor its own start_ms at the new turn's first push
       3. Not get polluted by anything from the previous turn"""
    rec = _make_recorder(monkeypatch, t0=1000.0)

    # Turn 1: barge-in.
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(2000))
    _advance(monkeypatch, to_seconds=1001.0)
    rec.mark_agent_barge_in()
    assert _approx_ms(len(rec._agent_segments[0][1]), 1000)

    # Orphan push from the dying turn-1 TTS task — dropped.
    rec.push_agent(_fake_24k_frame(80))

    # User speaks, server processes, time passes.
    _advance(monkeypatch, to_seconds=2000.0)

    # Turn 2 begins. Router signals.
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(600))
    _advance(monkeypatch, to_seconds=2000.6)
    rec.notify_agent_tts_done()
    rec.notify_agent_client_settled()

    # Two distinct segments at distinct anchors.
    assert len(rec._agent_segments) == 2
    assert rec._agent_segments[0][0] == 0           # turn 1 anchored at t=0
    assert rec._agent_segments[1][0] == 1000_000    # turn 2 at t=1000s
    assert _approx_ms(len(rec._agent_segments[0][1]), 1000)
    assert _approx_ms(len(rec._agent_segments[1][1]), 600)


def test_mid_turn_settled_does_not_commit(monkeypatch):
    """Client's audio queue briefly drains between sentences in the
    same turn (TTS pipeline pauses waiting for the next LLM token).
    The settled fires but TTS is still streaming for the turn — must
    NOT trigger an early commit."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(500))
    _advance(monkeypatch, to_seconds=1000.5)
    rec.notify_agent_client_settled()
    assert len(rec._agent_segments) == 0
    assert rec._agent_client_settled is True

    # Sentence 2 — push resets the settled flag.
    rec.push_agent(_fake_24k_frame(700))
    assert rec._agent_client_settled is False

    _advance(monkeypatch, to_seconds=1001.2)
    rec.notify_agent_client_settled()
    rec.notify_agent_tts_done()

    seg = _segment_bytes(rec)
    assert _approx_ms(len(seg), 1200)
    assert len(rec._agent_segments) == 1
    assert rec._agent_turn_open is False


def test_notify_agent_turn_started_is_idempotent(monkeypatch):
    """Defensive: calling notify_agent_turn_started twice without an
    intervening commit / barge-in (e.g. greeting fired it, then the
    first tts_consumer of a turn fires it again) must not corrupt
    state — the gate just stays open and the next push_agent opens
    a fresh turn."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    assert rec._agent_turn_open is True
    # Call again with the gate already open and no audio buffered.
    rec.notify_agent_turn_started()
    assert rec._agent_turn_open is True
    assert rec._agent_buffer == bytearray()
    assert rec._agent_turn_start_ms is None
    # Push works normally afterward.
    rec.push_agent(_fake_24k_frame(200))
    assert rec._agent_turn_start_ms is not None
    assert len(rec._agent_buffer) > 0


def test_notify_agent_turn_started_drops_stale_buffer(monkeypatch):
    """If a previous turn left orphan bytes in the buffer (e.g. the
    router forgot to call mark_agent_barge_in / tts_done — shouldn't
    happen but be defensive), notify_agent_turn_started discards
    them rather than letting them bleed into the new turn."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(400))
    # Skip the proper close — simulate the missing mark/tts_done bug.
    # Next turn starts.
    rec.notify_agent_turn_started()
    assert rec._agent_buffer == bytearray()
    assert rec._agent_turn_start_ms is None
    assert rec._agent_turn_open is True


def test_close_flushes_open_turn(monkeypatch, tmp_path):
    """If the WS closes mid-utterance (before tts_done or settled),
    close() must flush the still-open turn so the last utterance
    isn't silently dropped."""
    rec = _make_recorder(monkeypatch, t0=1000.0)
    rec.notify_agent_turn_started()
    rec.push_agent(_fake_24k_frame(300))
    rec._user_chunks.append((0, b"\x00" * 100))
    rec._user_total_bytes = 100

    _advance(monkeypatch, to_seconds=1000.3)

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
