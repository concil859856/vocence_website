import { useState } from 'react';
import { Sparkles, Play } from 'lucide-react';
import { Link } from 'react-router-dom';
import { VideoPlayerModal } from './VideoPlayerModal';

/**
 * Studio home page hero.
 *
 * Single-accent design: brand chartreuse (#DFFF00) on a near-black
 * card with neutral grays for everything else. No secondary hues —
 * the page is busy enough downstream that the hero should ground
 * the eye, not compete with the cards below.
 *
 * Right column hosts an animated brand orb (rings + halo + breathing
 * inner sphere with the Vocence mark). All animations are pure CSS
 * keyframes co-located in this file, no new deps, no Tailwind config
 * changes. Respects prefers-reduced-motion.
 */
const DEMO_VIDEO_URL = 'https://audio.vocence.ai/vocence_intro.mp4';

export function StudioHeroBanner() {
  const [demoOpen, setDemoOpen] = useState(false);
  return (
    <section
      aria-label="Vocence Studio"
      className="
        relative overflow-hidden rounded-[28px]
        border border-white/[0.06] bg-[#0A0A0B]
        px-6 py-12 md:px-14 md:py-16
      "
    >
      <BackgroundAura />

      <div className="relative grid grid-cols-1 lg:grid-cols-[1.05fr,0.95fr] gap-12 items-center">
        {/* ---------- LEFT: copy + CTAs + stats ---------- */}
        <div>
          <h1 className="font-bold leading-[0.95] tracking-tight text-white text-[44px] sm:text-[58px] md:text-[68px]">
            One studio.
            <br />
            <span className="text-[#DFFF00]">Every voice.</span>
          </h1>

          <p className="mt-6 max-w-[520px] text-[15px] md:text-base leading-relaxed text-[#A7B0B7]">
            Design speech, clone voices, score music, and ship real-time
            agents, all in one place. From a single line of text to
            millions of live conversations.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link
              to="/studio/voice-design"
              className="
                group inline-flex items-center gap-2
                rounded-full px-5 py-3 text-sm font-semibold
                bg-[#DFFF00] text-[#0A0A0B]
                shadow-[0_10px_30px_-12px_rgba(223,255,0,0.55)]
                transition-transform hover:-translate-y-0.5
              "
            >
              <Sparkles className="h-4 w-4" />
              Start creating
            </Link>
            <button
              type="button"
              onClick={() => setDemoOpen(true)}
              className="
                inline-flex items-center gap-2
                rounded-full border border-white/[0.10] bg-white/[0.03]
                px-5 py-3 text-sm font-medium text-white/85
                hover:bg-white/[0.06] transition-colors
              "
            >
              <span className="grid h-6 w-6 place-items-center rounded-full bg-white/10">
                <Play className="h-3 w-3 fill-white text-white" />
              </span>
              Watch the demo · 0:53
            </button>
          </div>

          <dl className="mt-12 grid grid-cols-3 gap-x-10 max-w-[500px]">
            <StatTile value="74"  label="Studio voices" />
            <StatTile value="24"  label="Languages" />
            <StatTile value="<1s" label="Avg latency" />
          </dl>
        </div>

        {/* ---------- RIGHT: animated brand orb ---------- */}
        <div className="relative h-[340px] md:h-[420px] flex items-center justify-center">
          <BrandOrb />
        </div>
      </div>

      <HeroStyles />

      <VideoPlayerModal
        open={demoOpen}
        onClose={() => setDemoOpen(false)}
        src={DEMO_VIDEO_URL}
        title="Vocence — product demo"
      />
    </section>
  );
}


/* ------------------------------------------------------------------ */

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <dt className="text-[28px] md:text-[32px] font-semibold tracking-tight text-white">
        {value}
      </dt>
      <dd className="mt-1 text-[10.5px] tracking-[0.18em] uppercase text-white/40">
        {label}
      </dd>
    </div>
  );
}


function BrandOrb() {
  // The orb borrows its layer structure from the Sonar Orb reference:
  //   aura · sonar pings · main orb (ribbon + node + logo).
  // Each layer has its own keyframe defined at the bottom of the file.
  return (
    <div className="relative h-[240px] w-[240px] md:h-[288px] md:w-[288px]">
      {/* No static halo, the chartreuse glow now lives on the
          orbiting yellow dot below, so the only yellow on the canvas
          is the moving one. Keeps the rest of the orb space clean. */}

      {/* SONAR PINGS, two stacked rings that expand outward and fade.
          Second one is half-cycle delayed so there's always one mid-ping. */}
      <span aria-hidden className="voc-sonar absolute inset-0 rounded-full" />
      <span aria-hidden className="voc-sonar absolute inset-0 rounded-full" style={{ animationDelay: '1.6s' }} />

      {/* ORBIT NODES, three dots (green, yellow, blue) sharing the
          same orbit. Each lives in a wrapper rotated to its angle so
          the parent's spin carries all three together at 120° apart. */}
      <div className="absolute inset-[6%] voc-orbit pointer-events-none">
        <OrbitDot angleDeg={0}   color="#22C55E" />
        <OrbitDot angleDeg={120} color="#DFFF00" />
        <OrbitDot angleDeg={240} color="#3B82F6" />
      </div>

      {/* BRAND MARK, sits directly in space, no disc behind it. */}
      <img
        src="/tab_logo.png"
        alt="Vocence"
        className="
          absolute inset-0 m-auto h-[78%] w-[78%] object-contain
          drop-shadow-[0_0_22px_rgba(0,0,0,0.5)]
        "
      />
    </div>
  );
}




function OrbitDot({ angleDeg, color }: { angleDeg: number; color: string }) {
  return (
    <div
      className="absolute inset-0"
      style={{ transform: `rotate(${angleDeg}deg)` }}
    >
      <span
        className="absolute left-1/2 -translate-x-1/2 -top-[1.5px] h-[5px] w-[5px] rounded-full"
        style={{
          backgroundColor: color,
          boxShadow: `0 0 7px 1px ${color}D9`, // D9 ≈ 85% alpha in hex
        }}
      />
    </div>
  );
}


function BackgroundAura() {
  return (
    <>
      {/* Subtle dot grid */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none opacity-[0.045]"
        style={{
          backgroundImage:
            'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.55) 1px, transparent 0)',
          backgroundSize: '26px 26px',
        }}
      />
    </>
  );
}


function HeroStyles() {
  return (
    <style>{`
      /* Sonar pings: ring starts at orb size, expands outward, fades.
         Two stacked instances with offset delays create the
         "always-one-mid-pulse" effect. */
      @keyframes voc-sonar {
        0%   { transform: scale(0.84); opacity: 0;   }
        18%  {                          opacity: 0.7; }
        100% { transform: scale(1.28); opacity: 0;   }
      }
      .voc-sonar {
        /* Hairline yellow ring uniformly around the full 360°. Sub-pixel
           border so it stays a true line at any scale. */
        border: 0.5px solid rgba(223,255,0,0.55);
        animation: voc-sonar 3.6s cubic-bezier(0.22, 0.61, 0.36, 1) infinite;
        will-change: transform, opacity;
      }

      /* Orbit: a child node is positioned at 12 o'clock; rotating the
         parent carries it around the rim of the orb. */
      @keyframes voc-orbit {
        from { transform: rotate(0deg);   }
        to   { transform: rotate(360deg); }
      }
      .voc-orbit { animation: voc-orbit 9s linear infinite; }

      @media (prefers-reduced-motion: reduce) {
        .voc-sonar, .voc-orbit {
          animation: none !important;
        }
      }
    `}</style>
  );
}
