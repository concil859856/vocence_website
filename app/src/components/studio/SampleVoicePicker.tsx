/**
 * SampleVoicePicker — flat one-row-per-voice list.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [⭕]  Aria                                            ▶  │
 *   │       Bright, energetic female voice                     │
 *   │       ━━━━━━━━━━━ 0:08                                   │  ← while playing
 *   └──────────────────────────────────────────────────────────┘
 *
 * Click anywhere on the row → select that voice.
 * Click the play button → preview the sample. Audio is owned by the
 * picker (not the row), so playing one voice automatically stops any
 * other that's currently previewing.
 */

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { asset } from '../../data/assets';
import { API_BASE_URL } from '../../services/baseUrl';
import {
  SAMPLE_VOICES,
  avatarGradientPairFor,
  resolveSampleVoiceAudioUrl,
  type SampleVoice,
} from '../../data/sampleVoices';
import { SampleVoiceAvatar } from './SampleVoiceAvatar';
import type { StudioDesignedVoiceItem } from '../../services/dashboardApi';

interface Props {
  selectedId: string | null;
  onSelect: (voice: SampleVoice) => void;
  /** Optional list of the user's saved "My Voices" (designed via Voice
   * Design A/B preview). When provided, they're rendered as a separate
   * section above the sample voices. The selected id for a designed
   * voice is encoded as ``dv:<numeric_id>``. */
  designedVoices?: StudioDesignedVoiceItem[];
  /** Selection callback for a designed voice. The encoded id ``dv:<n>``
   * is what gets stored on the agent config. */
  onSelectDesigned?: (encodedId: string, item: StudioDesignedVoiceItem) => void;
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) return '0:00';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function SampleVoicePicker({
  selectedId,
  onSelect,
  designedVoices,
  onSelectDesigned,
}: Props) {
  // Order is fixed (already hand-shuffled in sampleVoices.ts).
  const voices = SAMPLE_VOICES;
  const liveDesigned = (designedVoices ?? []).filter((v) => !v.expired && !!v.audio_url);

  // ----- Single shared audio engine ----------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);

  // Cleanup on unmount
  useEffect(() => () => {
    try { audioRef.current?.pause(); } catch { /* ignore */ }
    audioRef.current = null;
  }, []);

  const stopCurrent = () => {
    if (audioRef.current) {
      try { audioRef.current.pause(); } catch { /* ignore */ }
      audioRef.current = null;
    }
    setPlayingId(null);
    setPos(0);
    setDur(0);
  };

  const togglePlay = (voice: SampleVoice, url: string) => {
    if (!url) return;
    if (playingId === voice.id) {
      stopCurrent();
      return;
    }
    // Switching voice → stop the previous one first
    stopCurrent();
    const a = new Audio(url);
    audioRef.current = a;
    setPlayingId(voice.id);
    a.addEventListener('loadedmetadata', () => setDur(a.duration || 0));
    a.addEventListener('timeupdate', () => setPos(a.currentTime || 0));
    a.addEventListener('ended', () => {
      // only clear if this is still the current audio
      if (audioRef.current === a) stopCurrent();
    });
    a.addEventListener('error', () => {
      if (audioRef.current === a) stopCurrent();
    });
    a.play().catch(() => {
      if (audioRef.current === a) stopCurrent();
    });
  };

  return (
    <div className="space-y-6">
      {liveDesigned.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[11px] uppercase tracking-wider text-[#A7B0B7] px-1">My Voices</h3>
          {liveDesigned.map((dv) => {
            const encodedId = `dv:${dv.id}`;
            const isPlaying = playingId === encodedId;
            const pct = isPlaying && dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
            return (
              <DesignedVoiceRow
                key={dv.id}
                item={dv}
                selected={selectedId === encodedId}
                isPlaying={isPlaying}
                playPct={pct}
                playPos={isPlaying ? pos : 0}
                playDur={isPlaying ? dur : 0}
                onSelect={() => onSelectDesigned?.(encodedId, dv)}
                onTogglePlay={() => {
                  if (!dv.audio_url) return;
                  if (playingId === encodedId) {
                    stopCurrent();
                    return;
                  }
                  stopCurrent();
                  const a = new Audio(dv.audio_url);
                  audioRef.current = a;
                  setPlayingId(encodedId);
                  a.addEventListener('loadedmetadata', () => setDur(a.duration || 0));
                  a.addEventListener('timeupdate', () => setPos(a.currentTime || 0));
                  a.addEventListener('ended', () => { if (audioRef.current === a) stopCurrent(); });
                  a.addEventListener('error', () => { if (audioRef.current === a) stopCurrent(); });
                  a.play().catch(() => { if (audioRef.current === a) stopCurrent(); });
                }}
              />
            );
          })}
        </section>
      )}
      <section className="space-y-2">
        {liveDesigned.length > 0 && (
          <h3 className="text-[11px] uppercase tracking-wider text-[#A7B0B7] px-1">Sample voices</h3>
        )}
        {voices.map((voice) => {
          const url = resolveSampleVoiceAudioUrl(voice, asset, API_BASE_URL);
          const isPlaying = playingId === voice.id;
          const pct = isPlaying && dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
          return (
            <VoiceRow
              key={voice.id}
              voice={voice}
              selected={selectedId === voice.id}
              isPlaying={isPlaying}
              playPct={pct}
              playPos={isPlaying ? pos : 0}
              playDur={isPlaying ? dur : 0}
              onSelect={() => onSelect(voice)}
              onTogglePlay={() => togglePlay(voice, url)}
            />
          );
        })}
      </section>
    </div>
  );
}

