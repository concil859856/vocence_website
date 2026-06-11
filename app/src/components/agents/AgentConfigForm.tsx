/**
 * AgentConfigForm, flat, always-editable form for an agent's full config.
 *
 * Used in both the Builder (with a side Architect drawer) and the Detail
 * page's Settings tab. Every field is a plain input/textarea, no edit/save
 * toggle. Parent owns state; this is a controlled component.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { useConfirm } from '../../hooks/useConfirm';
import type { AgentConfig, AgentType } from '../../lib/agents/types';
import { SAMPLE_VOICE_INDEX, SAMPLE_VOICES, avatarGradientPairFor } from '../../data/sampleVoices';
import { SampleVoiceAvatar } from '../studio/SampleVoiceAvatar';
import { SampleVoicePickerModal } from '../studio/SampleVoicePickerModal';
import { Select } from '../ui/DropdownSelect';
import { dashboardApi, type StudioDesignedVoiceItem } from '../../services/dashboardApi';
import {
  agentsApi,
  agentCustomToolsApi,
  getStoredToken,
  type BuiltinToolInfo,
  type CustomTool,
} from '../../lib/agents/api';
import { CustomToolEditor } from './CustomToolEditor';

interface Props {
  name: string;
  type: AgentType;
  config: AgentConfig;
  availableModels: { id: string; label: string }[];
  onChange: (patch: { name?: string; type?: AgentType; config?: Partial<AgentConfig> }) => void;
  /** Optional architect trigger, shown as a subtle helper next to fields. */
  onAskArchitect?: (focusField?: string) => void;
  /** When provided (edit flow), the form shows the custom-tools
   *  subsection with per-agent bind/unbind toggles. AgentBuilder
   *  (create flow) omits this since there's no agent_id yet, users
   *  can register custom tools after first save. */
  agentId?: string | null;
  /** Builder-only: tools the user has pre-selected to bind on first save.
   *  When ``agentId`` is null these props track local selection state
   *  instead of calling the bind API. Ignored in edit mode. */
  pendingBindToolIds?: Set<string>;
  onPendingBindToolIdsChange?: (next: Set<string>) => void;
}

// The 10 languages supported by Qwen/Qwen3-TTS-12Hz-1.7B-Base (per its
// model card). Picking anything outside this set produces unusable audio —
// the synthesis server's lenient "pass-through unknown languages" path
// would still accept it but the 1.7B base model has no phoneme coverage
// for it. Keep this list in sync with the model on any base swap.
// English is intentionally first so it's the visible default in the
// Select; DEFAULT_AGENT_CONFIG.language pins it as the saved default too.
const LANGUAGE_OPTIONS = ['English', 'Chinese', 'Japanese', 'Korean', 'Spanish', 'French', 'German', 'Portuguese', 'Italian', 'Russian'];

