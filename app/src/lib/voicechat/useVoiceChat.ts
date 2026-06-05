/**
 * useVoiceChat, React hook that owns the WS state machine for the
 * Vocence in-Studio assistant bot.
 *
 * Two modes:
 *
 *   Push-to-talk (alwaysOn=false, legacy)
 *     idle  → user taps mic       → recording
 *     recording → user taps stop  → uploading → transcribing → thinking → speaking → idle
 *
 *   Always-on, VAD-driven (alwaysOn=true)
 *     idle → startListening()     → listening (mic hot, VAD running)
 *     listening → VAD speech-start → recording (also barge-in: cancels
 *                                    in-flight TTS + LLM turn)
 *     recording → VAD speech-end  → uploading → transcribing → thinking →
 *                                   speaking → listening (back to hot mic)
 *
 *   Both modes share the same WS protocol and same paced text reveal.
 *   Barge-in fires automatically in always-on mode whenever the user
 *   starts speaking during agent playback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StreamingAudioPlayer } from './audioPlayer';
import { MicRecorder } from './recorder';
import { VadController, arrayBufferToBase64 } from './vadController';

export type BotState = 'idle' | 'connecting' | 'listening' | 'recording' | 'uploading' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface ToolCallStatus {
  /** LLM-emitted call id, stable across started/completed events. */
  id: string;
  /** Tool name as the LLM saw it (e.g. ``web_search``, ``get_weather``,
   *  or a user-defined name like ``lookup_order``). */
  name: string;
  /** ``builtin`` or ``custom``, drives the chip icon/color so the user
   *  can tell at a glance whether the agent called a Vocence built-in
   *  or one of their own webhook tools. */
  kind: 'builtin' | 'custom';
  /** ``running`` while the dispatcher is executing, ``done`` once the
   *  result has come back, ``error`` when the dispatcher returned an
   *  ``{error: ...}`` payload. */
  status: 'running' | 'done' | 'error';
  /** Optional short preview of the result (first ~280 chars). */
  resultPreview?: string;
}

export interface BotMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  pending?: boolean;
  /** Tool calls the agent made during *this* assistant turn. Rendered
   *  as inline chips above the message text, "🔍 Searching the web…"
   *  while running, then the result preview when complete. */
  tool_calls?: ToolCallStatus[];
  /** Hint used by the chat UI to render system messages distinctly.
   *  e.g. ``'idle_timeout'`` → "Session ended, no activity" banner. */
  systemKind?: 'idle_timeout' | 'max_duration' | 'billing_exhausted' | 'info';
}

export interface UseVoiceChatOptions {
  enabled: boolean;        // open/close the WS
  authToken: string | null;
  /** When set, this WS talks to a user-created agent (Studio agents)
   * instead of the default Logos / Vocence Assistant. The backend uses
   * the agent's configured prompt, voice, knowledge, and RAG. */
  agentId?: string | null;
  /** Always-on VAD mode. The mic stays hot whenever `listening` is on;
   * the user just talks, and the hook auto-submits each speech segment.
   * Barge-in fires automatically when the user speaks over the agent. */
  alwaysOn?: boolean;
}

export interface UseVoiceChatResult {
  state: BotState;
  messages: BotMessage[];
  /** RMS-based mic level (push-to-talk mode) or VAD speech probability
   * (always-on mode), both 0..1, suitable for a level meter. */
  micLevel: number;
  error: string | null;
  /** Whether the mic is actively listening (always-on mode only). */
  listening: boolean;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  /** Always-on: open the mic and start VAD. No-op in push-to-talk mode. */
  startListening: () => Promise<void>;
  /** Always-on: close the mic and stop VAD. No-op in push-to-talk mode. */
  stopListening: () => void;
  sendText: (text: string) => Promise<void>;
  cancel: () => void;
  reset: () => void;
}

