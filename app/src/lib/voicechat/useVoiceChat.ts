/**
 * useVoiceChat — React hook that owns the WS state machine for the
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
import { API_ORIGIN_BASE } from '../../services/baseUrl';
import { StreamingAudioPlayer } from './audioPlayer';
import { MicRecorder } from './recorder';
import { VadController, arrayBufferToBase64 } from './vadController';

export type BotState = 'idle' | 'connecting' | 'listening' | 'recording' | 'uploading' | 'transcribing' | 'thinking' | 'speaking' | 'error';

export interface BotMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
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
  const origin = API_ORIGIN_BASE || `${window.location.protocol}//${window.location.host}`;
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
  const currentBotMsgIdRef = useRef<string | null>(null);
  const audioStartedForTurnRef = useRef(false);
  // Lock window after the agent starts speaking. While this is set,
  // VAD onSpeechStart events are ignored — gives the browser echo
  // canceller a moment to settle so we don't mistake the agent's own
  // first syllable (leaking through speakers) for a user barge-in.
  const POST_SPEAK_LOCK_MS = 600;

  // Paced text reveal — text appears in the chat bubble at a natural
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
        // keep the timer alive — more tokens may still be on the wire.
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
      playerRef.current = new StreamingAudioPlayer({
        onIdle: () => {
          // When the worklet drains and we're in 'speaking', consider turn done UX-wise.
        },
        onPlayingStart: () => {
          // The agent's audio just started hitting the speakers. Arm
          // the VAD lock so the agent's own first syllable bleeding
          // through speakers doesn't trip a false barge-in before the
          // echo canceller settles.
          vadRef.current?.lockSpeechStartFor(POST_SPEAK_LOCK_MS);
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
          // Audio is now flowing — start (or keep) the paced text reveal
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
          setState('thinking');
          break;
        case 'token': {
          // Tokens go into the reveal buffer, NOT directly into the
          // visible message — the timer copies them out at reading
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
          }
          // Functional updater so this handler doesn't depend on `state`
          // (reading it would cause `connect` to be recreated each render
          // and trigger a WS reconnect storm).
          setState((prev) => (prev === 'speaking' ? prev : 'thinking'));
          break;
        }
        case 'audio_meta':
          // server is about to send PCM frames for sentence N
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
          // No more frames coming — let the player drain to silence
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
            // On cancel, drop whatever was buffered — the user is moving on.
            const id = revealStateRef.current.msgId;
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
            revealStateRef.current = null;
          } else if (currentBotMsgIdRef.current) {
            const id = currentBotMsgIdRef.current;
            setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pending: false } : m)));
          }
          currentBotMsgIdRef.current = null;
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
        case 'error':
          setError(payload.message || payload.code || 'error');
          setState('error');
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
    if (!wsRef.current || wsRef.current.readyState !== 1) {
      setError('not connected');
      setState('error');
      return;
    }
    try {
      // Player must exist before VAD fires, so onPlayingStart can arm
      // the lock window without a race.
      await ensurePlayer();
      const vad = new VadController(
        {
          onSpeechStart: () => {
            // User started talking. If the agent was speaking or
            // thinking, cancel that turn first; then transition to
            // recording — the segment audio is captured by Silero and
            // delivered on speech-end.
            bargeIn();
            setState('recording');
          },
          onSpeechEnd: ({ wavBytes, durationMs }) => {
            const b64 = arrayBufferToBase64(wavBytes);
            submitVoiceB64(b64, 'audio/wav', durationMs);
          },
          onProbability: (p) => setMicLevel(p),
          onError: (err) => {
            setError(err.message || 'mic error');
            setState('error');
            setListening(false);
          },
        },
        { endSilenceMs: 700, minSpeechMs: 250 },
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
    }
  }, [alwaysOn, ensurePlayer, bargeIn, submitVoiceB64]);

  const stopListening = useCallback(() => {
    if (vadRef.current) {
      void vadRef.current.destroy();
      vadRef.current = null;
    }
    setListening(false);
    setMicLevel(0);
    setState((prev) => (prev === 'listening' || prev === 'recording' ? 'idle' : prev));
  }, []);

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
