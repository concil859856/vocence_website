"""Unit tests for the EOU ensembler + streaming session helpers.

The ensembler is now the same one the working stt-streaming demo uses:
a text-weighted completeness score that sets an adaptive required-silence
in [MIN_DELAY_MS, MAX_DELAY_MS], with a prosody veto that holds the turn
open while smart-turn strongly hears still-speaking intonation.

See ``turn_detection_client.py`` for the math, knobs, and the bug-fix
history that drove the rewrite.
"""

from __future__ import annotations

import asyncio

import pytest

from turn_detection_client import (
    AUDIO_CONTINUE,
    CONF_MID,
    MAX_DELAY_MS,
    MIN_DELAY_MS,
    completeness,
    decide_commit,
    required_silence_ms,
    text_completeness,
)


# ---------------------------------------------------------------------------
# Pure-math helpers
# ---------------------------------------------------------------------------

def test_text_completeness_centered_at_conf_mid() -> None:
    """conf == CONF_MID must map exactly to 0.5 — that's how the sigmoid
    is centred. Knob tuning leans on this anchor."""
    assert text_completeness(CONF_MID) == pytest.approx(0.5, abs=1e-6)


def test_text_completeness_monotonic() -> None:
    """Higher confidence → higher completeness, monotonically. The
    sigmoid saturates SLOWLY (log-space) by design — conf=100 only
    reaches ~0.85, conf=10_000 reaches ~0.99. That's intentional: a
    barely-complete clause (conf=1) shouldn't be much above a very
    complete one (conf=20)."""
    values = [text_completeness(c) for c in (0.01, 0.1, 1.0, CONF_MID, 20.0, 1000.0)]
    assert all(a < b for a, b in zip(values, values[1:]))
    # Bounded in [0, 1].
    assert 0.0 <= values[0] < 0.1
    assert 0.9 < values[-1] <= 1.0


def test_text_completeness_zero_or_negative_is_zero() -> None:
    """Defensive: an empty / never-scored confidence is 0.0 and must
    not blow up the log inside the sigmoid."""
    assert text_completeness(0.0) == 0.0
    assert text_completeness(-1.0) == 0.0


def test_completeness_weights_text_heavier() -> None:
    """Same numeric value for both inputs should still lean text-heavy.

    Smart-Turn saturates near 1.0 at every pause, so weighting it
    equally would falsely fast-fire on every breath — semantics has to
    dominate at the decision point."""
    # At conf=CONF_MID (text_c=0.5), p_audio=0.5 → blended ~0.5.
    # Bump only one of them and see which moves the score more.
    base = completeness(p_audio=0.5, conf_text=CONF_MID)
    bump_text = completeness(p_audio=0.5, conf_text=CONF_MID * 4)   # text up
    bump_audio = completeness(p_audio=0.9, conf_text=CONF_MID)      # audio up
    assert (bump_text - base) > (bump_audio - base)


def test_required_silence_endpoints() -> None:
    """c=0 -> MAX_DELAY (hard backstop); c=1 -> MIN_DELAY (fast commit)."""
    assert required_silence_ms(0.0) == MAX_DELAY_MS
    assert required_silence_ms(1.0) == MIN_DELAY_MS
    # Midpoint is between the two.
    mid = required_silence_ms(0.5)
    assert MIN_DELAY_MS < mid < MAX_DELAY_MS


def test_required_silence_monotonic_decreasing() -> None:
    """More complete -> shorter wait."""
    samples = [required_silence_ms(c) for c in (0.0, 0.2, 0.5, 0.8, 1.0)]
    assert all(a >= b for a, b in zip(samples, samples[1:]))


# ---------------------------------------------------------------------------
# decide_commit — the full fusion
# ---------------------------------------------------------------------------

def test_below_required_silence_no_commit() -> None:
    """Even a confident-looking turn must wait at least the adaptive
    required-silence target."""
    d = decide_commit(silence_ms=100, p_audio=0.95, conf_text=50.0)
    assert d.should_commit is False
    assert d.rule == ""
    assert d.required_ms >= MIN_DELAY_MS


