/**
 * AgentBuilder, /studio/agents/new
 *
 * Single-page editable form. The Agent Architect lives in a side drawer
 * the user opens on demand, closed by default so the form has full focus.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Save, Sparkles } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { AgentConfigForm } from '../../components/agents/AgentConfigForm';
import { ArchitectDrawer } from '../../components/agents/ArchitectDrawer';
import { useAuth } from '../../contexts/AuthContext';
import { agentsApi, agentCustomToolsApi, getStoredToken } from '../../lib/agents/api';
import {
  AGENT_TEMPLATES,
  DEFAULT_AGENT_CONFIG,
  type AgentConfig,
  type AgentType,
} from '../../lib/agents/types';
import { blockIfVoiceAgentsComingSoon } from '../../lib/voiceAgentsComingSoon';

export function AgentBuilder() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const templateId = params.get('template');
  const seedTemplate = useMemo(() => AGENT_TEMPLATES.find((t) => t.id === templateId) || null, [templateId]);

  const [name, setName] = useState('');
  const [type, setType] = useState<AgentType>(seedTemplate?.type ?? 'knowledge');
  const [config, setConfig] = useState<AgentConfig>(() => {
    // Voice templates with a full system_prompt prefill directly (industry-
    // standard pattern, what Vapi/Retell/ElevenLabs/OpenAI GPTs do). Goal
    // templates carry only a seed_prompt and rely on the Architect drawer
    // to draft a config.
    if (seedTemplate?.system_prompt) {
      return {
        ...DEFAULT_AGENT_CONFIG,
        system_prompt: seedTemplate.system_prompt,
        knowledge: seedTemplate.knowledge_starter ?? '',
        purpose: seedTemplate.purpose_placeholder ?? '',
        // Template's tailored greeting wins; fall back to the generic
        // DEFAULT_AGENT_CONFIG.first_message if the template didn't
        // specify one.
        first_message: seedTemplate.first_message ?? DEFAULT_AGENT_CONFIG.first_message,
      };
    }
    if (seedTemplate?.type === 'goal') {
      return { ...DEFAULT_AGENT_CONFIG, max_iterations: 5 };
    }
    return DEFAULT_AGENT_CONFIG;
  });

  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingBindToolIds, setPendingBindToolIds] = useState<Set<string>>(new Set());
  // Architect drawer opens by default for templates that need AI drafting
  // (i.e. those without a pre-filled system_prompt, typically goal agents).
  // Voice templates already arrive pre-filled, so the form is the focus and
  // the Architect stays collapsed until the user asks for it.
  const [architectOpen, setArchitectOpen] = useState(
    !(seedTemplate?.system_prompt),
  );

  // If we navigated in with a voice template whose system_prompt is already
  // pre-filled, keep the Architect closed, the user can open it manually.
  // For goal templates (Architect-drafted), keep it open.
  useEffect(() => {
    if (seedTemplate && !seedTemplate.system_prompt) {
      setArchitectOpen(true);
    }
  }, [seedTemplate]);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    agentsApi.listModels(token).then((r) => setModels(r.models)).catch(() => {});
  }, []);

  const handleConfigChange = (patch: { name?: string; type?: AgentType; config?: Partial<AgentConfig> }) => {
    if (patch.name !== undefined) setName(patch.name);
    if (patch.type !== undefined) setType(patch.type);
    if (patch.config) setConfig((prev) => ({ ...prev, ...patch.config }));
  };

  const applyArchitectDraft = (next: { name: string; type: AgentType; config: AgentConfig }) => {
    setName(next.name);
    setType(next.type);
    setConfig(next.config);
  };

  const handleSave = async (status: 'draft' | 'active') => {
    // Coming-soon gate. Even if the user lands on this page via a
    // bookmarked URL, the save attempt is short-circuited.
    if (blockIfVoiceAgentsComingSoon()) return;
    if (!name.trim() || !config.purpose.trim()) {
      setError('Name and Purpose are required.');
      return;
    }
    if (type === 'goal' && !(config.goal || '').trim()) {
      setError('Goal agents need a goal.');
      return;
    }
    const token = getStoredToken();
    if (!token) { setError('Sign in to save.'); return; }
    setSaving(true);
    setError(null);
    try {
      const { agent } = await agentsApi.create(token, { name, type, config });
      if (status === 'active') {
        await agentsApi.update(token, agent.id, { status: 'active' });
      }
      // Bind any pre-selected custom tools to the freshly created agent.
      if (pendingBindToolIds.size > 0) {
        await Promise.allSettled(
          Array.from(pendingBindToolIds).map((toolId) =>
            agentCustomToolsApi.bind(token, agent.id, toolId),
          ),
        );
      }
      navigate(`/studio/agents/${agent.id}`);
    } catch (err) {
      setError((err as Error).message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const canSave = !!name.trim() && !!config.purpose.trim() && (type !== 'goal' || !!(config.goal || '').trim());

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
    <StudioShell activeView="agents">
      {/* Stable layout: form is fixed at 1024 px (max-w-5xl). When the
          architect drawer is closed, the form is centered. When open on
          ≥ lg viewports, the form right-aligns against the drawer's left
          edge (`ml-auto` + `mr-[420px]`) so the drawer never covers it.
          Width stays the same; only position shifts. */}
      <div className={`max-w-5xl mx-auto transition-[margin] duration-200 ${
        architectOpen ? 'lg:ml-auto lg:mr-[420px]' : ''
      }`}>
        {/* Top bar */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link to="/studio/agents" className="text-[#A7B0B7] hover:text-white inline-flex items-center gap-1 text-sm">
              <ArrowLeft size={16} /> Back
            </Link>
            <h1 className="text-2xl font-semibold text-white inline-flex items-center gap-2">
              New Agent
              <span
                className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[9px] font-semibold uppercase tracking-[0.14em] text-indigo-300 bg-indigo-500/15 border border-indigo-400/30"
                title="Voice agents are in beta, features and pricing may change."
              >
                Beta
              </span>
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setArchitectOpen((v) => !v)}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium border transition-colors ${
                architectOpen
                  ? 'bg-[#DFFF00]/15 text-[#DFFF00] border-[#DFFF00]/30'
                  : 'bg-white/[0.04] hover:bg-white/[0.08] text-white border-white/10'
              }`}
              title="Open the Agent Architect"
            >
              <Sparkles size={14} />
              {architectOpen ? 'Hide Architect' : 'Ask Architect'}
            </button>
            <button
              type="button"
              onClick={() => handleSave('draft')}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-2 rounded-xl bg-white/[0.04] hover:bg-white/[0.08] text-white px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save draft
            </button>
            <button
              type="button"
              onClick={() => handleSave('active')}
              disabled={saving || !canSave}
              className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-40"
            >
              Deploy
            </button>
          </div>
        </div>

        <p className="text-sm text-[#A7B0B7] mb-6 max-w-2xl">
          Fill in the form directly, or click <span className="text-[#DFFF00]">Ask Architect</span> to describe your agent in
          plain English and have it drafted for you. You can use both, the Architect's drafts land in the form, and you can
          keep editing.
        </p>

        {error && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2 mb-4">{error}</div>
        )}

        <AgentConfigForm
          name={name}
          type={type}
          config={config}
          availableModels={models}
          onChange={handleConfigChange}
          pendingBindToolIds={pendingBindToolIds}
          onPendingBindToolIdsChange={setPendingBindToolIds}
        />
      </div>

      <ArchitectDrawer
        open={architectOpen && !!user}
        onClose={() => setArchitectOpen(false)}
        current={{ name, type, config }}
        onApply={applyArchitectDraft}
      />
    </StudioShell>
    </div>
  );
}
