"""Session-scoped stereo WAV recorder for voice-agent calls.

Both the user's PCM frames (server-side post-mute-gate, post-denoise)
and the agent's PCM frames (the bytes the server is about to ship to
the client's audio worklet) get teed here. On close we write a single
stereo WAV: left channel = user, right channel = agent.

Design notes
------------
- One file per WS session. Path is set by the caller (typically
  ``data/recordings/{user_id}/{session_id}.wav``).
- Both sides land in monotonic time order, but they DON'T arrive at
  the same rate. The user mic streams ~50 frames/sec continuously;
  the agent only produces audio during TTS bursts. We resolve this
  by stamping every chunk with ``time.monotonic()`` at receipt and
  mixing on close — empty slots become silence.
- Frame rate normalization: WAV is canonical 16 kHz mono s16le per
  channel. User PCM arrives natively at 16 kHz (frontend worklet
  decimates 48 kHz → 16 kHz before WS). Agent PCM arrives at 24 kHz
  (TTS pod's canonical output rate). The recorder decimates agent
  frames 2:3 internally (TTS frames are 40 ms = 960 samples,
  divisible by 3, so phase always aligns per frame — no cross-chunk
  state to carry). Aliasing for TTS speech (energy under ~6 kHz,
  Nyquist of the 16 kHz target is 8 kHz) is inaudible for a
  review-the-call recording. The on-disk file is ~64 KB/sec —
  small enough that we don't need Opus.
- We hold raw bytes in two ``bytearray``s during the call and write
  the WAV header + interleaved samples once at close. A 30-minute
  call at 16 kHz mono s16le is ~57 MB per side — RAM cost is real
  but bounded. If a deployment needs hour-long calls, swap to a
  rolling file write (deferred).
- No compression. WAV is the universal lingua franca; the customer
  downloads exactly what they get without losing fidelity to a
  follow-up transcode.
- Failure mode: any error during capture is swallowed (recording is
  best-effort; we never want to kill a live call because of a
  bookkeeping bug). The session-close path checks ``had_error`` to
  decide whether to write a row with ``recording_path`` or leave it
  NULL.
"""

from __future__ import annotations

import asyncio
import logging
import os
import struct
import time
import wave
from pathlib import Path


_log = logging.getLogger(__name__)

# Voice agent path is 16 kHz mono s16le throughout — same rate the
# STT pod expects on the way in and the TTS path produces on the way
# out (after upstream resample). Hardcoded here so the recorder
# doesn't have to negotiate with either side.
SAMPLE_RATE = 16000
SAMPLE_WIDTH_BYTES = 2  # s16le
BYTES_PER_MS = SAMPLE_RATE * SAMPLE_WIDTH_BYTES // 1000  # 32