def test_clearly_complete_commits_well_under_max() -> None:
    """High conf + high p_audio → completeness ~0.8 → required ~1.2s
    (well below the 4s backstop, much faster than text_unlikely).

    Note: text_completeness asymptotes slowly by design, so even
    'unmistakably done' clauses (conf=48-50) land at text_c~0.79 and
    completeness~0.81 — required~1.2s. Demo doc §6.5 worked example."""
    d = decide_commit(silence_ms=2000, p_audio=0.95, conf_text=50.0)
    assert d.should_commit is True
    assert d.rule in ("text", "audio")
    # 1.2s is "clearly done — commit fast" relative to the 4s backstop.
    assert d.required_ms < 2000
    assert d.required_ms < MAX_DELAY_MS // 2


def test_low_completeness_holds_until_backstop() -> None:
    """Both signals weak → wait grows close to MAX_DELAY, then commits
    with rule='silence' (no model was confident; the wait elapsed)."""
    # Both inputs near zero → combined ~0 → required ~= MAX_DELAY.
    sil_short = required_silence_ms(0.0) - 200   # 200 ms below the cap
    d_short = decide_commit(silence_ms=sil_short, p_audio=0.0, conf_text=0.05)
    assert d_short.should_commit is False
    d_at_cap = decide_commit(silence_ms=MAX_DELAY_MS, p_audio=0.0, conf_text=0.05)
    assert d_at_cap.should_commit is True
    assert d_at_cap.rule == "silence"


def test_prosody_veto_holds_complete_text() -> None:
    """If smart-turn strongly hears still-speaking (p_audio <
    AUDIO_CONTINUE) the turn must hold even when the text looks done,
    until the MAX_DELAY backstop. STT-independent insurance against
    garbled ASR making an incomplete clause look complete.

    Veto only kicks in once silence has already reached the adaptive
    required-target — before that the rule is just '' (not yet)."""
    veto = AUDIO_CONTINUE / 2
    # Pick a silence value past the required-target. With conf=50 and
    # p_audio=veto (~0.12), required is ~1.5s; sit at 1.6s.
    sil = required_silence_ms(completeness(p_audio=veto, conf_text=50.0)) + 100
    d = decide_commit(silence_ms=sil, p_audio=veto, conf_text=50.0)
    assert d.should_commit is False
    assert d.rule == "hold_veto"


def test_prosody_veto_lifts_at_backstop() -> None:
    """Even with the veto active, MAX_DELAY is the hard backstop —
    a hung detector must never freeze the bot."""
    veto = AUDIO_CONTINUE / 2
    d = decide_commit(silence_ms=MAX_DELAY_MS, p_audio=veto, conf_text=50.0)
    assert d.should_commit is True
    # combined here will be high (text dominates, weighted ~0.85 * ~0.8)
    # so the rule will land on "text" — not on "silence".
    assert d.rule in ("text", "silence")


def test_no_signal_at_all_uses_max_delay() -> None:
    """Both models silent (TD pod offline, smart-turn offline) →
    completeness=0 → wait the full MAX_DELAY → commit reason 'silence'."""
    d = decide_commit(silence_ms=MAX_DELAY_MS + 100, p_audio=0.0, conf_text=0.0)
    assert d.should_commit is True
    assert d.rule == "silence"
    assert d.required_ms == MAX_DELAY_MS


# ---------------------------------------------------------------------------
# _SignalState — running_transcript + silence_ms
# ---------------------------------------------------------------------------

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


def test_silence_clock_starts_from_construction() -> None:
    """Without any speech evidence, the silence clock measures wall-clock
    since the state was constructed."""
    from voicechat_stream import _SignalState

    state = _SignalState()
    # Brand-new state: silence_ms should be near zero (test runs in <50 ms).
    assert state.silence_ms() < 100


# ---------------------------------------------------------------------------
# _pump_stt — pod auto-finals must not end the streaming turn
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_pod_final_does_not_end_turn() -> None:
    """Regression: the STT pod auto-emits ``final`` after its internal
    ~800 ms silence threshold. That's NOT turn-end — the ensembler
    decides. We must keep accumulating across pod finals so a long
    monologue with natural pauses doesn't end up as just the first
    segment."""
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
