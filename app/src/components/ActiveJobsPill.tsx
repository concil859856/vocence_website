import { useState } from 'react';
import { Activity, Mic, Copy as CopyIcon, Film, Music as MusicIcon, Palette, Zap, X, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useGenerations, type JobType } from '../contexts/GenerationsContext';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';

const TYPE_META: Record<JobType, { label: string; color: string; icon: typeof Mic; href: string }> = {
  tts:          { label: 'TTS',          color: '#DFFF00', icon: Zap,      href: '/studio/tts' },
  stt:          { label: 'STT',          color: '#34d399', icon: Mic,      href: '/studio/stt' },
  clone:        { label: 'Voice clone',  color: '#22d3ee', icon: CopyIcon, href: '/studio/cloning' },
  voice_design: { label: 'Voice design', color: '#a78bfa', icon: Palette,  href: '/studio/voice-design' },
  music:        { label: 'Music',        color: '#f472b6', icon: MusicIcon, href: '/studio/music' },
  video_dub:    { label: 'Video dubbing', color: '#fb923c', icon: Film,     href: '/studio/dubbing' },
};

type PillVariant = 'sidebar' | 'floating';

export function ActiveJobsPill({ variant = 'sidebar' }: { variant?: PillVariant } = {}) {
  const { jobs, pendingCount, dismiss } = useGenerations();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (pendingCount === 0) return null;

  const pending = jobs.filter((j) => j.status === 'pending');
  const hasStale = pending.some((j) => j.staleAfterReload);
  const isFloating = variant === 'floating';

  // Floating variant: pill is auto-width and the dropdown opens UPWARD
  // (bottom-full) and aligns to the RIGHT so it never clips the
  // viewport edge. Sidebar variant keeps the original "stretch to
  // sidebar width, drop down" layout.
  const buttonLayout = isFloating
    ? 'inline-flex shadow-2xl'
    : 'w-full flex';
  const dropdownPosition = isFloating
    ? 'absolute bottom-full right-0 mb-2 w-[280px]'
    : 'absolute left-0 right-0 mt-2';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${buttonLayout} items-center gap-2 px-3 py-2 rounded-xl border text-xs transition-colors ${
          hasStale
            ? 'border-amber-300/30 bg-amber-400/[0.08] text-amber-200 hover:bg-amber-400/[0.12]'
            : 'border-[#DFFF00]/30 bg-[#DFFF00]/[0.06] text-[#DFFF00] hover:bg-[#DFFF00]/[0.10]'
        }`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="relative flex h-2 w-2">
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${hasStale ? 'bg-amber-400' : 'bg-[#DFFF00]'}`} />
          <span className={`relative inline-flex rounded-full h-2 w-2 ${hasStale ? 'bg-amber-400' : 'bg-[#DFFF00]'}`} />
        </span>
        <Activity size={12} />
        <span className="font-semibold">{pendingCount}</span>
        <span className="opacity-70">{hasStale ? 'in flight' : 'generating'}</span>
      </button>

      {open && (
        <div
          className={`${dropdownPosition} rounded-xl border border-white/10 bg-[#0f1115] p-2 shadow-2xl z-30`}
          role="menu"
        >
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-[10px] uppercase tracking-[0.14em] text-[#666]">Active jobs</p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-[#666] hover:text-white"
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </div>
          <ul className="space-y-1">
            {pending.map((j) => {
              const meta = TYPE_META[j.type];
              const Icon = meta.icon;
              const elapsed = Math.floor((Date.now() - j.startedAt) / 1000);
              const isStale = !!j.staleAfterReload;
              const row = (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/[0.05] group">
                  <button
                    type="button"
                    onClick={() => {
                      navigate(isStale ? '/studio/history' : meta.href);
                      setOpen(false);
                    }}
                    className="flex-1 flex items-center gap-2 min-w-0 text-left"
                  >
                    <span className="w-7 h-7 rounded-md flex items-center justify-center shrink-0" style={{ background: `${meta.color}1a`, color: meta.color }}>
                      {isStale ? <AlertTriangle size={14} className="text-amber-400" /> : <Icon size={14} />}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-xs text-white truncate">{j.label}</span>
                      <span className="block text-[10px] text-[#666]">
                        {meta.label} · {isStale ? 'after reload' : `${elapsed}s`}
                      </span>
                    </span>
                  </button>
                  {isStale && (
                    <button
                      type="button"
                      onClick={() => dismiss(j.id)}
                      className="opacity-50 group-hover:opacity-100 text-[#888] hover:text-white"
                      aria-label="Dismiss"
                      title="Dismiss"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              );
              return (
                <li key={j.id}>
                  {isStale ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{row}</TooltipTrigger>
                      <TooltipContent
                        side="right"
                        align="start"
                        sideOffset={8}
                        className="max-w-[260px] rounded-xl border border-amber-300/25 bg-[#1a1610] px-3.5 py-3 text-amber-100 shadow-2xl"
                      >
                        <div className="flex items-start gap-2">
                          <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
                          <div className="space-y-1.5">
                            <p className="text-xs font-semibold text-white">Connection lost</p>
                            <p className="text-[11px] leading-relaxed text-amber-100/80">
                              We lost the connection to this {meta.label.toLowerCase()} generation, likely because you reloaded the page.
                            </p>
                            <p className="text-[11px] leading-relaxed text-amber-100/80">
                              Check the <span className="text-amber-200 font-medium">History</span> page to see if it completed.
                            </p>
                          </div>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