function buildWsUrl(token: string, agentId?: string | null): string {
  // ALWAYS use the page's own origin for the WS, even when
  // ``API_ORIGIN_BASE`` (= VITE_API_URL) points at a different backend
  // host. The dev Vite proxy forwards same-origin ``/api/*`` WebSocket
  // upgrades to the backend (vite.config.ts → ``ws: true``).
  //
  // Going direct cross-origin (page on :5173 → ws on :8095) trips
  // Chrome's cross-origin WebSocket handling and closes the
  // connection with code 1006 immediately after handshake. Same-origin
  // through the proxy avoids it entirely.
  const origin = `${window.location.protocol}//${window.location.host}`;
  const wsOrigin = origin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  const params = new URLSearchParams({ token });
  if (agentId) params.set('agent_id', agentId);
  return `${wsOrigin}/api/dashboard/voicechat/session?${params.toString()}`;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function useVoiceChat(opts: UseVoiceChatOptions): UseVoiceChatResult {
  const { enabled, authToken, agentId, alwaysOn = false } = opts;
  const [state, setState] = useState<BotState>('idle');
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const recorderRef = useRef<MicRecorder | null>(null);
  const vadRef = useRef<VadController | null>(null);
  // Set true while ``startListening`` is mid-flight (await on
  // ``new VadController()``/``vad.start()``). Without this, React 18
  // StrictMode's double-mount fires startListening twice concurrently
  //, the second call passes the ``vadRef.current`` guard (still null
  // because the first await hasn't resolved), so both calls construct
  // a MicVAD. Both mic streams stay open, both fire onFrameProcessed,
  // PCM is sent at 2× rate to the server, and the STT pod's input
  // becomes garbled. The console then shows ``2× started micVAD``.
  const vadStartingRef = useRef<boolean>(false);
  const currentBotMsgIdRef = useRef<string | null>(null);
  const audioStartedForTurnRef = useRef(false);
  // Lock window after the agent starts speaking. While this is set,
  // VAD onSpeechStart events are ignored, gives the browser echo
  // canceller a moment to settle so we don't mistake the agent's own
  // first syllable (leaking through speakers) for a user barge-in.
  const POST_SPEAK_LOCK_MS = 600;

  // Backchannel filter, short speech bursts during agent playback
  // (e.g. "uh-huh", "yeah", "mhm", "right") shouldn't cut the agent
  // off. When VAD detects speech-start *while the agent is speaking*,
  // we defer the barge-in by BACKCHANNEL_GRACE_MS. If speech ends
  // within that window with a total duration ≤ BACKCHANNEL_MAX_MS,
  // the burst is treated as a backchannel: no barge-in, no submission,
  // agent keeps talking. Longer bursts go through the normal barge-in
  // path. Outside agent playback, barge-in fires immediately as before.
  const BACKCHANNEL_GRACE_MS = 250;   // how long to wait before committing to a barge-in
  const BACKCHANNEL_MAX_MS = 400;     // total speech duration that counts as a backchannel
  const pendingBargeInRef = useRef<number | null>(null);   // setTimeout id
  const bargeInDeferredRef = useRef<boolean>(false);       // true while grace window is open
  const isAgentSpeakingRef = useRef<boolean>(false);       // mirrors ``state === 'speaking'``
  // Streaming-voice opt-in: set true when ready.capabilities.voice_stream
  // is reported by the server. While true, VAD runs in stream mode and
  // we push PCM frames over the WS instead of one-shot WAV uploads.
  const streamingVoiceEnabledRef = useRef<boolean>(false);
  const streamTurnOpenRef = useRef<boolean>(false);

  // Paced text reveal, text appears in the chat bubble at a natural
  // reading pace (~22 chars/sec) starting when audio begins playing,
  // rather than dumping the whole reply the moment the LLM finishes.
  // The full text is buffered behind the scenes; the timer copies it
  // into the visible message a slice at a time.
  const REVEAL_TICK_MS = 33;
  const REVEAL_CHARS_PER_SEC = 22;
  const revealStateRef = useRef<{
    msgId: string;
    full: string;        // all tokens received so far
    shown: number;       // chars currently visible in messages state
    ended: boolean;      // turn_end has arrived
  } | null>(null);
  const revealTimerRef = useRef<number | null>(null);

  const stopRevealTimer = useCallback(() => {
    if (revealTimerRef.current !== null) {
      window.clearInterval(revealTimerRef.current);
      revealTimerRef.current = null;
    }
  }, []);

  // Helper for the backchannel filter: cancel any in-flight grace timer.
  const clearBackchannelGrace = useCallback(() => {
    if (pendingBargeInRef.current !== null) {
      window.clearTimeout(pendingBargeInRef.current);
      pendingBargeInRef.current = null;
    }
    bargeInDeferredRef.current = false;
  }, []);

  // Mirror state into a ref so the VAD callbacks (which capture closures
  // at vad.start() time) can read "is the agent currently speaking?"
  // without going stale.
  useEffect(() => {
    isAgentSpeakingRef.current = state === 'speaking';
    // When the agent finishes a turn, clear any pending grace window —
    // there's nothing left to defer barge-in on.
    if (state !== 'speaking') clearBackchannelGrace();
  }, [state, clearBackchannelGrace]);

  const startRevealTimer = useCallback(() => {
    if (revealTimerRef.current !== null) return;
    const advancePerTick = Math.max(1, Math.round(REVEAL_CHARS_PER_SEC * REVEAL_TICK_MS / 1000));
    revealTimerRef.current = window.setInterval(() => {
      const s = revealStateRef.current;
      if (!s) {
        stopRevealTimer();
        return;
      }
      if (s.shown >= s.full.length) {
        // Caught up. If the turn ended, finalise and stop. Otherwise
        // keep the timer alive, more tokens may still be on the wire.
        if (s.ended) {
          const id = s.msgId;
          setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
          stopRevealTimer();
          revealStateRef.current = null;
        }
        return;
      }
      s.shown = Math.min(s.full.length, s.shown + advancePerTick);
      const visible = s.full.slice(0, s.shown);
      const id = s.msgId;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, text: visible } : m)));
    }, REVEAL_TICK_MS);
  }, [stopRevealTimer]);

  const ensurePlayer = useCallback(async () => {
    if (!playerRef.current) {
      // Audio-pipeline diagnostics, only emitted in dev so we don't
      // spam every paying customer's DevTools console (or get picked
      // up by user-installed console-forwarding extensions / RUM).
      const DEBUG_AUDIO = import.meta.env.DEV;
      const turnStart = performance.now();
      playerRef.current = new StreamingAudioPlayer({
        onIdle: () => {
          if (DEBUG_AUDIO) console.log(`[audio] idle  t=${Math.round(performance.now() - turnStart)}ms`);
        },
        onPlayingStart: () => {
          if (DEBUG_AUDIO) console.log(`[audio] playing  t=${Math.round(performance.now() - turnStart)}ms`);
          // The agent's audio just started hitting the speakers. Arm
          // the VAD lock so the agent's own first syllable bleeding
          // through speakers doesn't trip a false barge-in before the
          // echo canceller settles.
          vadRef.current?.lockSpeechStartFor(POST_SPEAK_LOCK_MS);
        },
        onRebuffering: (queuedMs) => {
          // Buffer ran out mid-reply, surfaces "broken/glitchy audio".
          if (DEBUG_AUDIO) console.warn(
            `[audio] REBUFFERING (underrun)  t=${Math.round(performance.now() - turnStart)}ms  queued=${queuedMs.toFixed(0)}ms`,
          );
        },
      });
      await playerRef.current.init();
    }
  }, []);

  const connect = useCallback(() => {
    if (!authToken) return;
    if (wsRef.current && wsRef.current.readyState <= 1) return;

    setState('connecting');
    const url = buildWsUrl(authToken, agentId);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    // StrictMode-safe identity guard: previous WS handlers must not
    // mutate shared refs once we've been replaced by a successor.
    const isLive = () => wsRef.current === ws;

    ws.onopen = () => {
      if (!isLive()) return;
      setState('idle');
      setError(null);
    };
    ws.onerror = () => {
      if (!isLive()) return;
      setError('connection error');
      setState('error');
    };
    ws.onclose = () => {
      if (isLive()) {
        wsRef.current = null;
        setState((prev) => (prev === 'error' ? 'error' : 'idle'));
      }
    };
    ws.onmessage = async (ev) => {
      if (!isLive()) return;
      if (typeof ev.data !== 'string') {
        // binary PCM frame
        await ensurePlayer();
        playerRef.current?.push(ev.data as ArrayBuffer);
        if (!audioStartedForTurnRef.current) {
          audioStartedForTurnRef.current = true;
          setState('speaking');
          // Audio is now flowing, start (or keep) the paced text reveal
          // so chat-bubble text is in step with what the user is hearing.
          if (revealStateRef.current) startRevealTimer();
        }
        return;
      }
      let payload: any;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (payload.type) {
        case 'ready':
          // Latch the streaming-voice capability for the rest of the
          // session. Older servers (no capabilities block) stay on the
          // one-shot WAV path.
          streamingVoiceEnabledRef.current = !!payload?.capabilities?.voice_stream;
          break;
        case 'transcript':
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'user' && last.pending) {
              next[next.length - 1] = { ...last, text: payload.text, pending: false };
            } else {
              next.push({ id: makeId(), role: 'user', text: payload.text, pending: false });
            }
            return next;
          });
          // The server's ensembler just committed this turn. The stream
          // session is closing on the server side; reset our local flag
          // so the NEXT user speech-start (or first PCM frame) opens a
          // fresh stream_start. Doing this here instead of on the local
          // VAD's onSpeechEnd is what lets a mid-sentence thinking pause
          // NOT chunk the turn — the ensembler keeps the session open
          // and we keep streaming until it actually commits.
          streamTurnOpenRef.current = false;
          setState('thinking');
          break;
        case 'partial_transcript': {
          // Live caption from the streaming-STT pod (when wired up).
          // We paint these into the user's current pending bubble so
          // the UI updates in step with what they're saying instead
          // of waiting for the full turn to commit.
          //
          // ``payload.text`` is the cumulative running transcript
          // (NOT a delta), replace, don't append. ``audio_ms_consumed``
          // is optional metadata for debugging.
          if (import.meta.env.DEV) {
            console.log('[voicechat] ← partial_transcript', payload.text);
          }
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === 'user' && last.pending) {
              next[next.length - 1] = { ...last, text: payload.text };
            } else {
              next.push({ id: makeId(), role: 'user', text: payload.text, pending: true });
            }
            return next;
          });
          break;
        }
        case 'tool_call_started': {
          // The agent decided to invoke a tool. Render a chip on the
          // current assistant bubble so the user knows why the LLM
          // hasn't replied yet ("Searching the web…" beats silence).
          // If no assistant bubble exists yet, create one now, the
          // LLM may emit tool_calls before any content tokens.
          const tc: ToolCallStatus = {
            id: String(payload.id || makeId()),
            name: String(payload.name || ''),
            kind: payload.kind === 'custom' ? 'custom' : 'builtin',
            status: 'running',
          };
          // SYNC: claim the ref BEFORE setMessages, the previous version
          // mutated the ref inside the state-updater callback, which only
          // runs at commit time. A token frame arriving in the same
          // microtask would still see ``currentBotMsgIdRef.current === null``
          // and either create a duplicate bubble or, after my earlier
          // patch, fail to bind the reveal buffer. Setting it here makes
          // the ordering deterministic.
          const existingMsgId = currentBotMsgIdRef.current;
          const msgId = existingMsgId || makeId();
          if (!existingMsgId) {
            currentBotMsgIdRef.current = msgId;
            // Bind the reveal buffer to this bubble proactively so any
            // content tokens that arrive after the tool result have a
            // home, without this, every post-tool-call token gets
            // dropped on the floor (audio plays, text doesn't show).
            revealStateRef.current = { msgId, full: '', shown: 0, ended: false };
          }
          setMessages((prev) => {
            if (!existingMsgId) {
              return [
                ...prev,
                { id: msgId, role: 'assistant', text: '', pending: true, tool_calls: [tc] },
              ];
            }
            return prev.map((m) =>
              m.id === msgId
                ? { ...m, tool_calls: [...(m.tool_calls || []), tc] }
                : m,
            );
          });
          break;
        }
        case 'tool_call_completed': {
          const idStr = String(payload.id || '');
          const preview = String(payload.result_preview || '');
          // Detect dispatcher error envelope ({"error": "..."}).
          let status: ToolCallStatus['status'] = 'done';
          try {
            const parsed = JSON.parse(preview);
            if (parsed && typeof parsed === 'object' && 'error' in parsed) status = 'error';
          } catch { /* not JSON, treat as text result */ }
          const targetMsgId = currentBotMsgIdRef.current;
          if (!targetMsgId) break;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === targetMsgId && m.tool_calls
                ? {
                    ...m,
                    tool_calls: m.tool_calls.map((t) =>
                      t.id === idStr ? { ...t, status, resultPreview: preview } : t,
                    ),
                  }
                : m,
            ),
          );
          break;
        }
        case 'token': {
          // Tokens go into the reveal buffer, NOT directly into the
          // visible message, the timer copies them out at reading
          // pace once audio starts. The visible message is created
          // empty so the typing-dots animation shows during the
          // pre-audio wait.
          const incoming = (payload.text || '') as string;
          if (!currentBotMsgIdRef.current) {
            const id = makeId();
            currentBotMsgIdRef.current = id;
            revealStateRef.current = { msgId: id, full: incoming, shown: 0, ended: false };
            setMessages((prev) => [...prev, { id, role: 'assistant', text: '', pending: true }]);
          } else if (revealStateRef.current) {
            revealStateRef.current.full += incoming;
          } else {
            // The assistant message already exists (e.g. tool_call_started
            // created it) but no tokens had arrived yet, so revealStateRef
            // was never initialised. Bind it to the existing bubble now —
            // otherwise every post-tool-call token falls on the floor and
            // the user hears audio with no on-screen text.
            revealStateRef.current = {
              msgId: currentBotMsgIdRef.current,
              full: incoming,
              shown: 0,
              ended: false,
            };
            // If audio is already playing for this turn, the binary-frame
            // handler won't trigger again, kick the reveal timer here so
            // the text actually appears.
            if (audioStartedForTurnRef.current) startRevealTimer();
          }
          // Functional updater so this handler doesn't depend on `state`
          // (reading it would cause `connect` to be recreated each render
          // and trigger a WS reconnect storm).
          setState((prev) => (prev === 'speaking' ? prev : 'thinking'));
          break;
        }
        case 'audio_meta':
          // server is about to send PCM frames for sentence N.
          // is_filler=true means "Hmm,", "Okay," etc., drop the
          // prebuffer to ~80 ms so the filler plays immediately and
          // actually masks LLM latency instead of sitting hidden inside
          // the cold-start cushion.
          if (payload.is_filler) {
            playerRef.current?.setPrebufferMs(80);
          }
          break;
        case 'audio_end':
          // sentence N done; further audio belongs to the next sentence
          break;
        case 'turn_end':
          // Mark the buffered reveal as terminated. The reveal timer
          // will catch up to ``full`` and then mark the message
          // non-pending. If audio never started (TTS off / failed),
          // also kick off the timer here as a fallback so the user
          // still sees the text.
          if (revealStateRef.current) {
            revealStateRef.current.ended = true;
            startRevealTimer();
          } else if (currentBotMsgIdRef.current) {
            const id = currentBotMsgIdRef.current;
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
          }
          currentBotMsgIdRef.current = null;
          // No more frames coming, let the player drain to silence
          // without entering the rebuffer state.
          playerRef.current?.signalEnd();
          // Always-on: go back to listening so the mic is still hot
          // for the user's next turn. Push-to-talk: go idle.
          {
            const restState: BotState = vadRef.current ? 'listening' : 'idle';
            setState((prev) => (prev === 'speaking' ? 'speaking' : restState));
            window.setTimeout(() => {
              audioStartedForTurnRef.current = false;
              setState((prev) => (prev === 'speaking' ? restState : prev));
            }, 250);
          }
          break;
        case 'cancelled':
          stopRevealTimer();
          if (revealStateRef.current) {
            // On cancel, drop whatever was buffered, the user is moving on.
            const id = revealStateRef.current.msgId;
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
            revealStateRef.current = null;
          } else if (currentBotMsgIdRef.current) {
            const id = currentBotMsgIdRef.current;
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
          }
          currentBotMsgIdRef.current = null;
          // Server dropped the stream session — clear our flag so the
          // next user turn opens a fresh stream_start.
          streamTurnOpenRef.current = false;
          playerRef.current?.flush();
          audioStartedForTurnRef.current = false;
          // Always-on cancel: usually a barge-in we just sent. Go back
          // to listening (or recording if VAD already flipped state).
          setState((prev) => {
            if (vadRef.current) {
              return prev === 'recording' ? 'recording' : 'listening';
            }
            return 'idle';
          });
          break;
        case 'session_timeout': {
          // Backend auto-closed the session, either the 30-min hard
          // cap (code: max_duration) or the 60-sec idle watchdog
          // (code: idle_timeout). Surface a system bubble so the
          // user knows WHY the session ended; without this they
          // see the WS just go dead.
          const subCode = String(payload.code || '');
          const messageText = String(payload.message || (
            subCode === 'idle_timeout'
              ? 'Session ended, no activity for 60 seconds. Start a new conversation to continue.'
              : subCode === 'max_duration'
                ? 'Session ended, reached the 30-minute maximum. Start a new conversation to continue.'
                : 'Session ended.'
          ));
          setMessages((prev) => [
            ...prev,
            {
              id: makeId(),
              role: 'system',
              text: messageText,
              systemKind: subCode === 'idle_timeout'
                ? 'idle_timeout'
                : subCode === 'max_duration' ? 'max_duration' : 'info',
            },
          ]);
          setState('idle');
          break;
        }
        case 'billing_exhausted': {
          // User ran out of credits mid-session. Same UX pattern:
          // visible system message + state back to idle.
          const messageText = String(payload.message || 'Session ended, credit balance reached zero. Top up to continue.');
          setMessages((prev) => [
            ...prev,
            { id: makeId(), role: 'system', text: messageText, systemKind: 'billing_exhausted' },
          ]);
          setState('idle');
          break;
        }
        case 'error':
          setError(payload.message || payload.code || 'error');
          setState('error');
          // Server-side error ends any in-flight stream session, so
          // reset the local flag — otherwise the next speech-start
          // would skip stream_start and the new turn would be lost.
          streamTurnOpenRef.current = false;
          // one-shot recoverable: drop to idle after surfacing the error
          window.setTimeout(() => setState((prev) => (prev === 'error' ? 'idle' : prev)), 1500);
          break;
        default:
          break;
      }
    };
  }, [authToken, agentId, ensurePlayer, startRevealTimer, stopRevealTimer]);

  // open/close WS in lockstep with `enabled`
  useEffect(() => {
    if (enabled && authToken) {
      connect();
    } else {
      try { wsRef.current?.close(); } catch { /* ignore */ }
      wsRef.current = null;
      recorderRef.current?.cancel();
      recorderRef.current = null;
      if (vadRef.current) {
        void vadRef.current.destroy();
        vadRef.current = null;
        setListening(false);
      }
      playerRef.current?.close();
      playerRef.current = null;
      setState('idle');
    }
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
      // React 18 StrictMode double-mounts effects in dev, without
      // tearing down VAD here, the orphan MicVAD from the first mount
      // keeps its mic stream open and its onFrameProcessed firing,
      // racing the second-mount VAD against the same wsRef and
      // streamTurnOpenRef. Net effect: 2× PCM frames shipped, garbled
      // audio at the STT pod, and ``2× started micVAD`` in the
      // console. Destroy here so the second mount starts clean.
      if (vadRef.current) {
        void vadRef.current.destroy();
        vadRef.current = null;
      }
      vadStartingRef.current = false;
    };
  }, [enabled, authToken, agentId, connect]);

  // Internal: barge-in. Cancels in-flight TTS + LLM turn so the user's
  // new speech can be handled without the agent talking over them.
  // Shared by manual mic taps and VAD-triggered speech-start.
  const bargeIn = useCallback(() => {
    playerRef.current?.flush();
    audioStartedForTurnRef.current = false;
    stopRevealTimer();
    if (revealStateRef.current) {
      const id = revealStateRef.current.msgId;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
      revealStateRef.current = null;
    }
    if (currentBotMsgIdRef.current) {
      try { wsRef.current?.send(JSON.stringify({ type: 'cancel' })); } catch { /* ignore */ }
      currentBotMsgIdRef.current = null;
    }
  }, [stopRevealTimer]);

  // Internal: submit a captured voice segment over the WS.
  const submitVoiceB64 = useCallback((audioB64: string, mime: string, durationMs: number) => {
    if (!wsRef.current || wsRef.current.readyState !== 1) return;
    setMessages((prev) => {
      // Push a placeholder so the user sees their pending turn even
      // before the transcript comes back.
      if (prev[prev.length - 1]?.role === 'user' && prev[prev.length - 1]?.pending) return prev;
      return [...prev, { id: makeId(), role: 'user', text: '', pending: true }];
    });
    setState('transcribing');
    try {
      wsRef.current.send(JSON.stringify({
        type: 'voice',
        audio_b64: audioB64,
        mime,
        duration_ms: durationMs,
      }));
    } catch (err) {
      setError((err as Error).message || 'send failed');
      setState('error');
    }
  }, []);

  const startListening = useCallback(async () => {
    if (!alwaysOn) return;
    if (vadRef.current) return;
    // StrictMode double-mount guard: the first call enters the async
    // setup (`new VadController()` / `await vad.start()`); a parallel
    // second call would pass the vadRef.current null-check above and
    // construct a second MicVAD. Mark startup-in-flight so the second
    // call bails fast.
    if (vadStartingRef.current) return;
    vadStartingRef.current = true;
    // Wait up to 5s for the WS to finish its handshake. Callers
    // (useAgentSession, the Studio home spotlight) fire startListening
    // off the same state transition that opens the WS, if we bail
    // synchronously on readyState !== OPEN we lose a race the server
    // had no chance to win. CONNECTING (0) is benign; only treat
    // CLOSING/CLOSED as a real error.
    const ws = wsRef.current;
    if (!ws) {
      vadStartingRef.current = false;
      setError('not connected');
      setState('error');
      return;
    }
    if (ws.readyState === 0) {
      const ok = await new Promise<boolean>((resolve) => {
        const t = window.setTimeout(() => resolve(false), 5000);
        ws.addEventListener('open', () => { window.clearTimeout(t); resolve(true); }, { once: true });
        ws.addEventListener('error', () => { window.clearTimeout(t); resolve(false); }, { once: true });
        ws.addEventListener('close', () => { window.clearTimeout(t); resolve(false); }, { once: true });
      });
      if (!ok || (ws.readyState as number) !== 1) {
        vadStartingRef.current = false;
        setError('not connected');
        setState('error');
        return;
      }
    } else if (ws.readyState !== 1) {
      vadStartingRef.current = false;
      setError('not connected');
      setState('error');
      return;
    }
    try {
      // Player must exist before VAD fires, so onPlayingStart can arm
      // the lock window without a race.
      await ensurePlayer();
      const useStream = streamingVoiceEnabledRef.current;
      const DEBUG_STREAM = import.meta.env.DEV;
      // Per-turn counters so DevTools shows exactly how much PCM we
      // shipped between stream_start and stream_commit. If the server
      // reports a different byte count, the WS path is corrupting
      // frames; if both agree but STT is empty, the pod itself
      // isn't transcribing.
      let streamFramesSent = 0;
      let streamBytesSent = 0;
      let streamStartAt = 0;
      // Show a pending user bubble (typing dots) the instant we open
      // a streaming turn. The previous behaviour waited for the first
      // ``partial_transcript`` event to create the bubble, which left
      // the user staring at nothing for the pod's time-to-first-
      // partial (~200-400 ms), and if the pod silently dropped
      // partials, the bubble never appeared at all. Painting it
      // immediately gives instant visual feedback; partials then
      // replace the dots with live text as they arrive.
      const openPendingUserBubble = () => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'user' && last.pending) {
            return prev;  // already have one, don't double up
          }
          return [...prev, { id: makeId(), role: 'user', text: '', pending: true }];
        });
      };
      const vad = new VadController(
        {
          onSpeechStart: () => {
            // User started talking. Two cases:
            //
            // 1) Agent is NOT currently speaking → immediate barge-in
            //    (matches the old behaviour, no perceptible delay).
            //
            // 2) Agent IS currently speaking → defer the barge-in for
            //    BACKCHANNEL_GRACE_MS. If the speech turns out to be a
            //    short backchannel ("uh-huh", "yeah") that ends inside
            //    that window with total duration ≤ BACKCHANNEL_MAX_MS,
            //    onSpeechEnd will skip both the barge-in and the
            //    submission, the agent keeps talking. Otherwise the
            //    deferred timer fires the normal barge-in path.
            if (!isAgentSpeakingRef.current) {
              bargeIn();
              setState('recording');
              if (useStream && !streamTurnOpenRef.current && wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'stream_start' }));
                streamTurnOpenRef.current = true;
                streamFramesSent = 0;
                streamBytesSent = 0;
                streamStartAt = performance.now();
                openPendingUserBubble();
                if (DEBUG_STREAM) console.log('[voicechat] → stream_start (immediate)');
              }
              return;
            }
            bargeInDeferredRef.current = true;
            pendingBargeInRef.current = window.setTimeout(() => {
              pendingBargeInRef.current = null;
              bargeInDeferredRef.current = false;
              bargeIn();
              setState('recording');
              if (useStream && !streamTurnOpenRef.current && wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'stream_start' }));
                streamTurnOpenRef.current = true;
                streamFramesSent = 0;
                streamBytesSent = 0;
                streamStartAt = performance.now();
                openPendingUserBubble();
                if (DEBUG_STREAM) console.log('[voicechat] → stream_start (deferred barge-in)');
              }
            }, BACKCHANNEL_GRACE_MS);
          },
          onSpeechEnd: ({ wavBytes, durationMs }) => {
            // Backchannel swallow path, same regardless of mode.
            if (
              bargeInDeferredRef.current &&
              durationMs <= BACKCHANNEL_MAX_MS
            ) {
              clearBackchannelGrace();
              // If a stream had been pre-opened on the deferred barge-in
              // path it would normally still be empty here, but be
              // defensive: tell the server to drop it.
              if (useStream && streamTurnOpenRef.current && wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'cancel' }));
                streamTurnOpenRef.current = false;
              }
              return;
            }
            const wasDeferred = bargeInDeferredRef.current;
            clearBackchannelGrace();
            if (wasDeferred) {
              bargeIn();
              setState('recording');
            }
            if (useStream) {
              // Send stream_commit as a HINT — the server's ensembler
              // is the sole authority on turn-end (it can wait up to
              // 12 s for grammatically-incomplete partials before
              // committing). Crucially, we do NOT:
              //   * close ``streamTurnOpenRef`` (the session is still
              //     alive on the server, and PCM frames must keep
              //     flowing so the server's STT pod sees the silence
              //     that lets its VAD measure ``silence_ms``)
              //   * setState('transcribing') (the server may decide
              //     this is a mid-sentence pause and wait for more
              //     audio; flipping the UI now would make a long
              //     thinking-pause feel like a hang). When the server
              //     actually commits, it sends a ``transcript`` event
              //     and the handler transitions to 'thinking'.
              if (streamTurnOpenRef.current && wsRef.current?.readyState === 1) {
                wsRef.current.send(JSON.stringify({ type: 'stream_commit' }));
                if (DEBUG_STREAM) {
                  const elapsed = Math.round(performance.now() - streamStartAt);
                  console.log(
                    `[voicechat] → stream_commit hint  frames=${streamFramesSent} bytes=${streamBytesSent} elapsed=${elapsed}ms speech_dur=${durationMs}ms`,
                  );
                }
              }
              return;
            }
            const b64 = arrayBufferToBase64(wavBytes);
            submitVoiceB64(b64, 'audio/wav', durationMs);
          },
          onPcmFrame: useStream
            ? (pcm: Uint8Array) => {
                if (!wsRef.current || wsRef.current.readyState !== 1) return;
                // Open the streaming turn lazily on the first frame so
                // we don't truncate the start of the utterance.
                // Silero's onSpeechStart fires ~500-700 ms AFTER speech
                // actually begins (it needs to accumulate confidence),
                // so gating stream_start on onSpeechStart drops the
                // first word of every turn, STT then receives a
                // half-word and returns empty. The streaming pod's own
                // server-side VAD filters out the leading silence; we
                // just need to make sure the actual speech all arrives.
                if (!streamTurnOpenRef.current) {
                  wsRef.current.send(JSON.stringify({ type: 'stream_start' }));
                  streamTurnOpenRef.current = true;
                  streamFramesSent = 0;
                  streamBytesSent = 0;
                  streamStartAt = performance.now();
                  openPendingUserBubble();
                  if (DEBUG_STREAM) console.log('[voicechat] → stream_start (first frame)');
                }
                wsRef.current.send(pcm);
                streamFramesSent += 1;
                streamBytesSent += pcm.byteLength;
              }
            : undefined,
          onProbability: (p) => setMicLevel(p),
          onError: (err) => {
            setError(err.message || 'mic error');
            setState('error');
            setListening(false);
          },
        },
        {
          endSilenceMs: 1000,
          minSpeechMs: 500,
          mode: useStream ? 'stream' : 'segment',
        },
      );
      vadRef.current = vad;
      await vad.start();
      setListening(true);
      setState('listening');
    } catch (err) {
      setError((err as Error).message || 'mic permission denied');
      setState('error');
      setListening(false);
      vadRef.current?.destroy();
      vadRef.current = null;
    } finally {
      vadStartingRef.current = false;
    }
  }, [alwaysOn, ensurePlayer, bargeIn, submitVoiceB64]);

  const stopListening = useCallback(() => {
    if (vadRef.current) {
      void vadRef.current.destroy();
      vadRef.current = null;
    }
    clearBackchannelGrace();
    setListening(false);
    setMicLevel(0);
    setState((prev) => (prev === 'listening' || prev === 'recording' ? 'idle' : prev));
  }, [clearBackchannelGrace]);

  const startRecording = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== 1) {
      setError('not connected');
      setState('error');
      return;
    }
    // Barge-in: cancel any in-flight turn
    playerRef.current?.flush();
    audioStartedForTurnRef.current = false;
    stopRevealTimer();
    if (revealStateRef.current) {
      const id = revealStateRef.current.msgId;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
      revealStateRef.current = null;
    }
    if (currentBotMsgIdRef.current) {
      try { wsRef.current.send(JSON.stringify({ type: 'cancel' })); } catch { /* ignore */ }
      currentBotMsgIdRef.current = null;
    }

    try {
      await ensurePlayer();
      const rec = new MicRecorder({ onLevel: setMicLevel });
      await rec.start();
      recorderRef.current = rec;
      setState('recording');
      setMessages((prev) => [...prev, { id: makeId(), role: 'user', text: '', pending: true }]);
    } catch (err) {
      setError((err as Error).message || 'mic permission denied');
      setState('error');
    }
  }, [ensurePlayer, stopRevealTimer]);

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    setState('uploading');
    try {
      const result = await rec.stop();
      recorderRef.current = null;
      setMicLevel(0);
      if (result.durationMs < 250) {
        setMessages((prev) => prev.filter((m) => !(m.role === 'user' && m.pending)));
        setState('idle');
        return;
      }
      setState('transcribing');
      wsRef.current?.send(JSON.stringify({
        type: 'voice',
        audio_b64: result.base64,
        mime: result.mimeType,
        duration_ms: result.durationMs,
      }));
    } catch (err) {
      setError((err as Error).message || 'recording failed');
      setState('error');
    }
  }, []);

  const sendText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!wsRef.current || wsRef.current.readyState !== 1) {
      setError('not connected');
      setState('error');
      return;
    }
    // Barge-in
    playerRef.current?.flush();
    stopRevealTimer();
    if (revealStateRef.current) {
      const id = revealStateRef.current.msgId;
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
      revealStateRef.current = null;
    }
    if (currentBotMsgIdRef.current) {
      try { wsRef.current.send(JSON.stringify({ type: 'cancel' })); } catch { /* ignore */ }
      currentBotMsgIdRef.current = null;
    }
    setMessages((prev) => [...prev, { id: makeId(), role: 'user', text: trimmed, pending: false }]);
    setState('thinking');
    try {
      wsRef.current.send(JSON.stringify({ type: 'text', text: trimmed }));
    } catch (err) {
      setError((err as Error).message || 'send failed');
      setState('error');
    }
  }, [stopRevealTimer]);

  const cancel = useCallback(() => {
    playerRef.current?.flush();
    audioStartedForTurnRef.current = false;
    stopRevealTimer();
    revealStateRef.current = null;
    try { wsRef.current?.send(JSON.stringify({ type: 'cancel' })); } catch { /* ignore */ }
    if (recorderRef.current) {
      recorderRef.current.cancel();
      recorderRef.current = null;
    }
    // Server will drop the in-flight stream session on this cancel;
    // clear the local flag so the next user speech opens a new one.
    streamTurnOpenRef.current = false;
    // Always-on: stay listening after cancel so the user can keep
    // talking. Push-to-talk: go idle.
    setState(vadRef.current ? 'listening' : 'idle');
  }, [stopRevealTimer]);

  const reset = useCallback(() => {
    stopRevealTimer();
    revealStateRef.current = null;
    currentBotMsgIdRef.current = null;
    setMessages([]);
    setError(null);
    cancel();
  }, [cancel]);

  return {
    state,
    messages,
    micLevel,
    error,
    listening,
    startRecording,
    stopRecording,
    startListening,
    stopListening,
    sendText,
    cancel,
    reset,
  };
}
