/**
 * AgentDetail, /studio/agents/:id
 *
 *   • Header is one breathing line: gradient avatar, name + status dot,
 *     small type label, kebab menu for pause / delete.
 *   • Tabs: Chat (knowledge) or Runs (goal), and Settings. The old
 *     Activity tab folded into Settings as a small "Stats" card.
 *   • Settings has an explicit Save button. The page guards against
 *     leaving with unsaved changes, confirms on tab switch, on the
 *     Back link, and on browser-level navigation (refresh / close /
 *     external URL) via beforeunload.
 */

import { useEffect, useRef, useState } from 'react';
import { useConfirm } from '../../hooks/useConfirm';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, BookOpen, Clock, Loader2, MoreVertical, Pause, Play, Sparkles, Target, Trash2 } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AgentCall } from '../../components/agents/AgentCall';
import { AgentChat } from '../../components/agents/AgentChat';
import { useAgentSession } from '../../lib/voicechat/useAgentSession';
import { AgentConfigForm } from '../../components/agents/AgentConfigForm';
import { ArchitectDrawer } from '../../components/agents/ArchitectDrawer';
import { AgentKnowledgePanel } from '../../components/agents/AgentKnowledgePanel';
import { AgentEmbedTokensPanel } from '../../components/agents/AgentEmbedTokensPanel';
import { AgentCallsTab } from '../../components/agents/AgentCallsTab';
import { AgentAnalyticsTab } from '../../components/agents/AgentAnalyticsTab';
import { AgentWebhooksTab } from '../../components/agents/AgentWebhooksTab';
import { useAuth } from '../../contexts/AuthContext';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import { avatarGradientPairFor } from '../../data/sampleVoices';
import type { Agent, AgentConfig, AgentRun, AgentType } from '../../lib/agents/types';

type Tab = 'call' | 'chat' | 'runs' | 'calls' | 'analytics' | 'webhooks' | 'settings';

const STATUS_DOT: Record<Agent['status'], string> = {
  active: 'bg-emerald-400',
  paused: 'bg-amber-400',
  draft: 'bg-white/30',
  archived: 'bg-white/15',
};

const STATUS_LABEL: Record<Agent['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  draft: 'Draft',
  archived: 'Archived',
};

// Chip styling per status so the hero conveys the agent's state at a
// glance without needing the kebab menu. Mirrors the dot-color palette
// (active/paused/draft/archived) for cohesion with the rest of the UI.
const STATUS_CHIP: Record<Agent['status'], string> = {
  active:   'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
  paused:   'bg-amber-500/15 text-amber-200 border-amber-400/30',
  draft:    'bg-white/[0.06] text-[#A7B0B7] border-white/10',
  archived: 'bg-white/[0.04] text-[#666] border-white/10',
};

function formatRelative(iso?: string | null): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(t).toLocaleDateString();
}

/** Strip vendor/owner prefixes off an LLM model id so the chip in the
 *  hero stays readable. ``meta-llama/Llama-3-70B`` → ``Llama-3-70B``. */
