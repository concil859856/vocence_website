/**
 * AgentChat — voice-first chat surface for a deployed Studio agent.
 *
 * Thin shell on top of ``useVoiceChat`` (which Logos / Vocence Assistant
 * also uses), with the agent_id wired through. The shared hook owns the
 * WS state machine, audio playback, paced text reveal, barge-in, and
 * cancel — anything we improve in the bot's pipeline propagates here
 * automatically.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, PhoneOff, Play, Send } from 'lucide-react';
import type { Agent } from '../../lib/agents/types';
import type { AgentSession } from '../../lib/voicechat/useAgentSession';
import { renderMessage } from '../../lib/voicechat/renderInline';
import { ToolCallChip } from '../../lib/voicechat/ToolCallChip';
import { AgentAvatar } from './AgentAvatar';
import { ThumbsFeedback } from '../feedback/ThumbsFeedback';

interface Props {
  agent: Agent;
  session: AgentSession;
}

export function AgentChat({ agent, session }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState('');

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
    sendText,
    micError,
  } = session;

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, state]);

  const onSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendText(text);
  };

  const stateLabel: Record<typeof state, string> = {
    idle: started ? 'Connected' : 'Click Start to begin',
    connecting: 'Connecting…',
    listening: 'Listening…',
    recording: 'Listening…',
    uploading: 'Sending…',
    transcribing: 'Transcribing…',
    thinking: 'Thinking…',
    speaking: 'Speaking',
    error: error || 'Error',
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0B0D10] flex flex-col h-[calc(100vh-16rem)] min-h-[480px]">
      <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2.5">
        <AgentAvatar id={agent.id} name={agent.name} size="xs" rounded="full" />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-white leading-tight truncate">{agent.name}</div>
          <div className="text-[10px] text-[#A7B0B7] leading-tight">{stateLabel[state]}</div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-sm text-[#A7B0B7] py-8">
            {started ? `Say something to ${agent.name}.` : `Click Start to begin a conversation with ${agent.name}.`}
          </div>
        )}
        {messages.map((m) => {
          // System bubbles (session ended notifications) get their own
          // centered banner so they don't blend in with user/assistant
          // chat traffic. Colour reflects severity:
          //   • idle_timeout / max_duration — amber (informational close)
          //   • billing_exhausted — red (action required: top up)
          //   • info — neutral grey
          if (m.role === 'system') {
            const tone =
              m.systemKind === 'billing_exhausted'
                ? 'border-red-400/30 bg-red-500/[0.08] text-red-100'
                : m.systemKind === 'idle_timeout' || m.systemKind === 'max_duration'
                  ? 'border-amber-300/30 bg-amber-400/[0.08] text-amber-100'
                  : 'border-white/10 bg-white/[0.04] text-[#C6CDD4]';
            return (
              <div key={m.id} className="flex justify-center">
                <div className={`max-w-[90%] rounded-xl border px-3.5 py-2 text-xs leading-snug text-center ${tone}`}>
                  {m.text}
                </div>
              </div>
            );
          }
          // Assistant messages get a small thumbs-up/down on hover after
          // they've finished pending — feeds generation_feedback for the
          // Quality dashboard. Disabled while the LLM is still streaming
          // so the user doesn't rate a half-formed answer.
          const showThumbs = m.role === 'assistant' && !m.pending && !!m.text;
          return (
            <div key={m.id} className={`group flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={`rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                    m.role === 'user'
                      ? 'bg-[#DFFF00] text-[#07080A]'
                      : 'bg-white/[0.06] text-white border border-white/10'
                  }`}
                >
                  {/* Tool-call chips — rendered above the message text so
                      the user sees "Searching the web…" while the LLM is
                      fetching the data it needs to answer. */}
                  {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-1.5">
                      {m.tool_calls.map((tc) => (
                        <ToolCallChip key={tc.id} call={tc} />
                      ))}
                    </div>
                  )}
                  {m.pending && !m.text ? (
                    <span className="inline-flex gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse" />
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:120ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:240ms]" />
                    </span>
                  ) : m.role === 'assistant' ? (
                    renderMessage(m.text)
                  ) : (
                    m.text
                  )}
                </div>
                {showThumbs && (
                  <div className="mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <ThumbsFeedback entryType="agent_message" entryId={m.id} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-white/10 bg-white/[0.02] p-3">
        {/* Mic-permission error from useAgentSession.start(). Shown
            here AND on the Call tab so the user sees it wherever they
            tried to start. */}
        {!started && micError && (
          <div className="mb-3 rounded-xl border border-red-400/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-100">
            <span className="font-semibold">Mic blocked.</span> {micError}
          </div>
        )}
        {!started ? (
          // Pre-session — single big Start button. No WS is open yet,
          // no billing has started; the user must explicitly opt in.
          <button
            type="button"
            onClick={start}
            disabled={state === 'connecting'}
            className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#DFFF00] text-[#07080A] px-4 py-3 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
          >
            {state === 'connecting' ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <Play size={16} fill="currentColor" /> Start conversation
              </>
            )}
          </button>
        ) : (
          // Active session — End button (left), mic toggle (centre),
          // text input (right). End cleanly closes the WS so the
          // backend writes the final transaction row.
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={end}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-2xl bg-red-500/15 border border-red-400/30 px-3 py-2 text-xs font-semibold text-red-200 hover:bg-red-500/25"
              aria-label="End session"
              title="End session"
            >
              <PhoneOff size={14} /> End
            </button>
            <button
              type="button"
              onClick={toggleMute}
              disabled={state === 'connecting'}
              className={`relative shrink-0 w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
                !muted
                  ? 'bg-white/[0.08] text-white'
                  : 'bg-white/[0.04] text-[#A7B0B7] hover:bg-white/[0.08]'
              }`}
              aria-label={muted ? 'Unmute mic' : 'Mute mic'}
              title={muted ? 'Unmute mic' : 'Mute mic'}
            >
              {muted ? <MicOff size={18} /> : <Mic size={18} />}
              {!muted && (
                <span
                  className="absolute -inset-0.5 rounded-full border-2 border-[#DFFF00]/60 pointer-events-none"
                  style={{ transform: `scale(${1 + micLevel * 0.3})` }}
                />
              )}
            </button>
            <form onSubmit={onSubmitText} className="flex-1 flex items-end gap-2">
              <textarea
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (input.trim()) {
                      const t = input;
                      setInput('');
                      e.currentTarget.style.height = 'auto';
                      void sendText(t);
                    }
                  }
                }}
                placeholder="Type a message…"
                title="Shift+Enter for new line"
                disabled={state === 'connecting'}
                className="flex-1 bg-white/[0.04] border border-white/10 rounded-2xl px-4 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 disabled:opacity-50 resize-none leading-snug"
              />
              <button
                type="submit"
                disabled={!input.trim() || state === 'connecting'}
                className="shrink-0 w-10 h-10 rounded-full bg-white/[0.06] hover:bg-white/[0.10] text-white disabled:opacity-30 flex items-center justify-center"
                aria-label="Send"
              >
                {state === 'connecting' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

