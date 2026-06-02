/**
 * AgentCall, voice-only "phone call" mode for testing an agent.
 *
 * No chat bubbles, no text input. One animated orb in the centre,
 * the agent's name and current state below it, an End Call button
 * at the bottom, and small mute / open-transcript secondaries.
 *
 * The session itself lives in ``useAgentSession`` one level up so
 * the Call and Chat tabs share a single WebSocket, clicking
 * "Open transcript" switches to Chat with the same conversation
 * still going.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, Mic, MicOff, MessageSquare, PhoneOff } from 'lucide-react';
import type { Agent } from '../../lib/agents/types';
import type { AgentSession } from '../../lib/voicechat/useAgentSession';
import { AgentOrb, type OrbState } from './AgentOrb';

interface Props {
  agent: Agent;
  session: AgentSession;
  /** Switch to the Chat tab (transcript view). The session keeps
   *  running across the swap so the user picks up where they left off. */
  onSwitchToChat?: () => void;
}

export function AgentCall({ agent, session, onSwitchToChat }: Props) {
  const {
    started,
    muted,
    start,
    end,
    toggleMute,
    state,
    messages,
    micLevel,
    error,
  } = session;

  // Map voicechat state machine → orb's 4 visual states.
  const orbState: OrbState = useMemo(() => {
    if (state === 'listening' || state === 'recording') return 'listening';
    if (state === 'thinking' || state === 'transcribing' || state === 'uploading') return 'thinking';
    if (state === 'speaking') return 'speaking';
    return 'idle';
  }, [state]);

  // Pseudo-pulse for the speaking state since we don't expose the
  // raw TTS amplitude from the hook. Two overlapping sinusoids feel
  // alive without trying to fake real audio reactivity.
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (state !== 'speaking') return;
    let raf = 0;
    const startedAt = performance.now();
    const tick = (now: number) => {
      const t = (now - startedAt) / 1000;
      setPulse(0.4 + 0.3 * Math.abs(Math.sin(t * 2.1)) + 0.2 * Math.abs(Math.sin(t * 0.7)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const orbLevel = state === 'listening' || state === 'recording' ? micLevel : pulse;

  const stateLabel: Record<typeof state, string> = {
    idle: started ? 'Connected' : 'Ready when you are',
    connecting: 'Connecting…',
    listening: 'Listening…',
    recording: 'Listening…',
    uploading: 'Sending…',
    transcribing: 'Transcribing…',
    thinking: 'Thinking…',
    speaking: 'Speaking',
    error: error || 'Error',
  };

  const initials = useMemo(() => {
    return (agent.name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]!.toUpperCase())
      .join('');
  }, [agent.name]);

  // Most-recent system message, surfaced after onEnd auto-fires so
  // the user sees WHY the call ended (timeout vs. credits vs. manual).
  const lastSystemMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'system') return messages[i];
    }
    return null;
  }, [messages]);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0B0D10] h-[calc(100vh-16rem)] min-h-[480px] flex flex-col items-center justify-center px-6 py-10 relative overflow-hidden">
      <div
        className="absolute inset-0 pointer-events-none transition-opacity duration-700"
        style={{
          background:
            orbState === 'speaking'
              ? 'radial-gradient(circle at 50% 50%, rgba(223, 255, 0, 0.06), transparent 60%)'
              : orbState === 'listening'
                ? 'radial-gradient(circle at 50% 50%, rgba(125, 211, 252, 0.06), transparent 60%)'
                : orbState === 'thinking'
                  ? 'radial-gradient(circle at 50% 50%, rgba(196, 181, 253, 0.05), transparent 60%)'
                  : 'transparent',
        }}
      />

      <AgentOrb state={orbState} level={orbLevel} size={280} initials={initials} />

      <div className="mt-8 text-center relative">
        <div className="text-lg font-semibold text-white">{agent.name}</div>
        <div className="text-sm text-[#A7B0B7] mt-1 tabular-nums" aria-live="polite">
          {stateLabel[state]}
        </div>
      </div>

      {/* Mic-permission error takes priority over post-call system
          messages so the user sees the most actionable problem first. */}
      {!started && session.micError && (
        <div className="mt-5 max-w-md relative">
          <div className="rounded-xl border px-4 py-2.5 text-xs leading-snug text-center border-red-400/30 bg-red-500/[0.08] text-red-100">
            <div className="font-semibold mb-1">Mic blocked</div>
            <div>{session.micError}</div>
          </div>
        </div>
      )}
      {!started && !session.micError && lastSystemMsg && (
        <div className="mt-5 max-w-md relative">
          <div
            className={`rounded-xl border px-4 py-2.5 text-xs leading-snug text-center ${
              lastSystemMsg.systemKind === 'billing_exhausted'
                ? 'border-red-400/30 bg-red-500/[0.08] text-red-100'
                : 'border-amber-300/30 bg-amber-400/[0.08] text-amber-100'
            }`}
          >
            {lastSystemMsg.text}
          </div>
        </div>
      )}

      <div className="mt-10 relative">
        {!started ? (
          <button
            type="button"
            onClick={start}
            disabled={state === 'connecting'}
            className="inline-flex items-center justify-center gap-2 rounded-full bg-[#DFFF00] text-[#07080A] px-8 py-4 text-base font-semibold hover:brightness-110 shadow-[0_0_40px_rgba(223,255,0,0.25)] disabled:opacity-50 disabled:shadow-none"
          >
            {state === 'connecting' ? (
              <>
                <Loader2 size={18} className="animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M19.95 21q-3.125 0-6.175-1.363t-5.55-3.862-3.862-5.55T3 4.05q0-.45.3-.75t.75-.3H8.1q.35 0 .625.238t.325.562l.65 3.5q.05.4-.025.675T9.4 8.45L6.975 10.9q.5.925 1.187 1.787t1.513 1.663q.775.775 1.625 1.438T13.1 17l2.35-2.35q.225-.225.588-.337t.712-.063l3.45.7q.35.1.575.363T21 15.9v4.05q0 .45-.3.75t-.75.3"/>
                </svg>
                Start call
              </>
            )}
          </button>
        ) : (
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={toggleMute}
              className={`shrink-0 w-14 h-14 rounded-full flex items-center justify-center transition-colors ${
                muted
                  ? 'bg-white/[0.04] text-[#A7B0B7] hover:bg-white/[0.08]'
                  : 'bg-white/[0.08] text-white hover:bg-white/[0.12]'
              }`}
              aria-label={muted ? 'Unmute mic' : 'Mute mic'}
              title={muted ? 'Unmute mic' : 'Mute mic'}
            >
              {muted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>

            <button
              type="button"
              onClick={end}
              className="shrink-0 inline-flex items-center justify-center gap-2 rounded-full bg-red-500 text-white px-7 py-3.5 text-sm font-semibold hover:bg-red-600 shadow-[0_0_30px_rgba(239,68,68,0.25)]"
            >
              <PhoneOff size={16} fill="currentColor" />
              End call
            </button>

            {onSwitchToChat && (
              <button
                type="button"
                onClick={onSwitchToChat}
                className="shrink-0 w-14 h-14 rounded-full bg-white/[0.04] text-[#A7B0B7] hover:bg-white/[0.08] flex items-center justify-center transition-colors"
                aria-label="Open transcript (Chat view)"
                title="Open transcript (Chat view)"
              >
                <MessageSquare size={18} />
              </button>
            )}
          </div>
        )}
      </div>

      {!started && !lastSystemMsg && (
        <p className="mt-6 text-[11px] text-[#7D8A95] text-center max-w-sm relative">
          When you start, the agent greets you and the mic opens. Talk naturally, the call ends when you click End, or after 30 min of conversation / 60 s of silence.
        </p>
      )}
    </div>
  );
}
