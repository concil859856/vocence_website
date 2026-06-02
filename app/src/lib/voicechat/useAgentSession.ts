/**
 * useAgentSession, single shared session controller for an agent's
 * Call and Chat tabs.
 *
 * Previously each tab (AgentCall, AgentChat) called ``useVoiceChat``
 * independently with its own ``started`` state. Result: opening a
 * call in the Call tab left the Chat tab still showing its own
 * "Start conversation" button, and clicking "switch to chat" never
 * propagated the active session.
 *
 * This hook centralises that state. The parent (AgentDetail) calls
 * it once, both tab views receive the same controller via props,
 * and there's exactly one WebSocket open across both tabs.
 */

import { useEffect, useRef, useState } from 'react';
import { useVoiceChat, type UseVoiceChatResult } from './useVoiceChat';

export interface AgentSession {
  /** True once the user clicked Start in either tab. */
  started: boolean;
  /** True when mic is intentionally muted (call still active). */
  muted: boolean;
  /** Open the WS and start listening. Safe to await multiple times. */
  start: () => Promise<void>;
  /** Close the WS cleanly and reset state. */
  end: () => void;
  /** Toggle mic mute without ending the session. */
  toggleMute: () => Promise<void>;
  /** Lower-level controls exposed for the text-input fallback. */
  sendText: UseVoiceChatResult['sendText'];
  cancel: UseVoiceChatResult['cancel'];
  /** State machine + telemetry pass-through. */
  state: UseVoiceChatResult['state'];
  messages: UseVoiceChatResult['messages'];
  micLevel: UseVoiceChatResult['micLevel'];
  error: UseVoiceChatResult['error'];
  listening: UseVoiceChatResult['listening'];
  /** Mic-permission error from the pre-flight check.
   *  Null when no error. Cleared on the next ``start`` attempt. */
  micError: string | null;
  /** Manually dismiss the mic error (e.g. after user fixes settings). */
  clearMicError: () => void;
}

/** Pre-flight check that the browser actually has microphone access
 *  before we open the WS + start billing. Without this, the call
 *  would connect, the agent's first_message would play, and the
 *  user would be billed without ever being able to respond. */
async function checkMicPermission(): Promise<{ ok: boolean; error?: string }> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      error: "This browser doesn't support microphone access.",
    };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Release the probe stream immediately, the real mic open
    // happens inside ``useVoiceChat.startListening`` shortly after.
    stream.getTracks().forEach((t) => t.stop());
    return { ok: true };
  } catch (raw) {
    const err = raw as DOMException;
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      return {
        ok: false,
        error:
          "Microphone access denied. Click the lock icon in your browser's address bar, allow microphone, then try again.",
      };
    }
    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      return {
        ok: false,
        error: "No microphone detected. Plug one in (or check your audio settings) and try again.",
      };
    }
    if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      return {
        ok: false,
        error: "Microphone is in use by another app. Close it (Zoom, Meet, etc.) and try again.",
      };
    }
    return {
      ok: false,
      error: err.message || 'Could not access the microphone.',
    };
  }
}

export function useAgentSession(
  agentId: string,
  authToken: string | null,
): AgentSession {
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);

  const voice = useVoiceChat({
    enabled: !!authToken && started,
    authToken,
    agentId,
    alwaysOn: !muted,
  });

  // Backend auto-close (idle 60s, max 30min, balance hit 0) → reset
  // to the pre-session state in BOTH tabs simultaneously. The hook
  // emits a system message; we flip ``started`` back to false so the
  // Start button reappears wherever the user lands.
  //
  // BUG GUARD: the system message LIVES in ``voice.messages`` after
  // the session ends. Without ``endedSessionIdRef``, clicking Start
  // again would mount this effect with ``started=true`` and a stale
  // system bubble as ``last``, it'd immediately end the new session.
  // We track which messages array we already handled and only act on
  // a fresh transition (last message added since we last reacted).
  const handledSystemMsgRef = useRef<string | null>(null);
  useEffect(() => {
    const last = voice.messages[voice.messages.length - 1];
    if (last?.role !== 'system' || !started) return;
    if (handledSystemMsgRef.current === last.id) return;
    handledSystemMsgRef.current = last.id;
    setStarted(false);
    voice.stopListening();
  }, [voice.messages, started, voice.stopListening]);

  // Auto-start the mic once the WS handshake has completed.
  //
  // ``startListening`` requires ``wsRef.readyState === OPEN`` and bails
  // synchronously with "not connected" otherwise. Calling it from
  // ``start()`` directly after ``setStarted(true)`` therefore races
  // the WS open (the effect that calls ``connect()`` doesn't run
  // until after the next render commit). Watching for the post-open
  // ``idle`` state and arming the mic in an effect avoids the race
  // cleanly: ``state === 'idle' && started === true`` is exactly the
  // "WS open, mic not yet running" window we care about.
  useEffect(() => {
    if (!started) return;
    if (muted) return;
    if (!authToken) return;
    if (voice.listening) return;
    // ``state === 'idle'`` covers BOTH the initial pre-WS render
    // (which we filter out via ``started``) and the post-handshake
    // ready state. Combined with ``started=true``, this only fires
    // once the WS is actually open.
    if (voice.state !== 'idle') return;
    void voice.startListening();
  }, [started, muted, authToken, voice.state, voice.listening, voice.startListening]);

  const start = async () => {
    setMicError(null);
    // Pre-flight: confirm mic permission BEFORE opening the WS so we
    // don't bill for a call the user can't speak on. If denied,
    // surface a clear actionable error and bail without billing.
    const mic = await checkMicPermission();
    if (!mic.ok) {
      setMicError(mic.error || 'Microphone unavailable.');
      return;
    }
    // Wipe the previous session's transcript (including any "Session
    // ended" system bubble). Without this, the auto-end watcher would
    // re-trigger on the stale system message and immediately close
    // the new session.
    voice.reset();
    handledSystemMsgRef.current = null;
    // Just flip ``started``; do NOT call startListening here. The
    // WS-open effect below sees ``started=true``, opens the WS, and
    // a separate auto-start effect watches for the post-connect
    // ``idle`` state to kick the mic on. Calling startListening
    // synchronously here would race the WS open and bail with
    // "not connected" before the handshake completed.
    setStarted(true);
  };

  const end = () => {
    voice.stopListening();
    voice.cancel();
    setStarted(false);
  };

  const toggleMute = async () => {
    if (muted) {
      // Unmute: just clear the flag. The auto-start effect above
      // sees ``!muted && state === 'idle'`` and rearms the mic
      // without racing the WS state.
      setMuted(false);
    } else {
      setMuted(true);
      voice.stopListening();
    }
  };

  return {
    started,
    muted,
    start,
    end,
    toggleMute,
    state: voice.state,
    messages: voice.messages,
    micLevel: voice.micLevel,
    error: voice.error,
    listening: voice.listening,
    sendText: voice.sendText,
    cancel: voice.cancel,
    micError,
    clearMicError: () => setMicError(null),
  };
}
