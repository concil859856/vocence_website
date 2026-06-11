"""Client for the ``vocence/turn-detection`` pod.

Wraps both turn-detection endpoints behind small Python APIs:

  * ``SmartTurnStream`` — audio in, prosody probability ``p_audio`` out
    over a WebSocket. Used during a streaming voice turn: every PCM
    frame is forwarded both to the STT pod AND to a SmartTurnStream so
    the ensembler in voicechat_stream has the prosody signal.

  * ``TurnDetectorScorer`` — text in, semantic completeness out over
    HTTP. Re-scored every time the in-progress transcript changes via
    the pod's BATCH endpoint ``POST /v1/turn-detector/batch``.

Why batch (HTTP) instead of streaming (WS) for the text model?
    The streaming WS only emits a new probability on a ``>= 0.05``
    change. Incomplete fragments live in the tiny-p range (0.001-0.05)
    where every change is suppressed, so ``confidence`` would freeze
    at a stale HIGH value and incomplete fragments would falsely fire
    end-of-turn. Verified empirically: the live WS reported
    ``conf=7.07`` for the partial "I want to know about" while the
    batch endpoint correctly returned ``conf=0.09`` for the same text.
    Scoring via batch on every text change gives the EXACT, fresh
    confidence and adds only ~50 ms per call — well within the
    decision budget.

Ensembler (pure helpers, no I/O):

  * ``text_completeness(conf)``    — semantic confidence → 0..1 via
                                      log-sigmoid centred at CONF_MID.
  * ``completeness(p_audio, conf)`` — weighted blend of text + prosody.
  * ``required_silence_ms(c)``      — adaptive silence target from
                                      completeness, in [MIN, MAX] ms.
  * ``decide_commit(silence_ms, p_audio, conf_text)`` — full fusion;
                                      returns (commit?, reason, snapshot).

Activation:
    ``is_configured()`` returns True iff at least one ``turn_detection``
    pod is currently online in the ops registry. The voicechat code
    checks this before opening either client so we never block a turn
    on a pod that isn't deployed.

Failure semantics:
    Both clients are **best-effort** signals. If a stream errors or
    times out, the voicechat ensembler degrades gracefully (drops the
    prosody contribution or the text contribution), it never raises
    into the voice turn — we log + close.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
from dataclasses import dataclass
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Connection knobs
# ---------------------------------------------------------------------------

# Turn detection is on the hot voice-turn path, so we cap both connect
# and inactivity tightly. Anything over 1s means the pod is too slow to
# be useful; better to skip the signal than block the turn.
_CONNECT_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_CONNECT_TIMEOUT_SEC") or "0.5")
_SOCK_READ_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_SOCK_READ_TIMEOUT_SEC") or "5.0")
# HTTP batch text-scoring timeout — the pod runs SmolLM v2 on CPU; one
# call is typically ~30-80 ms. 800 ms gives plenty of headroom while
# keeping the worst case bounded.
_BATCH_TIMEOUT_SEC = float(os.environ.get("TD_BATCH_TIMEOUT_SEC") or "0.8")


# ---------------------------------------------------------------------------
# Fusion knobs — env-overrideable, defaults from the mic_proxy demo
# ---------------------------------------------------------------------------
#
# All knobs from the working stt-streaming demo. See
# ``examples/TURN_DETECTION.md`` in that repo for the derivation. The
# weighted-completeness + adaptive-silence model replaces the legacy
# OR-of-thresholds ensembler (which falsely cut users off mid-sentence
# because the audio model saturates near 1.0 at every pause).

# Weight of semantic completeness vs prosody in the fused score.
# Semantics dominates because Smart-Turn saturates at every pause; its
# value is mostly as a VETO (see AUDIO_CONTINUE below), not as a level.
W_TEXT = float(os.environ.get("W_TEXT", "0.85"))
W_AUDIO = float(os.environ.get("W_AUDIO", "0.15"))

# Confidence value that maps to completeness=0.5. The web demo's
# tuning of CONF_MID=6.0 prioritises accuracy over latency — the
# resulting wait windows feel sluggish (~1.6 s on confident endings)
# but the rate of mid-thought cut-offs is very low. We tried CONF_MID=3.0
# briefly to chase Vapi-tier latency; reverted to the demo's 6.0 after
# A/B testing showed it cut users off ("How are we doing?" → committed
# at 353 ms before the user had really finished). Tune via env var per
# deployment if a specific agent needs tighter feel.
CONF_MID = float(os.environ.get("CONF_MID", "6.0"))
TEXT_SLOPE = float(os.environ.get("TEXT_SLOPE", "1.6"))  # log-sigmoid steepness

# Adaptive silence window. Complete-looking turn → MIN; uncertain → MAX.
# MAX_DELAY is also the hard backstop — even at completeness=0 the turn
# ends after MAX_DELAY ms of silence so a hung detector can't freeze
# the bot.
#
# Reverted from MIN=300/MAX=2500 to the demo's MIN=500/MAX=4000 after
# A/B testing showed the shorter window felt twitchy — UltraVAD's
# uv_p=0.4 threshold combined with MIN_DELAY=300 fired commits while
# the user was still mid-sentence ("How are we doing?" → committed at
# 353 ms). The demo's 500/4000 is a known-good baseline that the user
# reported feeling natural in side-by-side comparisons. Tune via env
# vars per deployment if a specific agent needs tighter feel.
MIN_DELAY_MS = int(os.environ.get("MIN_DELAY_MS", "500"))
MAX_DELAY_MS = int(os.environ.get("MAX_DELAY_MS", "4000"))

# Prosody veto threshold. While the audio model strongly hears
# "still-speaking" intonation (p < AUDIO_CONTINUE), hold the turn open
# regardless of the text score — until the MAX_DELAY backstop. This is
# STT-independent insurance against garbled ASR making an incomplete
# clause look complete.
AUDIO_CONTINUE = float(os.environ.get("AUDIO_CONTINUE", "0.25"))


# ---------------------------------------------------------------------------
# Pod registry helpers
# ---------------------------------------------------------------------------

def is_configured() -> bool:
    """True when at least one turn-detection pod is registered + online.

    The per-pod API key is read from the encrypted ops registry at
    call time (see :func:`_pick_pod`) — no dashboard-side env var
    is required to enable the integration."""
    try:
        from ops import pool as ops_pool
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return False
    svc = snap.get("turn_detection") or {}
    return any(p.get("status") == "online" for p in svc.get("pods", []))


async def _pick_pod() -> tuple[str, str] | None:
    """Pick a healthy turn-detection pod.

    Returns ``(ws_base_url, api_key)`` — for the HTTP batch path the
    WS scheme is rewritten to HTTP by the caller. Returns ``None`` if
    no online pod is available."""
    from ops import pool as ops_pool
    try:
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return None
    svc = snap.get("turn_detection")
    if not svc:
        return None
    for p in svc.get("pods", []):
        if p.get("status") == "online":
            key = p.get("api_key") or ""
            return f"ws://{p['host']}:{p['port']}", key
    return None


def _ws_to_http(base: str) -> str:
    return base.replace("wss://", "https://").replace("ws://", "http://")


# ---------------------------------------------------------------------------
# Smart Turn (audio prosody) — WebSocket stream
# ---------------------------------------------------------------------------

class SmartTurnStream:
    """Async-context manager over a single Smart Turn WS session.

    Forwards PCM frames to the pod and exposes the latest
    ``last_p_end_of_turn`` (the prosody-derived probability) for the
    ensembler to read. The pod sends a ``probability`` event every
    ``emit_every_ms`` (default 150 ms) by sliding a ``window_ms`` of
    rolling audio under the model.

    Usage:

        async with SmartTurnStream() as st:
            if await st.start():
                async for frame in audio_frames:
                    await st.send_pcm(frame)
                    p_audio = st.last_p_end_of_turn
    """

    def __init__(self, *, sample_rate: int = 16000, window_ms: int = 4000,
                 emit_every_ms: int = 150) -> None:
        self.sample_rate = sample_rate
        self.window_ms = window_ms
        self.emit_every_ms = emit_every_ms
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader_task: asyncio.Task | None = None
        self._keepalive_task: asyncio.Task | None = None
        self.last_p_end_of_turn: float = 0.0
        self.last_event: dict[str, Any] | None = None
        self._ready = asyncio.Event()

    async def __aenter__(self) -> "SmartTurnStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(self) -> bool:
        """Connect, send the start frame, spawn the reader + keepalive.
        Returns False if no pod is available or the handshake fails."""
        picked = await _pick_pod()
        if picked is None:
            return False
        base, api_key = picked
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=_CONNECT_TIMEOUT_SEC,
            sock_read=_SOCK_READ_TIMEOUT_SEC,
        )
        try:
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._ws = await self._session.ws_connect(
                f"{base}/v1/smart-turn",
                headers={"X-API-Key": api_key} if api_key else {},
            )
            await self._ws.send_json({
                "type": "start",
                "sample_rate": self.sample_rate,
                "encoding": "pcm_s16le",
                "window_ms": self.window_ms,
                "emit_every_ms": self.emit_every_ms,
            })
            self._reader_task = asyncio.create_task(self._reader_loop())
            # The pod idle-closes after 60 s of no message. A normal
            # voice session keeps PCM flowing continuously, but a
            # mid-turn long silence (LLM thinking, user paused while
            # bot mute-gate is active) can stop frames long enough to
            # trigger the close. Ping every 20 s defensively.
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn connect failed: %s", exc)
            await self.close()
            return False

    async def send_pcm(self, pcm16_bytes: bytes) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_bytes(pcm16_bytes)
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn send_pcm failed: %s", exc)
            await self.close()

    async def reset(self) -> None:
        """Clear the rolling window — call when a new turn starts after
        a commit so the previous utterance doesn't bleed into the next."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json({"type": "reset"})
            self.last_p_end_of_turn = 0.0
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn reset failed: %s", exc)

    async def _keepalive_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(20)
                ws = self._ws
                if ws is None or ws.closed:
                    return
                try:
                    await ws.send_json({"type": "ping", "ts": 0})
                except Exception:  # noqa: BLE001
                    return
        except asyncio.CancelledError:
            raise

    async def _reader_loop(self) -> None:
        ws = self._ws
        assert ws is not None
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    obj = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "ready":
                    self._ready.set()
                elif t == "probability" or t == "end_of_turn":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                elif t == "error":
                    _log.warning("smart_turn pod error: %s", obj)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn reader errored: %s", exc)

    async def close(self) -> None:
        for task in (self._reader_task, self._keepalive_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):  # noqa: BLE001
                    pass
        self._reader_task = self._keepalive_task = None
        if self._ws is not None:
            try:
                if not self._ws.closed:
                    await self._ws.send_json({"type": "close"})
                    await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:  # noqa: BLE001
                pass
            self._session = None


