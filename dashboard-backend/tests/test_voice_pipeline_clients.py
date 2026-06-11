"""Integration tests for the new voice-pipeline pod clients.

Stands up REAL aiohttp WS servers in-process that implement the
``ULTRAVAD_POD_SPEC`` and ``DENOISER_STREAMING_POD_SPEC`` contracts,
then exercises ``ultravad_client.UltraVADStream`` and
``denoiser_client.DenoiserPipe`` against them. Locks the wire
protocol in before the real pods exist.

When the real pods come online, these tests still pass — the fakes
exist to verify that the clients send and parse exactly what the
spec says. Spec drift on either side breaks these tests loudly.

The ``ops.pool`` snapshot lookup is monkeypatched per-test to point
at the in-process server.
"""

from __future__ import annotations

import asyncio
import json

import aiohttp
import pytest
from aiohttp import web


# ---------------------------------------------------------------------------
# Fake UltraVAD pod
# ---------------------------------------------------------------------------


class _FakeUltraVAD:
    """Minimal in-process implementation of WS /v1/ultravad.

    Honours the start-frame, accepts binary PCM, emits a single
    ``probability`` event back after each binary frame (so tests can
    drive ``last_p_end_of_turn`` by sending specific frames). Also
    handles ``reset`` and ``ping`` to make sure the client wires
    those up correctly.
    """

    def __init__(self) -> None:
        self.app = web.Application()
        self.app.router.add_get("/healthz", self._healthz)
        self.app.router.add_get("/v1/ultravad", self._ws)
        self.received_starts: list[dict] = []
        self.received_resets = 0
        self.received_pings = 0
        self.received_pcm_bytes = 0
        # Next p_end_of_turn to emit — let tests stage values.
        self.next_p = 0.0
        self.api_key = "test-uv-key"

    async def _healthz(self, request: web.Request) -> web.Response:
        return web.json_response({
            "status": "ok",
            "service": "ultravad",
            "model": {"name": "ultravad-8b", "loaded": True, "license": "test"},
        })

    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        if request.headers.get("X-API-Key") != self.api_key:
            return web.Response(status=401)
        ws = web.WebSocketResponse(heartbeat=None)
        await ws.prepare(request)
        await ws.send_json({"type": "ready", "model": "ultravad-8b", "session_id": "test"})
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                obj = json.loads(msg.data)
                t = obj.get("type")
                if t == "start":
                    self.received_starts.append(obj)
                elif t == "reset":
                    self.received_resets += 1
                elif t == "ping":
                    self.received_pings += 1
                    await ws.send_json({"type": "pong"})
                elif t == "close":
                    await ws.close()
                    return ws
            elif msg.type == aiohttp.WSMsgType.BINARY:
                self.received_pcm_bytes += len(msg.data)
                # Emit a probability event so the client's
                # last_p_end_of_turn updates.
                await ws.send_json({
                    "type": "probability",
                    "p_end_of_turn": self.next_p,
                    "ts_ms": self.received_pcm_bytes // 32,  # rough samples→ms
                })
        return ws


# ---------------------------------------------------------------------------
# Fake denoiser-streaming pod
# ---------------------------------------------------------------------------


class _FakeDenoiser:
    """Minimal in-process implementation of WS /v1/stream.

    On each binary input frame, emits a binary OUTPUT frame whose
    bytes are the input bitwise-NOTed — a recognisable "denoised"
    sentinel that lets tests confirm output frames came from the pod
    and not a passthrough. Preserves frame order (one out per in).
    """

    def __init__(self) -> None:
        self.app = web.Application()
        self.app.router.add_get("/healthz", self._healthz)
        self.app.router.add_get("/v1/stream", self._ws)
        self.received_starts: list[dict] = []
        self.received_pcm_bytes = 0
        self.api_key = "test-dn-key"

    async def _healthz(self, request: web.Request) -> web.Response:
        return web.json_response({
            "status": "ok",
            "service": "denoiser_streaming",
            "model": {"name": "deepfilternet3", "loaded": True, "license": "MIT"},
        })

    async def _ws(self, request: web.Request) -> web.WebSocketResponse:
        if request.headers.get("X-API-Key") != self.api_key:
            return web.Response(status=401)
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        await ws.send_json({"type": "ready", "model": "deepfilternet3", "session_id": "test"})
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                obj = json.loads(msg.data)
                t = obj.get("type")
                if t == "start":
                    self.received_starts.append(obj)
                elif t == "close":
                    await ws.close()
                    return ws
            elif msg.type == aiohttp.WSMsgType.BINARY:
                self.received_pcm_bytes += len(msg.data)
                inverted = bytes((~b) & 0xFF for b in msg.data)
                await ws.send_bytes(inverted)
        return ws


