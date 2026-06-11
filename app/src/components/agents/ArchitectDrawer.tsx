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

// Cosmetic phase label for the thinking bubble. The architect is a
// reasoning model, so it goes through real internal phases (parse
// request → consult draft → consider options → compose). We don't
// have telemetry from OpenAI for these phases, but rotating through
// plausible labels at human-readable cadence makes the wait feel
// purposeful rather than stuck. The labels are advisory only — no
// behavior depends on which one is showing.
function thinkingPhaseLabel(elapsedSec: number): string {
  if (elapsedSec < 4) return 'Reading your message…';
  if (elapsedSec < 12) return 'Considering your draft…';
  if (elapsedSec < 30) return 'Weighing options…';
  if (elapsedSec < 60) return 'Composing a response…';
  return 'Still thinking…';
}

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
  // Wall-clock seconds since the current request was sent. The
  // architect runs on a high-reasoning model (gpt-5 / thinking
  // effort=high), responses regularly take 30-120 s. Without a
  // visible counter the user can't tell whether it's still thinking
  // or the request died, so we show "Thinking… 12s" in the
  // placeholder bubble.
  const [thinkingSec, setThinkingSec] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Tick the thinking-elapsed counter while a request is in flight.
  // Resets to 0 the moment ``busy`` flips on, freezes on the final
  // value when it flips off (so the user briefly sees the total
  // before the bubble is replaced by the assistant reply).
  useEffect(() => {
    if (!busy) return;
    setThinkingSec(0);
    const t = window.setInterval(() => setThinkingSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [busy]);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy, open]);

  useEffect(() => {
    setArchitectOpen(open);
    return () => setArchitectOpen(false);
  }, [open]);

  // Cancel any in-flight architect stream when the drawer is closed
  // (user dismissed) or the component unmounts. Otherwise the request
  // keeps running and the user is billed for tokens they'll never see.
  useEffect(() => {
    if (!open) abortRef.current?.abort();
    return () => abortRef.current?.abort();
  }, [open]);

  // ``abortRef`` lets us cancel an in-flight streaming call if the
  // user closes the drawer or sends a new message before the previous
  // one finishes.
  const abortRef = useRef<AbortController | null>(null);

  // Send a turn through the streaming endpoint. Tokens arrive as
  // ``token`` events and we append them to the live architect bubble.
  // A ``proposed`` event materializes the Apply button mid-stream.
  // ``done`` closes the turn; ``error`` surfaces the message.
  //
  // ``synthetic`` (default false) marks the call as a hidden client-
  // triggered message — e.g. "(applied)" after the user clicks Apply.
  // We send it through the LLM but don't echo it as a user bubble.
  const runArchitectTurn = async (
    text: string,
    { synthetic = false }: { synthetic?: boolean } = {},
  ) => {
    const token = getStoredToken();
    if (!token) {
      setError('Sign in to use the architect.');
      return;
    }
    // Cancel any prior in-flight stream so the next call's tokens
    // don't interleave with a stale one's tail.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // History is built from the visible chat; synthetic ("(applied)")
    // markers ARE included so the model knows what was done.
    const history: ArchitectChatTurn[] = messages
      .filter((m) => m.role === 'user' || m.role === 'architect')
      .slice(-10)
      .map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.text,
      }));

    // For real user input we add a user bubble immediately. Synthetic
    // turns stay invisible — we go straight to the architect bubble.
    if (!synthetic) {
      setMessages((prev) => [...prev, { id: newId(), role: 'user', text }]);
    }

    // Pre-create an empty architect bubble that tokens will accumulate
    // into. Its id is the handle the streaming loop appends to. We
    // create it AFTER showing the user bubble so the chat order is
    // correct in StrictMode (the buffered user bubble doesn't get
    // re-ordered ahead).
    const architectMsgId = newId();
    setMessages((prev) => [
      ...prev,
      { id: architectMsgId, role: 'architect', text: '' },
    ]);
    setInput('');
    setBusy(true);
    setError(null);

    let receivedAnyToken = false;
    let proposedAttached: Proposed | null = null;
    try {
      for await (const evt of agentsApi.architectChatStream(
        token,
        {
          message: text,
          history,
          existing: { name: current.name, type: current.type, ...current.config },
        },
        ctrl.signal,
      )) {
        if (evt.type === 'token') {
          receivedAnyToken = true;
          // Functional update — concurrent state changes (e.g. user
          // typing in the input) can't race against the appended chunk.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === architectMsgId ? { ...m, text: (m.text || '') + evt.delta } : m,
            ),
          );
        } else if (evt.type === 'proposed') {
          proposedAttached = {
            name: evt.data.name,
            type: evt.data.type,
            config: evt.data.config,
            summary: evt.data.summary,
          };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === architectMsgId ? { ...m, proposed: proposedAttached } : m,
            ),
          );
        } else if (evt.type === 'error') {
          throw new Error(evt.message);
        }
        // ``done`` is a no-op here — the loop just exits naturally.
      }
      // Edge case: stream ended with no tokens AND no proposal (model
      // emitted nothing useful). Replace the empty bubble with a
      // gentle nudge so the user isn't staring at a blank shape.
      if (!receivedAnyToken && !proposedAttached) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === architectMsgId
              ? { ...m, text: 'Got it. Want me to make any specific changes?' }
              : m,
          ),
        );
      }
    } catch (err) {
      const msg = (err as Error).message || 'Architect chat failed';
      setError(msg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === architectMsgId ? { ...m, text: `(error) ${msg}` } : m,
        ),
      );
    } finally {
      setBusy(false);
      // Clear the controller ref only if it's still the current one
      // (a new call may have already supplanted us).
      if (abortRef.current === ctrl) abortRef.current = null;
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    await runArchitectTurn(text);
  };

  const applyProposed = (msgId: string) => {
    let appliedSummary: string | undefined;
    setMessages((prev) => {
      const target = prev.find((m) => m.id === msgId);
      if (!target?.proposed) return prev;
      appliedSummary = target.proposed.summary;
      onApply({
        name: target.proposed.name,
        type: target.proposed.type,
        config: target.proposed.config,
      });
      return prev.map((m) =>
        m.id === msgId ? { ...m, applied: true, proposed: null } : m,
      );
    });
    // Close the loop — fire a hidden synthetic turn so the architect
    // confirms and asks what's next. CHAT_STREAM_SYSTEM treats
    // "(applied)" as the canonical post-Apply trigger and replies
    // briefly without proposing again. Without this the architect
    // goes silent after Apply, which feels broken.
    if (appliedSummary !== undefined) {
      void runArchitectTurn('(applied)', { synthetic: true });
    }
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
              <div className="bg-white/[0.06] text-white border border-white/10 rounded-2xl px-3.5 py-2 text-sm flex items-center gap-2 min-w-[180px]">
                <span className="inline-flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:120ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60 animate-pulse [animation-delay:240ms]" />
                </span>
                <span className="text-[#A7B0B7] text-xs">
                  {thinkingPhaseLabel(thinkingSec)}
                  {thinkingSec > 0 ? (
                    <span className="ml-1 opacity-60">· {thinkingSec}s</span>
                  ) : null}
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
