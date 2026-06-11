"""Client for the ``vocence/ultravad`` pod.

UltraVAD is an 8B audio-only end-of-turn model. The dashboard
forwards real-time PCM frames during a voice turn and reads back a
streaming ``p_end_of_turn`` probability; when that probability
crosses a threshold (default 0.4), the ensembler in
``voicechat_stream`` commits the turn.

Contract: see ``ULTRAVAD_POD_SPEC.md`` at repo root. This module
talks to ``WS /v1/ultravad``, sends ``{type:'start',...}``, streams
PCM frames in, reads ``{type:'probability', p_end_of_turn:...}``
events out, and keeps a 20 s keepalive ping running so the pod's
idle-close timer doesn't trip on mid-turn silence.

Failure semantics:
    Best-effort signal. On connect timeout / unhealthy pod / WS
    error, ``start()`` returns False — caller treats the signal as
    unavailable and degrades to the fusion ensembler (Smart Turn +
    LiveKit) instead. We never raise into the voice turn.

API surface intentionally mirrors :class:`SmartTurnStream` so the
swap in ``voicechat_stream._open_upstreams`` is one line:
    self._smart  = SmartTurnStream(...)
    self._ultra  = UltraVADStream(...)
Both expose ``start() / send_pcm() / reset() / close()`` plus a
``last_p_end_of_turn`` attribute read every ensembler tick.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


# Connection timeouts. UltraVAD inference is ~50-80 ms p95 per the
# spec; if the connect handshake takes more than 500 ms the pod is
# either overloaded or unhealthy and we'd rather degrade than block
# the voice turn.
_CONNECT_TIMEOUT_SEC = float(os.environ.get("ULTRAVAD_CLIENT_CONNECT_TIMEOUT_SEC") or "0.5")
_SOCK_READ_TIMEOUT_SEC = float(os.environ.get("ULTRAVAD_CLIENT_SOCK_READ_TIMEOUT_SEC") or "5.0")


def is_configured() -> bool:
    """True when at least one ultravad pod is registered + online.

    Same shape as :func:`turn_detection_client.is_configured` so the
    voicechat router can guard both paths with parallel checks."""
    try:
        from ops import pool as ops_pool
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return False
    svc = snap.get("ultravad") or {}
    return any(p.get("status") == "online" for p in svc.get("pods", []))


async def _pick_pod() -> tuple[str, str] | None:
    """Pick a healthy ultravad pod from the dispatcher registry.

    Returns ``(ws_base_url, api_key)`` or ``None`` when no online pod
    is available — caller must handle ``None`` gracefully and fall
    back to the fusion ensembler."""
    from ops import pool as ops_pool
    try:
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return None
    svc = snap.get("ultravad")
    if not svc:
        return None
    for p in svc.get("pods", []):
        if p.get("status") == "online":
            key = p.get("api_key") or ""
            return f"ws://{p['host']}:{p['port']}", key
    return None


class UltraVADStream:
    """Async-context manager over one UltraVAD WS session.

    Lifecycle per voice turn:
        async with UltraVADStream() as uv:
            if await uv.start():
                async for frame in audio_frames:
                    await uv.send_pcm(frame)
                    p = uv.last_p_end_of_turn        # read every tick
                    if p > 0.4: break
                await uv.reset()                      # clear for next turn

    Background tasks:
      * ``_reader_loop`` drains ``probability`` events from the pod
        and keeps ``last_p_end_of_turn`` fresh
      * ``_keepalive_loop`` sends ``ping`` every 20 s so the pod's
        idle-close timer (60 s in the spec) doesn't trip mid-turn
        when the mic-mute gate is dropping all frames
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

    async def __aenter__(self) -> "UltraVADStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(self) -> bool:
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
                f"{base}/v1/ultravad",
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
            self._keepalive_task = asyncio.create_task(self._keepalive_loop())
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("ultravad connect failed: %s", exc)
            await self.close()
            return False

    async def send_pcm(self, pcm16_bytes: bytes) -> None:
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_bytes(pcm16_bytes)
        except Exception as exc:  # noqa: BLE001
            _log.warning("ultravad send_pcm failed: %s", exc)
            await self.close()

    async def reset(self) -> None:
        """Clear the rolling audio window after a commit so the next
        turn's first second isn't biased by the previous utterance's
        tail. Matches the demo's ``up_audio.send({"type":"reset"})``
        after every turn_end."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json({"type": "reset"})
            self.last_p_end_of_turn = 0.0
        except Exception as exc:  # noqa: BLE001
            _log.warning("ultravad reset failed: %s", exc)

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
                elif t in ("probability", "end_of_turn"):
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                elif t == "pong":
                    pass
                elif t == "error":
                    _log.warning("ultravad pod error: %s", obj)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("ultravad reader errored: %s", exc)

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


__all__ = ["UltraVADStream", "is_configured"]
