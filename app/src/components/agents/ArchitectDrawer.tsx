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
import { Check, Loader2, RotateCcw, Send, Sparkles, X } from 'lucide-react';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { AgentConfig, AgentType, ArchitectChatTurn } from '../../lib/agents/types';
import { setArchitectOpen } from '../../lib/uiOverlay';

const newId = () => Math.random().toString(36).slice(2, 11);

// Field labels for the proposal card's diff list. Order matters: this
// is the visual order of the bullets so user-recognisable fields like
// Name come first, low-importance ones like LLM and Temperature last.
const PROPOSAL_FIELD_ORDER: { key: keyof AgentConfig | 'name' | 'type'; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'type', label: 'Type' },
  { key: 'voice', label: 'Voice' },
  { key: 'language', label: 'Language' },
  { key: 'purpose', label: 'Purpose' },
  { key: 'system_prompt', label: 'System prompt' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'goal', label: 'Goal' },
  { key: 'success_metric', label: 'Success metric' },
  { key: 'max_iterations', label: 'Max iterations' },
  { key: 'temperature', label: 'Temperature' },
  { key: 'llm_model', label: 'LLM' },
];

// Long-prose fields where a before→after inline diff would be useless
// (system prompts are paragraphs). Show "(rewritten)" or "(set)"
// instead so the card stays scannable.
const PROSE_FIELDS = new Set(['system_prompt', 'knowledge', 'purpose', 'goal', 'success_metric']);

function shortValue(v: unknown, max = 28): string {
  const s = v == null ? '' : String(v);
  if (!s) return '—';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

interface DiffRow { label: string; key: string; before: string; after: string; prose: boolean }

/** Compute which fields the proposal would actually change vs the
 *  current draft. Skips equal fields so a model that re-proposes the
 *  whole config doesn't produce a wall of "no change" rows. */
function diffProposal(
  proposed: Proposed,
  current: { name: string; type: AgentType; config: AgentConfig },
): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const { key, label } of PROPOSAL_FIELD_ORDER) {
    const before =
      key === 'name' ? current.name
      : key === 'type' ? current.type
      : (current.config as any)[key];
    const after =
      key === 'name' ? proposed.name
      : key === 'type' ? proposed.type
      : (proposed.config as any)[key];
    // Normalize null/undefined/empty-string so they're all "no value".
    const beforeStr = before == null ? '' : String(before);
    const afterStr = after == null ? '' : String(after);
    if (beforeStr === afterStr) continue;
    rows.push({ label, key, before: beforeStr, after: afterStr, prose: PROSE_FIELDS.has(String(key)) });
  }
  return rows;
}

interface ProposalCardProps {
  proposed: Proposed;
  current: { name: string; type: AgentType; config: AgentConfig };
  onApply: () => void;
  onDiscard: () => void;
}

/** Compact preview card that lists which fields the proposal will
 *  change before the user commits to Apply. Modelled on the
 *  Copilot-Edits "preview with clarity" pattern (research finding
 *  #10). Long-prose fields collapse to "(rewritten)" / "(set)" so
 *  the card stays scannable. */
