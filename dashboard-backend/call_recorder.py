"""Session-scoped stereo WAV recorder for voice-agent calls.

Both the user's PCM frames (server-side post-mute-gate, post-denoise)
and the agent's PCM frames (the bytes the server is about to ship to
the client's audio worklet) get teed here. On close we write a single
stereo WAV: left channel = user, right channel = agent.

Storage
-------
- WAV bytes built in memory at session close, then uploaded to the
  active object store (Cloudflare R2 by default; Hippius S3 as the
  legacy fallback). Same client + same bucket as the rest of the
  audio artifacts (TTS outputs, voice clones, etc.).
- Key layout: ``{user_id}/call-recordings/{session_id}.wav`` —
  deterministic, server-issued, idempotent. The audio endpoint
  builds a presigned GET URL straight from the session_id.
- We hold raw PCM bytes in two ``bytearray``s during the call and
  upload once at close. A 30-minute call at 16 kHz mono s16le is
  ~57 MB per leg before stereo interleave — RAM cost is real but
  bounded. If a deployment needs hour-long calls, swap to a
  rolling multipart upload (deferred).

Frame rate
----------
- WAV is canonical 16 kHz mono s16le per channel. User PCM arrives
  natively at 16 kHz (frontend worklet decimates 48 kHz → 16 kHz
  before WS). Agent PCM arrives at 24 kHz (TTS pod's canonical
  output rate). The recorder decimates agent frames 2:3 internally
  (TTS frames are 40 ms = 960 samples, divisible by 3, so phase
  always aligns per frame — no cross-chunk state to carry).
  Aliasing for TTS speech is inaudible at the review level.

Failure mode
------------
Any error during capture is swallowed (recording is best-effort; we
never want to kill a live call because of a bookkeeping bug). The
session-close path checks the returned (bucket, key, size) tuple —
on (None, None, 0) we leave ``recording_path`` NULL on the call log
row and the UI just shows "No recording".
"""

from __future__ import annotations