# ---------------------------------------------------------------------------
# Pool snapshot patching
# ---------------------------------------------------------------------------


def _patch_pool(monkeypatch, service_name: str, host: str, port: int, api_key: str) -> None:
    """Stub ``ops.pool.snapshot`` so the client's ``_pick_pod`` returns
    our in-process test server's address."""
    import ops.pool as ops_pool
    snap = {
        service_name: {
            "pods": [{
                "host": host, "port": port,
                "api_key": api_key, "status": "online",
            }],
        },
    }
    monkeypatch.setattr(ops_pool, "snapshot", lambda: snap)


# ---------------------------------------------------------------------------
# UltraVAD client tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ultravad_start_handshake_sends_spec_fields(unused_tcp_port, monkeypatch):
    fake = _FakeUltraVAD()
    runner = web.AppRunner(fake.app)
    await runner.setup()
    port = unused_tcp_port
    site = web.TCPSite(runner, "127.0.0.1", port)
    await site.start()
    try:
        _patch_pool(monkeypatch, "ultravad", "127.0.0.1", port, fake.api_key)
        from ultravad_client import UltraVADStream
        async with UltraVADStream(window_ms=4000, sample_rate=16000) as uv:
            ok = await uv.start()
            assert ok is True
            # Give the server a tick to receive the start frame.
            await asyncio.sleep(0.05)
        # The handshake fields must match the spec exactly.
        assert len(fake.received_starts) == 1
        s = fake.received_starts[0]
        assert s["type"] == "start"
        assert s["sample_rate"] == 16000
        assert s["encoding"] == "pcm_s16le"
        assert s["window_ms"] == 4000
        assert s["emit_every_ms"] == 150
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_ultravad_probability_event_updates_last_p(unused_tcp_port, monkeypatch):
    fake = _FakeUltraVAD()
    runner = web.AppRunner(fake.app)
    await runner.setup()
    port = unused_tcp_port
    await web.TCPSite(runner, "127.0.0.1", port).start()
    try:
        _patch_pool(monkeypatch, "ultravad", "127.0.0.1", port, fake.api_key)
        from ultravad_client import UltraVADStream
        async with UltraVADStream() as uv:
            assert await uv.start()
            fake.next_p = 0.73
            await uv.send_pcm(b"\x00" * 640)
            # Reader is async — give it a chance to consume the probability frame.
            for _ in range(50):
                if uv.last_p_end_of_turn > 0:
                    break
                await asyncio.sleep(0.01)
            assert uv.last_p_end_of_turn == pytest.approx(0.73, abs=1e-3)
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_ultravad_reset_clears_last_p(unused_tcp_port, monkeypatch):
    fake = _FakeUltraVAD()
    runner = web.AppRunner(fake.app)
    await runner.setup()
    port = unused_tcp_port
    await web.TCPSite(runner, "127.0.0.1", port).start()
    try:
        _patch_pool(monkeypatch, "ultravad", "127.0.0.1", port, fake.api_key)
        from ultravad_client import UltraVADStream
        async with UltraVADStream() as uv:
            assert await uv.start()
            fake.next_p = 0.9
            await uv.send_pcm(b"\x00" * 640)
            for _ in range(50):
                if uv.last_p_end_of_turn > 0:
                    break
                await asyncio.sleep(0.01)
            assert uv.last_p_end_of_turn > 0.5
            await uv.reset()
            assert uv.last_p_end_of_turn == 0.0
            # Server got the reset
            await asyncio.sleep(0.05)
            assert fake.received_resets == 1
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_ultravad_no_pod_returns_false_on_start(monkeypatch):
    """When no online pod is registered, ``start()`` must return False
    without raising — the voicechat caller falls back to the fusion
    ensembler in that case."""
    import ops.pool as ops_pool
    monkeypatch.setattr(ops_pool, "snapshot", lambda: {})
    from ultravad_client import UltraVADStream
    async with UltraVADStream() as uv:
        ok = await uv.start()
        assert ok is False


