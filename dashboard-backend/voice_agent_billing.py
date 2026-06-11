"""Per-minute billing for voice agents.

Runs as a background asyncio task alongside the WebSocket session.
Every ``INCREMENT_SEC`` seconds it deducts a proportional slice of
credits from the user's balance. When the balance can't cover the
next increment, it asks the WS to close and the session ends.

Design notes:
  - 6-second increments (industry standard — Vapi, Retell, Eleven).
  - 30-second minimum charge per session, mirroring Vapi: a 2-second
    "hello, never mind" hang-up still bills for 30 sec. Prevents the
    flap-attack where opening + closing 1000 calls/second costs ~$0.
  - Credit deduction uses atomic_deduct_credits (TOCTOU-safe).
  - One credit_transactions row per session — written at end. Per-
    increment rows would flood the table; the per-increment atomic
    balance update is the source of truth, the transactions log is a
    summary.
  - Only billed for sessions with an ``agent_id`` (user's custom
    voice agents). The Vocence Assistant on the website is free.
  - When the server crashes mid-session, the user gets billed up to
    the last successful increment but no transactions row is written.
    Operationally acceptable — the credit balance is correct, and the
    user's billing history will be slightly under-reported.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import suppress
from typing import Any, Awaitable, Callable

from local_db import (
    atomic_deduct_credits,
    get_connection,
    record_credit_transaction,
)

_log = logging.getLogger(__name__)


# ── Tunables (env-overrideable, sane defaults match Vapi/Retell) ──────
VOICE_AGENT_CREDITS_PER_MIN = int(os.environ.get("VOICE_AGENT_CREDITS_PER_MIN", "40"))
INCREMENT_SEC = int(os.environ.get("VOICE_AGENT_INCREMENT_SEC", "6"))
MIN_CHARGE_SEC = int(os.environ.get("VOICE_AGENT_MIN_CHARGE_SEC", "30"))
# Hard upper bound on a single session — protects against runaway calls
# that drain a user's wallet, and prevents wedged sessions from holding
# upstream pod slots forever. 30 min is in line with OpenAI Realtime
# (60 min) and Retell (1–2 h) but more conservative.
MAX_SESSION_SEC = int(os.environ.get("VOICE_AGENT_MAX_SESSION_SEC", str(30 * 60)))
# How long without ANY user turn (voice or text) before we close the
# session for idleness. Stops a user from accidentally leaving a tab
# open and burning credits while away.
IDLE_TIMEOUT_SEC = int(os.environ.get("VOICE_AGENT_IDLE_TIMEOUT_SEC", "60"))
# Hard cap for free-mode sessions (Logos / Vocence Assistant). When the
# user has had Logos chat for this many seconds, the billing loop fires
# REASON_FREE_TIME_UP and the WS handler interrupts whatever's happening
# to play a farewell + close. Push paid agents into Studio for longer
# sessions. Env-override per deployment; default 2 minutes per user spec.
LOGOS_FREE_MAX_SESSION_SEC = int(
    os.environ.get("LOGOS_FREE_MAX_SESSION_SEC", "120")
)


def credits_for_seconds(seconds: float) -> int:
    """Convert a duration to credit cost, rounded up to the increment.

    Floor at ``MIN_CHARGE_SEC``. Always returns >= 0 integer credits.
    """
    if seconds <= 0:
        return 0
    billed_sec = max(seconds, float(MIN_CHARGE_SEC))
    # Round up to the next increment so a 7-sec call bills 12 sec (2
    # increments), not 6. Matches Vapi billing.
    increments = (billed_sec + INCREMENT_SEC - 1) // INCREMENT_SEC
    increment_credits = (VOICE_AGENT_CREDITS_PER_MIN * INCREMENT_SEC) / 60.0
    return int(round(increments * increment_credits))


async def precheck_balance(user_id: str) -> tuple[bool, int]:
    """Verify the user can afford at least the minimum-charge session.

    Returns (ok, current_balance). Callers reject the WS connect with
    a 4402 close code if not ok.
    """
    needed = credits_for_seconds(MIN_CHARGE_SEC)
    conn = await get_connection()
    try:
        cur = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cur.fetchone()
        if not row:
            return False, 0
        balance = int(row["credits"] or 0)
        return balance >= needed, balance
    finally:
        await conn.close()


class VoiceAgentBilling:
    """Per-session billing state and incremental-deduction loop.

    Usage:
        billing = VoiceAgentBilling(
            user_id, session_id, agent_id,
            on_session_end=callback,   # await'd with a reason string
        )
        billing.start()                # spawns the increment loop
        ...                            # WS lives — call mark_activity()
                                       # on every user turn so idle-detection
                                       # doesn't fire mid-conversation.
        await billing.stop()           # final reconciliation + transaction row

    ``on_session_end`` is invoked when the loop decides the session
    must end early — passed one of:
      "exhausted"     — balance hit zero
      "max_duration"  — session crossed MAX_SESSION_SEC
      "idle_timeout"  — no user activity for IDLE_TIMEOUT_SEC
    The WS handler decides what to send and close with.
    """

    # Reason constants returned to ``on_session_end``.
    REASON_EXHAUSTED = "exhausted"
    REASON_MAX_DURATION = "max_duration"
    REASON_IDLE_TIMEOUT = "idle_timeout"
    # Free-mode (Logos) sessions hit a much shorter cap than paid agents.
    # Distinct reason so the WS handler can interrupt with a farewell
    # speech + a sign-in / create-agent CTA instead of the generic
    # "session ended" close used for paid max-duration.
    REASON_FREE_TIME_UP = "free_time_up"

    def __init__(
        self,
        *,
        user_id: str,
        session_id: str,
        agent_id: str,
        on_session_end: Callable[[str], Awaitable[None]] | None = None,
        # Back-compat: old call sites pass ``on_exhausted`` with no args.
        # We adapt it to the new ``on_session_end(reason)`` shape.
        on_exhausted: Callable[[], Awaitable[None]] | None = None,
        # Fired after EVERY successful deduction (per-minute tick AND
        # final stop() reconciliation) with the new account balance.
        # The voicechat router wires this to ws.send_json so the
        # frontend's sidebar credits counter can refresh live instead
        # of staying stale until the user reloads.
        on_deduct: Callable[[int], Awaitable[None]] | None = None,
        # ``free_mode``: run only the max-duration and idle watchdogs;
        # skip all credit deductions and the final transaction row.
        # Used for the free Vocence Assistant so its sessions still
        # hard-cap at 30 min and idle-close at 60 sec (protecting
        # upstream pod slots) without charging the user.
        free_mode: bool = False,
        # Tighter session cap that applies ONLY when free_mode=True.
        # Defaults to None (use the platform MAX_SESSION_SEC). The
        # voicechat router passes LOGOS_FREE_MAX_SESSION_SEC here for
        # Logos sessions so they end after the per-user-spec 2 minutes
        # via REASON_FREE_TIME_UP, distinct from the generic 30-min
        # MAX_DURATION cap that paid agents hit.
        free_max_sec: float | None = None,
    ) -> None:
        self.user_id = user_id
        self.session_id = session_id
        self.agent_id = agent_id
        self.free_mode = free_mode

        # Normalize the two callback shapes onto one internal handler.
        if on_session_end is not None:
            self._on_end = on_session_end
        elif on_exhausted is not None:
            async def _adapter(_reason: str) -> None:
                await on_exhausted()  # type: ignore[misc]
            self._on_end = _adapter
        else:
            self._on_end = None  # type: ignore[assignment]

        self._on_deduct = on_deduct
        self._free_max_sec = free_max_sec

        # Per-increment cost. Pre-computed once.
        self._increment_credits: int = max(
            1, int(round((VOICE_AGENT_CREDITS_PER_MIN * INCREMENT_SEC) / 60.0))
        )

        self._started_at: float = 0.0
        # Bumped each time an agent turn ENDS — that is, when the agent
        # stops talking. Idle is measured from this timestamp, NOT from
        # the user sending a turn, so the 60-second rule reads exactly
        # as "60 s after the agent stops talking" (see ``mark_turn_ended``).
        self._last_activity_at: float = 0.0
        # Number of agent turns currently in flight (LLM running / TTS
        # streaming). While > 0 the watchdog skips the idle check —
        # otherwise a turn that takes longer than IDLE_TIMEOUT_SEC would
        # self-terminate mid-speech.
        self._in_flight_turns: int = 0
        self._total_charged: int = 0
        self._task: asyncio.Task | None = None
        self._stopping = asyncio.Event()
        self._exhausted = False
        self._end_reason: str | None = None

    @property
    def total_charged(self) -> int:
        return self._total_charged

    @property
    def elapsed_seconds(self) -> int:
        if self._started_at == 0:
            return 0
        return int(time.monotonic() - self._started_at)

    def start(self) -> None:
        """Begin the increment loop. Idempotent — second call is a no-op."""
        if self._task is not None:
            return
        now = time.monotonic()
        self._started_at = now
        # Treat session start as activity so the idle watchdog doesn't
        # fire immediately if the user takes a moment to start speaking.
        self._last_activity_at = now
        self._task = asyncio.create_task(
            self._loop(), name=f"voice_agent_billing:{self.session_id}"
        )

    def mark_turn_started(self) -> None:
        """Note that an agent turn is now in flight (LLM + TTS streaming).

        While a turn is in flight, the idle watchdog SKIPS its idle check
        — long-running turns (tool calls, slow LLMs) used to self-
        terminate at the 60-second mark even though the agent was still
        mid-speech, because ``mark_activity`` only fires at turn-end.
        Decoupling "user activity" from "turn in flight" lets the idle
        rule be exactly what we want: 60 s after the agent STOPS
        talking, regardless of how long the previous turn took."""
        self._in_flight_turns += 1

    def mark_turn_ended(self) -> None:
        """Called when an agent turn finishes (TTS drained / cancelled /
        errored). Resets the idle clock AND decrements the in-flight
        counter — both transitions happen atomically so the watchdog
        sees a consistent state on its next tick."""
        self._in_flight_turns = max(0, self._in_flight_turns - 1)
        self._last_activity_at = time.monotonic()

    def mark_activity(self) -> None:
        """Call when ANY user turn arrives (voice or text). Resets the
        idle watchdog. Safe to call before start() — recorded but no-op."""
        self._last_activity_at = time.monotonic()

    @property
    def end_reason(self) -> str | None:
        """One of REASON_* once the session has been auto-terminated;
        None if it ended on a normal client/server disconnect."""
        return self._end_reason

    async def stop(self) -> int:
        """Stop the loop and return total credits charged.

        If the session ended before the minimum-charge floor, this also
        pulls the remainder so the user is correctly billed for the
        minimum even on instant hang-ups.
        """
        self._stopping.set()
        if self._task is not None:
            self._task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self._task
            self._task = None

        # Reconcile to the minimum-charge floor if applicable.
        # Free-mode sessions skip both reconciliation and the
        # transaction row — no money should change hands.
        elapsed = self.elapsed_seconds
        if self.free_mode:
            return 0
        owed_total = credits_for_seconds(elapsed)
        delta = owed_total - self._total_charged
        if delta > 0:
            conn = await get_connection()
            try:
                new_balance = await atomic_deduct_credits(
                    conn, user_id=self.user_id, cost=delta
                )
                # Commit before close — see comment in ``_deduct_once``.
                # Without this, the reconciliation UPDATE is rolled back
                # and the user's balance stays untouched even though the
                # transaction-log row records the deduction.
                await conn.commit()
                if new_balance is not None:
                    self._total_charged += delta
                    if self._on_deduct is not None:
                        with suppress(Exception):
                            await self._on_deduct(int(new_balance))
            finally:
                await conn.close()

        # Write a single summary transaction row.
        if self._total_charged > 0:
            conn = await get_connection()
            try:
                # Refetch balance for the transaction log.
                cur = await conn.execute(
                    "SELECT credits FROM auth_users WHERE id = ?", (self.user_id,)
                )
                row = await cur.fetchone()
                balance_after = int(row["credits"] or 0) if row else 0
                await record_credit_transaction(
                    conn,
                    user_id=self.user_id,
                    transaction_type="voice_agent",
                    amount=-self._total_charged,
                    balance_after=balance_after,
                    description=f"Voice agent session ({elapsed}s)",
                    reference_type="voice_agent_session",
                    reference_id=self.session_id,
                )
                await conn.commit()
            except Exception:
                _log.exception("voice_agent_billing: failed to log transaction")
            finally:
                await conn.close()

        return self._total_charged

    async def _deduct_once(self, cost: int) -> int | None:
        """Atomic deduction. Returns new balance or None if exhausted.

        CRITICAL: aiosqlite connections use Python's default isolation
        level (deferred), so the UPDATE inside ``atomic_deduct_credits``
        runs in an implicit transaction that gets ROLLED BACK when the
        connection closes without an explicit commit. Skipping the
        commit here is exactly what caused the "voice agent doesn't
        deduct credits" bug — the transaction row still got written
        (separate connection, did commit) but ``auth_users.credits``
        never moved. Always commit before close.
        """
        conn = await get_connection()
        try:
            new_balance = await atomic_deduct_credits(
                conn, user_id=self.user_id, cost=cost
            )
            await conn.commit()
            return new_balance
        finally:
            await conn.close()

    async def _fire_end(self, reason: str) -> None:
        """Record the auto-end reason and invoke the WS-handler callback."""
        self._end_reason = reason
        if reason == self.REASON_EXHAUSTED:
            self._exhausted = True
        if self._on_end is not None:
            with suppress(Exception):
                await self._on_end(reason)

    async def _loop(self) -> None:
        """Increment loop — runs until stopped, balance exhausted, max
        session length reached, or user goes idle.

        Three watchdog checks fire every INCREMENT_SEC:
          1. Balance check — atomic deduct returns None → REASON_EXHAUSTED
          2. Max session check — elapsed >= MAX_SESSION_SEC → REASON_MAX_DURATION
          3. Idle check — last_activity older than IDLE_TIMEOUT_SEC → REASON_IDLE_TIMEOUT

        Cancellation-safe: a cancel during sleep stops cleanly without
        a partial deduction (deduct only runs after the full sleep).
        """
        while not self._stopping.is_set():
            try:
                await asyncio.sleep(INCREMENT_SEC)
            except asyncio.CancelledError:
                raise

            if self._stopping.is_set():
                return

            now = time.monotonic()

            # 0. Free-mode tighter cap (Logos). Checked BEFORE the generic
            #    max-duration so Logos always ends with REASON_FREE_TIME_UP
            #    (which fires the farewell-speech path) rather than the
            #    generic max_duration close. Idempotent — re-checking the
            #    same condition next tick is fine because _fire_end returns.
            if (
                self.free_mode
                and self._free_max_sec is not None
                and self._free_max_sec > 0
                and (now - self._started_at) >= self._free_max_sec
            ):
                await self._fire_end(self.REASON_FREE_TIME_UP)
                return

            # 1. Max session length — cheap check before we touch the DB.
            #    If we deduct then close, we'd over-bill by one increment
            #    when the session was already at the cap.
            if MAX_SESSION_SEC > 0 and (now - self._started_at) >= MAX_SESSION_SEC:
                await self._fire_end(self.REASON_MAX_DURATION)
                return

            # 2. Idle timeout — also before deduction. A user who walked
            #    away shouldn't be charged for one more increment past
            #    the threshold; we close on the increment AT the boundary.
            if (
                IDLE_TIMEOUT_SEC > 0
                and self._in_flight_turns == 0
                and (now - self._last_activity_at) >= IDLE_TIMEOUT_SEC
            ):
                await self._fire_end(self.REASON_IDLE_TIMEOUT)
                return

            # 3. Charge for the increment we're entering.
            if self.free_mode:
                # Free Assistant session: skip the deduct, just keep
                # ticking the watchdog. No REASON_EXHAUSTED path.
                continue

            # ``asyncio.shield`` keeps the deduction atomic with the
            # local counter update: if the task is cancelled between
            # the DB write and ``_total_charged +=``, shield lets the
            # cancellation be deferred until both complete. Prevents
            # the stop() reconciliation from over-billing by one
            # increment when the WS closes mid-deduct.
            new_balance = await asyncio.shield(
                self._deduct_once(self._increment_credits)
            )
            if new_balance is None:
                await self._fire_end(self.REASON_EXHAUSTED)
                return
            self._total_charged += self._increment_credits
            # Fire-and-suppress: a slow/dead WS callback must not stall
            # the billing loop. The next tick will re-fire with a fresh
            # balance anyway, so a dropped update is at worst one
            # increment of UI lag.
            if self._on_deduct is not None:
                with suppress(Exception):
                    await self._on_deduct(int(new_balance))

    @property
    def exhausted(self) -> bool:
        return self._exhausted

    def billing_update_payload(self, balance_remaining: int | None = None) -> dict[str, Any]:
        """Snapshot for the WS client. Send via ws.send_json after each
        increment to power a live counter in the UI."""
        return {
            "type": "billing_update",
            "session_seconds": self.elapsed_seconds,
            "credits_charged": self._total_charged,
            "credits_per_min": VOICE_AGENT_CREDITS_PER_MIN,
            "credits_remaining": balance_remaining,
        }