function shortenModelLabel(id: string | undefined | null): string {
  if (!id) return 'default';
  const tail = id.split('/').pop() || id;
  return tail.length > 24 ? tail.slice(0, 22) + '…' : tail;
}

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('call');
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  // Track unsaved changes in the Settings tab. The form lifts this up
  // so we can guard navigation (tab switch, back link, browser unload).
  const [settingsDirty, setSettingsDirty] = useState(false);

  // Browser-level guard: warns on tab close / refresh / external URL.
  useEffect(() => {
    if (!settingsDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore custom strings, just need to set
      // returnValue so the native dialog appears.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [settingsDirty]);

  const confirmLeaveIfDirty = async (): Promise<boolean> => {
    if (!settingsDirty) return true;
    const ok = await confirm({ title: 'Unsaved Changes', message: 'You have unsaved changes in Settings. Leave anyway?', confirmLabel: 'Leave', confirmVariant: 'danger' });
    if (ok) setSettingsDirty(false);
    return ok;
  };

  useEffect(() => { setToken(getStoredToken()); }, [user?.id]);

  // Shared session controller, single WS / single ``started`` state
  // across both the Call tab and the Chat tab. Without this, each tab
  // had its own ``useVoiceChat`` and they couldn't see each other's
  // progress, so switching from Call→Chat showed the Start button on
  // Chat even while the Call tab's session was still active.
  // Passing an empty agentId while the agent loads is safe, the
  // hook stays inert (enabled=false) until the user clicks Start,
  // which can only happen after the agent has loaded.
  const session = useAgentSession(agent?.id ?? '', token);

  useEffect(() => {
    if (!id || !token) return;
    let cancelled = false;
    agentsApi.get(token, id)
      .then((res) => { if (!cancelled) setAgent(res.agent); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load'); });
    return () => { cancelled = true; };
  }, [id, token]);

  useEffect(() => {
    if (!token) return;
    agentsApi.listModels(token).then((r) => setModels(r.models)).catch(() => {});
  }, [token]);

  // Default tab: chat for knowledge, runs for goal.
  useEffect(() => {
    if (agent && agent.type === 'goal') setActiveTab('runs');
  }, [agent?.type]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!agent) {
    return (
      <div className="min-h-screen bg-[#07080A] pt-20">
        <StudioShell activeView="agents">
          <div className="flex items-center justify-center py-20">
            {error
              ? <div className="text-red-300 text-sm">{error}</div>
              : <Loader2 size={28} className="animate-spin text-[#A7B0B7]" />
            }
          </div>
        </StudioShell>
      </div>
    );
  }

  const typeLabel = agent.type === 'goal' ? 'Goal agent' : 'Knowledge agent';
  const tabs: { id: Tab; label: string; show: boolean }[] = [
    // Call mode is the primary voice-product experience (industry
    // standard, ElevenLabs / Vapi / Retell all lead with it). Chat
    // stays as the secondary text-iteration surface.
    { id: 'call', label: 'Call', show: agent.type === 'knowledge' },
    { id: 'chat', label: 'Chat', show: agent.type === 'knowledge' },
    { id: 'runs', label: 'Runs', show: agent.type === 'goal' },
    // Calls + Analytics shown for every agent (regardless of type).
    // ``voice_call_logs`` is written for goal-agent runs too if they
    // ever open a voice WS, and the table degrades to an empty
    // state cleanly when there are no rows.
    { id: 'calls', label: 'Calls', show: true },
    { id: 'analytics', label: 'Analytics', show: true },
    { id: 'webhooks', label: 'Webhooks', show: true },
    { id: 'settings', label: 'Settings', show: true },
  ];

  // Agent identity gradient, same pair the avatar uses, so the hero
  // backdrop "matches" the avatar without us picking colors manually.
  const grad = avatarGradientPairFor(`agent-${agent.id}`);
  const isActive = agent.status === 'active';

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
    <StudioShell activeView="agents">
      <div className="max-w-6xl">
        {/* Back link, gated by the unsaved-changes confirm dialog. */}
        <Link
          to="/studio/agents"
          onClick={(e) => {
            if (settingsDirty) {
              e.preventDefault();
              void confirmLeaveIfDirty().then((ok) => { if (ok) navigate('/studio/agents'); });
            }
          }}
          className="text-[#A7B0B7] hover:text-white inline-flex items-center gap-1.5 text-sm mb-3"
        >
          <ArrowLeft size={14} /> All agents
        </Link>

        {/* ── HERO ─────────────────────────────────────────────────────
            Identity-tinted hero. The agent's avatar gradient blurs out
            behind the content as a soft backdrop, then a dark gradient
            fades it back into the page background. Bleeds to the
            content area's edges via -mx-6/-mx-10 like the playbook
            detail hero, so the agent's color reads as a banner.

            The blurred layer lives in its own overflow-hidden wrapper
            so the kebab/menu popovers inside the hero can drop down
            past the bottom edge without being clipped. */}
        <div className="relative -mx-6 lg:-mx-10 px-6 lg:px-10 pb-3 mb-3">
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
            <div className={`absolute inset-0 bg-gradient-to-br ${grad.outer} opacity-20 blur-3xl saturate-150`} />
            <div className="absolute inset-0 bg-gradient-to-b from-[#07080A]/60 via-[#07080A]/85 to-[#07080A]" />
          </div>

          <div className="relative pt-3 flex items-center gap-3 pr-10">
            <div className="shadow-lg shadow-black/40 rounded-full shrink-0">
              <AgentAvatar id={agent.id} name={agent.name} size="md" rounded="full" />
            </div>

            <div className="flex-1 min-w-0">
              {/* Kicker line, chips on a single row alongside the
                  status pulse-dot. Compact for the small-hero layout. */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-white/70">Agent</span>
                <span
                  className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-[0.14em] text-indigo-300 bg-indigo-500/15 border border-indigo-400/30"
                  title="Voice agents are in beta, features and pricing may change."
                >
                  Beta
                </span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium ${
                  agent.type === 'goal'
                    ? 'bg-purple-500/15 text-purple-200 border border-purple-400/30'
                    : 'bg-[#DFFF00]/15 text-[#DFFF00] border border-[#DFFF00]/30'
                }`}>
                  {agent.type === 'goal' ? <Target size={9} /> : <Sparkles size={9} />}
                  {typeLabel}
                </span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium border ${STATUS_CHIP[agent.status]}`}>
                  <span className="relative inline-flex">
                    <span className={`block w-1.5 h-1.5 rounded-full ${STATUS_DOT[agent.status]}`} />
                    {isActive && (
                      <span className={`absolute inset-0 rounded-full ${STATUS_DOT[agent.status]} animate-ping opacity-60`} />
                    )}
                  </span>
                  {STATUS_LABEL[agent.status]}
                </span>
              </div>

              <h1 className="text-lg sm:text-xl font-bold text-white leading-tight tracking-tight truncate mt-0.5">
                {agent.name}
              </h1>

              {/* Purpose + stats collapsed onto adjacent rows so the
                  whole hero stays one short stack. Purpose truncates
                  to one line; full text still lives in Settings. */}
              {agent.config.purpose && (
                <p className="text-[#A7B0B7] text-xs mt-0.5 leading-snug truncate">{agent.config.purpose}</p>
              )}

              {/* Footer stats, runs / last-run are GOAL-agent concepts.
                  Knowledge (voice-chat) agents never run in that sense,
                  so 0 runs · never · model_id was pure noise. We now
                  show the goal-agent stats only when relevant; the LLM
                  model lives in Settings where it belongs. */}
              {agent.type === 'goal' && (
                <div className="flex items-center gap-1.5 mt-1 text-[11px] text-[#A7B0B7] flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <Play size={10} />
                    <span className="tabular-nums text-white font-medium">{agent.run_count}</span>
                    run{agent.run_count === 1 ? '' : 's'}
                  </span>
                  <span className="text-[#444]">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={10} />
                    <span className="text-white">{formatRelative(agent.last_run_at)}</span>
                  </span>
                  <span className="text-[#444]">·</span>
                  <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-white/[0.05] text-[#A7B0B7] border border-white/10" title={agent.config.llm_model}>
                    {shortenModelLabel(agent.config.llm_model)}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Top-right controls: Guide link + Kebab. Guide opens the
              docs in a new tab so the user keeps their unsaved edits
              and live chat session intact. */}
          <div className="absolute top-2 right-4 lg:right-8 z-20 flex items-center gap-1.5">
            <Link
              to="/docs/guide-agents"
              target="_blank"
              rel="noopener"
              title="Open the Agents guide in a new tab"
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/20 px-2.5 py-1.5 text-[11px] text-[#A7B0B7] hover:text-white transition-colors"
            >
              <BookOpen size={12} />
              <span className="hidden sm:inline">Guide</span>
            </Link>
            <KebabMenu
              agent={agent}
              token={token}
              onUpdate={(a) => setAgent(a)}
              onDelete={() => navigate('/studio/agents')}
            />
          </div>
        </div>

        {/* Tabs, Runs gets a count chip; Settings shows an "unsaved"
            indicator dot when the form is dirty so the user sees they
            have pending edits without leaving the current tab. */}
        <div className="border-b border-white/10 mb-6 flex gap-1">
          {tabs.filter((t) => t.show).map((t) => {
            const isCurrent = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  // Switching AWAY from Settings while dirty asks for confirm.
                  if (activeTab === 'settings' && t.id !== 'settings' && settingsDirty) {
                    void confirmLeaveIfDirty().then((ok) => { if (ok) setActiveTab(t.id); });
                    return;
                  }
                  setActiveTab(t.id);
                }}
                className={`relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                  isCurrent
                    ? 'border-[#DFFF00] text-white'
                    : 'border-transparent text-[#A7B0B7] hover:text-white'
                }`}
              >
                {t.label}
                {t.id === 'runs' && agent.run_count > 0 && (
                  <span className="text-[10px] tabular-nums px-1.5 py-0.5 rounded bg-white/[0.06] text-[#A7B0B7]">
                    {agent.run_count}
                  </span>
                )}
                {t.id === 'settings' && settingsDirty && (
                  <span
                    className="w-1.5 h-1.5 rounded-full bg-amber-400"
                    title="You have unsaved changes"
                    aria-label="Unsaved changes"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content. We MOUNT the chat / runs panel continuously and
            only toggle visibility with `hidden`, unmounting <AgentChat>
            when the user clicks Settings would (a) drop the messages
            state, (b) close the WebSocket, and (c) wipe the server's
            in-memory conversation array. The user would come back to a
            blank chat with an amnesiac agent. Hiding instead of
            unmounting keeps the WS alive, the audio worklet running,
            and the agent's session memory intact.

            Paused / archived agents see a blocked state in the active
            tab, backend also enforces this; the frontend check is just
            to avoid a wasted WS attempt. Drafts are NOT blocked so
            users can test an agent before activating.

            Settings IS conditionally mounted because (a) it has no
            persistent socket / memory worth preserving, and (b) keeping
            it mounted while the user types in chat would keep
            `settingsDirty` stuck. */}
        {agent.type === 'knowledge' && (
          <>
            <div className={activeTab === 'call' ? '' : 'hidden'}>
              {isAgentBlocked(agent.status) ? (
                <AgentBlockedCard agent={agent} token={token} onUpdate={(a) => setAgent(a)} />
              ) : (
                <AgentCall
                  agent={agent}
                  session={session}
                  onSwitchToChat={() => setActiveTab('chat')}
                />
              )}
            </div>
            <div className={activeTab === 'chat' ? '' : 'hidden'}>
              {isAgentBlocked(agent.status) ? (
                <AgentBlockedCard agent={agent} token={token} onUpdate={(a) => setAgent(a)} />
              ) : (
                <AgentChat agent={agent} session={session} />
              )}
            </div>
          </>
        )}
        {agent.type === 'goal' && (
          <div className={activeTab === 'runs' ? '' : 'hidden'}>
            {isAgentBlocked(agent.status) ? (
              <AgentBlockedCard agent={agent} token={token} onUpdate={(a) => setAgent(a)} />
            ) : (
              <RunsTab agent={agent} token={token} />
            )}
          </div>
        )}
        {activeTab === 'calls' && (
          <AgentCallsTab agentId={agent.id} agentName={agent.name} token={token} />
        )}
        {activeTab === 'analytics' && (
          <AgentAnalyticsTab agentId={agent.id} token={token} />
        )}
        {activeTab === 'webhooks' && (
          <AgentWebhooksTab agentId={agent.id} token={token} />
        )}
        {activeTab === 'settings' && (
          <SettingsTab
            agent={agent}
            token={token}
            models={models}
            onUpdated={(a) => setAgent(a)}
            onDirtyChange={setSettingsDirty}
          />
        )}
      </div>
    </StudioShell>
    {confirmDialog}
    </div>
  );
}

function KebabMenu({
  agent,
  token,
  onUpdate,
  onDelete,
}: {
  agent: Agent;
  token: string | null;
  onUpdate: (a: Agent) => void;
  onDelete: () => void;
}) {
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const isPaused = agent.status === 'paused';
  const isActive = agent.status === 'active';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = async () => {
    if (!token) return;
    setBusy(true);
    setOpen(false);
    try {
      const next = isActive ? 'paused' : 'active';
      const { agent: updated } = await agentsApi.update(token, agent.id, { status: next });
      onUpdate(updated);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!token) return;
    setOpen(false);
    if (!await confirm({ title: 'Delete Agent', message: `Delete agent "${agent.name}"? This can't be undone.`, confirmLabel: 'Delete', confirmVariant: 'danger' })) return;
    setBusy(true);
    try {
      await agentsApi.remove(token, agent.id);
      onDelete();
    } catch (err) {
      alert((err as Error).message || 'Failed to delete');
      setBusy(false);
    }
  };

  const canToggle = !(agent.status === 'archived' || agent.status === 'draft');

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => !busy && setOpen((v) => !v)}
        disabled={busy}
        className="w-9 h-9 rounded-full text-[#A7B0B7] hover:text-white hover:bg-white/5 flex items-center justify-center disabled:opacity-50"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <MoreVertical size={18} />}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1.5 w-44 rounded-lg border border-white/15 bg-[#0B0D10] shadow-2xl shadow-black/50 backdrop-blur-xl py-1 z-30"
        >
          {canToggle && (
            <button
              type="button"
              role="menuitem"
              onClick={toggle}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-white hover:bg-white/5 text-left"
            >
              {isActive ? <Pause size={14} /> : <Play size={14} />}
              {isActive ? 'Pause agent' : isPaused ? 'Resume agent' : 'Activate'}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={remove}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-300 hover:bg-red-500/10 text-left"
          >
            <Trash2 size={14} /> Delete
          </button>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; message: string };

function SettingsTab({
  agent,
  token,
  models,
  onUpdated,
  onDirtyChange,
}: {
  agent: Agent;
  token: string | null;
  models: { id: string; label: string }[];
  onUpdated: (a: Agent) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // Migrate legacy agents that pre-date the ``first_message`` feature:
  // their config_json has no key, so the editable input would show empty
  // and silently propagate that as "user wants silent start" on the
  // next save. Backfill with the default greeting on the EDIT side so
  // the user sees what the runtime backend is using and can keep,
  // change, or explicitly clear it.
  const hydrateConfig = (c: AgentConfig): AgentConfig =>
    c.first_message === undefined
      ? { ...c, first_message: 'Hello, how may I assist you today?' }
      : c;

  const [name, setName] = useState(agent.name);
  const [type, setType] = useState<AgentType>(agent.type);
  const [config, setConfig] = useState<AgentConfig>(() => hydrateConfig(agent.config));
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);
  // Architect drawer for refining the existing agent in natural
  // language. Same drawer used by AgentBuilder; here it patches the
  // local edit state and flips ``dirty`` so the user reviews the
  // change in the form and saves explicitly, we never auto-save
  // architect drafts on top of a live agent.
  const [architectOpen, setArchitectOpen] = useState(false);

  // Lift dirty state up so the parent can guard navigation.
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // If the source agent changes from outside (e.g. status toggle from
  // the kebab menu), reset our local form state to it, but only when
  // we don't have unsaved changes, so we never silently overwrite the
  // user's edits.
  useEffect(() => {
    if (dirty) return;
    setName(agent.name);
    setType(agent.type);
    setConfig(hydrateConfig(agent.config));
  }, [agent.id, agent.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!token || !dirty) return;
    setSaveState({ kind: 'saving' });
    try {
      const { agent: updated } = await agentsApi.update(token, agent.id, { name, config });
      onUpdated(updated);
      setSaveState({ kind: 'saved', at: Date.now() });
      setDirty(false);
      // Auto-dismiss the confirmation chip after 4s so the bottom bar
      // can return to ``idle`` and disappear instead of squatting on
      // screen with a stale "Saved 12m ago". The SaveBar uses ``idle``
      // + clean to hide itself.
      window.setTimeout(() => {
        setSaveState((s) => (s.kind === 'saved' ? { kind: 'idle' } : s));
      }, 4000);
    } catch (err) {
      setSaveState({ kind: 'error', message: (err as Error).message || 'Save failed' });
    }
  };

  // Cmd/Ctrl + S → save, when dirty. Standard editor muscle memory.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className={`max-w-3xl space-y-4 pb-28 transition-[margin] duration-200 ${
        architectOpen
          ? 'lg:ml-0 lg:mr-[536px] xl:mr-[596px] 2xl:mr-[636px]'
          : ''
      }`}
    >
      {/* Architect launcher, sits above the form so the user sees
          "Ask Architect" before scrolling. Disabled while a save is
          in flight to avoid concurrent edits. */}
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() => setArchitectOpen((v) => !v)}
          className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium border transition-colors ${
            architectOpen
              ? 'bg-[#DFFF00]/15 text-[#DFFF00] border-[#DFFF00]/30'
              : 'bg-white/[0.04] hover:bg-white/[0.08] text-white border-white/10'
          }`}
          title="Refine this agent in natural language"
        >
          <Sparkles size={13} />
          {architectOpen ? 'Hide Architect' : 'Ask Architect'}
        </button>
      </div>

      <AgentConfigForm
        name={name}
        type={type}
        config={config}
        availableModels={models}
        agentId={agent.id}
        onChange={(patch) => {
          setDirty(true);
          if (patch.name !== undefined) setName(patch.name);
          if (patch.type !== undefined) setType(patch.type);
          if (patch.config) setConfig((prev) => ({ ...prev, ...patch.config }));
        }}
      />

      {/* External knowledge sources, PDF/URL/sitemap/text uploads
          flowing through the vocence/knowledge-ingestion pod. Hidden
          when the pod isn't deployed (panel renders its own notice). */}
      <AgentKnowledgePanel agentId={agent.id} token={getStoredToken()} />

      {/* Embed tokens, agent owner generates these to drop the agent
          into a customer-facing website via the @vocence/widget script. */}
      <AgentEmbedTokensPanel agentId={agent.id} token={getStoredToken()} />

      {/* Stats, folded in from the old Activity tab */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-3">Stats</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <Stat label="Created" value={fmtDate(agent.created_at)} />
          <Stat label="Last updated" value={fmtDate(agent.updated_at)} />
          <Stat label="Last run" value={agent.last_run_at ? fmtDate(agent.last_run_at) : '—'} />
          <Stat label="Total runs" value={String(agent.run_count)} />
          <Stat label="Voice" value={agent.config.voice || 'default'} />
          <Stat label="Temperature" value={agent.config.temperature.toFixed(2)} />
        </div>
      </div>

      {/* Sticky save bar. Anchored to the viewport bottom while the user
          scrolls the form, so the action is always reachable. Shows
          quiet state when saved, urgent amber tinge when unsaved.
          Shifts left when the Architect drawer is open so the action
          stays reachable instead of hiding under the drawer. */}
      <SaveBar
        dirty={dirty}
        saveState={saveState}
        onSave={() => void save()}
        shifted={architectOpen}
      />

      <ArchitectDrawer
        open={architectOpen}
        onClose={() => setArchitectOpen(false)}
        current={{ name, type, config }}
        onApply={(next) => {
          setName(next.name);
          setType(next.type);
          setConfig(hydrateConfig(next.config));
          setDirty(true);
        }}
      />
    </div>
  );
}

function SaveBar({
  dirty,
  saveState,
  onSave,
  shifted = false,
}: {
  dirty: boolean;
  saveState: SaveState;
  onSave: () => void;
  /** When the Architect drawer is open on ≥ lg, shift this bar left
   *  so the drawer doesn't sit on top of the Save button. */
  shifted?: boolean;
}) {
  const saving = saveState.kind === 'saving';
  // Hide the bar entirely when there's nothing to communicate. We show
  // it when (a) the form is dirty, (b) a save is in flight, (c) a save
  // just succeeded (briefly, auto-cleared by SettingsTab after 4s), or
  // (d) the last save errored. Otherwise the bar is just visual noise
  // permanently squatting at the bottom of the page.
  const shouldShow =
    dirty ||
    saveState.kind === 'saving' ||
    saveState.kind === 'saved' ||
    saveState.kind === 'error';
  if (!shouldShow) return null;
  return (
    <div
      className={`fixed bottom-4 z-40 max-w-3xl w-[calc(100%-2rem)] pointer-events-none transition-[left,transform] duration-200 ${
        shifted
          ? 'left-1/2 -translate-x-1/2 lg:left-auto lg:right-[440px] lg:translate-x-0'
          : 'left-1/2 -translate-x-1/2'
      }`}
    >
      <div className={`pointer-events-auto rounded-2xl border backdrop-blur-md shadow-2xl shadow-black/40 px-4 py-3 flex items-center gap-3 transition-colors ${
        dirty
          ? 'border-amber-400/30 bg-[#1a1308]/90'
          : 'border-white/10 bg-[#0B0D10]/85'
      }`}>
        <SaveStatus state={saveState} dirty={dirty} />
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          className="ml-auto inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}

function SaveStatus({ state, dirty }: { state: SaveState; dirty: boolean }) {
  const [, setTick] = useState(0);
  // Re-render every ~5 s so "Saved 12s ago" stays fresh.
  useEffect(() => {
    if (state.kind !== 'saved') return;
    const handle = window.setInterval(() => setTick((n) => n + 1), 5000);
    return () => window.clearInterval(handle);
  }, [state.kind]);

  if (state.kind === 'error') {
    return <span className="text-sm text-red-300 truncate">{state.message}</span>;
  }
  if (dirty) {
    return (
      <span className="text-sm text-amber-200/90 inline-flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
        Unsaved changes
      </span>
    );
  }
  if (state.kind === 'saving') {
    return (
      <span className="inline-flex items-center gap-2 text-sm text-[#A7B0B7]">
        <Loader2 size={13} className="animate-spin" /> Saving…
      </span>
    );
  }
  if (state.kind === 'saved') {
    const sec = Math.max(1, Math.floor((Date.now() - state.at) / 1000));
    const ago = sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
    return <span className="text-sm text-emerald-300/80">Saved {ago}</span>;
  }
  return <span className="text-sm text-[#666]">No changes</span>;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[#666] mb-0.5">{label}</div>
      <div className="text-white truncate" title={value}>{value}</div>
    </div>
  );
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function isAgentBlocked(status: Agent['status']): boolean {
  return status === 'paused' || status === 'archived';
}

function AgentBlockedCard({
  agent,
  token,
  onUpdate,
}: {
  agent: Agent;
  token: string | null;
  onUpdate: (a: Agent) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isPaused = agent.status === 'paused';

  const restore = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { agent: updated } = await agentsApi.update(token, agent.id, { status: 'active' });
      onUpdate(updated);
    } catch (err) {
      setError((err as Error).message || 'Failed to update');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] px-6 py-12 text-center max-w-2xl mx-auto">
      <div
        className={`w-14 h-14 rounded-full flex items-center justify-center mx-auto mb-5 ${
          isPaused
            ? 'bg-amber-500/15 border border-amber-400/30 text-amber-300'
            : 'bg-white/[0.04] border border-white/15 text-[#A7B0B7]'
        }`}
      >
        {isPaused ? <Pause size={22} /> : <Archive size={22} />}
      </div>
      <h3 className="text-lg font-semibold text-white mb-2">
        {isPaused ? 'This agent is paused' : 'This agent is archived'}
      </h3>
      <p className="text-[#A7B0B7] text-sm max-w-md mx-auto mb-6 leading-relaxed">
        {isPaused
          ? "Chat and runs are disabled while paused. Resume to start using the agent again, its config and history are kept."
          : "Archived agents can't be chatted with or run. Restore to active to use it again."}
      </p>
      <button
        type="button"
        onClick={restore}
        disabled={busy}
        className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {isPaused ? 'Resume agent' : 'Restore to active'}
      </button>
      {error && <div className="mt-4 text-xs text-red-300">{error}</div>}
    </div>
  );
}

function RunsTab({ agent, token }: { agent: Agent; token: string | null }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    if (!token) return;
    try {
      const { runs } = await agentsApi.listRuns(token, agent.id);
      setRuns(runs);
    } catch (err) {
      setError((err as Error).message || 'Failed to load runs');
      setRuns([]);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [agent.id, token]);

  const start = async () => {
    if (!token) return;
    setStarting(true);
    try {
      const { run } = await agentsApi.startRun(token, agent.id);
      navigate(`/studio/agents/${agent.id}/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message || 'Failed to start');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div className="text-sm text-[#A7B0B7] min-w-0">
          Goal: <span className="text-white">{agent.config.goal || <span className="italic text-[#666]">not set</span>}</span>
        </div>
        <button
          type="button"
          onClick={start}
          disabled={starting || !agent.config.goal}
          className="shrink-0 inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40"
        >
          {starting ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Start run
        </button>
      </div>

      {error && <div className="text-xs text-red-300">{error}</div>}

      {runs === null ? (
        <div className="flex items-center justify-center py-12"><Loader2 size={20} className="animate-spin text-[#A7B0B7]" /></div>
      ) : runs.length === 0 ? (
        <div className="text-center py-12 text-[#A7B0B7] text-sm rounded-xl border border-white/10 bg-white/[0.02]">
          No runs yet. Click "Start run" above to kick one off.
        </div>
      ) : (
        <div className="rounded-xl border border-white/10 divide-y divide-white/10 overflow-hidden">
          {runs.map((run) => (
            <Link
              key={run.id}
              to={`/studio/agents/${agent.id}/runs/${run.id}`}
              className="flex items-center justify-between p-4 hover:bg-white/[0.03]"
            >
              <div>
                <div className="text-sm text-white font-medium">
                  Run {run.id.slice(0, 8)} · {run.status}
                </div>
                <div className="text-xs text-[#A7B0B7] mt-0.5">
                  {run.iterations.length} iterations · started {new Date(run.started_at).toLocaleString()}
                </div>
              </div>
              {typeof run.best_score === 'number' && (
                <div className="text-xs text-[#DFFF00]">score {run.best_score.toFixed(2)}</div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