# ---------------------------------------------------------------------------
# Denoiser client tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_denoiser_start_handshake_sends_spec_fields(unused_tcp_port, monkeypatch):
    fake = _FakeDenoiser()
    runner = web.AppRunner(fake.app)
    await runner.setup()
    port = unused_tcp_port
    await web.TCPSite(runner, "127.0.0.1", port).start()
    try:
        _patch_pool(monkeypatch, "denoiser_streaming", "127.0.0.1", port, fake.api_key)
        from denoiser_client import DenoiserPipe
        async with DenoiserPipe(block_ms=200) as d:
            ok = await d.start()
            assert ok is True
            await asyncio.sleep(0.05)
        assert len(fake.received_starts) == 1
        s = fake.received_starts[0]
        assert s["type"] == "start"
        assert s["sample_rate"] == 16000
        assert s["encoding"] == "pcm_s16le"
        assert s["block_ms"] == 200
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_denoiser_process_returns_output_frames(unused_tcp_port, monkeypatch):
    """One PCM input frame in → fake pod emits one transformed output
    frame → ``process()`` returns it from the queue."""
    fake = _FakeDenoiser()
    runner = web.AppRunner(fake.app)
    await runner.setup()
    port = unused_tcp_port
    await web.TCPSite(runner, "127.0.0.1", port).start()
    try:
        _patch_pool(monkeypatch, "denoiser_streaming", "127.0.0.1", port, fake.api_key)
        from denoiser_client import DenoiserPipe
        async with DenoiserPipe() as d:
            assert await d.start()
            input_frame = bytes([0x11, 0x22, 0x33, 0x44]) * 80  # 320 bytes
            # The reader may not have queued the output yet on the
            # first call — retry briefly so the test is robust to
            # asyncio scheduling jitter.
            collected: list[bytes] = []
            for _ in range(20):
                collected.extend(await d.process(input_frame if not collected else b""))
                if collected:
                    break
                await asyncio.sleep(0.01)
            assert len(collected) >= 1
            # Fake inverts bytes; verify the first output matches.
            expected = bytes((~b) & 0xFF for b in input_frame)
            assert collected[0] == expected
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_denoiser_no_pod_returns_false_on_start(monkeypatch):
    """When no denoiser pod is online, ``start()`` returns False and
    the caller forwards RAW frames instead of denoised ones."""
    import ops.pool as ops_pool
    monkeypatch.setattr(ops_pool, "snapshot", lambda: {})
    from denoiser_client import DenoiserPipe
    async with DenoiserPipe() as d:
        ok = await d.start()
        assert ok is False


@pytest.mark.asyncio
async def test_denoiser_rejects_invalid_block_ms():
    """Client-side guard: ``block_ms`` outside the spec's accepted set
    must raise at construction so the bad value never reaches the WS
    (the pod would close 1003 anyway, but local raise is cleaner)."""
    from denoiser_client import DenoiserPipe
    with pytest.raises(ValueError):
        DenoiserPipe(block_ms=123)
    # Accepted values shouldn't raise.
    for ok_block in (50, 100, 200, 320, 480):
        DenoiserPipe(block_ms=ok_block)
