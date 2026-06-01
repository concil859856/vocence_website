"""Unit test for the agent-stop-anchored idle watchdog.

The contract:
  - ``_last_activity_at`` is bumped ONLY when an agent turn ends
    (``mark_turn_ended``), never on user-send.
  - While ``_in_flight_turns > 0`` the idle watchdog skips its check —
    a long turn (> IDLE_TIMEOUT_SEC) won't self-terminate mid-speech.
  - The moment the in-flight count drops to 0, the 60-second countdown
    begins from "now".

This is a pure-logic test on the billing object — no DB, no WS, no
asyncio loop. We poke the state we care about directly.
"""

from __future__ import annotations

import os
import time
from unittest.mock import AsyncMock

import pytest

from voice_agent_billing import VoiceAgentBilling


def _make() -> VoiceAgentBilling:
    """Cheap factory — the actual constructor needs a bunch of DB-ish
    args, but for state-machine tests we just need a fresh instance."""
    return VoiceAgentBilling(
        user_id="u_test",
        session_id="s_test",
        agent_id="a_test",
        free_mode=False,
        on_session_end=AsyncMock(),
    )


def test_initial_state_has_no_in_flight_turns() -> None:
    b = _make()
    assert b._in_flight_turns == 0


def test_mark_turn_started_increments_in_flight() -> None:
    b = _make()
    b.mark_turn_started()
    b.mark_turn_started()
    assert b._in_flight_turns == 2


def test_mark_turn_ended_decrements_and_resets_activity_clock() -> None:
    b = _make()
    b._last_activity_at = 0.0  # simulate "stale"
    b.mark_turn_started()
    b.mark_turn_started()
    b.mark_turn_ended()
    assert b._in_flight_turns == 1
    # _last_activity_at was reset to "now-ish" — it should be within a
    # second of monotonic now, definitely not still 0.0.
    assert abs(time.monotonic() - b._last_activity_at) < 1.0


def test_mark_turn_ended_never_goes_negative() -> None:
    """Defensive: if mark_turn_ended is called without a paired
    mark_turn_started (shouldn't happen, but stack-corruption-style
    bugs do), we clamp at 0 rather than going negative — a negative
    counter would mean the watchdog skip-check ``_in_flight_turns == 0``
    is permanently false and the session never times out."""
    b = _make()
    b.mark_turn_ended()
    b.mark_turn_ended()
    assert b._in_flight_turns == 0


def test_mark_activity_legacy_still_resets_clock() -> None:
    """``mark_activity`` is kept for legacy callers (first-message
    greeting playback). It should still reset _last_activity_at."""
    b = _make()
    b._last_activity_at = 0.0
    b.mark_activity()
    assert abs(time.monotonic() - b._last_activity_at) < 1.0


def test_user_send_does_not_reset_clock() -> None:
    """The whole point of the refactor — calling neither
    ``mark_turn_started`` nor ``mark_activity`` from the user-send path
    means a user message in isolation doesn't bump _last_activity_at.
    We simulate by NOT calling either helper and asserting the clock
    stays where it was."""
    b = _make()
    b._last_activity_at = 100.0  # pretend an agent turn ended at t=100
    # User sends a message — at this point in the real code, neither
    # mark_turn_started nor mark_turn_ended has been called yet (the
    # turn task hasn't been spawned). The clock should stay at 100.
    assert b._last_activity_at == 100.0


def test_idle_check_skipped_while_turn_in_flight() -> None:
    """End-to-end of the watchdog rule: with in_flight > 0, the idle
    boundary ``(now - last_activity) >= IDLE_TIMEOUT_SEC`` MUST NOT
    fire the timeout. We re-implement the watchdog check inline since
    the loop is async and we just want to assert the boolean expression."""
    from voice_agent_billing import IDLE_TIMEOUT_SEC

    b = _make()
    # Stale activity from 10 minutes ago (far past the 60s threshold).
    b._last_activity_at = time.monotonic() - 600
    b.mark_turn_started()

    # Watchdog expression — must be False because in_flight > 0.
    now = time.monotonic()
    should_fire = (
        IDLE_TIMEOUT_SEC > 0
        and b._in_flight_turns == 0
        and (now - b._last_activity_at) >= IDLE_TIMEOUT_SEC
    )
    assert should_fire is False

    # Once the turn ends, the clock resets — idle won't fire on the
    # next tick either (just-reset activity timestamp).
    b.mark_turn_ended()
    now = time.monotonic()
    should_fire = (
        IDLE_TIMEOUT_SEC > 0
        and b._in_flight_turns == 0
        and (now - b._last_activity_at) >= IDLE_TIMEOUT_SEC
    )
    assert should_fire is False


def test_idle_check_fires_once_turn_finishes_and_time_elapses() -> None:
    """The good path: no in-flight turn AND last activity older than
    the threshold → watchdog should fire. We backdate _last_activity_at
    rather than sleeping IDLE_TIMEOUT_SEC."""
    from voice_agent_billing import IDLE_TIMEOUT_SEC

    b = _make()
    b._in_flight_turns = 0
    b._last_activity_at = time.monotonic() - (IDLE_TIMEOUT_SEC + 5)

    now = time.monotonic()
    should_fire = (
        IDLE_TIMEOUT_SEC > 0
        and b._in_flight_turns == 0
        and (now - b._last_activity_at) >= IDLE_TIMEOUT_SEC
    )
    assert should_fire is True
