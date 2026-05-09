/**
 * ArchitectDrawer — opt-in side panel that lets the user describe an
 * agent in natural language and have the form filled / refined for them.
 *
 * Self-contained: owns its own chat state, calls the /agents/draft
 * endpoint, and emits a single onApply patch when the LLM responds.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X } from 'lucide-react';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { AgentConfig, AgentType } from '../../lib/agents/types';
import { setArchitectOpen } from '../../lib/uiOverlay';

const newId = () => Math.random().toString(36).slice(2, 11);

interface ChatMsg {
  id: string;
  role: 'user' | 'architect';
  text: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current draft so the architect refines instead of starting over. */
  current: { name: string; type: AgentType; config: AgentConfig };
  /** Called when the architect produces a new draft. */
  onApply: (next: { name: string; type: AgentType; config: AgentConfig }) => void;
}

export function ArchitectDrawer({ open, onClose, current, onApply }: Props) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: newId(),
      role: 'architect',
      text: "Tell me what your agent should do. I'll fill in the form on the left, and you can keep editing it directly.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, open]);

  // Tell the floating Vocence Assistant launcher to step out of the way
  // while this drawer is on screen.
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
    setMessages((prev) => [...prev, { id: newId(), role: 'user', text }]);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const res = await agentsApi.draft(token, {
        description: text,
        type_hint: current.type,
        existing: { name: current.name, type: current.type, ...current.config },
      });
      onApply({ name: res.name, type: res.type, config: res.config });
      setMessages((prev) => [...prev, { id: newId(), role: 'architect', text: res.note || 'Draft updated.' }]);
    } catch (err) {
      const msg = (err as Error).message || 'Draft failed';
      setError(msg);
      setMessages((prev) => [...prev, { id: newId(), role: 'architect', text: `(error) ${msg}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* Mobile backdrop — covers everything below the navbar (z-50) */}
      {open && (
        <div
          className="fixed top-20 left-0 right-0 bottom-0 bg-black/60 z-[45] lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      {/* Drawer — sits below the navbar (top-20 = 80px), z-[45] keeps it
          under the navbar's z-50 so the user menu stays clickable. */}
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
            <div className="text-[11px] text-[#A7B0B7] leading-tight">{busy ? 'Drafting…' : 'Describe or refine'}</div>
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
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                m.role === 'user'
                  ? 'bg-[#DFFF00] text-[#07080A]'
                  : 'bg-white/[0.06] text-white border border-white/10'
              }`}>
                {m.text}
              </div>
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
            placeholder="e.g. 'make it more concise' or describe a new agent"
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