function DesignedVoiceRow({
  item,
  selected,
  isPlaying,
  playPct,
  playPos,
  playDur,
  onSelect,
  onTogglePlay,
}: {
  item: StudioDesignedVoiceItem;
  selected: boolean;
  isPlaying: boolean;
  playPct: number;
  playPos: number;
  playDur: number;
  onSelect: () => void;
  onTogglePlay: () => void;
}) {
  const showProgress = isPlaying || playPos > 0;
  const initials = (item.display_name || 'V')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`w-full cursor-pointer text-left flex items-center gap-4 rounded-xl border bg-white/[0.02] hover:bg-white/[0.04] transition-colors px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#DFFF00]/40 ${
        selected ? 'border-[#DFFF00] ring-1 ring-[#DFFF00]/30' : 'border-white/10 hover:border-white/25'
      }`}
    >
      {(() => {
        const grad = avatarGradientPairFor(`dv-${item.id}`);
        return (
          <div className={`shrink-0 w-12 h-12 rounded-full p-[2px] bg-gradient-to-br ${grad.outer}`}>
            <div className={`w-full h-full rounded-full flex items-center justify-center text-sm font-semibold text-white bg-gradient-to-br ${grad.inner}`}>
              {initials || 'V'}
            </div>
          </div>
        );
      })()}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-white truncate">{item.display_name || 'Untitled voice'}</span>
          {selected && (
            <span className="text-[10px] uppercase tracking-wider text-[#DFFF00]">Selected</span>
          )}
        </div>
        <div className="text-xs text-[#A7B0B7] truncate">{item.voice_description || 'Custom designed voice'}</div>
        {showProgress && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-white/[0.08] overflow-hidden">
              <div className="h-full bg-[#DFFF00] transition-[width] duration-100" style={{ width: `${playPct}%` }} />
            </div>
            <span className="text-[10px] text-[#666] tabular-nums shrink-0">
              {fmt(playPos)} / {fmt(playDur)}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePlay(); }}
        disabled={!item.audio_url}
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
          isPlaying
            ? 'bg-[#DFFF00] text-[#07080A]'
            : 'bg-white/[0.06] text-white hover:bg-white/[0.10] disabled:opacity-30'
        }`}
        aria-label={isPlaying ? `Pause ${item.display_name}` : `Play ${item.display_name}`}
      >
        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
    </div>
  );
}

function VoiceRow({
  voice,
  selected,
  isPlaying,
  playPct,
  playPos,
  playDur,
  onSelect,
  onTogglePlay,
}: {
  voice: SampleVoice;
  selected: boolean;
  isPlaying: boolean;
  playPct: number;
  playPos: number;
  playDur: number;
  onSelect: () => void;
  onTogglePlay: () => void;
}) {
  const showProgress = isPlaying || playPos > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); } }}
      className={`w-full cursor-pointer text-left flex items-center gap-4 rounded-xl border bg-white/[0.02] hover:bg-white/[0.04] transition-colors px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-[#DFFF00]/40 ${
        selected ? 'border-[#DFFF00] ring-1 ring-[#DFFF00]/30' : 'border-white/10 hover:border-white/25'
      }`}
    >
      <SampleVoiceAvatar voice={voice} size="md" rounded="full" />

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-white truncate">{voice.name}</span>
          {selected && (
            <span className="text-[10px] uppercase tracking-wider text-[#DFFF00]">Selected</span>
          )}
        </div>
        <div className="text-xs text-[#A7B0B7] truncate">{voice.description}</div>
        {showProgress && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1 rounded-full bg-white/[0.08] overflow-hidden">
              <div
                className="h-full bg-[#DFFF00] transition-[width] duration-100"
                style={{ width: `${playPct}%` }}
              />
            </div>
            <span className="text-[10px] text-[#666] tabular-nums shrink-0">
              {useFmt(playPos)} / {useFmt(playDur)}
            </span>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onTogglePlay(); }}
        className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
          isPlaying
            ? 'bg-[#DFFF00] text-[#07080A]'
            : 'bg-white/[0.06] text-white hover:bg-white/[0.10]'
        }`}
        aria-label={isPlaying ? `Pause ${voice.name}` : `Play ${voice.name}`}
      >
        {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
      </button>
    </div>
  );
}

// (small helper kept inline to stay local — same as `fmt` above; using a
// local name so the JSX below reads naturally without re-declaring fmt)
function useFmt(t: number): string {
  return fmt(t);
}
