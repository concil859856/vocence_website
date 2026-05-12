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
import { Loader2, Mic, Send, Square } from 'lucide-react';
import type { Agent } from '../../lib/agents/types';
import { useVoiceChat } from '../../lib/voicechat/useVoiceChat';
import { renderMessage } from '../../lib/voicechat/renderInline';
import { AgentAvatar } from './AgentAvatar';

interface Props {
  agent: Agent;
  authToken: string | null;
}

export function AgentChat({ agent, authToken }: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [input, setInput] = useState('');

  const {
    state,
    messages,
    micLevel,
    error,
    startRecording,
    stopRecording,
    sendText,
    cancel,
  } = useVoiceChat({ enabled: !!authToken, authToken, agentId: agent.id });

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, state]);

  // Tear down on unmount: cancel any in-flight turn so the WS releases
  // the session promptly when the user navigates away.
  useEffect(() => {
    return () => cancel();
  }, [cancel]);

  const onMicClick = async () => {
    if (state === 'recording') {
      await stopRecording();
    } else if (state === 'idle' || state === 'error' || state === 'speaking' || state === 'thinking') {
      await startRecording();
    }
  };

  const onSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendText(text);
  };

  const stateLabel: Record<typeof state, string> = {
    idle: authToken ? 'Tap mic to talk' : 'Sign in to chat',
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
      <div className="px-4 py-3 border-b border-white/10 flex items-center gap-3">
        <AgentAvatar id={agent.id} name={agent.name} size="sm" rounded="full" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white leading-tight truncate">{agent.name}</div>
          <div className="text-[11px] text-[#A7B0B7] leading-tight">{stateLabel[state]}</div>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-sm text-[#A7B0B7] py-8">
            Say something to {agent.name}.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-[#DFFF00] text-[#07080A]'
                  : 'bg-white/[0.06] text-white border border-white/10'
              }`}
            >
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
          </div>
        ))}
      </div>

      <div className="border-t border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-end gap-2">
          <button
            type="button"
            onClick={onMicClick}
            disabled={state === 'connecting' || state === 'uploading' || state === 'transcribing'}
            className={`relative shrink-0 w-12 h-12 rounded-full flex items-center justify-center transition-colors ${
              state === 'recording'
                ? 'bg-red-500 text-white'
                : 'bg-[#DFFF00] text-[#07080A] hover:brightness-110 disabled:opacity-50'
            }`}
            aria-label={state === 'recording' ? 'Stop' : 'Talk'}
          >
            {state === 'recording' ? <Square size={18} fill="currentColor" /> : <Mic size={20} />}
            {state === 'recording' && (
              <span
                className="absolute -inset-1 rounded-full border-2 border-red-400/60 pointer-events-none"
                style={{ transform: `scale(${1 + micLevel * 0.4})` }}
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
                // Enter submits; Shift+Enter inserts a newline.
                // Skip while an IME (CJK) is composing a character.
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
              placeholder={state === 'recording' ? 'Recording…' : 'Type a message…'}
              title="Shift+Enter for new line"
              disabled={state === 'recording' || state === 'connecting' || !authToken}
              className="flex-1 bg-white/[0.04] border border-white/10 rounded-2xl px-4 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 disabled:opacity-50 resize-none leading-snug"
            />
            <button
              type="submit"
              disabled={!input.trim() || state === 'recording' || state === 'connecting'}
              className="shrink-0 w-10 h-10 rounded-full bg-white/[0.06] hover:bg-white/[0.10] text-white disabled:opacity-30 flex items-center justify-center"
              aria-label="Send"
            >
              {state === 'connecting' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
