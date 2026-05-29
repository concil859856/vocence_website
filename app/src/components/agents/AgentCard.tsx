/**
 * AgentCard — tile shown in the agents list grid.
 *
 * Visual goals:
 *   • One clear focal point: the avatar.
 *   • Subtle identity tint in the top-right corner using the agent's
 *     own outer-ring gradient — every card feels distinct without
 *     shouting.
 *   • Hover lifts the card with a soft shadow + slight upward shift,
 *     and the avatar scales up a touch so the card feels alive.
 *   • Active status pulses; everything else is a quiet dot.
 */

import { Link } from 'react-router-dom';
import { Clock, Play } from 'lucide-react';
import type { Agent } from '../../lib/agents/types';
import { AgentAvatar } from './AgentAvatar';
import { avatarGradientPairFor } from '../../data/sampleVoices';

const STATUS_DOT: Record<Agent['status'], { color: string; ring: string; pulse: boolean }> = {
  active:   { color: 'bg-emerald-400', ring: 'shadow-[0_0_0_3px_rgba(52,211,153,0.18)]', pulse: true },
  paused:   { color: 'bg-amber-400',   ring: 'shadow-[0_0_0_3px_rgba(251,191,36,0.16)]', pulse: false },
  draft:    { color: 'bg-white/30',    ring: '', pulse: false },
  archived: { color: 'bg-white/15',    ring: '', pulse: false },
};

const STATUS_LABEL: Record<Agent['status'], string> = {
  active: 'Active',
  paused: 'Paused',
  draft: 'Draft',
  archived: 'Archived',
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

export function AgentCard({ agent }: { agent: Agent }) {
  const typeLabel = agent.type === 'goal' ? 'Goal agent' : 'Knowledge agent';
  const status = STATUS_DOT[agent.status];
  // Faint identity tint using the agent's own outer-ring gradient.
  // 12 % opacity in the top-right corner, blurred, so each card carries
  // a hint of the agent's color without looking gaudy.
  const grad = avatarGradientPairFor(`agent-${agent.id}`);

  return (
    <Link
      to={`/studio/agents/${agent.id}`}
      className="group relative block rounded-2xl border border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 hover:-translate-y-[1px] hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-all duration-300 p-5 overflow-hidden"
    >
      {/* Identity-tinted corner glow */}
      <div
        className={`pointer-events-none absolute -top-12 -right-12 w-36 h-36 rounded-full bg-gradient-to-br ${grad.outer} opacity-[0.10] blur-2xl group-hover:opacity-[0.16] transition-opacity duration-500`}
        aria-hidden
      />

      {/* Header: avatar + name + status */}
      <div className="relative flex items-start gap-4 mb-4">
        <div className="transition-transform duration-300 group-hover:scale-[1.04]">
          <AgentAvatar id={agent.id} name={agent.name} size="lg" rounded="full" />
        </div>
        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-white font-semibold text-[15px] truncate leading-tight">
              {agent.name}
            </h3>
            <span className="relative shrink-0" title={STATUS_LABEL[agent.status]} aria-label={STATUS_LABEL[agent.status]}>
              <span className={`block w-2 h-2 rounded-full ${status.color} ${status.ring}`} />
              {status.pulse && (
                <span className={`absolute inset-0 rounded-full ${status.color} animate-ping opacity-60`} />
              )}
            </span>
          </div>
          <div className="text-[11px] text-[#A7B0B7] mt-0.5">{typeLabel}</div>
        </div>
      </div>

      {/* Purpose */}
      <p className="relative text-[#A7B0B7] text-[13px] leading-relaxed line-clamp-2 mb-5 min-h-[2.6em]">
        {agent.config.purpose || <span className="text-[#666] italic">No purpose set yet.</span>}
      </p>

      {/* Footer stats — runs / last-run are GOAL-agent concepts. For
          knowledge (voice-chat) agents they're always 0 / never and
          just add noise, so we hide them. Knowledge-agent footer is
          intentionally blank for now; we can swap in conversation
          metrics later. */}
      {agent.type === 'goal' && (
        <div className="relative flex items-center gap-3 text-[11px] text-[#7a7f86]">
          <span className="inline-flex items-center gap-1">
            <Play size={10} className="opacity-70" />
            {agent.run_count} run{agent.run_count === 1 ? '' : 's'}
          </span>
          <span className="text-white/10">·</span>
          <span className="inline-flex items-center gap-1">
            <Clock size={10} className="opacity-70" />
            {formatRelative(agent.last_run_at)}
          </span>
        </div>
      )}
    </Link>
  );
}