import asyncio
import io
import logging
import struct
import time
import wave


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

        rec = CallRecorder(user_id="...", session_id="...")
        rec.start()                                  # at session_open
        rec.push_user(pcm_bytes)                     # in _forward_frames
        rec.push_agent(pcm_bytes_at_24k_mono_s16le)  # before ws.send_bytes
        bucket, key, size = await rec.close()        # in session_close

    All methods are safe to call from multiple tasks — push_* are
    list-appends only and close() is one-shot via the _closed flag.
    """

    def __init__(self, *, user_id: str, session_id: str) -> None:
        self._user_id = user_id
        self._session_id = session_id
        # User leg: (started_at_monotonic_offset_ms, bytes). User
        # PCM arrives at real-time speed from the mic, so the push
        # timestamps already line up with what the human ear heard.
        self._user_chunks: list[tuple[int, bytes]] = []
        self._user_total_bytes = 0

        # Agent leg: more complex because TTS streams FASTER than
        # real-time (the pod synthesises a 5-second sentence in
        # ~0.7s and we push all those frames immediately). Naively
        # appending those frames to the recorder timeline produces a
        # mix where the recording contains audio the user never
        # actually heard — exactly the user's barge-in-but-agent-
        # keeps-talking-in-the-recording bug.
        #
        # The fix is to buffer agent PCM as it's pushed but commit
        # to the timeline only as the CLIENT signals playback. The
        # client sends ``client_audio_started`` when its worklet
        # first hits the speakers and ``client_audio_settled`` (or
        # the server sees a ``cancel``) when playback ends. Between
        # those events we know real-time elapsed; we keep only
        # ``elapsed_ms × BYTES_PER_MS`` of the buffered agent PCM
        # and discard the tail (audio that was buffered server-side
        # but never reached the user).
        #
        # _agent_pending_buffer accumulates pushes for the CURRENT
        # turn until a stop signal arrives. _agent_segments are
        # (start_offset_ms, pcm_bytes) for windows that DID play;
        # they're flattened into the right leg of the stereo WAV
        # on close.
        self._agent_pending_buffer: bytearray = bytearray()
        self._agent_segments: list[tuple[int, bytes]] = []
        # Set on client_audio_started; cleared on settled / cancel.
        # When set, holds the recorder offset (ms from session
        # start) at which the user first heard audio for this turn.
        self._agent_playback_start_ms: int | None = None

        self._t0: float = 0.0
        self._started = False
        self._closed = False

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
        WAV file's single rate.

        The chunk goes into a PENDING buffer, not directly into the
        timeline. The buffer drains into a timeline segment when
        ``notify_agent_playback_stopped`` fires — at that point we
        know how much wall-clock the user actually heard and trim
        the buffer to that duration. Audio that was synthesized but
        never played (because the user barged in, the WS closed
        early, etc.) is dropped.
        """
        if not self.started or not pcm:
            return
        try:
            decimated = self._decimate_24k_to_16k(bytes(pcm))
            if not decimated:
                return
            self._agent_pending_buffer.extend(decimated)
        except Exception:
            _log.debug("recorder: push_agent swallowed", exc_info=False)

    def notify_agent_playback_started(self) -> None:
        """Mark the start of a CLIENT-side playback window. Anchors
        the agent timeline at the current recorder offset so the
        segment we eventually commit lines up with what the user
        heard. Idempotent — a flapping client_audio_started doesn't
        reset us mid-playback.

        Called from the voicechat router on receipt of
        ``client_audio_started`` from the client.
        """
        if not self.started or self._agent_playback_start_ms is not None:
            return
        self._agent_playback_start_ms = self._now_ms()

    def notify_agent_playback_stopped(self) -> None:
        """Close the current playback window. The buffered agent
        PCM is trimmed to ``(now - playback_start) × BYTES_PER_MS``
        bytes — the volume of audio that could have reached the
        speakers in the elapsed wall-clock. Anything beyond is
        dropped (= the TTS audio that was synthesised faster than
        real-time and buffered server-side but never played).

        Called from the voicechat router on receipt of either
        ``client_audio_settled`` (normal end-of-utterance) or
        ``cancel`` (user barge-in). Both produce the same correct
        behaviour: the recording only contains what the user heard.
        """
        if not self.started or self._agent_playback_start_ms is None:
            return
        elapsed_ms = self._now_ms() - self._agent_playback_start_ms
        if elapsed_ms < 0:
            elapsed_ms = 0
        max_played_bytes = elapsed_ms * BYTES_PER_MS
        # Even byte boundary for s16le.
        if max_played_bytes & 1:
            max_played_bytes -= 1

        # The pending buffer was cleared by the previous
        # notify_stopped (or starts at 0 for the first turn), so
        # index 0 is the first byte of the current turn's audio.
        # The client plays in order from there; we keep only the
        # prefix that fits in the elapsed wall-clock.
        playable = bytes(self._agent_pending_buffer[:max_played_bytes])
        if playable:
            self._agent_segments.append(
                (self._agent_playback_start_ms, playable)
            )

        self._agent_pending_buffer = bytearray()
        self._agent_playback_start_ms = None

    @staticmethod
    def _decimate_24k_to_16k(pcm_s16le_24k: bytes) -> bytes:
        """Keep 2 of every 3 input samples (drop every third) — exact
        24 kHz → 16 kHz ratio. The samples we drop carry frequencies
        above 8 kHz; for TTS speech content the audible artifact is
        negligible compared to what Opus / mp3 would mask anyway."""
        n_in = len(pcm_s16le_24k) // SAMPLE_WIDTH_BYTES
        if n_in == 0:
            return b""
        samples = struct.unpack(f"<{n_in}h", pcm_s16le_24k[: n_in * 2])
        kept = [s for i, s in enumerate(samples) if i % 3 != 2]
        return struct.pack(f"<{len(kept)}h", *kept)

    async def close(self) -> tuple[str | None, str | None, int]:
        """Build the stereo WAV in memory and upload to object
        storage. Returns ``(bucket, key, bytes_written)`` so the
        caller can persist all three on the voice_call_logs row.
        Returns ``(None, None, 0)`` if nothing was captured or
        the upload failed — caller treats it as "no recording".

        Call exactly once per session, in the session_close finally
        block. Subsequent calls are no-ops.
        """
        if self._closed:
            return (None, None, 0)

        # Flush any pending agent playback window BEFORE flipping
        # _closed. notify_agent_playback_stopped() bails when
        # ``started`` is False, and ``started`` reads
        # ``_started and not _closed`` — so we have to do the
        # flush while ``started`` is still True. Otherwise the
        # last utterance of a session that ended mid-playback
        # (WS closed before client_audio_settled arrived) would
        # be silently dropped from the recording.
        if self._agent_playback_start_ms is not None:
            self.notify_agent_playback_stopped()

        self._closed = True

        agent_total = sum(len(seg[1]) for seg in self._agent_segments)
        if self._user_total_bytes == 0 and agent_total == 0:
            # Brand-new session that disconnected before any audio
            # flowed. Nothing to upload.
            return (None, None, 0)

        try:
            # Build interleaved stereo PCM off-thread because both
            # legs can be tens of MB and we don't want to stall the
            # event loop while serializing them.
            user_mono = await asyncio.to_thread(self._flatten, self._user_chunks)
            agent_mono = await asyncio.to_thread(self._flatten, self._agent_segments)

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
            wav_bytes = await asyncio.to_thread(self._build_wav_bytes, interleaved)

            # Upload off-thread — MinIO's put_object is blocking, so
            # calling it directly in the event loop would stall every
            # other WS session on this worker until R2 accepts the
            # bytes. Local import keeps studio_tts_service out of the
            # cold-start path for deployments that don't use voice
            # agents at all.
            from studio_tts_service import upload_call_recording_wav
            bucket, key = await asyncio.to_thread(
                upload_call_recording_wav,
                self._user_id, self._session_id, wav_bytes,
            )
            return (bucket, key, len(wav_bytes))
        except Exception:
            _log.exception(
                "recorder: close failed (non-fatal, recording_path will be NULL) "
                "session=%s", self._session_id,
            )
            return (None, None, 0)

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
        n = len(left) // SAMPLE_WIDTH_BYTES
        L = struct.unpack(f"<{n}h", left)
        R = struct.unpack(f"<{n}h", right)
        out = bytearray(n * 2 * SAMPLE_WIDTH_BYTES)
        fmt = "<2h"
        for i in range(n):
            struct.pack_into(fmt, out, i * 4, L[i], R[i])
        return bytes(out)

    @staticmethod
    def _build_wav_bytes(stereo_pcm: bytes) -> bytes:
        """Wrap stereo PCM in a WAV header and return the full byte
        blob ready for upload."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(SAMPLE_WIDTH_BYTES)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(stereo_pcm)
        return buf.getvalue()


async def sweep_expired_recordings(retention_days: int) -> tuple[int, int]:
    """Delete recording objects older than ``retention_days`` and
    NULL their pointers on ``voice_call_logs``. Returns
    ``(objects_removed, rows_updated)``.

    Idempotent — safe to call any number of times. Per-row order:

        1. SELECT rows with non-NULL recording_path older than the
           cutoff.
        2. Per row: remove_object from the bucket (tolerating "not
           found" silently, since MinIO treats it as no-op).
        3. Per row that succeeded at step 2: UPDATE row to NULL
           recording_path + recording_bucket + recording_bytes.

    If step 2 errors (auth / network / bucket missing), the row is
    left alone — the next sweep retries. If we crash between step 2
    and step 3, the next sweep re-removes (no-op since the object is
    already gone) and then NULLs the columns. Net: never leaves a
    dangling pointer on the UI beyond one sweep cycle.
    """
    from local_db import get_connection
    from studio_tts_service import delete_call_recording_object

    if retention_days <= 0:
        return (0, 0)

    objects_removed = 0
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT session_id, recording_bucket, recording_path
            FROM voice_call_logs
            WHERE recording_path IS NOT NULL
              AND started_at < datetime('now', ?)
            """,
            (f"-{retention_days} days",),
        )).fetchall()

        # Run object deletes off-thread (MinIO is blocking) and
        # collect session_ids that succeeded so we can batch the
        # UPDATE. Iterating one-by-one in the executor would multiply
        # the latency on a big sweep — but a sweep big enough to
        # matter is unusual (hourly cadence), so keep the simple loop.
        cleared_session_ids: list[str] = []
        for r in rows:
            session_id = str(r[0])
            bucket = str(r[1] or "")
            key = str(r[2] or "")
            if not bucket or not key:
                # Row from before the R2 migration (filesystem path).
                # The local file is gone post-redeploy — clear the
                # pointer and move on so the UI stops trying to play it.
                cleared_session_ids.append(session_id)
                continue
            ok = await asyncio.to_thread(
                delete_call_recording_object, bucket, key
            )
            if ok:
                objects_removed += 1
                cleared_session_ids.append(session_id)
            else:
                _log.warning(
                    "recording sweep: remove_object failed for session=%s "
                    "bucket=%s key=%s (will retry next cycle)",
                    session_id, bucket, key,
                )

        if cleared_session_ids:
            placeholders = ",".join(["?"] * len(cleared_session_ids))
            await conn.execute(
                f"""
                UPDATE voice_call_logs
                SET recording_path = NULL,
                    recording_bucket = NULL,
                    recording_bytes = NULL
                WHERE session_id IN ({placeholders})
                """,
                cleared_session_ids,
            )
            await conn.commit()
    finally:
        await conn.close()
    return (objects_removed, len(cleared_session_ids))
