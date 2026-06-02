"""Unit tests for the EOU ensembler + defer logic.

Covers two pieces:

  * :func:`turn_detection_client.should_commit_turn` — weighted EOU
    blend + 0.65 threshold. Verifies the historic "either model alone
    can fire" bug is gone: a confident smart_turn + low turn_detector
    must NOT fire fast-path commit.
  * :func:`voicechat_stream.StreamingTurnSession._defer_commit` —
    deferring a client commit when EOU is unconfident, and resuming
    when fresh PCM arrives during the grace window.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

import pytest

from turn_detection_client import combine_eou, should_commit_turn


# ---------------------------------------------------------------------------
# should_commit_turn — weighted blend + threshold 0.65
# ---------------------------------------------------------------------------


def test_below_min_endpointing_no_commit() -> None:
    commit, _ = should_commit_turn(
        silence_ms=200, smart_turn_p=0.9, turn_detector_p=0.9,
    )
    assert not commit


def test_above_hard_cap_commits_regardless_of_eou() -> None:
    commit, rule = should_commit_turn(
        silence_ms=13_000, smart_turn_p=0.0, turn_detector_p=0.0,
    )
    assert commit
    assert rule == "hard_cap"


def test_confident_text_eou_commits_fast() -> None:
    # turn_detector very confident, smart_turn echoes it → blended ~0.83
    commit, rule = should_commit_turn(
        silence_ms=600, smart_turn_p=0.7, turn_detector_p=0.9,
    )
    assert commit
    assert rule == "eou_confident"


def test_grammatical_partial_does_not_fast_commit() -> None:
    """Regression: at threshold 0.65 a Turn Detector returning 0.9 on
    a grammatical-but-incomplete partial ("I want to go to the store")
    combined with a neutral 0.3 smart-turn produced blended 0.69 —
    enough to fast-commit even though the user wasn't done. At 0.75
    threshold the same input falls through to the slow path."""
    commit, rule = should_commit_turn(
        silence_ms=600, smart_turn_p=0.3, turn_detector_p=0.9,
    )
    # blended = 0.35*0.3 + 0.65*0.9 = 0.69 — below 0.75 now.
    assert not commit
    assert rule == ""


def test_confident_prosody_alone_does_not_fire_fast_path() -> None:
    """Regression: the old code used max(smart, td) so a noisy 0.8
    smart_turn would fire commit even when turn_detector said 0.1.
    With weighted blending (0.35*0.8 + 0.65*0.1 = 0.345) we stay
    below 0.75 and fall through to the slow path."""
    commit, rule = should_commit_turn(
        silence_ms=600, smart_turn_p=0.8, turn_detector_p=0.1,
    )
    # silence_ms=600 is just above min_endpointing (500) but the slow
    # path requires silence ≥ ~8000+ms with EOU ~0.35, so no commit yet.
    assert not commit
    assert rule == ""


def test_combine_eou_default_weights() -> None:
    # 0.35 * 1.0 + 0.65 * 0.0 = 0.35
    assert combine_eou(1.0, 0.0) == pytest.approx(0.35)
    # 0.35 * 0.0 + 0.65 * 1.0 = 0.65
    assert combine_eou(0.0, 1.0) == pytest.approx(0.65)


def test_slow_path_low_eou_waits_longer() -> None:
    # Both models flatline; with combined_eou ≈ 0, required_silence
    # equals max_endpointing_delay_ms (the slow-path linear scaling
    # at 1.0 gap). Hard cap is 12 s now.
    commit, rule = should_commit_turn(
        silence_ms=8000, smart_turn_p=0.0, turn_detector_p=0.0,
    )
    assert not commit  # still below required_silence ≈ 12000
    commit, rule = should_commit_turn(
        silence_ms=12_500, smart_turn_p=0.0, turn_detector_p=0.0,
    )
    assert commit  # hits hard_cap
    assert rule == "hard_cap"


# ---------------------------------------------------------------------------
# _defer_commit — runs on a real-ish StreamingTurnSession harness
# ---------------------------------------------------------------------------


@pytest.fixture
def session_factory():
    """Build a StreamingTurnSession with a stubbed receive function so
    _defer_commit can be exercised without an actual WebSocket."""
    from voicechat_stream import StreamingTurnSession

    def make(receive_fn: Callable[[], Awaitable[bytes | None]]):
        async def _send_json(_msg):  # not exercised in defer-only tests
            return None

        return StreamingTurnSession(
            client_ws=None,
            language="en",
            history=[],
            receive_binary=receive_fn,
            send_json=_send_json,
        )

    return make


@pytest.mark.asyncio
async def test_defer_returns_none_on_timeout(session_factory, monkeypatch) -> None:
    """When no PCM arrives during the grace window, defer returns None
    (signalling caller should finalize)."""
    # Shrink the base grace so the test finishes fast.
    import voicechat_stream as vs
    monkeypatch.setattr(vs, "DEFER_GRACE_BASE_MS", 100)

    async def never_returns() -> bytes | None:
        await asyncio.sleep(10)  # would block forever; wait_for kills it
        return None

    sess = session_factory(never_returns)
    result = await sess._defer_commit(eou_at_commit=0.0)
    assert result is None


@pytest.mark.asyncio
async def test_defer_returns_frame_on_resumption(session_factory, monkeypatch) -> None:
    """If PCM arrives during the grace window, defer returns the frame
    so the caller can re-enter the forwarding loop."""
    import voicechat_stream as vs
    monkeypatch.setattr(vs, "DEFER_GRACE_BASE_MS", 1000)

    fired = asyncio.Event()
    async def emits_pcm_after_delay() -> bytes | None:
        if not fired.is_set():
            fired.set()
            await asyncio.sleep(0.05)
            return b"\x00\x01" * 16  # 32-byte fake PCM
        await asyncio.sleep(10)
        return None

    sess = session_factory(emits_pcm_after_delay)
    result = await sess._defer_commit(eou_at_commit=0.0)
    assert isinstance(result, bytes)
    assert len(result) == 32


@pytest.mark.asyncio
async def test_defer_grace_scales_with_eou_gap(session_factory, monkeypatch) -> None:
    """Higher EOU → shorter grace. We pass EOU=0.7 (just below the
    0.75 threshold) and expect the grace to be roughly base * (0.05 /
    0.75) ≈ 6.7% of base — far shorter than the EOU=0.0 case."""
    import voicechat_stream as vs
    monkeypatch.setattr(vs, "DEFER_GRACE_BASE_MS", 1000)

    async def never_returns() -> bytes | None:
        await asyncio.sleep(10)
        return None

    sess = session_factory(never_returns)
    start = asyncio.get_event_loop().time()
    await sess._defer_commit(eou_at_commit=0.7)
    elapsed_ms = (asyncio.get_event_loop().time() - start) * 1000
    # Expected: 1000 * (0.05 / 0.75) ≈ 67 ms. Allow generous slack.
    assert elapsed_ms < 300, f"defer took {elapsed_ms:.0f}ms, expected < 300"


def test_running_transcript_concatenates_segments() -> None:
    """``running_transcript`` composes accumulator + partial. This is
    what we now send as ``partial_transcript`` and what becomes the
    final result so a long monologue with pod auto-commits doesn't
    truncate to just the first segment."""
    from voicechat_stream import _SignalState

    state = _SignalState()
    assert state.running_transcript() == ""
    state.partial_text = "hello"
    assert state.running_transcript() == "hello"
    state.finals_accumulated.append("hello world.")
    state.partial_text = ""
    assert state.running_transcript() == "hello world."
    state.partial_text = "and goodbye"
    assert state.running_transcript() == "hello world. and goodbye"
    state.finals_accumulated.append("and goodbye too.")
    state.partial_text = ""
    assert state.running_transcript() == "hello world. and goodbye too."


def test_running_transcript_skips_empty_segments() -> None:
    """Defensive: if the pod ever emits an empty final the join must
    not produce ``" world."``-style leading spaces."""
    from voicechat_stream import _SignalState

    state = _SignalState()
    state.finals_accumulated = ["", "hello", "", "world"]
    state.partial_text = ""
    assert state.running_transcript() == "hello world"


@pytest.mark.asyncio
async def test_pod_final_does_not_end_turn(session_factory) -> None:
    """Regression: when the pod auto-emits a ``final`` (its internal
    silence timer fired mid-utterance), ``_pump_stt`` must NOT return.
    Verified by feeding two simulated finals through and checking the
    accumulator grew to 2 and the task is still running."""
    import json as _json

    class FakeMsg:
        def __init__(self, mtype, data):
            import aiohttp
            self.type = aiohttp.WSMsgType.TEXT
            self.data = _json.dumps({"type": mtype, **data})

    class FakeWs:
        def __init__(self):
            self.closed = False
            self._queue = asyncio.Queue()
        async def receive(self):
            return await self._queue.get()
        async def send_json(self, _payload):
            return None
        def feed(self, msg):
            self._queue.put_nowait(msg)

    async def stub_recv() -> bytes | None:
        await asyncio.sleep(10)
        return None

    sess = session_factory(stub_recv)
    fake_ws = FakeWs()
    sess._stt_ws = fake_ws  # type: ignore[assignment]

    pump_task = asyncio.create_task(sess._pump_stt())
    try:
        fake_ws.feed(FakeMsg("partial", {"text": "hello"}))
        fake_ws.feed(FakeMsg("final", {"text": "hello world."}))
        fake_ws.feed(FakeMsg("partial", {"text": "and goodbye"}))
        fake_ws.feed(FakeMsg("final", {"text": "and goodbye too."}))
        # Give the pump time to consume all four messages.
        await asyncio.sleep(0.1)

        assert sess._state.finals_accumulated == ["hello world.", "and goodbye too."]
        assert sess._state.running_transcript() == "hello world. and goodbye too."
        # Pump is still alive — pod finals do NOT end the turn anymore.
        assert not pump_task.done(), "_pump_stt returned on pod final (regression)"
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except asyncio.CancelledError:
            pass


@pytest.mark.asyncio
async def test_defer_zero_grace_at_threshold(session_factory, monkeypatch) -> None:
    """EOU at exactly the threshold should produce zero grace (caller
    should commit immediately) but _defer_commit is only called when
    EOU < threshold. Passing 0.75 still maths to grace=0 → returns
    None instantly."""
    import voicechat_stream as vs
    monkeypatch.setattr(vs, "DEFER_GRACE_BASE_MS", 1000)

    async def never_returns() -> bytes | None:
        await asyncio.sleep(10)
        return None

    sess = session_factory(never_returns)
    start = asyncio.get_event_loop().time()
    result = await sess._defer_commit(eou_at_commit=0.75)
    elapsed_ms = (asyncio.get_event_loop().time() - start) * 1000
    assert result is None
    assert elapsed_ms < 50  # essentially instant
