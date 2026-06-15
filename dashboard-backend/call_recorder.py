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

        # Agent leg: complex because TTS streams FASTER than real-time
        # (the pod synthesises a 5-second sentence in ~0.7s and we push
        # all those frames immediately). Naively appending pushes to the
        # timeline produces a recording with audio the user never heard —
        # the barge-in-but-agent-keeps-talking-in-the-recording bug.
        #
        # Design (server-driven turn lifecycle, NOT per-chunk client
        # signals — the previous design tried to bracket each
        # client_audio_started/settled pair and got cut by mid-turn
        # queue-drains between sentences):
        #
        # Each agent turn opens a SINGLE buffer when push_agent first
        # fires. The buffer accumulates every chunk of every sentence
        # in that turn. The buffer commits to a segment in exactly two
        # ways:
        #
        #   * ``mark_agent_barge_in()``: user took the floor. Trim the
        #     buffer to ``(now - turn_start) × BYTES_PER_MS`` bytes —
        #     that's how much audio could possibly have reached the
        #     speakers given the wall-clock elapsed. Drop the rest
        #     (the over-produced TTS tail).
        #   * ``mark_agent_turn_complete()``: TTS finished AND the
        #     client signalled queue-drain. Keep everything; the user
        #     heard it all. Called once both flags are set, in either
        #     order — _tts_done from the router after the TTS pipeline
        #     ends, _client_settled from client_audio_settled.
        #
        # ``_client_settled`` is reset to False on EVERY push_agent —
        # so a stale settled signal from before the latest sentence
        # arrived can't trigger a premature commit.
        self._agent_buffer: bytearray = bytearray()
        self._agent_segments: list[tuple[int, bytes]] = []
        # Recorder offset (ms from session start) at which the current
        # turn's first push_agent fired. None when no turn is open.
        self._agent_turn_start_ms: int | None = None
        # Set when the router has signalled that no more push_agent
        # calls will arrive for this turn (TTS pipeline ended).
        self._agent_tts_done: bool = False
        # Set when the client has signalled queue-drain AFTER the
        # latest push of this turn. Reset on every push_agent so a
        # mid-turn settled doesn't survive into the post-TTS check.
        self._agent_client_settled: bool = False
        # ROUTER-OWNED gate. The router signals the start of every
        # agent reply (greeting + every LLM/TTS turn) via
        # ``notify_agent_turn_started``. Set False at session start;
        # ``mark_agent_barge_in`` flips it back to False so any
        # in-flight push_agent calls from the cancelled turn's TTS
        # task (which takes up to 1 s to actually die under its
        # cooperative-cancellation grace window) get DROPPED instead
        # of opening a phantom turn at the barge-in moment. Without
        # this guard the orphan pushes would either land in their
        # own phantom segment overlapping the user's interruption,
        # OR — worse — get merged into the buffer of the NEXT real
        # turn and the recording would have agent audio bleeding
        # across two turns at the same time offset. The user-visible
        # symptom: "in the recording, both agent and my interruption
        # are playing together".
        self._agent_turn_open: bool = False

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

    @property
    def agent_turn_open(self) -> bool:
        """Whether the recorder is currently accepting agent audio
        pushes. The router uses this to also short-circuit
        ``ws.send_bytes`` to the client: when a barge-in has closed
        the gate but cancellation hasn't yet landed inside the
        running TTS task, any chunks that would otherwise have
        slipped through to the client (and queued behind the
        already-flushed playback) are dropped server-side instead.
        """
        return self._agent_turn_open

    @property
    def agent_audio_dispatched(self) -> bool:
        """Whether at least one PCM chunk has been pushed for the
        currently-open turn. Used by the router's idle-watchdog wiring
        to distinguish "agent has audio still playing on the client"
        (need to wait for client_audio_settled) from "turn ended
        without any audio" (text-only with TTS off, or cancel before
        any chunk landed — in which case settled will never arrive
        and the watchdog must reset its idle clock from the
        pipeline-done callback).

        Decoupled from the mic-mute gate: the 6 s gate-safety release
        clears bot_speaking_evt for echo-prevention reasons even while
        the bot is still mid-playback, but this flag stays True until
        the turn actually completes (settled + tts_done) or a barge-in
        closes it.
        """
        return self._agent_turn_start_ms is not None

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

    def notify_agent_turn_started(self) -> None:
        """Router signals a new agent reply is about to begin (greeting
        or normal LLM/TTS turn). Opens the agent-turn gate so the next
        push_agent will buffer.

        Idempotent: if a turn is already open with no audio yet, this
        is a no-op. If the previous turn left orphan bytes in the
        buffer (defensive — shouldn't happen if the router calls
        ``mark_agent_barge_in`` / ``notify_agent_tts_done`` correctly),
        they are dropped here rather than bleeding into the new turn.
        """
        if not self.started:
            return
        if self._agent_buffer or self._agent_turn_start_ms is not None:
            # Defensive: should be empty already. Drop without
            # recording — these are leftover bytes from an
            # improperly-closed previous turn and we'd rather lose
            # a few frames than corrupt the timeline.
            self._reset_agent_turn_state()
        self._agent_turn_open = True

    def push_agent(self, pcm: bytes | bytearray | memoryview) -> None:
        """Append an agent PCM chunk just before it goes to the client.

        Input is 24 kHz mono s16le (TTS pod's canonical output).
        Decimated 2:3 to 16 kHz so it matches the user side and the
        WAV file's single rate.

        DROPS the frame if no turn is open. This is the key guard
        against the orphan-push race: after ``mark_agent_barge_in``
        the previous turn's TTS task can still emit one or two more
        chunks before its cancellation-grace window closes. Those
        chunks land here with the gate closed and we drop them on
        the floor — they never enter the buffer, never anchor a
        phantom turn, never bleed into the next real turn's
        recording. The first push within an OPEN turn anchors
        ``_agent_turn_start_ms`` to ``_now_ms()``.
        """
        if not self.started or not pcm:
            return
        if not self._agent_turn_open:
            return
        try:
            decimated = self._decimate_24k_to_16k(bytes(pcm))
            if not decimated:
                return
            if self._agent_turn_start_ms is None:
                self._agent_turn_start_ms = self._now_ms()
            # New audio means any earlier "client buffer drained" signal
            # is stale — the client will need to drain again after these
            # bytes finish playing.
            self._agent_client_settled = False
            self._agent_buffer.extend(decimated)
        except Exception:
            _log.debug("recorder: push_agent swallowed", exc_info=False)

    def mark_agent_barge_in(self) -> None:
        """User took the floor. Trim the open turn's buffer to the
        wall-clock elapsed since the turn started and commit it as a
        segment, then CLOSE the agent-turn gate so any straggling
        push_agent calls from the cancelled TTS task (which has up
        to 1 s grace to actually die) are dropped. The next real
        turn won't accept pushes until ``notify_agent_turn_started``
        re-opens the gate.

        Called from the voicechat router on receipt of ``cancel``.
        No-op (but still closes the gate) if there's no buffered
        audio yet.
        """
        if not self.started:
            return
        if self._agent_turn_start_ms is not None:
            elapsed_ms = self._now_ms() - self._agent_turn_start_ms
            if elapsed_ms < 0:
                elapsed_ms = 0
            max_played_bytes = elapsed_ms * BYTES_PER_MS
            if max_played_bytes & 1:
                max_played_bytes -= 1
            keep = min(max_played_bytes, len(self._agent_buffer))
            playable = bytes(self._agent_buffer[:keep])
            if playable:
                self._agent_segments.append(
                    (self._agent_turn_start_ms, playable)
                )
        self._reset_agent_turn_state()
        # Close the gate. Orphan pushes from the cancelled TTS
        # task's grace window land here with the gate False and
        # are dropped — that's the fix for "in the recording,
        # both agent and my interruption are playing together".
        self._agent_turn_open = False

    def notify_agent_tts_done(self) -> None:
        """Router signals the TTS pipeline has finished for this turn —
        no more push_agent calls coming. If the client has ALREADY
        settled (queue-drained), this completes the turn and commits
        the whole buffer (the user heard it all). Otherwise we wait
        for the settled signal.
        """
        if not self.started or self._agent_turn_start_ms is None:
            return
        self._agent_tts_done = True
        self._maybe_complete_agent_turn()

    def notify_agent_client_settled(self) -> None:
        """Client's audio queue drained. If TTS is also done pushing
        for this turn, the user has heard all of it — commit the whole
        buffer. Otherwise note the settled and wait for TTS to finish
        (a queue-drain mid-turn between sentences is normal and
        shouldn't truncate the recording).
        """
        if not self.started or self._agent_turn_start_ms is None:
            return
        self._agent_client_settled = True
        self._maybe_complete_agent_turn()

    def _maybe_complete_agent_turn(self) -> None:
        """Commit the whole turn buffer once BOTH conditions are met:
        TTS pushing has finished AND the client has reported queue-
        drained. Order doesn't matter; whichever arrives second runs
        the commit. Also closes the turn gate — a subsequent
        notify_agent_turn_started must reopen it before the next
        agent reply can push."""
        if not (self._agent_tts_done and self._agent_client_settled):
            return
        if self._agent_turn_start_ms is None:
            return
        if self._agent_buffer:
            self._agent_segments.append(
                (self._agent_turn_start_ms, bytes(self._agent_buffer))
            )
        self._reset_agent_turn_state()
        self._agent_turn_open = False

    def _reset_agent_turn_state(self) -> None:
        self._agent_buffer = bytearray()
        self._agent_turn_start_ms = None
        self._agent_tts_done = False
        self._agent_client_settled = False

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

        # Flush any pending agent turn BEFORE flipping _closed.
        # ``started`` reads ``_started and not _closed`` so the
        # commit helpers below bail once we flip. If the session
        # ended mid-turn (WS closed before client_audio_settled
        # arrived), the last utterance would otherwise be silently
        # dropped from the recording — commit the buffer as-is
        # since we have no signal that the user didn't hear it.
        if self._agent_turn_start_ms is not None and self._agent_buffer:
            self._agent_segments.append(
                (self._agent_turn_start_ms, bytes(self._agent_buffer))
            )
            self._reset_agent_turn_state()

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