export function AgentConfigForm({ name, type, config, availableModels, onChange, agentId, pendingBindToolIds, onPendingBindToolIdsChange }: Props) {
  const isGoal = type === 'goal';
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [designedVoices, setDesignedVoices] = useState<StudioDesignedVoiceItem[]>([]);
  const [builtinTools, setBuiltinTools] = useState<BuiltinToolInfo[]>([]);

  // Custom (user-defined) tools the LLM can call. Two collections to track:
  //   • allUserTools, every custom tool the signed-in user owns (across
  //     all their agents). Always loaded so they can bind any of them
  //     to this agent.
  //   • boundTools, the subset currently bound to *this* agent. Drives
  //     the checked state of the binding toggles.
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [allUserTools, setAllUserTools] = useState<CustomTool[] | null>(null);
  const [boundToolIds, setBoundToolIds] = useState<Set<string>>(new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<CustomTool | null>(null);
  const [bindingBusy, setBindingBusy] = useState<Set<string>>(new Set());

  const refreshCustomTools = useCallback(async () => {
    const token = getStoredToken();
    if (!token) return;
    try {
      const list = await agentCustomToolsApi.list(token);
      setAllUserTools(list.tools);
    } catch {
      setAllUserTools([]);
    }
    if (agentId) {
      try {
        const bound = await agentCustomToolsApi.listBoundToAgent(token, agentId);
        setBoundToolIds(new Set(bound.tools.map((t) => t.id)));
      } catch {
        setBoundToolIds(new Set());
      }
    } else {
      setBoundToolIds(new Set());
    }
  }, [agentId]);

  useEffect(() => {
    void refreshCustomTools();
  }, [refreshCustomTools]);

  const handleBindToggle = async (tool: CustomTool, nextChecked: boolean) => {
    if (!agentId) return;
    const token = getStoredToken();
    if (!token) return;
    setBindingBusy((prev) => new Set(prev).add(tool.id));
    // Optimistic toggle.
    setBoundToolIds((prev) => {
      const next = new Set(prev);
      if (nextChecked) next.add(tool.id); else next.delete(tool.id);
      return next;
    });
    try {
      if (nextChecked) {
        await agentCustomToolsApi.bind(token, agentId, tool.id);
      } else {
        await agentCustomToolsApi.unbind(token, agentId, tool.id);
      }
    } catch {
      // Revert optimistic change on failure.
      setBoundToolIds((prev) => {
        const next = new Set(prev);
        if (nextChecked) next.delete(tool.id); else next.add(tool.id);
        return next;
      });
    } finally {
      setBindingBusy((prev) => {
        const next = new Set(prev);
        next.delete(tool.id);
        return next;
      });
    }
  };

  const handleDeleteTool = async (tool: CustomTool) => {
    if (!await confirm({ title: 'Delete Tool', message: `Delete tool "${tool.name}"? This unbinds it from every agent and can't be undone.`, confirmLabel: 'Delete', confirmVariant: 'danger' })) return;
    const token = getStoredToken();
    if (!token) return;
    try {
      await agentCustomToolsApi.remove(token, tool.id);
      await refreshCustomTools();
    } catch (e) {
      window.alert((e as Error).message || 'Delete failed');
    }
  };

  // Pull the user's saved "My Voices" so they appear alongside the
  // sample voices in the picker. Failures are silent, the picker
  // simply won't show the My Voices section.
  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    dashboardApi
      .listStudioDesignedVoices(token)
      .then((r) => { if (!cancelled) setDesignedVoices(r.voices); })
      .catch(() => { /* ignore, picker will just not show My Voices */ });
    return () => { cancelled = true; };
  }, []);

  // Pull the built-in tool catalog so we can render the Tools section.
  // The endpoint reports per-tool availability (web_search needs Tavily,
  // weather needs OpenWeatherMap) so we can grey out tools the server
  // can't actually run.
  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    agentsApi
      .listBuiltinTools(token)
      .then((r) => { if (!cancelled) setBuiltinTools(r.tools); })
      .catch(() => { /* ignore, Tools section just renders empty */ });
    return () => { cancelled = true; };
  }, []);

  // Resolve enabled-tool state. When config.enabled_tools is undefined
  // (the default for fresh agents), every available tool is implicitly
  // enabled, same behaviour as the backend when ``enabled_tools`` is
  // absent from the AgentConfig. Once the user toggles anything, the
  // form persists an explicit list and locks that semantic in.
  const enabledToolNames = useMemo<Set<string>>(() => {
    if (config.enabled_tools === undefined) {
      return new Set(builtinTools.filter((t) => t.available).map((t) => t.name));
    }
    return new Set(config.enabled_tools);
  }, [config.enabled_tools, builtinTools]);

  const isToolToggleExplicit = config.enabled_tools !== undefined;

  const handleToolToggle = (toolName: string, nextEnabled: boolean) => {
    // First toggle: seed the explicit list from the implicit "all
    // available" default so the user's choice is encoded honestly.
    const base = isToolToggleExplicit
      ? new Set(config.enabled_tools)
      : new Set(builtinTools.filter((t) => t.available).map((t) => t.name));
    if (nextEnabled) base.add(toolName);
    else base.delete(toolName);
    onChange({ config: { enabled_tools: Array.from(base) } });
  };

  // Resolve current voice. Three cases:
  //   • dv:<id>   → user designed voice from My Voices
  //   • sample id → one of the 28 sample voices
  //   • anything  → fall back to the first sample (for legacy speaker names)
  const designedSelected = config.voice.startsWith('dv:')
    ? designedVoices.find((v) => `dv:${v.id}` === config.voice) ?? null
    : null;
  const selectedSampleVoice = designedSelected
    ? null
    : SAMPLE_VOICE_INDEX[config.voice] ?? SAMPLE_VOICES[0] ?? null;

  return (
    <div className="space-y-6">
      {/* Type */}
      <Section title="Agent type" hint="Knowledge agents respond to chat. Goal agents iterate toward a target.">
        <div className="flex gap-2">
          <TypeButton active={type === 'knowledge'} onClick={() => onChange({ type: 'knowledge' })} accent="lime">
            Knowledge
          </TypeButton>
          <TypeButton
            active={type === 'goal'}
            onClick={() => {
              void confirm({
                title: 'Coming Soon',
                message: 'Goal agents (self-improving) are under active development. They\'ll be available in a future release.',
                confirmLabel: 'Got it',
                cancelLabel: '',
                confirmVariant: 'primary',
              });
            }}
            accent="purple"
          >
            Goal (self-improving)
          </TypeButton>
        </div>
      </Section>

      {/* Basics */}
      <Section title="Basics">
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Postgres Support Assistant"
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40"
          />
        </Field>
        <Field
          label="Purpose"
          required
          hint="One or two sentences. What it does and who it's for."
        >
          <textarea
            value={config.purpose}
            onChange={(e) => onChange({ config: { purpose: e.target.value } })}
            placeholder="A friendly Postgres support agent that answers user questions about connection errors, replication, and query performance."
            rows={3}
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y"
          />
        </Field>
      </Section>

      {/* Behavior */}
      <Section title="Behavior" hint="The system prompt drives tone, refusals, fallback rules. Knowledge belongs in the next section.">
        <Field
          label="First message"
          hint="The agent says this when a session opens, before the user speaks. Leave empty to start silent."
        >
          <input
            type="text"
            value={config.first_message ?? ''}
            onChange={(e) => onChange({ config: { first_message: e.target.value } })}
            placeholder="Hello, how may I assist you today?"
            maxLength={500}
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40"
          />
        </Field>
        <Field label="System prompt">
          <textarea
            value={config.system_prompt}
            onChange={(e) => onChange({ config: { system_prompt: e.target.value } })}
            placeholder="You are a friendly Postgres expert. Answer concisely. If you don't know, say so."
            rows={20}
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y font-mono"
          />
        </Field>
      </Section>

      {/* Knowledge */}
      <Section title="Knowledge" hint="Reference text injected into context every turn. v1 is text-only, file/URL upload coming soon.">
        <Field label="">
          <textarea
            value={config.knowledge}
            onChange={(e) => onChange({ config: { knowledge: e.target.value } })}
            placeholder="Pricing tiers, FAQ entries, API examples, error code lookups…"
            rows={15}
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y"
          />
        </Field>
      </Section>

      {/* Goal-only */}
      {isGoal && (
        <Section title="Goal" hint="The agent runs in a loop, scoring itself against the success metric each iteration.">
          <Field label="What should the agent accomplish?" required>
            <textarea
              value={config.goal || ''}
              onChange={(e) => onChange({ config: { goal: e.target.value } })}
              placeholder="Refine my cold email until it's under 90 words, no buzzwords, with a single clear ask."
              rows={3}
              className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y"
            />
          </Field>
          <Field label="Success metric" hint="The agent self-scores against this. Concrete > vague.">
            <textarea
              value={config.success_metric || ''}
              onChange={(e) => onChange({ config: { success_metric: e.target.value } })}
              placeholder="Under 90 words, single clear ask, no buzzwords ('synergy', 'leverage', 'ecosystem'), sounds human."
              rows={3}
              className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y"
            />
          </Field>
          <Field label="Max iterations" hint="Hard cap so runs can't go on forever. 1–20.">
            <input
              type="number"
              min={1}
              max={20}
              value={config.max_iterations ?? 5}
              onChange={(e) => onChange({ config: { max_iterations: Math.max(1, Math.min(20, Number(e.target.value) || 5)) } })}
              className="w-32 bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-[#DFFF00]/40"
            />
          </Field>
        </Section>
      )}

      {/* Voice & model */}
      <Section title="Voice & model">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Voice" hint="Pick from sample voices or your saved My Voices, the agent will speak using this voice.">
            <button
              type="button"
              onClick={() => setVoicePickerOpen(true)}
              className="w-full flex items-center gap-3 rounded-lg border border-white/15 bg-[#07080A] hover:bg-white/[0.04] hover:border-white/25 transition-colors pl-1.5 pr-3 py-1.5 text-left"
            >
              {designedSelected ? (
                <>
                  <DesignedVoiceMiniAvatar item={designedSelected} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate leading-tight flex items-center gap-1.5">
                      {designedSelected.display_name || 'Untitled voice'}
                      <span className="text-[9px] uppercase tracking-wider text-[#DFFF00]/80 px-1 py-0.5 rounded bg-[#DFFF00]/10">My Voice</span>
                    </div>
                    <div className="text-[11px] text-[#A7B0B7] truncate leading-tight">{designedSelected.voice_description || 'Custom designed voice'}</div>
                  </div>
                </>
              ) : selectedSampleVoice ? (
                <>
                  <SampleVoiceAvatar voice={selectedSampleVoice} size="sm" rounded="lg" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-white truncate leading-tight">{selectedSampleVoice.name}</div>
                    <div className="text-[11px] text-[#A7B0B7] truncate leading-tight">{selectedSampleVoice.description}</div>
                  </div>
                </>
              ) : (
                <span className="text-sm text-[#A7B0B7] px-1.5">Choose a voice</span>
              )}
              <ChevronDown size={16} className="text-[#A7B0B7] shrink-0" />
            </button>
          </Field>
          <Field label="Language">
            <Select
              value={config.language}
              onChange={(v) => onChange({ config: { language: v } })}
              options={LANGUAGE_OPTIONS.map((l) => ({ value: l, label: l }))}
            />
          </Field>
        </div>
        <Field label="LLM model" hint="Leave empty to use the server default.">
          {availableModels.length > 0 ? (
            <Select
              value={config.llm_model}
              onChange={(v) => onChange({ config: { llm_model: v } })}
              options={[
                { value: '', label: 'Use default' },
                ...availableModels.map((m) => ({ value: m.id, label: m.label })),
              ]}
            />
          ) : (
            <input
              type="text"
              value={config.llm_model}
              onChange={(e) => onChange({ config: { llm_model: e.target.value } })}
              placeholder="Use server default"
              className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-sm text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 font-mono"
            />
          )}
        </Field>
        <Field label="Temperature" hint={`Lower = more deterministic. Current: ${config.temperature.toFixed(2)}`}>
          <input
            type="range"
            min={0}
            max={1.5}
            step={0.05}
            value={config.temperature}
            onChange={(e) => onChange({ config: { temperature: Number(e.target.value) } })}
            className="w-full accent-[#DFFF00]"
          />
        </Field>
      </Section>

      {/* Tools, built-in capabilities the agent can call mid-conversation.
          Web search, weather, time, URL fetch, Wikipedia. Tools the
          deployment can't run (missing API key) render disabled with
          a hint so it's clear why. Custom (user-defined) tools land in
          a separate section in Phase 3. */}
      {builtinTools.length > 0 && (
        <Section
          title="Tools"
          hint="Built-in capabilities the agent can call. Disabled tools won't be advertised to the LLM."
        >
          <div className="space-y-2">
            {builtinTools.map((tool) => {
              const enabled = enabledToolNames.has(tool.name) && tool.available;
              // When a tool isn't configured server-side, explain the
              // exact env var that's missing, and for web_search,
              // point users at the no-key alternative (Groq Compound)
              // so they don't feel stuck. If they're already on a
              // Compound model, switch to a positive message, the
              // tool registry doesn't see it, but the agent's model
              // has search built in.
              const usingCompound = (config.llm_model || '').includes('compound');
              let disabledReason = '';
              if (!tool.available) {
                if (tool.name === 'web_search' && usingCompound) {
                  disabledReason = "Your selected model (Groq Compound) has web search built in, no key needed.";
                } else {
                  disabledReason = `Not configured on this deployment (needs ${tool.requires_env.join(', ')}).`;
                  if (tool.name === 'web_search') {
                    disabledReason += ' Or pick the "Groq · Compound" model above, it has web search built in, no key needed.';
                  }
                }
              }
              return (
                <label
                  key={tool.name}
                  className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                    tool.available
                      ? 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04] cursor-pointer'
                      : 'border-white/[0.06] bg-white/[0.01] opacity-60 cursor-not-allowed'
                  }`}
                  title={disabledReason || undefined}
                >
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={!tool.available}
                    onChange={(e) => handleToolToggle(tool.name, e.target.checked)}
                    className="mt-1 accent-[#DFFF00] shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Wrench size={12} className="text-[#A7B0B7] shrink-0" />
                      <code className="text-[12px] font-mono text-white">{tool.name}</code>
                      {!tool.available && (
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-[#666] border border-white/10">
                          unavailable
                        </span>
                      )}
                    </div>
                    <p className="text-[12px] text-[#A7B0B7] mt-1 leading-snug">{tool.description}</p>
                    {disabledReason && (
                      <p className="text-[11px] text-amber-300/80 mt-1">{disabledReason}</p>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        </Section>
      )}

      {/* Custom tools, user-defined webhook executors the LLM can call.
          In the builder (no agent_id), tracks selection locally via
          ``pendingBindToolIds`` so AgentBuilder can bind on first save.
          In edit mode (agent_id set), bind/unbind hits the API directly. */}
      <Section
        title="Custom tools"
        hint={agentId
          ? "Webhook endpoints the LLM can call mid-conversation. Same JSON Schema shape OpenAI/Groq/Anthropic accept."
          : "Register webhook tools your agent can call. Selections bind automatically on first save."}
      >
          <div className="space-y-2">
            {allUserTools === null ? (
              <p className="text-[12px] text-[#666]">Loading…</p>
            ) : allUserTools.length === 0 ? (
              <p className="text-[12px] text-[#666]">
                You haven't registered any custom tools yet. Click <span className="text-white">+ New custom tool</span> to add one.
              </p>
            ) : (
              allUserTools.map((tool) => {
                const isBound = agentId
                  ? boundToolIds.has(tool.id)
                  : (pendingBindToolIds?.has(tool.id) ?? false);
                const busy = bindingBusy.has(tool.id);
                const togglePending = (next: boolean) => {
                  if (!onPendingBindToolIdsChange) return;
                  const set = new Set(pendingBindToolIds ?? []);
                  if (next) set.add(tool.id); else set.delete(tool.id);
                  onPendingBindToolIdsChange(set);
                };
                return (
                  <div
                    key={tool.id}
                    className="flex items-start gap-3 p-3 rounded-xl border border-white/10 bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={isBound}
                      disabled={busy}
                      onChange={(e) => {
                        if (agentId) void handleBindToggle(tool, e.target.checked);
                        else togglePending(e.target.checked);
                      }}
                      className="mt-1 accent-[#DFFF00] shrink-0"
                      title={isBound ? 'Bound to this agent' : 'Bind to this agent'}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Wrench size={12} className="text-[#A7B0B7] shrink-0" />
                        <code className="text-[12px] font-mono text-white">{tool.name}</code>
                        <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-[#A7B0B7] border border-white/10">
                          {tool.method}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#A7B0B7] mt-1 leading-snug line-clamp-2">{tool.description}</p>
                      <p className="text-[11px] text-[#666] mt-1 font-mono truncate">{tool.endpoint_url}</p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => { setEditingTool(tool); setEditorOpen(true); }}
                        className="p-1.5 rounded-md text-[#A7B0B7] hover:text-white hover:bg-white/5 transition-colors"
                        title="Edit"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDeleteTool(tool)}
                        className="p-1.5 rounded-md text-[#A7B0B7] hover:text-red-300 hover:bg-red-500/10 transition-colors"
                        title="Delete"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
            <button
              type="button"
              onClick={() => { setEditingTool(null); setEditorOpen(true); }}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-white/15 text-sm text-[#A7B0B7] hover:text-white hover:border-white/30 hover:bg-white/[0.02] transition-colors"
            >
              <Plus size={14} />
              New custom tool
            </button>
          </div>
        </Section>

      <SampleVoicePickerModal
        open={voicePickerOpen}
        selectedId={config.voice}
        onSelect={(v) => onChange({ config: { voice: v.id } })}
        designedVoices={designedVoices}
        onSelectDesigned={(encodedId) => onChange({ config: { voice: encodedId } })}
        onClose={() => setVoicePickerOpen(false)}
      />

      {editorOpen && (
        <CustomToolEditor
          initial={editingTool}
          onClose={() => { setEditorOpen(false); setEditingTool(null); }}
          onSaved={() => { void refreshCustomTools(); }}
        />
      )}
      {confirmDialog}
    </div>
  );
}

function DesignedVoiceMiniAvatar({ item }: { item: StudioDesignedVoiceItem }) {
  const initials = (item.display_name || 'V')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('') || 'V';
  const grad = avatarGradientPairFor(`dv-${item.id}`);
  return (
    <div
      className={`shrink-0 w-9 h-9 rounded-lg p-[2px] bg-gradient-to-br ${grad.outer}`}
      aria-hidden
    >
      <div className={`w-full h-full rounded-[6px] flex items-center justify-center text-[12px] font-semibold text-white bg-gradient-to-br ${grad.inner}`}>
        {initials}
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    // Tighter padding (px-4 py-4 vs the prior p-5) so the form takes
    // less horizontal space when the Architect drawer is open. The
    // drawer eats 480-620px on the right; with the old p-5 every
    // section card lost another 40px to whitespace at narrow widths.
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {hint && <p className="text-[11px] text-[#666] mt-0.5">{hint}</p>}
      </div>
      <div className="space-y-3.5">{children}</div>
    </section>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      {label && (
        <label className="block text-[11px] uppercase tracking-wider text-[#A7B0B7] mb-1.5">
          {label}{required && <span className="text-[#DFFF00] ml-0.5">*</span>}
        </label>
      )}
      {children}
      {hint && <p className="text-[11px] text-[#666] mt-1.5">{hint}</p>}
    </div>
  );
}

function TypeButton({
  active,
  accent,
  onClick,
  children,
}: {
  active: boolean;
  accent: 'lime' | 'purple';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeCls =
    accent === 'lime'
      ? 'bg-[#DFFF00]/15 text-[#DFFF00] border-[#DFFF00]/30'
      : 'bg-purple-500/15 text-purple-200 border-purple-400/30';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium border transition-colors ${
        active ? activeCls : 'bg-white/[0.02] text-[#A7B0B7] border-white/10 hover:bg-white/[0.04]'
      }`}
    >
      {children}
    </button>
  );
}