# ---------------------------------------------------------------------------
# Turn Detector (text semantics) — HTTP batch scorer
# ---------------------------------------------------------------------------

@dataclass
class TextScore:
    """One scoring result from ``POST /v1/turn-detector/batch``."""
    p_end_of_turn: float
    confidence: float            # = p_end_of_turn / per-language threshold
    language_threshold: float    # diagnostic; ensembler uses ``confidence``


class TurnDetectorScorer:
    """HTTP batch client for the text-EOU model.

    Single ``aiohttp.ClientSession`` per voice turn, reused across all
    score calls. Stateless from the pod's perspective — every call is
    a fresh ``{history: [], in_progress: "..."}`` POST. We don't pass
    the conversation history because the demo proved the model scores
    accurately on the current turn's text alone, and keeping history
    out of the request lets us cache nothing and skip a serialisation
    step.

    Use ``score(text)`` for one-off calls. The ``score_loop()`` helper
    polls a getter every 80 ms and only POSTs when the text actually
    changes — that's how voicechat_stream consumes it.
    """

    def __init__(self) -> None:
        self._session: aiohttp.ClientSession | None = None
        self._http_base: str | None = None
        self._api_key: str = ""
        self.last_score: TextScore = TextScore(0.0, 0.0, 0.0)

    async def __aenter__(self) -> "TurnDetectorScorer":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(self) -> bool:
        picked = await _pick_pod()
        if picked is None:
            return False
        ws_base, api_key = picked
        self._http_base = _ws_to_http(ws_base)
        self._api_key = api_key
        try:
            self._session = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=_BATCH_TIMEOUT_SEC),
            )
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector_scorer init failed: %s", exc)
            return False

    async def score(self, text: str) -> TextScore | None:
        """POST ``text`` to the batch endpoint and return the score.

        Returns ``None`` on transport / pod errors (caller keeps the
        previous ``last_score`` unchanged in that case)."""
        if not text.strip() or self._session is None or self._http_base is None:
            return None
        headers = {"X-API-Key": self._api_key} if self._api_key else {}
        try:
            async with self._session.post(
                f"{self._http_base}/v1/turn-detector/batch",
                headers=headers,
                json={"history": [], "in_progress": text},
            ) as r:
                d = await r.json()
        except Exception as exc:  # noqa: BLE001
            _log.debug("turn_detector_scorer.score failed: %s", exc)
            return None
        score = TextScore(
            p_end_of_turn=float(d.get("p_end_of_turn", 0.0) or 0.0),
            confidence=float(d.get("confidence", 0.0) or 0.0),
            language_threshold=float(d.get("language_threshold", 0.0) or 0.0),
        )
        self.last_score = score
        return score

    async def close(self) -> None:
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:  # noqa: BLE001
                pass
            self._session = None


