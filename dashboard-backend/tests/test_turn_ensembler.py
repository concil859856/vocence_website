"""Unit tests for the EOU ensembler + streaming session helpers."""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

import pytest

from turn_detection_client import (
    combine_eou,
    compute_required_silence_ms,
    should_commit_turn,
)


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


def test_text_confident_commits_at_min_delay() -> None:
    commit, rule = should_commit_turn(
        silence_ms=600, smart_turn_p=0.3, turn_detector_p=0.9,
    )
    assert commit
    assert rule == "text_confident"


def test_text_unlikely_waits_for_max_delay() -> None:
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.2, smart_turn_p=0.95,
    )
    assert rule == "text_unlikely"
    assert required == 6_000

    commit, _ = should_commit_turn(
        silence_ms=required - 100, smart_turn_p=0.95, turn_detector_p=0.2,
    )
    assert not commit

    commit, rule = should_commit_turn(
        silence_ms=required, smart_turn_p=0.95, turn_detector_p=0.2,
    )
    assert commit
    assert rule in ("text_unlikely", "hard_cap")


def test_prosody_alone_cannot_override_low_text_eou() -> None:
    """High smart-turn + low text-EOU must not fast-commit."""
    commit, rule = should_commit_turn(
        silence_ms=2000, smart_turn_p=0.95, turn_detector_p=0.2,
    )
    assert not commit
    assert rule == ""


def test_borderline_text_waits_longer_than_min() -> None:
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.65, smart_turn_p=0.3,
    )
    assert rule == "text_scaled"
    assert required > 500
    commit, _ = should_commit_turn(
        silence_ms=required - 100,
        smart_turn_p=0.3,
        turn_detector_p=0.65,
    )
    assert not commit
    commit, rule = should_commit_turn(
        silence_ms=required + 50,
        smart_turn_p=0.3,
        turn_detector_p=0.65,
    )
    assert commit
    assert rule == "text_scaled"


def test_combine_eou_default_weights() -> None:
    assert combine_eou(1.0, 0.0) == pytest.approx(0.35)
    assert combine_eou(0.0, 1.0) == pytest.approx(0.65)


# ---------------------------------------------------------------------------
# Confidence-based path — multilingual pod (>= v0.2)
# ---------------------------------------------------------------------------

def test_confidence_signal_supersedes_raw_p_when_present() -> None:
    """When the pod emits ``confidence``, the ensembler must use that
    instead of raw ``turn_detector_p``. Without this, multilingual
    deployments silently regress: e.g. German "complete" raw p ~0.09
    would never cross the 0.85 raw threshold even though confidence
    is ~15× (decisively complete).
    """
    # German complete sentence: raw p=0.09 (would fail old text_unlikely
    # check), confidence=15.0 (well above _TD_CONF_HIGH=5.0 → text_confident).
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.09, turn_detector_confidence=15.0,
    )
    assert rule == "text_confident"
    assert required == 500  # min_endpointing_delay_ms

    commit, rule = should_commit_turn(
        silence_ms=600, smart_turn_p=0.3,
        turn_detector_p=0.09, turn_detector_confidence=15.0,
    )
    assert commit
    assert rule == "text_confident"


def test_confidence_unlikely_holds_long() -> None:
    """Confidence < 1.0 → model says NOT done → wait max_endpointing."""
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.0001, turn_detector_confidence=0.05,
    )
    assert rule == "text_unlikely"
    assert required == 6_000


def test_confidence_borderline_scales() -> None:
    """Confidence between 1.0 and 5.0 → linear scaling, somewhere
    between min and max delay."""
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.4, turn_detector_confidence=3.0,
    )
    assert rule == "text_scaled"
    assert 500 < required < 6000


def test_old_pod_no_confidence_falls_back_to_raw_p() -> None:
    """When ``turn_detector_confidence`` is 0 (old EN-only pod image
    that doesn't emit the field), we must fall back to the raw-p
    rules so existing deployments keep behaving as they did before
    the multilingual switch."""
    # turn_detector_confidence defaults to 0.0 — should use raw-p path.
    required, rule = compute_required_silence_ms(
        turn_detector_p=0.9, smart_turn_p=0.3,
    )
    assert rule == "text_confident"
    assert required == 500


def test_prosody_only_mode_when_text_unavailable() -> None:
    commit, rule = should_commit_turn(
        silence_ms=1000,
        smart_turn_p=0.9,
        turn_detector_p=0.0,
        text_eou_available=False,
    )
    assert commit
    assert rule == "prosody_only_confident"


def test_running_transcript_concatenates_segments() -> None:
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


def test_running_transcript_skips_empty_segments() -> None:
    from voicechat_stream import _SignalState

    state = _SignalState()
    state.finals_accumulated = ["", "hello", "", "world"]
    state.partial_text = ""
    assert state.running_transcript() == "hello world"


@pytest.mark.asyncio
async def test_pod_final_does_not_end_turn() -> None:
    """Regression: pod auto-finals must not end the streaming turn."""
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

    from voicechat_stream import StreamingTurnSession

    async def _send_json(_msg: dict) -> None:
        return None

    sess = StreamingTurnSession(
        client_ws=None,
        language="en",
        history=[],
        receive_binary=stub_recv,
        send_json=_send_json,
    )
    fake_ws = FakeWs()
    sess._stt_ws = fake_ws  # type: ignore[assignment]

    pump_task = asyncio.create_task(sess._pump_stt())
    try:
        fake_ws.feed(FakeMsg("partial", {"text": "hello"}))
        fake_ws.feed(FakeMsg("final", {"text": "hello world."}))
        fake_ws.feed(FakeMsg("partial", {"text": "and goodbye"}))
        fake_ws.feed(FakeMsg("final", {"text": "and goodbye too."}))
        await asyncio.sleep(0.1)

        assert sess._state.finals_accumulated == ["hello world.", "and goodbye too."]
        assert not pump_task.done()
    finally:
        pump_task.cancel()
        try:
            await pump_task
        except asyncio.CancelledError:
            pass
