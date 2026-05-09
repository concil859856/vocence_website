/**
 * useVoiceChat — React hook that owns the WS state machine for the
 * Vocence in-Studio assistant bot.
 *
 * State machine:
 *   idle  → user taps mic       → recording
 *   recording → user taps stop  → uploading → transcribing → thinking → speaking → idle
 *   any → error                 → idle
 *   any → user taps mic         → cancel current turn → recording (barge-in)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_ORIGIN_BASE } from '../../services/baseUrl';
import { StreamingAudioPlayer } from './audioPlayer';
import { MicRecorder } from './recorder';

export type BotState = 'idle' | 'connecting' | 'recording' | 'uploading' | 'transcribing' | 'thinking' | 'speaking' | 'error';

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
}

export interface UseVoiceChatResult {
  state: BotState;
  messages: BotMessage[];
  micLevel: number;
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
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
  const { enabled, authToken, agentId } = opts;
  const [state, setState] = useState<BotState>('idle');
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [micLevel, setMicLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const playerRef = useRef<StreamingAudioPlayer | null>(null);
  const recorderRef = useRef<MicRecorder | null>(null);
  const currentBotMsgIdRef = useRef<string | null>(null);
  const audioStartedForTurnRef = useRef(false);

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
          setState((prev) => (prev === 'speaking' ? 'speaking' : 'idle'));
          window.setTimeout(() => {
            audioStartedForTurnRef.current = false;
            setState((prev) => (prev === 'speaking' ? 'idle' : prev));
          }, 250);
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
          setState('idle');
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
      playerRef.current?.close();
      playerRef.current = null;
      setState('idle');
    }
    return () => {
      try { wsRef.current?.close(); } catch { /* ignore */ }
    };
  }, [enabled, authToken, agentId, connect]);

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
    setState('idle');
  }, [stopRevealTimer]);

  const reset = useCallback(() => {
    stopRevealTimer();
    revealStateRef.current = null;
    currentBotMsgIdRef.current = null;
    setMessages([]);
    setError(null);
    cancel();
  }, [cancel]);

  return { state, messages, micLevel, error, startRecording, stopRecording, sendText, cancel, reset };
}