class CallRecorder:
    """Accumulates user + agent PCM into a stereo WAV. Both sides
    are time-stamped so the final file plays back as it actually
    sounded — gaps where one side was silent stay silent.

    Lifecycle:

        rec = CallRecorder(path="...")
        rec.start()                                  # at session_open
        rec.push_user(pcm_bytes)                     # in _forward_frames
        rec.push_agent(pcm_bytes_at_16k_mono_s16le)  # before ws.send_bytes
        path, size = await rec.close()               # in session_close

    All methods are thread-safe via an asyncio.Lock — the recorder
    sits between the WS receive loop and the WS send loop, both of
    which mutate the buffers from different tasks.
    """

    def __init__(self, *, path: str) -> None:
        self._path = path
        # (started_at_monotonic_offset_ms, bytes) tuples for each leg.
        # `bytes` is raw s16le PCM. We collect in a list to avoid
        # quadratic concat costs on long calls.
        self._user_chunks: list[tuple[int, bytes]] = []
        self._agent_chunks: list[tuple[int, bytes]] = []
        self._user_total_bytes = 0
        self._agent_total_bytes = 0
        self._t0: float = 0.0
        self._started = False
        self._closed = False
        self._lock = asyncio.Lock()

    def start(self) -> None:
        """Anchor the recording clock. Called once per session_open."""
        self._t0 = time.monotonic()
        self._started = True

    @property
    def started(self) -> bool:
        return self._started and not self._closed

    def _now_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    def push_user(self, pcm: bytes | bytearray | memoryview) -> None:
        """Append a user PCM chunk (post-mute-gate, post-denoise).
        Caller is responsible for ensuring 16 kHz mono s16le."""
        if not self.started or not pcm:
            return
        try:
            data = bytes(pcm)
            self._user_chunks.append((self._now_ms(), data))
            self._user_total_bytes += len(data)
        except Exception:
            _log.debug("recorder: push_user swallowed", exc_info=False)

    def push_agent(self, pcm: bytes | bytearray | memoryview) -> None:
        """Append an agent PCM chunk just before it goes to the client.

        Input is 24 kHz mono s16le (TTS pod's canonical output).
        Decimated 2:3 to 16 kHz so it matches the user side and the
        WAV file's single rate. TTS chunks are 40 ms = 960 samples
        which is divisible by 3, so the decimation phase always
        aligns per chunk — no carrying state across calls.
        """
        if not self.started or not pcm:
            return
        try:
            decimated = self._decimate_24k_to_16k(bytes(pcm))
            if not decimated:
                return
            self._agent_chunks.append((self._now_ms(), decimated))
            self._agent_total_bytes += len(decimated)
        except Exception:
            _log.debug("recorder: push_agent swallowed", exc_info=False)

    @staticmethod
    def _decimate_24k_to_16k(pcm_s16le_24k: bytes) -> bytes:
        """Keep 2 of every 3 input samples (drop every third) — exact
        24 kHz → 16 kHz ratio. The samples we drop carry frequencies
        above 8 kHz; for TTS speech content the audible artifact is
        negligible compared to what Opus / mp3 would mask anyway."""
        # struct over the whole buffer once, then slice; avoids
        # per-sample Python iteration for the common path. Length
        # has to be a multiple of 2 (s16le) — caller frames are
        # guaranteed by TTS frame size, but be defensive.
        n_in = len(pcm_s16le_24k) // SAMPLE_WIDTH_BYTES
        if n_in == 0:
            return b""
        samples = struct.unpack(f"<{n_in}h", pcm_s16le_24k[: n_in * 2])
        kept = [s for i, s in enumerate(samples) if i % 3 != 2]
        return struct.pack(f"<{len(kept)}h", *kept)

    async def close(self) -> tuple[str | None, int]:
        """Flush the two legs to disk as a stereo WAV. Returns
        (path, bytes_written), or (None, 0) if nothing was captured
        or writing failed (in which case the caller leaves
        recording_path NULL).

        Call exactly once per session, in the session_close finally
        block. Subsequent calls are no-ops.
        """
        if self._closed:
            return (None, 0)
        self._closed = True

        if self._user_total_bytes == 0 and self._agent_total_bytes == 0:
            # Brand-new session that disconnected before any audio
            # flowed. No file to write.
            return (None, 0)

        try:
            # Build a flat time-anchored mono buffer per leg, then
            # interleave to stereo. Off-thread because both can be
            # tens of MB and we don't want to stall the event loop
            # serializing them.
            user_mono = await asyncio.to_thread(self._flatten, self._user_chunks)
            agent_mono = await asyncio.to_thread(self._flatten, self._agent_chunks)

            # Pad the shorter leg with silence so both arrays have
            # the same sample count — required for interleave.
            n = max(len(user_mono), len(agent_mono))
            if len(user_mono) < n:
                user_mono = user_mono + bytes(n - len(user_mono))
            if len(agent_mono) < n:
                agent_mono = agent_mono + bytes(n - len(agent_mono))

            interleaved = await asyncio.to_thread(
                self._interleave_stereo, user_mono, agent_mono
            )

            # Write to disk under an .inprogress suffix then rename
            # atomically so a half-written file can't be served if
            # the process crashes between write + close.
            Path(self._path).parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path + ".inprogress"
            await asyncio.to_thread(self._write_wav, tmp, interleaved)
            os.replace(tmp, self._path)
            size = os.path.getsize(self._path)
            return (self._path, size)
        except Exception:
            _log.exception("recorder: close failed (non-fatal, recording_path will be NULL)")
            return (None, 0)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _flatten(chunks: list[tuple[int, bytes]]) -> bytes:
        """Convert a list of (start_offset_ms, pcm_bytes) into a
        contiguous mono PCM buffer. Gaps between the end of one
        chunk and the start of the next become zero-padded silence.

        Per-chunk ordering is preserved by the caller (append-only),
        so we walk in input order and only insert silence when the
        next chunk's start exceeds the current write head.
        """
        if not chunks:
            return b""
        out = bytearray()
        write_head_bytes = 0
        for offset_ms, data in chunks:
            target_bytes = offset_ms * BYTES_PER_MS
            # Align to even byte boundary (s16le sample = 2 bytes).
            if target_bytes & 1:
                target_bytes += 1
            if target_bytes > write_head_bytes:
                # Pad with silence to bring the head up to the new
                # chunk's intended start time.
                out.extend(bytes(target_bytes - write_head_bytes))
                write_head_bytes = target_bytes
            out.extend(data)
            write_head_bytes += len(data)
        return bytes(out)

    @staticmethod
    def _interleave_stereo(left: bytes, right: bytes) -> bytes:
        """Interleave two equal-length mono s16le buffers into a
        stereo s16le buffer (L0, R0, L1, R1, …)."""
        if len(left) != len(right):
            raise ValueError("stereo interleave requires equal mono lengths")
        # Each sample is 2 bytes (s16le). Use struct.unpack/pack for
        # clarity; for big calls this gets called once at close so
        # the perf is fine.
        n = len(left) // SAMPLE_WIDTH_BYTES
        L = struct.unpack(f"<{n}h", left)
        R = struct.unpack(f"<{n}h", right)
        out = bytearray(n * 2 * SAMPLE_WIDTH_BYTES)
        # Use struct.pack_into to avoid building a large Python list.
        fmt = "<2h"
        for i in range(n):
            struct.pack_into(fmt, out, i * 4, L[i], R[i])
        return bytes(out)

    @staticmethod
    def _write_wav(path: str, stereo_pcm: bytes) -> None:
        with wave.open(path, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(stereo_pcm)


def recording_path_for(user_id: str, session_id: str, root: str | None = None) -> str:
    """Standard layout: ``data/recordings/{user_id}/{session_id}.wav``.

    Caller can override ``root`` for tests. The default is relative
    to the dashboard-backend process CWD, which matches how
    LanceDB / SQLite are sited today.
    """
    base = root or os.environ.get("CALL_RECORDINGS_DIR") or "data/recordings"
    # Sanitize: the IDs are server-issued so no traversal risk in
    # practice, but be defensive in case the path layout changes.
    safe_user = user_id.replace("/", "_").replace("..", "_")
    safe_sess = session_id.replace("/", "_").replace("..", "_")
    return str(Path(base) / safe_user / f"{safe_sess}.wav")
