/**
 * AgentDetail — /studio/agents/:id
 *
 *   • Header is one breathing line: gradient avatar, name + status dot,
 *     small type label, kebab menu for pause / delete.
 *   • Tabs: Chat (knowledge) or Runs (goal), and Settings. The old
 *     Activity tab folded into Settings as a small "Stats" card.
 *   • Settings has an explicit Save button. The page guards against
 *     leaving with unsaved changes — confirms on tab switch, on the
 *     Back link, and on browser-level navigation (refresh / close /
 *     external URL) via beforeunload.
 */

import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Archive, ArrowLeft, Loader2, MoreVertical, Pause, Play, Trash2 } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { AgentAvatar } from '../../components/agents/AgentAvatar';
import { AgentChat } from '../../components/agents/AgentChat';
import { AgentConfigForm } from '../../components/agents/AgentConfigForm';
import { useAuth } from '../../contexts/AuthContext';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { Agent, AgentConfig, AgentRun, AgentType } from '../../lib/agents/types';

type Tab = 'chat' | 'runs' | 'settings';

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

export function AgentDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('chat');
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
      // Modern browsers ignore custom strings — just need to set
      // returnValue so the native dialog appears.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [settingsDirty]);

  const confirmLeaveIfDirty = (): boolean => {
    if (!settingsDirty) return true;
    const ok = window.confirm('You have unsaved changes in Settings. Leave anyway?');
    if (ok) setSettingsDirty(false); // user accepted abandonment
    return ok;
  };

  useEffect(() => { setToken(getStoredToken()); }, [user?.id]);

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
    { id: 'chat', label: 'Chat', show: agent.type === 'knowledge' },
    { id: 'runs', label: 'Runs', show: agent.type === 'goal' },
    { id: 'settings', label: 'Settings', show: true },
  ];

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
    <StudioShell activeView="agents">
      <div className="max-w-6xl">
        {/* Back link — gated by the unsaved-changes confirm dialog. */}
        <Link
          to="/studio/agents"
          onClick={(e) => { if (!confirmLeaveIfDirty()) e.preventDefault(); }}
          className="text-[#A7B0B7] hover:text-white inline-flex items-center gap-1.5 text-sm mb-4"
        >
          <ArrowLeft size={14} /> All agents
        </Link>

        {/* Header — one breathing line */}
        <div className="flex items-center gap-4 mb-6">
          <AgentAvatar id={agent.id} name={agent.name} size="lg" rounded="xl" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-semibold text-white truncate">{agent.name}</h1>
              <span
                className={`shrink-0 w-2 h-2 rounded-full ${STATUS_DOT[agent.status]}`}
                title={STATUS_LABEL[agent.status]}
                aria-label={STATUS_LABEL[agent.status]}
              />
            </div>
            <div className="text-[12px] text-[#A7B0B7] mt-0.5">{typeLabel}</div>
            {agent.config.purpose && (
              <p className="text-[#A7B0B7] text-sm mt-2 max-w-2xl line-clamp-2">{agent.config.purpose}</p>
            )}
          </div>
          <KebabMenu
            agent={agent}
            token={token}
            onUpdate={(a) => setAgent(a)}
            onDelete={() => navigate('/studio/agents')}
          />
        </div>

        {/* Tabs */}
        <div className="border-b border-white/10 mb-6 flex gap-1">
          {tabs.filter((t) => t.show).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                // Switching AWAY from Settings while dirty asks for confirm.
                if (activeTab === 'settings' && t.id !== 'settings' && !confirmLeaveIfDirty()) {
                  return;
                }
                setActiveTab(t.id);
              }}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t.id
                  ? 'border-[#DFFF00] text-white'
                  : 'border-transparent text-[#A7B0B7] hover:text-white'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content. Paused / archived agents see a blocked state in
            the active tab — backend also enforces this; the frontend
            check is just to avoid a wasted WS attempt and give a clear
            empty state. Drafts are NOT blocked so users can test an
            agent before activating. */}
        {activeTab === 'chat' && agent.type === 'knowledge' && (
          isAgentBlocked(agent.status) ? (
            <AgentBlockedCard agent={agent} token={token} onUpdate={(a) => setAgent(a)} />
          ) : (
            <AgentChat agent={agent} authToken={token} />
          )
        )}
        {activeTab === 'runs' && agent.type === 'goal' && (
          isAgentBlocked(agent.status) ? (
            <AgentBlockedCard agent={agent} token={token} onUpdate={(a) => setAgent(a)} />
          ) : (
            <RunsTab agent={agent} token={token} />
          )
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
    if (!window.confirm(`Delete agent "${agent.name}"? This can't be undone.`)) return;
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
  const [name, setName] = useState(agent.name);
  const [type, setType] = useState<AgentType>(agent.type);
  const [config, setConfig] = useState<AgentConfig>(agent.config);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const [dirty, setDirty] = useState(false);

  // Lift dirty state up so the parent can guard navigation.
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  // If the source agent changes from outside (e.g. status toggle from
  // the kebab menu), reset our local form state to it — but only when
  // we don't have unsaved changes, so we never silently overwrite the
  // user's edits.
  useEffect(() => {
    if (dirty) return;
    setName(agent.name);
    setType(agent.type);
    setConfig(agent.config);
  }, [agent.id, agent.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!token || !dirty) return;
    setSaveState({ kind: 'saving' });
    try {
      const { agent: updated } = await agentsApi.update(token, agent.id, { name, config });
      onUpdated(updated);
      setSaveState({ kind: 'saved', at: Date.now() });
      setDirty(false);
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
    <div className="max-w-3xl space-y-4 pb-28">
      <AgentConfigForm
        name={name}
        type={type}
        config={config}
        availableModels={models}
        onChange={(patch) => {
          setDirty(true);
          if (patch.name !== undefined) setName(patch.name);
          if (patch.type !== undefined) setType(patch.type);
          if (patch.config) setConfig((prev) => ({ ...prev, ...patch.config }));
        }}
      />
      {/* Stats — folded in from the old Activity tab */}
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
          quiet state when saved, urgent amber tinge when unsaved. */}
      <SaveBar
        dirty={dirty}
        saveState={saveState}
        onSave={() => void save()}
      />
    </div>
  );
}

function SaveBar({
  dirty,
  saveState,
  onSave,
}: {
  dirty: boolean;
  saveState: SaveState;
  onSave: () => void;
}) {
  const saving = saveState.kind === 'saving';
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-3xl w-[calc(100%-2rem)] pointer-events-none">
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
          ? "Chat and runs are disabled while paused. Resume to start using the agent again — its config and history are kept."
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
