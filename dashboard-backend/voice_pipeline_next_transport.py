"""Bridge between FastAPI's WebSocket and the framework's AgentSession.

The framework's built-in WebSocket transport (``WebSocketTransportHandler``)
binds its own ``websockets`` server on a port — fine when the framework
owns the whole process, hostile when we're already inside a FastAPI WS
handler that's already accepted the upgrade.

This module ports the same pattern to wrap an *already-open* FastAPI
WebSocket. The framework's pipeline + Agent + AgentSession are
unchanged; only the transport layer is swapped.

Architecture:

    FastAPI WS recv ─► pipeline.on_audio_delta(bytes)     (mic → STT/VAD)
    pipeline.audio_track ─► add_sink ─► FastAPI WS send   (TTS → speaker)

The audio_track is a ``WebSocketAudioTrack`` (framework class, reused
verbatim) — same Tee implementation that handles fade-out + interrupt
correctly. Our ``send()`` method matches the
``websockets.WebSocketServerProtocol`` shape just enough that the
framework's own interrupt path can call it without modification.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import WebSocket
from videosdk.agents.transports.base import BaseTransportHandler  # type: ignore[import-not-found]
from videosdk.agents.transports.websocket_handler import (  # type: ignore[import-not-found]
    WebSocketAudioTrack,
)

logger = logging.getLogger(__name__)


class FastAPIWebSocketTransport(BaseTransportHandler):
    """Wraps a FastAPI WebSocket as a framework transport.

    Pre-conditions: the WS upgrade has already been accepted by the
    caller. We don't call ``ws.accept()`` — that's the caller's job
    (auth happens before we get the WS).
    """

    def __init__(
        self,
        *,
        loop: asyncio.AbstractEventLoop,
        pipeline: Any,
        ws: WebSocket,
        on_text_frame: Optional[Any] = None,
        on_cancel_frame: Optional[Any] = None,
    ) -> None:
        super().__init__(loop=loop, pipeline=pipeline)
        self._ws = ws
        # Callbacks injected by run_next_session. The transport speaks
        # the framework's audio API but the client protocol's control
        # frames (text input, cancel) belong to the session layer, so
        # we hand them up rather than handling them here.
        self._on_text_frame = on_text_frame
        self._on_cancel_frame = on_cancel_frame
        # Audio track the framework writes to during TTS playback.
        # Reusing ``WebSocketAudioTrack`` gives us the framework's
        # fade-out + interrupt handling for free; the only thing it
        # needs is a ``websocket_handler`` with ``active_connection``
        # that exposes a ``send()`` coroutine.
        self.audio_track = WebSocketAudioTrack(
            loop=loop,
            websocket_handler=self,
            pipeline=pipeline,
        )
        # The audio_track and its interrupt() use ``active_connection.send()``
        # at the websockets-server protocol level (single argument: bytes
        # or str). We expose ``self`` as the active_connection so its
        # send() call lands on our adapter below.
        self.active_connection: Optional["FastAPIWebSocketTransport"] = self

        # Read loop runs for the lifetime of the session.
        self._read_task: Optional[asyncio.Task[None]] = None
        self._closed = asyncio.Event()
        self._audio_sink_registered = False

    # ---- websockets.WebSocketServerProtocol-shaped send -----------------
    async def send(self, data: Any) -> None:
        """Compatibility shim: ``WebSocketAudioTrack`` and its
        ``interrupt()`` call ``self.active_connection.send(payload)``
        with either a bytes-like (audio) or str (JSON control)
        payload. FastAPI's WebSocket uses ``send_bytes`` / ``send_text``
        instead, so we route based on type."""
        try:
            if isinstance(data, (bytes, bytearray, memoryview)):
                await self._ws.send_bytes(bytes(data))
            else:
                # Strings / JSON-serialized control frames.
                await self._ws.send_text(str(data))
        except Exception as exc:  # noqa: BLE001
            logger.debug("FastAPIWebSocketTransport.send failed: %s", exc)

    # ---- BaseTransportHandler abstract overrides ------------------------
    async def connect(self) -> None:
        """Start the read loop. WS is already accepted by the caller."""
        if self._read_task is not None:
            return
        # Register our outbound sink on the pipeline's audio_track if
        # the pipeline owns one. Mirrors the upstream handler's
        # behavior (see WebSocketTransportHandler._handle_connection).
        sink = self._make_audio_sink()
        pl_track = getattr(self.pipeline, "audio_track", None) if self.pipeline else None
        if pl_track is not None and hasattr(pl_track, "add_sink"):
            pl_track.add_sink(sink)
            self._audio_sink_registered = True
        elif pl_track is not None and hasattr(pl_track, "sinks"):
            pl_track.sinks.append(sink)
            self._audio_sink_registered = True
        else:
            # Fall back to our own track's sinks list. The framework
            # links pipeline.audio_track = self.audio_track during
            # ``_set_loop_and_audio_track`` post-connect, so this
            # branch is the safety net for unusual lifecycles.
            self.audio_track.add_sink(sink)
            self._audio_sink_registered = True

        self._read_task = asyncio.create_task(
            self._read_loop(), name="fastapi_ws_transport_read"
        )

    async def disconnect(self) -> None:
        """Tear down the read loop. The WS itself is owned by the
        caller (the voicechat router) — DO NOT close it here, just
        signal we're done so the caller's finally block runs its
        own teardown order (billing, recorder, etc.)."""
        self._closed.set()
        if self._read_task is not None and not self._read_task.done():
            self._read_task.cancel()
            try:
                await self._read_task
            except (asyncio.CancelledError, Exception):
                pass
            self._read_task = None

    async def wait_for_participant(
        self, participant_id: Optional[str] = None
    ) -> str:
        """The WS upgrade IS the participant join — the caller has
        already authenticated before constructing us. Return the
        provided id (or a sentinel) immediately."""
        return participant_id or "user"

    async def publish_to_pubsub(self, pubsub_config: Any) -> None:
        """Not supported on this transport — pubsub is a feature of
        the framework's hosted video-meeting room, not a generic
        WS. Silently no-op so callers that always invoke it don't
        crash."""
        return None

    async def cleanup(self) -> None:
        """Release the audio sink registration + stop the read loop.
        Safe to call multiple times."""
        await self.disconnect()
        # Best-effort: remove our sink from the pipeline track so a
        # subsequent session in the same process doesn't accidentally
        # double-write to a stale closure.
        pl_track = getattr(self.pipeline, "audio_track", None) if self.pipeline else None
        if pl_track is not None and self._audio_sink_registered:
            sinks = getattr(pl_track, "sinks", None)
            if sinks is not None:
                # We don't have a handle on our exact sink callable
                # anymore (it was a local closure). Just clear out
                # anything still attached — the pipeline is going
                # away with us.
                with _suppress():
                    pl_track.sinks.clear()

    # ---- internals ------------------------------------------------------
    def _make_audio_sink(self):
        """Closure that writes one PCM frame back over the WS. Async
        because the upstream pipeline awaits sinks individually."""
        async def _sink(data: bytes) -> None:
            if self._closed.is_set():
                return
            try:
                await self._ws.send_bytes(data)
            except Exception as exc:  # noqa: BLE001
                logger.debug("audio sink send failed: %s", exc)
        return _sink

    async def _read_loop(self) -> None:
        """Drain inbound FastAPI WS messages, route to the pipeline.

        Binary frames are user audio → ``pipeline.on_audio_delta``.
        Text frames are framework-control JSON (currently ignored —
        the existing voicechat protocol uses text for its own control
        messages which the wrapping router handles before / after
        this transport runs).
        """
        # Per-session counters surface in the session-end log so a
        # missing-audio diagnosis takes one log read, not a
        # second-round repro: zero-audio + nonzero ctrl frames means
        # the FRONTEND didn't ship PCM (mic mute / VAD never fired /
        # ``stream_start`` was never sent); nonzero audio + STT silent
        # means the pipeline is the suspect.
        bytes_frames = 0
        bytes_total = 0
        ctrl_frames: dict[str, int] = {}
        try:
            while not self._closed.is_set():
                try:
                    msg = await self._ws.receive()
                except Exception as exc:  # noqa: BLE001
                    logger.debug("ws.receive failed in transport: %s", exc)
                    break
                mtype = msg.get("type")
                if mtype == "websocket.disconnect":
                    break
                if mtype != "websocket.receive":
                    continue
                if msg.get("bytes") is not None:
                    frame = msg["bytes"]
                    if not frame or self.pipeline is None:
                        continue
                    bytes_frames += 1
                    bytes_total += len(frame)
                    if bytes_frames == 1:
                        logger.info(
                            "FastAPIWebSocketTransport: first PCM frame "
                            "received (%d bytes)", len(frame),
                        )
                    on_audio = getattr(self.pipeline, "on_audio_delta", None)
                    if on_audio is None:
                        continue
                    try:
                        await on_audio(frame)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("on_audio_delta raised: %s", exc)
                    continue
                # Text frames are client-protocol control messages. The
                # framework doesn't define a vocabulary here — the legacy
                # voicechat router defines it (text, cancel, voice,
                # stream_start, etc). Dispatch to the session-layer
                # callbacks for the ones we care about; ignore the rest
                # (stream_start/voice are STT-stream control, redundant
                # in the new path where the framework owns audio).
                text = msg.get("text")
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except (json.JSONDecodeError, TypeError):
                    continue
                mtype = (payload.get("type") or "").lower() if isinstance(payload, dict) else ""
                ctrl_frames[mtype] = ctrl_frames.get(mtype, 0) + 1
                if mtype == "text" and self._on_text_frame is not None:
                    body = (payload.get("text") or "").strip() if isinstance(payload, dict) else ""
                    if body:
                        try:
                            await self._on_text_frame(body)
                        except Exception as exc:  # noqa: BLE001
                            logger.warning("on_text_frame raised: %s", exc)
                elif mtype == "cancel" and self._on_cancel_frame is not None:
                    try:
                        await self._on_cancel_frame()
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("on_cancel_frame raised: %s", exc)
        except asyncio.CancelledError:
            pass
        finally:
            self._closed.set()
            logger.info(
                "FastAPIWebSocketTransport: read loop end "
                "pcm_frames=%d pcm_bytes=%d ctrl=%s",
                bytes_frames, bytes_total, dict(ctrl_frames),
            )


class _suppress:
    """Inline contextlib.suppress(Exception)."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        return exc_type is not None and issubclass(exc_type, Exception)