# ---------------------------------------------------------------------------
# Fusion — pure helpers
# ---------------------------------------------------------------------------

def _sigmoid(x: float) -> float:
    if x <= -60:
        return 0.0
    if x >= 60:
        return 1.0
    return 1.0 / (1.0 + math.exp(-x))


def text_completeness(confidence: float) -> float:
    """Map turn-detector ``confidence`` to a 0..1 semantic-completeness
    score via a log-sigmoid centred at CONF_MID.

    Examples (with default CONF_MID=6.0, TEXT_SLOPE=1.6):
      conf=0.09  ->  0.07   ("I want to know about")
      conf=1.0   ->  0.25   (model's bare threshold; barely complete)
      conf=6.0   ->  0.50
      conf=20    ->  0.68   (solid clause)
      conf=48    ->  0.79   ("thank you" — unmistakably done)
    """
    if confidence <= 0.0:
        return 0.0
    return _sigmoid((math.log(confidence) - math.log(CONF_MID)) / TEXT_SLOPE)


def completeness(*, p_audio: float, conf_text: float) -> float:
    """Weighted fusion of prosody + semantic completeness, clamped 0..1."""
    text_c = text_completeness(conf_text)
    c = W_TEXT * text_c + W_AUDIO * float(p_audio)
    return max(0.0, min(1.0, c))