function ProposalCard({ proposed, current, onApply, onDiscard }: ProposalCardProps) {
  const diffs = diffProposal(proposed, current);
  const VISIBLE = 6;
  const visible = diffs.slice(0, VISIBLE);
  const overflow = Math.max(0, diffs.length - VISIBLE);

  return (
    <div className="w-full max-w-[85%] rounded-xl border border-[#DFFF00]/25 bg-[#DFFF00]/[0.04] p-3 space-y-2.5">
      {proposed.summary ? (
        <div className="text-xs text-white/85 leading-snug">{proposed.summary}</div>
      ) : null}

      {diffs.length === 0 ? (
        <div className="text-[11px] text-[#A7B0B7] italic">
          No changes vs current draft.
        </div>
      ) : (
        <ul className="space-y-1 text-[11px] border-t border-white/[0.06] pt-2">
          {visible.map((d) => {
            // For prose fields, replace value with a status token so a
            // 2000-char system_prompt doesn't blow up the card.
            const valueText = d.prose
              ? (d.before ? '(rewritten)' : '(set)')
              : `${shortValue(d.before)} → ${shortValue(d.after)}`;
            return (
              <li key={d.key} className="flex items-baseline gap-1.5">
                <span className="text-[#DFFF00]/70 shrink-0">•</span>
                <span className="text-white/80 shrink-0 font-medium">{d.label}</span>
                <span className="text-[#A7B0B7] truncate">{valueText}</span>
              </li>
            );
          })}
          {overflow > 0 ? (
            <li className="text-[11px] text-[#A7B0B7] italic pl-3">
              + {overflow} more {overflow === 1 ? 'field' : 'fields'}
            </li>
          ) : null}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={onApply}
          disabled={diffs.length === 0}
          className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-3.5 py-2 text-xs font-semibold hover:brightness-110 disabled:opacity-40 shadow-[0_0_24px_-8px_rgba(223,255,0,0.55)]"
        >
          <Check size={13} />
          Apply changes
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-transparent text-[#A7B0B7] hover:text-white hover:bg-white/5 px-3 py-2 text-xs font-medium"
        >
          Discard
        </button>
      </div>
    </div>
  );
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
  /** True between the ``proposed_starting`` server event (the model
   *  committed to calling propose_changes) and the ``proposed`` event
   *  (full args parsed). During this window we render the Apply
   *  button disabled with a "preparing…" hint, so the user sees that
   *  a change is on the way instead of watching tokens stream into
   *  the void. */
  proposing?: boolean;
  /** True once the user has clicked Apply on this turn's proposal. */
  applied?: boolean;
  /** True once the user has clicked Discard on this turn's proposal.
   *  Mutually exclusive with ``applied``. Render a muted "Discarded"
   *  pill and trigger a hidden "(discarded)" architect turn so the
   *  model knows to ask what was off, rather than re-proposing the
   *  same thing. Research finding #11 (Cursor + arxiv 2505.06120):
   *  fresh refinement beats follow-up patch prompts. */
  discarded?: boolean;
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
      // Opening message — sets expectations for the full surface the
      // architect can drive (name, type, voice, prompt, language,
      // temperature) AND surfaces the two adjacent features the user
      // owns manually (knowledge file/text, custom webhook tools), so
      // they're not surprised those exist later. Keep it short, the
      // builder UI itself is the better reference.
      text:
        "Hey — I'll help you design your agent. Tell me what you're " +
        "building and I'll handle the name, voice, system prompt, tone, " +
        "and other settings. Knowledge and custom tools are added " +
        "separately in the builder once the base is set up. Nothing " +
        "applies until you click Apply.",
    },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Running summary of user intent, maintained by the model via the
  // ``update_requirements`` tool. Survives the 12-turn history cap on
  // the backend by being re-sent in the request body each turn.
  // Treat as a ref-style atomic value — server emits replacements,
  // we don't merge / append.
  const [requirementsSummary, setRequirementsSummary] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the textarea between 1 and 3 visible lines as the user
  // types. Strategy: reset to scrollHeight on every change, capped at
  // ~5.25rem (= 3 lines @ leading-snug + the 2 × py-2 padding). Beyond
  // 3 lines an overflow-y scroller takes over. Mirrors ChatGPT's
  // composer — input feels lightweight while one-liner, expands when
  // the user actually needs space.
  //
  // overflow-y is set IMPERATIVELY here (not as a Tailwind class)
  // because some browsers reserve scrollbar gutter on ``overflow-y:
  // auto`` even when content fits, which produces a phantom scrollbar
  // on the very first line. We toggle to ``auto`` only once content
  // actually exceeds the cap; ``hidden`` otherwise.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';                    // collapse to measure
    const MAX_PX = 5.25 * 16;                   // ~3 lines
    const needed = el.scrollHeight;
    el.style.height = `${Math.min(needed, MAX_PX)}px`;
    el.style.overflowY = needed > MAX_PX ? 'auto' : 'hidden';
  }, [input]);

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
          // Persisted-by-the-model summary of user intent. Round-trip
          // it every turn so the backend can re-inject into the
          // system context after the 12-turn history truncates the
          // earliest turns. Empty string == "no summary yet".
          requirements_summary: requirementsSummary || undefined,
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
        } else if (evt.type === 'proposed_starting') {
          // Mid-stream — model has committed to a tool call but args
          // are still streaming. Flip the bubble's ``proposing`` flag
          // so the Apply card materializes immediately in a disabled
          // "preparing…" state. The user knows a change is on the
          // way without waiting for the full args blob.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === architectMsgId ? { ...m, proposing: true } : m,
            ),
          );
        } else if (evt.type === 'requirements') {
          // Server says "here's the latest understanding of intent".
          // Replace, don't append — the server side instructs the
          // model that update_requirements is a full replacement.
          setRequirementsSummary(evt.summary);
        } else if (evt.type === 'proposed') {
          proposedAttached = {
            name: evt.data.name,
            type: evt.data.type,
            config: evt.data.config,
            summary: evt.data.summary,
          };
          setMessages((prev) =>
            prev.map((m) =>
              m.id === architectMsgId
                ? { ...m, proposed: proposedAttached, proposing: false }
                : m,
            ),
          );
        } else if (evt.type === 'error') {
          throw new Error(evt.message);
        }
        // ``done`` is a no-op here — the loop just exits naturally.
      }
      // Edge case: stream ended with no tokens AND no proposal. This
      // should never happen under the current system prompt (which
      // requires visible text on every turn), but if the model fails
      // we show an honest error rather than the previous fake-reply
      // "Got it. Want me to make any specific changes?" which made
      // the architect look broken even when it was just empty.
      if (!receivedAnyToken && !proposedAttached) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === architectMsgId
              ? { ...m, text: '(no response — please try again)' }
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

  // Keyboard semantics on the composer match ChatGPT / Slack / Linear:
  //   Enter           → send
  //   Shift+Enter     → newline (default textarea behavior — don't preventDefault)
  //   anything during busy → do nothing (user can edit but not submit)
  const onTextareaKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    if (busy) return;
    const text = input.trim();
    if (!text) return;
    void runArchitectTurn(text);
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

  // Discard a proposal without applying. Mark the bubble as discarded
  // and fire a hidden "(discarded)" turn so the architect knows what
  // happened and asks "what was off?" instead of re-emitting the
  // same proposal. Research-backed (Cursor blog + arxiv 2505.06120):
  // fresh refinement of intent beats iterative patches, but the
  // signal back to the architect has to be explicit.
  const discardProposed = (msgId: string) => {
    let didDiscard = false;
    setMessages((prev) => {
      const target = prev.find((m) => m.id === msgId);
      if (!target?.proposed) return prev;
      didDiscard = true;
      return prev.map((m) =>
        m.id === msgId ? { ...m, discarded: true, proposed: null } : m,
      );
    });
    if (didDiscard) {
      void runArchitectTurn('(discarded)', { synthetic: true });
    }
  };

  // "Start over" — clear the conversation back to the opening greeting,
  // abort any in-flight stream, and re-seed with the FIRST user message
  // of the prior session so the architect can take another swing without
  // making the user re-type their original brief. Per research finding
  // #11 (Cursor): "go back to the plan, refine the plan, run it again"
  // — but the seed is the user's intent, NOT the failed proposal.
  const startOver = () => {
    abortRef.current?.abort();
    setError(null);
    setInput('');
    // Capture the first user message (the original brief) before
    // wiping state. If there isn't one yet, just reset to the
    // greeting.
    const firstBrief = messages.find((m) => m.role === 'user')?.text?.trim();
    const greeting: ChatMsg = {
      id: newId(),
      role: 'architect',
      text:
        "Hey — I'll help you design your agent. Tell me what you're " +
        "building and I'll handle the name, voice, system prompt, tone, " +
        "and other settings. Knowledge and custom tools are added " +
        "separately in the builder once the base is set up. Nothing " +
        "applies until you click Apply.",
    };
    setMessages([greeting]);
    setBusy(false);
    // Wipe the running requirements summary — start-over means the
    // model should re-derive intent from scratch given the fresh brief,
    // not anchor on whatever it thought before the bad proposal.
    setRequirementsSummary('');
    if (firstBrief) {
      // Re-run the original brief. ``runArchitectTurn`` is async but we
      // don't await — let it stream into the freshly cleared chat.
      void runArchitectTurn(firstBrief);
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
        className={`fixed top-20 right-0 z-[45] bg-[#0B0D10] border-l border-white/10 shadow-2xl transition-transform duration-200 flex flex-col w-full sm:w-[480px] lg:w-[560px] xl:w-[620px] ${
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
            onClick={startOver}
            disabled={busy}
            className="p-1.5 rounded-md text-[#A7B0B7] hover:text-white hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Start over with the same brief"
            title="Start over — clears chat and re-runs your original brief"
          >
            <RotateCcw size={16} />
          </button>
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
          {messages.map((m) => {
            // The architect bubble may be empty for a beat between
            // "send" and the first streamed token (high-reasoning
            // gpt-5 can take 20-60 s to start emitting). While the
            // bubble is empty AND we're still busy, render the
            // floating dots INSIDE the bubble — that single shape
            // serves as both the "thinking" indicator and the future
            // home for the tokens. The instant the first token lands,
            // text replaces the dots in the same bubble, no flicker
            // and no double rendering.
            const isPendingArchitect =
              m.role === 'architect' && !m.text && busy;
            return (
            <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-snug whitespace-pre-wrap break-words ${
                  m.role === 'user'
                    ? 'bg-[#DFFF00] text-[#07080A]'
                    : 'bg-white/[0.06] text-white border border-white/10'
                }`}
              >
                {isPendingArchitect ? (
                  <span
                    className="inline-flex items-center gap-1.5 py-0.5"
                    aria-label="thinking"
                  >
                    <span className="architect-dot" />
                    <span className="architect-dot" style={{ animationDelay: '160ms' }} />
                    <span className="architect-dot" style={{ animationDelay: '320ms' }} />
                  </span>
                ) : (
                  m.text
                )}
              </div>
              {m.role === 'architect' && (m.proposed || m.proposing || m.applied || m.discarded) && (
                <div className="mt-2 w-full max-w-[85%] flex flex-wrap items-center gap-2">
                  {m.proposing && !m.proposed && !m.applied && !m.discarded ? (
                    // Mid-stream: model committed to a proposal but args
                    // are still streaming. Show a disabled placeholder
                    // so the user has a visible signal a change is on
                    // the way. Replaced by the full ProposalCard the
                    // moment the args parse cleanly.
                    <div className="inline-flex items-center gap-2 rounded-xl border border-[#DFFF00]/30 bg-[#DFFF00]/[0.06] px-3.5 py-2 text-xs font-semibold text-[#DFFF00]/70 cursor-default select-none">
                      <Loader2 size={13} className="animate-spin" />
                      Preparing changes…
                    </div>
                  ) : m.proposed && !m.applied && !m.discarded ? (
                    <ProposalCard
                      proposed={m.proposed}
                      current={current}
                      onApply={() => applyProposed(m.id)}
                      onDiscard={() => discardProposed(m.id)}
                    />
                  ) : m.applied ? (
                    <div className="inline-flex items-center gap-1.5 rounded-xl border border-[#DFFF00]/30 bg-[#DFFF00]/[0.08] px-2.5 py-1 text-[11px] font-semibold text-[#DFFF00]/90">
                      <Check size={11} /> Applied
                    </div>
                  ) : m.discarded ? (
                    <div className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-[#A7B0B7]">
                      Discarded
                    </div>
                  ) : null}
                </div>
              )}
            </div>
            );
          })}
          {error && <div className="text-xs text-red-300">{error}</div>}
        </div>

        <form
          onSubmit={send}
          className="p-3 border-t border-white/10 flex items-end gap-2"
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onTextareaKey}
            placeholder="Ask anything, or describe a change…"
            disabled={busy}
            rows={1}
            className="flex-1 bg-white/[0.04] border border-white/10 rounded-2xl px-4 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 disabled:opacity-50 resize-none leading-snug max-h-[5.25rem]"
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
