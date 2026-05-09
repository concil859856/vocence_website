/**
 * AgentConfigForm — flat, always-editable form for an agent's full config.
 *
 * Used in both the Builder (with a side Architect drawer) and the Detail
 * page's Settings tab. Every field is a plain input/textarea — no edit/save
 * toggle. Parent owns state; this is a controlled component.
 */

import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { AgentConfig, AgentType } from '../../lib/agents/types';
import { SAMPLE_VOICE_INDEX, SAMPLE_VOICES, avatarGradientPairFor } from '../../data/sampleVoices';
import { SampleVoiceAvatar } from '../studio/SampleVoiceAvatar';
import { SampleVoicePickerModal } from '../studio/SampleVoicePickerModal';
import { Select } from '../ui/DropdownSelect';
import { dashboardApi, type StudioDesignedVoiceItem } from '../../services/dashboardApi';
import { getStoredToken } from '../../lib/agents/api';

interface Props {
  name: string;
  type: AgentType;
  config: AgentConfig;
  availableModels: { id: string; label: string }[];
  onChange: (patch: { name?: string; type?: AgentType; config?: Partial<AgentConfig> }) => void;
  /** Optional architect trigger — shown as a subtle helper next to fields. */
  onAskArchitect?: (focusField?: string) => void;
}

const LANGUAGE_OPTIONS = ['English', 'Chinese', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'];

export function AgentConfigForm({ name, type, config, availableModels, onChange }: Props) {
  const isGoal = type === 'goal';
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [designedVoices, setDesignedVoices] = useState<StudioDesignedVoiceItem[]>([]);

  // Pull the user's saved "My Voices" so they appear alongside the
  // sample voices in the picker. Failures are silent — the picker
  // simply won't show the My Voices section.
  useEffect(() => {
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    dashboardApi
      .listStudioDesignedVoices(token)
      .then((r) => { if (!cancelled) setDesignedVoices(r.voices); })
      .catch(() => { /* ignore — picker will just not show My Voices */ });
    return () => { cancelled = true; };
  }, []);

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
          <TypeButton active={type === 'goal'} onClick={() => onChange({ type: 'goal' })} accent="purple">
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
        <Field label="System prompt">
          <textarea
            value={config.system_prompt}
            onChange={(e) => onChange({ config: { system_prompt: e.target.value } })}
            placeholder="You are a friendly Postgres expert. Answer concisely. If you don't know, say so."
            rows={8}
            className="w-full bg-[#07080A] border border-white/15 rounded-lg px-3 py-2 text-[13px] text-white placeholder:text-[#666] focus:outline-none focus:border-[#DFFF00]/40 resize-y font-mono"
          />
        </Field>
      </Section>

      {/* Knowledge */}
      <Section title="Knowledge" hint="Reference text injected into context every turn. v1 is text-only — file/URL upload coming soon.">
        <Field label="">
          <textarea
            value={config.knowledge}
            onChange={(e) => onChange({ config: { knowledge: e.target.value } })}
            placeholder="Pricing tiers, FAQ entries, API examples, error code lookups…"
            rows={6}
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
          <Field label="Voice" hint="Pick from sample voices or your saved My Voices — the agent will speak using this voice.">
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

      <SampleVoicePickerModal
        open={voicePickerOpen}
        selectedId={config.voice}
        onSelect={(v) => onChange({ config: { voice: v.id } })}
        designedVoices={designedVoices}
        onSelectDesigned={(encodedId) => onChange({ config: { voice: encodedId } })}
        onClose={() => setVoicePickerOpen(false)}
      />
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
    <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        {hint && <p className="text-[11px] text-[#666] mt-0.5">{hint}</p>}
      </div>
      <div className="space-y-4">{children}</div>
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