def required_silence_ms(c: float) -> int:
    """Adaptive silence target. More complete → shorter wait.

      c=0   -> MAX_DELAY (hard backstop)
      c=1   -> MIN_DELAY (fast commit)
      c=0.5 -> midpoint
    """
    c = max(0.0, min(1.0, c))
    span = MAX_DELAY_MS - MIN_DELAY_MS
    return int(MAX_DELAY_MS - span * c)


@dataclass
class CommitDecision:
    """Snapshot returned by :func:`decide_commit`. ``rule`` mirrors the
    demo's ``reason`` label — useful in logs to see which signal drove
    the cut-off:

      ``"silence"`` — neither model was confident; the MAX_DELAY wait
                      elapsed (or just the adaptive target).
      ``"text"``    — semantics dominated the decision.
      ``"audio"``   — prosody dominated.
      ``"hold_veto"`` — silence target hit but prosody veto held the
                        turn open (caller continues; not a commit).
      ``""``        — silence target not reached.
    """
    should_commit: bool
    rule: str
    text_c: float
    audio_c: float
    combined: float
    required_ms: int


def decide_commit(
    *,
    silence_ms: int,
    p_audio: float,
    conf_text: float,
) -> CommitDecision:
    """Full fusion: decide whether to end the user's turn now.

    Mirrors ``decision_watch`` in the working stt-streaming demo:

      1. Combine text completeness (semantics) and ``p_audio`` (prosody)
         into a 0..1 ``combined`` score (semantics weighted higher).
      2. Map combined → adaptive ``required_ms`` silence target.
      3. Fire commit when ``silence_ms >= required_ms``, UNLESS:
         - prosody strongly hears still-speaking (``p_audio <
           AUDIO_CONTINUE``) AND we're not yet at the MAX_DELAY hard
           backstop → hold the turn open (``rule='hold_veto'``).
    """
    text_c = text_completeness(conf_text)
    audio_c = float(p_audio)
    combined = max(0.0, min(1.0, W_TEXT * text_c + W_AUDIO * audio_c))
    req_ms = required_silence_ms(combined)

    if silence_ms < req_ms:
        return CommitDecision(False, "", text_c, audio_c, combined, req_ms)

    # Prosody veto — STT-independent insurance.
    if audio_c < AUDIO_CONTINUE and silence_ms < MAX_DELAY_MS:
        return CommitDecision(False, "hold_veto", text_c, audio_c, combined, req_ms)

    if combined < 0.5:
        rule = "silence"
    elif W_TEXT * text_c >= W_AUDIO * audio_c:
        rule = "text"
    else:
        rule = "audio"
    return CommitDecision(True, rule, text_c, audio_c, combined, req_ms)


__all__ = [
    "is_configured",
    "SmartTurnStream",
    "TurnDetectorScorer",
    "TextScore",
    "text_completeness",
    "completeness",
    "required_silence_ms",
    "decide_commit",
    "CommitDecision",
    # Knobs exposed for tests / introspection
    "W_TEXT",
    "W_AUDIO",
    "CONF_MID",
    "TEXT_SLOPE",
    "MIN_DELAY_MS",
    "MAX_DELAY_MS",
    "AUDIO_CONTINUE",
]
