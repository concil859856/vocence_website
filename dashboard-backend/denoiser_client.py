"""Client for the ``vocence/denoiser-streaming`` pod.

DeepFilterNet 3 noise removal as an inline PCM pipe:

    browser PCM  ──► DenoiserPipe.process(frame) ──► denoised PCM
                                                       │
                                                       └─► tee to STT + UltraVAD

Different API shape from the audio-EOU clients (SmartTurn / UltraVAD)
because this pod is a TRANSFORM, not an observer. Caller pushes input
frames and pulls output frames; ordering is preserved by the pod
(spec §6.1: "the dashboard correlates input and output by ORDER, not
by any frame header").

Contract: see ``DENOISER_STREAMING_POD_SPEC.md`` at repo root.

Failure semantics:
    Best-effort transform. If the pod is unhealthy / WS errors /
    times out, the caller should fall back to forwarding RAW frames
    (no denoise) instead of failing the voice turn. ``start()``
    returns False to signal "fall back to raw".

Usage pattern in ``voicechat_stream._forward_frames``:

    denoiser = DenoiserPipe()
    if not await denoiser.start():
        denoiser = None  # raw passthrough

    while frame := await client_recv():
        if denoiser is not None:
            out = await denoiser.process(frame)  # one in → list of denoised frames out
            for d in out:
                await stt.send(d)
                await ultravad.send_pcm(d)
        else:
            await stt.send(frame)
            await ultravad.send_pcm(frame)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


_CONNECT_TIMEOUT_SEC = float(os.environ.get("DENOISER_CLIENT_CONNECT_TIMEOUT_SEC") or "0.5")
_SOCK_READ_TIMEOUT_SEC = float(os.environ.get("DENOISER_CLIENT_SOCK_READ_TIMEOUT_SEC") or "5.0")


def is_configured() -> bool:
    """True when at least one denoiser-streaming pod is online."""
    try:
        from ops import pool as ops_pool
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return False
    svc = snap.get("denoiser_streaming") or {}
    return any(p.get("status") == "online" for p in svc.get("pods", []))


async def _pick_pod() -> tuple[str, str] | None:
    """Pick a healthy denoiser-streaming pod from the dispatcher
    registry. Returns ``(ws_base_url, api_key)`` or ``None``."""
    from ops import pool as ops_pool
    try:
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return None
    svc = snap.get("denoiser_streaming")
    if not svc:
        return None
    for p in svc.get("pods", []):
        if p.get("status") == "online":
            key = p.get("api_key") or ""
            return f"ws://{p['host']}:{p['port']}", key
    return None


class DenoiserPipe:
    """Async-context manager over one denoiser WS session.

    Single voice-turn lifecycle:
        async with DenoiserPipe(block_ms=200) as d:
            if await d.start():
                async for raw in frames:
                    for out in await d.process(raw):
                        forward(out)

    Block-size note: the pod processes in ~200 ms blocks by default
    (configurable per session via the start frame). One call to
    ``process()`` may produce zero, one, or more output frames
    depending on how much the input filled the block boundary.
    Callers MUST iterate the returned list — don't assume 1:1.
    """

    def __init__(self, *, sample_rate: int = 16000, block_ms: int = 200) -> None:
        if block_ms not in (50, 100, 200, 320, 480):
            # The pod rejects other values with close 1003; catch it
            # client-side so the error is local rather than a half-open
            # WS that costs us a connect roundtrip.
            raise ValueError(
                f"block_ms must be one of 50/100/200/320/480, got {block_ms}"
            )
        self.sample_rate = sample_rate
        self.block_ms = block_ms
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._out_queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=64)
        self._reader_task: asyncio.Task | None = None
        self._ready = asyncio.Event()
        self.bytes_in: int = 0
        self.bytes_out: int = 0

    async def __aenter__(self) -> "DenoiserPipe":
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
                f"{base}/v1/stream",
                headers={"X-API-Key": api_key} if api_key else {},
                max_msg_size=2 * 1024 * 1024,
            )
            await self._ws.send_json({
                "type": "start",
                "sample_rate": self.sample_rate,
                "encoding": "pcm_s16le",
                "block_ms": self.block_ms,
            })
            self._reader_task = asyncio.create_task(self._reader_loop())
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("denoiser connect failed: %s", exc)
            await self.close()
            return False

    async def process(self, pcm16_bytes: bytes) -> list[bytes]:
        """Send one input PCM chunk, return the denoised output chunks
        that became available because of it (0..N frames depending on
        whether the input filled a block boundary).

        Non-blocking on the pod side — the WS reader buffers output
        frames into a queue and ``process()`` drains whatever's
        ready. Caller should iterate the returned list and forward
        each frame to STT + UltraVAD in order.
        """
        ws = self._ws
        if ws is None or ws.closed:
            return []
        try:
            await ws.send_bytes(pcm16_bytes)
            self.bytes_in += len(pcm16_bytes)
        except Exception as exc:  # noqa: BLE001
            _log.warning("denoiser send_bytes failed: %s", exc)
            await self.close()
            return []
        # Drain whatever the reader has queued without blocking.
        out: list[bytes] = []
        while True:
            try:
                frame = self._out_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            if frame is None:
                # Sentinel from reader = pod closed mid-stream.
                break
            out.append(frame)
        return out

    async def _reader_loop(self) -> None:
        ws = self._ws
        assert ws is not None
        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.BINARY:
                    self.bytes_out += len(msg.data)
                    try:
                        self._out_queue.put_nowait(msg.data)
                    except asyncio.QueueFull:
                        # Caller fell behind; drop the OLDEST queued
                        # frame and enqueue the new one (denoise is a
                        # transform, dropping is worse for tail audio
                        # than for leading audio).
                        try:
                            self._out_queue.get_nowait()
                        except asyncio.QueueEmpty:
                            pass
                        try:
                            self._out_queue.put_nowait(msg.data)
                        except asyncio.QueueFull:
                            pass
                    continue
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    obj = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "ready":
                    self._ready.set()
                elif t == "error":
                    _log.warning("denoiser pod error: %s", obj)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("denoiser reader errored: %s", exc)
        finally:
            # Sentinel so any in-flight process() call drains cleanly.
            try:
                self._out_queue.put_nowait(None)
            except asyncio.QueueFull:
                pass

    async def close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._reader_task = None
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


__all__ = ["DenoiserPipe", "is_configured"]
