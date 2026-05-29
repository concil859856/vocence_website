/**
 * AgentOrb — animated focal point for voice-call mode.
 *
 * Four states, each visually distinct so a user can tell at a glance
 * who's currently doing what:
 *
 *   idle       slow ambient breath, soft glow
 *   listening  reactive to mic input level — outer ring expands with volume
 *   thinking   slow rotation + shimmer (LLM is generating)
 *   speaking   reactive to TTS output amplitude — inner core pulses
 *
 * Pure SVG + CSS so it stays light (no WebGL, no Three.js dependency).
 * Borrows the visual language ElevenLabs popularized with their open-
 * source orb but stays Vocence-branded (lime-on-charcoal).
 */

import { useEffect, useState } from 'react';

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Props {
  state: OrbState;
  /** 0–1 amplitude reactivity. From mic level when listening, from TTS
   *  output when speaking. Ignored in idle / thinking. */
  level?: number;
  size?: number;
  /** Agent's initial(s) shown in the center of the orb. */
  initials?: string;
}

export function AgentOrb({ state, level = 0, size = 280, initials }: Props) {
  // Smooth the level so the orb breathes rather than twitches per frame.
  // ``requestAnimationFrame`` lerp with a tiny step makes mic spikes
  // visually pleasing instead of jittery.
  const [smoothed, setSmoothed] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      setSmoothed((prev) => prev + (level - prev) * 0.18);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [level]);

  // Per-state visual params. Reactive amplitude maps to outer-ring
  // scale in listening, core-glow intensity in speaking.
  const reactiveScale = state === 'listening' ? 1 + smoothed * 0.18 : 1;
  const coreGlowOpacity = state === 'speaking' ? 0.55 + smoothed * 0.35 : 0.4;

  const hue = stateHue(state);

  return (
    <div
      className="relative inline-flex items-center justify-center"
      style={{ width: size, height: size }}
      aria-label={`Agent is ${state}`}
    >
      {/* Outer ambient halo — always-on but soft */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none transition-all duration-300"
        style={{
          background: `radial-gradient(circle, ${hue.halo} 0%, transparent 65%)`,
          opacity: state === 'idle' ? 0.5 : 0.85,
          filter: 'blur(20px)',
        }}
      />

      {/* Listening ring — outer pulse reactive to mic level */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none transition-transform duration-100"
        style={{
          transform: `scale(${reactiveScale})`,
          border: state === 'listening' ? `2px solid ${hue.ringStrong}` : `1px solid ${hue.ringSoft}`,
          opacity: state === 'listening' ? 0.7 : 0.2,
        }}
      />

      {/* Idle / thinking breathing ring — slow scale via CSS */}
      <div
        className={`absolute inset-2 rounded-full pointer-events-none ${
          state === 'idle' ? 'orb-breathe' : state === 'thinking' ? 'orb-spin' : ''
        }`}
        style={{
          border: `1px solid ${hue.ringSoft}`,
          opacity: 0.4,
        }}
      />

      {/* Core orb — gradient ball with glow */}
      <div
        className="absolute rounded-full transition-all duration-300"
        style={{
          inset: '14%',
          background: `radial-gradient(circle at 35% 30%, ${hue.coreLight}, ${hue.coreDark})`,
          boxShadow: `
            inset 0 0 60px rgba(0, 0, 0, 0.4),
            0 0 80px ${hue.glow}
          `,
          opacity: coreGlowOpacity + 0.45,
        }}
      />

      {/* Speaking shimmer — translucent overlay that pulses with TTS */}
      {state === 'speaking' && (
        <div
          className="absolute rounded-full pointer-events-none"
          style={{
            inset: '20%',
            background: `radial-gradient(circle, ${hue.shimmer} 0%, transparent 70%)`,
            opacity: 0.3 + smoothed * 0.4,
            mixBlendMode: 'screen',
          }}
        />
      )}

      {/* Initials at center (optional) */}
      {initials && (
        <div
          className="relative font-semibold text-white/85 select-none pointer-events-none"
          style={{
            fontSize: size * 0.22,
            textShadow: `0 0 14px ${hue.glow}`,
          }}
        >
          {initials}
        </div>
      )}

      {/* Inline keyframes — keeping the orb self-contained so any page
          that imports it just works without a global stylesheet edit. */}
      <style>{`
        @keyframes orb-breathe-kf {
          0%, 100% { transform: scale(1); opacity: 0.4; }
          50%      { transform: scale(1.05); opacity: 0.6; }
        }
        @keyframes orb-spin-kf {
          from { transform: rotate(0deg);   opacity: 0.4; }
          to   { transform: rotate(360deg); opacity: 0.4; }
        }
        .orb-breathe { animation: orb-breathe-kf 4s ease-in-out infinite; }
        .orb-spin    { animation: orb-spin-kf 6s linear infinite; }
      `}</style>
    </div>
  );
}

function stateHue(state: OrbState) {
  switch (state) {
    case 'listening':
      // Cyan — visually obvious "your input matters now"
      return {
        halo: 'rgba(125, 211, 252, 0.5)',
        ringSoft: 'rgba(125, 211, 252, 0.3)',
        ringStrong: 'rgba(125, 211, 252, 0.7)',
        coreLight: '#7dd3fc',
        coreDark: '#0c4a6e',
        glow: 'rgba(125, 211, 252, 0.5)',
        shimmer: 'rgba(186, 230, 253, 0.7)',
      };
    case 'thinking':
      // Muted violet — "processing, not yours to interrupt"
      return {
        halo: 'rgba(196, 181, 253, 0.45)',
        ringSoft: 'rgba(196, 181, 253, 0.3)',
        ringStrong: 'rgba(196, 181, 253, 0.6)',
        coreLight: '#c4b5fd',
        coreDark: '#4c1d95',
        glow: 'rgba(196, 181, 253, 0.4)',
        shimmer: 'rgba(221, 214, 254, 0.7)',
      };
    case 'speaking':
      // Brand lime — "the agent is talking"
      return {
        halo: 'rgba(223, 255, 0, 0.5)',
        ringSoft: 'rgba(223, 255, 0, 0.3)',
        ringStrong: 'rgba(223, 255, 0, 0.7)',
        coreLight: '#dfff00',
        coreDark: '#4d5a00',
        glow: 'rgba(223, 255, 0, 0.55)',
        shimmer: 'rgba(255, 255, 255, 0.85)',
      };
    case 'idle':
    default:
      // Neutral white-grey — quiet, waiting
      return {
        halo: 'rgba(255, 255, 255, 0.18)',
        ringSoft: 'rgba(255, 255, 255, 0.15)',
        ringStrong: 'rgba(255, 255, 255, 0.4)',
        coreLight: '#cbd5e1',
        coreDark: '#1e293b',
        glow: 'rgba(255, 255, 255, 0.18)',
        shimmer: 'rgba(255, 255, 255, 0.6)',
      };
  }
}
