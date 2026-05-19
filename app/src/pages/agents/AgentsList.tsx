/**
 * Agents list page — entry point for /studio/agents.
 *
 * Cleaned up after the redesign: a tighter header (no oversized hero
 * card on the empty state), bigger template tiles with type-coloured
 * accents, and a quieter populated grid layout.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { BookOpen, Bot, Loader2, Plus, Search, Sparkles, Target } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { AgentCard } from '../../components/agents/AgentCard';
import { useAuth } from '../../contexts/AuthContext';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import { AGENT_TEMPLATES, type Agent, type AgentTemplate } from '../../lib/agents/types';

export function AgentsList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!user) return;
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    agentsApi
      .list(token)
      .then((res) => { if (!cancelled) setAgents(res.agents); })
      .catch((err) => { if (!cancelled) { setError(err.message || 'Failed to load agents'); setAgents([]); } });
    return () => { cancelled = true; };
  }, [user]);

  const filtered = useMemo(() => {
    if (!agents) return null;
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => a.name.toLowerCase().includes(q) || a.config.purpose.toLowerCase().includes(q));
  }, [agents, search]);

  const handleTemplateClick = (tpl: AgentTemplate) => {
    navigate(`/studio/agents/new?template=${encodeURIComponent(tpl.id)}`);
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
    <StudioShell activeView="agents">
      {/* No max-width here — let the grid breathe on wide screens.
          More columns kick in at xl / 2xl breakpoints below. */}
      <div>
        {/* Header */}
        {/* Header — title block on the left, action button at the page's
            right edge. Description sits below the title at its own width
            so it doesn't wrap awkwardly mid-sentence. */}
        <div className="flex items-start justify-between gap-4 mb-8 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold text-white mb-1.5">Agents</h1>
            <p className="text-[#A7B0B7] text-sm max-w-2xl">
              Voice agents with custom knowledge or autonomous goals — built by chatting, no code.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Link
              to="/docs/guide-agents"
              target="_blank"
              rel="noopener"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] hover:border-white/20 px-3.5 py-2.5 text-sm text-[#A7B0B7] hover:text-white transition-colors"
            >
              <BookOpen size={14} /> Guide
            </Link>
            <Link
              to="/studio/agents/new"
              className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2.5 text-sm font-semibold hover:brightness-110"
            >
              <Plus size={16} /> New agent
            </Link>
          </div>
        </div>

        {agents === null ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={28} className="animate-spin text-[#A7B0B7]" />
          </div>
        ) : agents.length === 0 ? (
          <EmptyState onTemplateClick={handleTemplateClick} error={error} />
        ) : (
          <Populated agents={filtered ?? []} search={search} setSearch={setSearch} error={error} />
        )}
      </div>
    </StudioShell>
    </div>
  );
}

function EmptyState({ onTemplateClick, error }: { onTemplateClick: (tpl: AgentTemplate) => void; error: string | null }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5 text-sm text-[#A7B0B7]">
        <Sparkles size={14} className="text-[#DFFF00]" />
        <span>Pick a template to start fast — or describe your own from scratch.</span>
      </div>
      {error && <div className="text-xs text-amber-300">{error}</div>}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {AGENT_TEMPLATES.map((tpl) => (
          <TemplateTile key={tpl.id} template={tpl} onClick={() => onTemplateClick(tpl)} />
        ))}
      </div>
    </div>
  );
}

function TemplateTile({ template, onClick }: { template: AgentTemplate; onClick: () => void }) {
  const isGoal = template.type === 'goal';
  const Icon = isGoal ? Target : Bot;
  // Soft type-keyed accent — purple for goal, lime for knowledge.
  const accent = isGoal
    ? { tile: 'border-purple-400/15 bg-purple-500/[0.04] hover:bg-purple-500/[0.08] hover:border-purple-400/30',
        chip: 'bg-purple-500/15 text-purple-200', icon: 'text-purple-200' }
    : { tile: 'border-[#DFFF00]/15 bg-[#DFFF00]/[0.03] hover:bg-[#DFFF00]/[0.06] hover:border-[#DFFF00]/30',
        chip: 'bg-[#DFFF00]/15 text-[#DFFF00]', icon: 'text-[#DFFF00]' };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-2xl border p-5 transition-all ${accent.tile}`}
    >
      <div className="flex items-start gap-3 mb-3">
        <div className={`w-10 h-10 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 ${accent.icon}`}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-white font-semibold truncate">{template.name}</span>
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-md ${accent.chip}`}>
              {isGoal ? 'Goal' : 'Knowledge'}
            </span>
          </div>
        </div>
      </div>
      <p className="text-[#A7B0B7] text-sm leading-snug">{template.blurb}</p>
    </button>
  );
}

function Populated({
  agents,
  search,
  setSearch,
  error,
}: {
  agents: Agent[];
  search: string;
  setSearch: (s: string) => void;
  error: string | null;
}) {
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#666]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents…"
            className="w-full bg-white/[0.03] border border-white/10 rounded-lg pl-9 pr-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/30"
          />
        </div>
        <span className="text-xs text-[#666]">{agents.length} {agents.length === 1 ? 'agent' : 'agents'}</span>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] text-amber-100 text-sm px-3 py-2">{error}</div>
      )}

      {agents.length === 0 ? (
        <div className="text-center py-12 text-[#A7B0B7] text-sm">No matches for "{search}".</div>
      ) : (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
        </div>
      )}
    </div>
  );
}
