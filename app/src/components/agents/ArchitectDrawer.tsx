/**
 * ArchitectDrawer, opt-in side panel that lets the user describe an
 * agent in natural language. Previously this drawer fired the
 * one-shot ``/agents/draft`` endpoint on every message and silently
 * mutated the user's agent, so a casual question like "what can you
 * help with?" rewrote everything.
 *
 * Current flow:
 *   • The drawer is a normal chat. Every message goes through the
 *     conversational ``/agents/architect/chat`` endpoint.
 *   • The architect replies in plain English and asks clarifying
 *     questions when needed.
 *   • When (and ONLY when) the architect believes the user asked for
 *     a concrete edit, the response includes ``proposed_changes``.
 *     The UI then renders an "Apply" button on that turn, the user
 *     has to click it before anything mutates.
 *
 * Self-contained: owns its own chat state. Calls ``onApply`` only
 * when the user clicks Apply on a proposed change.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, Send, Sparkles, X } from 'lucide-react';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { AgentConfig, AgentType, ArchitectChatTurn } from '../../lib/agents/types';
import { setArchitectOpen } from '../../lib/uiOverlay';

const newId = () => Math.random().toString(36).slice(2, 11);

type Proposed = {
  name: string;
  type: AgentType;
  config: AgentConfig;
  summary?: string;
};

interface ChatMsg {
  id: string;
  role: 'user' | 'architect';
  text: string;
  /** Present on architect messages where the LLM produced a concrete
   *  edit the user can apply. Cleared after the user clicks Apply,
   *  so the button doesn't linger as a confusing artefact. */
  proposed?: Proposed | null;
  /** True once the user has clicked Apply on this turn's proposal. */
  applied?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current draft so the architect refines instead of starting over. */
  current: { name: string; type: AgentType; config: AgentConfig };
  /** Called when the user clicks Apply on a proposed change. */
  onApply: (next: { name: string; type: AgentType; config: AgentConfig }) => void;
}

export function ArchitectDrawer({ open, onClose, current, onApply }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: newId(),
      role: 'architect',
      text:
        "Hey, I'm here to help you design or refine your agent. Tell me what " +
        "you're building, or ask me anything about how to set it up. I won't " +
        "change anything until you say so.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    setArchitectOpen(open);
    return () => setArchitectOpen(false);
  }, [open]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    const token = getStoredToken();
    if (!token) {
      setError('Sign in to use the architect.');
      return;
    }
    // Build the rolling history the backend uses for context, cap at
    // the last ~10 user/architect turns so latency stays low.
    const history: ArchitectChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'architect')
      .slice(-10)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      }));
    setMessages((prev) => [...prev, { id: newId(), role: 'user', text }]);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const res = await agentsApi.architectChat(token, {
        message: text,
        history,
        existing: { name: current.name, type: current.type, ...current.config },
      });
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: 'architect',
          text: res.reply,
          proposed: res.proposed_changes
            ? {
                name: res.proposed_changes.name,
                type: res.proposed_changes.type,
                config: res.proposed_changes.config,
                summary: res.proposed_changes.summary,
              }
            : null,
        },
      ]);
    } catch (err) {
      const msg = (err as Error).message || 'Architect chat failed';
      setError(msg);
      setMessages((prev) => [...prev, { id: newId(), role: 'architect', text: `(error) ${msg}` }]);
    } finally {
      setBusy(false);
    }
  };

  const applyProposed = (msgId: string) => {
    setMessages((prev) => {
      const target = prev.find((m) => m.id === msgId);
      if (!target?.proposed) return prev;
      onApply({
        name: target.proposed.name,
        type: target.proposed.type,
        config: target.proposed.config,
      });
      return prev.map((m) =>
        m.id === msgId ? { ...m, applied: true, proposed: null } : m,
      );
    });
  };

  return (
    <>
      {open && (
        <div
          className="fixed top-20 left-0 right-0 bottom-0 bg-black/60 z-[45] lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        className={`fixed top-20 right-0 z-[45] bg-[#0B0D10] border-l border-white/10 shadow-2xl transition-transform duration-200 flex flex-col w-full sm:w-[420px] ${
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
        style={{ height: 'calc(100vh - 5rem)' }}
        aria-hidden={!open}
      >
        <header className="px-4 py-3 border-b border-white/10 flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-[#DFFF00]/15 border border-[#DFFF00]/30 flex items-center justify-center">
            <Sparkles size={16} className="text-[#DFFF00]" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-white leading-tight">Agent Architect</div>
            <div className="text-[11px] text-[#A7B0B7] leading-tight">
              {busy ? 'Thinking…' : 'Chat, no changes are applied until you click Apply'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[#A7B0B7] hover:text-white hover:bg-white/5"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m) => (
            <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                  m.role === 'user'
                    ? 'bg-[#DFFF00] text-[#07080A]'
                    : 'bg-white/[0.06] text-white border border-white/10'
                }`}
              >
                {m.text}
              </div>
              {m.role === 'architect' && (m.proposed || m.applied) && (
                <div className="mt-2 max-w-[85%]">
                  {m.proposed && !m.applied ? (
                    <button
                      type="button"
                      onClick={() => applyProposed(m.id)}
                      className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-3.5 py-2 text-xs font-semibold hover:brightness-110 shadow-[0_0_24px_-8px_rgba(223,255,0,0.55)]"
                      title={m.proposed.summary || 'Apply the proposed changes to your draft'}
                    >
                      <Check size={13} />
                      Apply changes
                      {m.proposed.summary ? (
                        <span className="ml-1 font-medium opacity-70 truncate max-w-[180px]">
                          · {m.proposed.summary}
                        </span>
                      ) : null}
                    </button>
                  ) : (
                    <div className="inline-flex items-center gap-1.5 rounded-xl border border-[#DFFF00]/30 bg-[#DFFF00]/[0.08] px-2.5 py-1 text-[11px] font-semibold text-[#DFFF00]/90">
                      <Check size={11} /> Applied
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="bg-white/[0.06] text-white border border-white/10 rounded-2xl px-3.5 py-2 text-sm">
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:120ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:240ms]" />
                </span>
              </div>
            </div>
          )}
          {error && <div className="text-xs text-red-300">{error}</div>}
        </div>

        <form onSubmit={send} className="p-3 border-t border-white/10 flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything, or describe a change…"
            disabled={busy}
            className="flex-1 bg-white/[0.04] border border-white/10 rounded-full px-4 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            className="shrink-0 w-10 h-10 rounded-full bg-[#DFFF00] text-[#07080A] hover:brightness-110 disabled:opacity-30 flex items-center justify-center"
            aria-label="Send"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </form>
      </aside>
    </>
  );
}
