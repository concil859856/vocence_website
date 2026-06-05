/**
 * AgentChat, voice-first chat surface for a deployed Studio agent.
 *
 * Thin shell on top of ``useVoiceChat`` (which Logos / Vocence Assistant
 * also uses), with the agent_id wired through. The shared hook owns the
 * WS state machine, audio playback, paced text reveal, barge-in, and
 * cancel, anything we improve in the bot's pipeline propagates here
 * automatically.
 *
 * Layout: a single rounded card. Top = header with the agent's avatar
 * + an animated state pill. Middle = scrollable conversation. Bottom =
 * either a single Start button (pre-session) or the active-call control
 * row (End / Mic / Text input). The active row uses visual hierarchy:
 * End is a small chip, Mic is the prominent audio-reactive circle, the
 * text input fills the remaining width.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, PhoneOff, Play, Send, Sparkles } from 'lucide-react';
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

// Visual style + label per state. ``dot`` is a small coloured pulse
// next to the label, ``ring`` colours the audio-reactive ring around
// the mic button when the agent is on a state that warrants it.
const STATE_STYLE: Record<string, { label: string; tone: string; dot: string }> = {
  idle:        { label: 'Connected',     tone: 'text-white/70',        dot: 'bg-white/40' },
  connecting:  { label: 'Connecting…',   tone: 'text-amber-200',       dot: 'bg-amber-300' },
  listening:   { label: 'Listening',     tone: 'text-sky-200',         dot: 'bg-sky-400' },
  recording:   { label: 'Listening',     tone: 'text-sky-200',         dot: 'bg-sky-400' },
  uploading:   { label: 'Sending…',      tone: 'text-violet-200',      dot: 'bg-violet-400' },
  transcribing:{ label: 'Transcribing…', tone: 'text-violet-200',      dot: 'bg-violet-400' },
  thinking:    { label: 'Thinking…',     tone: 'text-violet-200',      dot: 'bg-violet-400' },
  speaking:    { label: 'Speaking',      tone: 'text-[#DFFF00]',       dot: 'bg-[#DFFF00]' },
  error:       { label: 'Error',         tone: 'text-red-300',         dot: 'bg-red-400' },
};

export function AgentChat({ agent, session }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState('');

  const {
    started, muted, start, end, toggleMute,
    state, messages, micLevel, error, sendText, micError,
  } = session;

  // Auto-scroll to bottom on new message AND while a streaming reply
  // is growing (token-by-token reveal). The last bubble's text length
  // is in the deps so each new chunk triggers a re-scroll.
  const lastMsgText = messages[messages.length - 1]?.text ?? '';
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, lastMsgText, state]);

  const onSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendText(text);
  };

  const stateStyle = STATE_STYLE[state] ?? STATE_STYLE.idle;
  const stateLabel = state === 'error' ? (error || 'Error') : stateStyle.label;
  // Idle has no animated dot, only the "active" states get the pulse.
  const isActiveState = state !== 'idle' && state !== 'error';

  // Suggested first messages, only shown on the empty state. Pulled
  // from the agent's purpose if set, otherwise generic conversation
  // starters that work for any agent type.
  const suggestions = useMemo(() => {
    const purpose = (agent.config?.purpose || '').trim();
    return purpose
      ? [`Tell me what you can help with.`, `Walk me through ${purpose.split('.')[0].toLowerCase()}.`]
      : [`Hi! What can you do?`, `Tell me about yourself.`];
  }, [agent.config?.purpose]);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0B0D10] flex flex-col h-[calc(100vh-16rem)] min-h-[520px] overflow-hidden shadow-xl shadow-black/30">
      {/* ============ Header ============ */}
      <div className="px-5 py-3.5 border-b border-white/10 bg-gradient-to-b from-white/[0.04] to-transparent flex items-center gap-3">
        <AgentAvatar id={agent.id} name={agent.name} size="sm" rounded="full" />
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-white leading-tight truncate">
            {agent.name}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`relative inline-flex w-1.5 h-1.5 rounded-full ${stateStyle.dot}`}>
              {isActiveState && (
                <span className={`absolute inset-0 rounded-full ${stateStyle.dot} animate-ping opacity-75`} />
              )}
            </span>
            <span className={`text-[11px] font-medium tabular-nums ${stateStyle.tone}`}>
              {stateLabel}
            </span>
          </div>
        </div>
        {/* Live indicator chip on the right, only visible while a
            session is in progress. Helps the user remember billing
            is running. */}
        {started && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 border border-red-400/25 px-2.5 py-1 text-[10px] font-semibold text-red-300 uppercase tracking-wider">
            <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-red-400">
              <span className="absolute inset-0 rounded-full bg-red-400 animate-ping opacity-75" />
            </span>
            Live
          </span>
        )}
      </div>

      {/* ============ Conversation ============ */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-5 space-y-4 bg-gradient-to-b from-transparent via-transparent to-white/[0.015]"
      >
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-14 h-14 rounded-2xl bg-white/[0.04] border border-white/10 flex items-center justify-center mb-3">
              <Sparkles size={22} className="text-[#DFFF00]/70" />
            </div>
            <div className="text-[15px] font-semibold text-white mb-1">
              {started ? `Say something to ${agent.name}` : `Start chatting with ${agent.name}`}
            </div>
            <div className="text-[12px] text-[#A7B0B7] max-w-[260px] mb-4 leading-snug">
              {started
                ? 'Talk naturally, voice or text both work.'
                : 'Click Start to begin the conversation. You can talk or type.'}
            </div>
            {started && (
              <div className="flex flex-wrap gap-2 justify-center max-w-[320px]">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void sendText(s)}
                    className="rounded-full bg-white/[0.04] border border-white/10 hover:border-white/25 hover:bg-white/[0.07] px-3 py-1.5 text-[11.5px] text-white/85 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {messages.map((m) => {
          // System bubbles (session-ended banners) sit centred, neutral
          // tone, they're not a "message" from anybody.
          if (m.role === 'system') {
            const tone =
              m.systemKind === 'billing_exhausted'
                ? 'border-red-400/30 bg-red-500/[0.08] text-red-100'
                : m.systemKind === 'idle_timeout' || m.systemKind === 'max_duration'
                  ? 'border-amber-300/30 bg-amber-400/[0.08] text-amber-100'
                  : 'border-white/10 bg-white/[0.04] text-[#C6CDD4]';
            return (
              <div key={m.id} className="flex justify-center">
                <div className={`max-w-[90%] rounded-xl border px-3.5 py-2 text-[11.5px] leading-snug text-center ${tone}`}>
                  {m.text}
                </div>
              </div>
            );
          }
          const showThumbs = m.role === 'assistant' && !m.pending && !!m.text;
          const isUser = m.role === 'user';
          return (
            <div key={m.id} className={`group flex items-start gap-2.5 ${isUser ? 'justify-end' : ''}`}>
              {/* Assistant avatar, small, only on assistant rows.
                  Gives the chat a clear "who's talking" cue without
                  repeating the name on every bubble. */}
              {!isUser && (
                <div className="shrink-0 mt-0.5">
                  <AgentAvatar id={agent.id} name={agent.name} size="xs" rounded="full" />
                </div>
              )}
              <div className={`max-w-[78%] flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <div
                  className={`rounded-2xl px-4 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap break-words shadow-sm ${
                    isUser
                      ? 'bg-[#DFFF00] text-[#07080A] shadow-[#DFFF00]/10 rounded-br-md'
                      : 'bg-white/[0.05] text-white border border-white/10 rounded-bl-md'
                  }`}
                >
                  {/* Tool-call chips, rendered above the message text
                      so the user sees "Searching the web…" while the
                      LLM is fetching the data it needs to answer. */}
                  {m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {m.tool_calls.map((tc) => (
                        <ToolCallChip key={tc.id} call={tc} />
                      ))}
                    </div>
                  )}
                  {m.pending && !m.text ? (
                    <span className="inline-flex gap-1 py-0.5">
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
                  <div className="mt-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <ThumbsFeedback entryType="agent_message" entryId={m.id} />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ============ Footer ============ */}
      <div className="border-t border-white/10 bg-[#07080A]/80 backdrop-blur p-3.5">
        {/* Mic-permission error from useAgentSession.start(). Shown
            here AND on the Call tab so the user sees it wherever they
            tried to start. */}
        {!started && micError && (
          <div className="mb-3 rounded-xl border border-red-400/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-100">
            <span className="font-semibold">Mic blocked.</span> {micError}
          </div>
        )}
        {!started ? (
          // Pre-session, single big Start button. No WS is open yet,
          // no billing has started; the user must explicitly opt in.
          <button
            type="button"
            onClick={start}
            disabled={state === 'connecting'}
            className="w-full inline-flex items-center justify-center gap-2 rounded-2xl bg-[#DFFF00] text-[#07080A] px-4 py-3 text-sm font-semibold hover:brightness-110 disabled:opacity-50 shadow-[0_0_40px_-12px_rgba(223,255,0,0.55)]"
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
          // Active session, End button (left), mic toggle (centre),
          // text input (right). End cleanly closes the WS so the
          // backend writes the final transaction row.
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={end}
              className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-red-500/15 border border-red-400/30 px-3.5 h-10 text-xs font-semibold text-red-200 hover:bg-red-500/25 transition-colors"
              aria-label="End session"
              title="End session"
            >
              <PhoneOff size={13} /> End
            </button>
            <button
              type="button"
              onClick={toggleMute}
              disabled={state === 'connecting'}
              className={`relative shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
                !muted
                  ? 'bg-[#DFFF00]/[0.12] text-[#DFFF00] hover:bg-[#DFFF00]/[0.18]'
                  : 'bg-white/[0.04] text-[#A7B0B7] hover:bg-white/[0.08]'
              }`}
              aria-label={muted ? 'Unmute mic' : 'Mute mic'}
              title={muted ? 'Unmute mic' : 'Mute mic'}
            >
              {muted ? <MicOff size={17} /> : <Mic size={17} />}
              {!muted && (
                <span
                  className="absolute inset-0 rounded-full border-2 border-[#DFFF00]/60 pointer-events-none transition-transform duration-100"
                  style={{ transform: `scale(${1 + Math.min(micLevel, 1) * 0.35})` }}
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
                placeholder="Type a message or just talk…"
                title="Shift+Enter for new line"
                disabled={state === 'connecting'}
                className="flex-1 bg-white/[0.04] border border-white/10 rounded-full px-4 py-2.5 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 focus:bg-white/[0.06] disabled:opacity-50 resize-none leading-snug transition-colors"
              />
              <button
                type="submit"
                disabled={!input.trim() || state === 'connecting'}
                className={`shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all ${
                  input.trim() && state !== 'connecting'
                    ? 'bg-[#DFFF00] text-[#07080A] hover:brightness-110 shadow-[0_0_24px_-8px_rgba(223,255,0,0.6)]'
                    : 'bg-white/[0.04] text-white/30'
                }`}
                aria-label="Send"
              >
                {state === 'connecting' ? <Loader2 size={16} className="animate-spin" /> : <Send size={15} />}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
