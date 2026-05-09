/**
 * Sample voice catalog for the General TTS subpage.
 *
 * 28 voices — flat list (no groups). The backend has its own copy of the
 * audio URLs / file paths in dashboard-backend/sample_voices_data.py —
 * keep them in sync.
 *
 * Two audio sources:
 *  - imageAssetKey + audioAssetKey present → CDN-hosted (audio.vocence.ai)
 *  - audioStaticPath present → served by dashboard-backend at
 *    /api/dashboard/sample-voices/{file}; render a code avatar instead.
 */

export interface SampleVoice {
  id: string;             // stable id used by the backend voice-clone endpoint
  name: string;           // display name
  description: string;    // 1-line vibe / tone

  // Either the CDN-asset pair (older curated voices)…
  imageAssetKey?: string;
  audioAssetKey?: string;

  // …or a backend-static path (newer local voices)
  imageStaticPath?: string;   // file under /api/dashboard/sample-voices/
  audioStaticPath?: string;
}

// Order is hand-shuffled and intentionally fixed — voices interleave so
// nothing groups by source (CDN vs local, design vs character).
// Don't re-sort or re-shuffle.
export const SAMPLE_VOICES: SampleVoice[] = [
  { id: 'voc-atlas',   name: 'Atlas',   description: 'Deep, commanding male voice',
    audioStaticPath: 'deep_male.wav',  imageStaticPath: 'voc-atlas.webp' },
  { id: 'design-aria', name: 'Aria',    description: 'Bright, energetic female voice',
    imageAssetKey: 'voice-design.aria',  audioAssetKey: 'voice-design-audio.aria' },
  { id: 'voc-harper',  name: 'Harper',  description: 'Warm, conversational podcast voice',
    audioStaticPath: 'pod_female.wav',   imageStaticPath: 'voc-harper.webp' },
  { id: 'char-epic-warrior', name: 'Epic Warrior', description: 'Heroic, booming battle voice',
    imageAssetKey: 'tts-style.epic-warrior', audioAssetKey: 'tts-demo.epic-warrior' },
  { id: 'voc-camille', name: 'Camille', description: 'Smooth, polished female voice',
    audioStaticPath: 'feamle2.wav',      imageStaticPath: 'voc-camille.webp' },
  { id: 'design-aurora', name: 'Aurora', description: 'Soft, dreamy female voice',
    imageAssetKey: 'voice-design.aurora', audioAssetKey: 'voice-design-audio.aurora' },
  { id: 'voc-chase',   name: 'Chase',   description: 'Energetic, engaging podcast host',
    audioStaticPath: 'pod_male1.wav',    imageStaticPath: 'voc-chase.webp' },
  { id: 'design-dante', name: 'Dante',  description: 'Deep, confident male voice',
    imageAssetKey: 'voice-design.dante', audioAssetKey: 'voice-design-audio.dante' },
  { id: 'voc-iris',    name: 'Iris',    description: 'Bright, articulate female voice',
    audioStaticPath: 'feamle1.wav',      imageStaticPath: 'voc-iris.webp' },
  { id: 'char-friendly-ai-assistant', name: 'Friendly AI', description: 'Pleasant, helpful assistant voice',
    imageAssetKey: 'tts-style.friendly-ai-assistant', audioAssetKey: 'tts-demo.friendly-ai-assistant' },
  { id: 'voc-theo',    name: 'Theo',    description: 'Thoughtful, measured male voice',
    audioStaticPath: 'pod_male3.wav',    imageStaticPath: 'voc-theo.webp' },
  { id: 'design-kai',  name: 'Kai',     description: 'Smooth, friendly male voice',
    imageAssetKey: 'voice-design.kai',   audioAssetKey: 'voice-design-audio.kai' },
  { id: 'voc-roman',   name: 'Roman',   description: 'Rich, classical male tone',
    audioStaticPath: 'deep_male2.wav',   imageStaticPath: 'voc-roman.webp' },
  { id: 'real-sophia', name: 'Sophia',  description: 'Warm, expressive female voice',
    imageAssetKey: 'clone.sophia',       audioAssetKey: 'clone-audio.sophia' },
  { id: 'voc-maximus', name: 'Maximus', description: 'Bold, authoritative male voice',
    audioStaticPath: 'deep_male4.wav',   imageStaticPath: 'voc-maximus.webp' },
  { id: 'design-luna', name: 'Luna',    description: 'Mysterious, ethereal female voice',
    imageAssetKey: 'voice-design.luna',  audioAssetKey: 'voice-design-audio.luna' },
  { id: 'voc-owen',    name: 'Owen',    description: 'Clear, professional podcast voice',
    audioStaticPath: 'pod_male5.wav',    imageStaticPath: 'voc-owen.webp' },
  { id: 'char-little-girl', name: 'Little Girl', description: 'Young, playful child voice',
    imageAssetKey: 'tts-style.little-girl', audioAssetKey: 'tts-demo.little-girl' },
  { id: 'voc-vincent', name: 'Vincent', description: 'Refined, baritone male voice',
    audioStaticPath: 'deep_male3.wav',   imageStaticPath: 'voc-vincent.webp' },
  { id: 'design-yuki', name: 'Yuki',    description: 'Calm, gentle female voice',
    imageAssetKey: 'voice-design.yuki',  audioAssetKey: 'voice-design-audio.yuki' },
  { id: 'voc-lyle',    name: 'Lyle',    description: 'Smooth, easy-listening male voice',
    audioStaticPath: 'pod_male2.wav',    imageStaticPath: 'voc-lyle.webp' },
  { id: 'char-happy-female', name: 'Happy Female', description: 'Cheerful, upbeat female voice',
    imageAssetKey: 'tts-style.happy-female', audioAssetKey: 'tts-demo.happy-female' },
  { id: 'design-marcus', name: 'Marcus', description: 'Authoritative, mature male voice',
    imageAssetKey: 'voice-design.marcus', audioAssetKey: 'voice-design-audio.marcus' },
  { id: 'voc-jasper',  name: 'Jasper',  description: 'Warm, friendly storytelling voice',
    audioStaticPath: 'pod_male4.wav',    imageStaticPath: 'voc-jasper.webp' },
  { id: 'design-ember', name: 'Ember',  description: 'Warm, soulful female voice',
    imageAssetKey: 'voice-design.ember', audioAssetKey: 'voice-design-audio.ember' },
  { id: 'char-military-commander', name: 'Military Commander', description: 'Stern, commanding officer voice',
    imageAssetKey: 'tts-style.military-commander', audioAssetKey: 'tts-demo.military-commander' },
  { id: 'design-rafael', name: 'Rafael', description: 'Charismatic, expressive male voice',
    imageAssetKey: 'voice-design.rafael', audioAssetKey: 'voice-design-audio.rafael' },
  { id: 'char-neutral-male', name: 'Neutral Male', description: 'Clear, neutral male narrator',
    imageAssetKey: 'tts-style.neutral-male', audioAssetKey: 'tts-demo.neutral-male' },
];

export const SAMPLE_VOICE_INDEX: Record<string, SampleVoice> = Object.fromEntries(
  SAMPLE_VOICES.map((v) => [v.id, v]),
);

/**
 * Resolve a SampleVoice to a playable audio URL. CDN voices use the
 * asset() lookup; local voices use the dashboard-backend's static mount.
 *
 * Caller passes ``apiBaseUrl`` (the same VITE_API_URL the rest of the app
 * uses) so this works in dev (Vite proxy) and prod alike.
 */
export function resolveSampleVoiceAudioUrl(
  voice: SampleVoice,
  assetResolve: (key: string) => string,
  apiBaseUrl: string,
): string {
  if (voice.audioStaticPath) {
    const base = apiBaseUrl.replace(/\/$/, '');
    return `${base}/dashboard/sample-voices/${voice.audioStaticPath}`;
  }
  if (voice.audioAssetKey) {
    return assetResolve(voice.audioAssetKey);
  }
  return '';
}

/**
 * Two-ring deterministic gradient avatars.
 *
 * Each agent / voice / track gets a dual-circle look: a bright outer
 * RING with a multi-stop cool gradient (4 colours), a small visible gap,
 * then a deeper inner BODY with its own multi-stop cool gradient
 * (3 colours). White initials sit on the inner body. Same cool palette
 * across the product (emerald / teal / cyan / sky / green / blue) — no
 * warm colours, no overly-bright pastels, no overly-dark muds.
 *
 * The outer ring's lighter saturation makes the avatar pop without
 * shouting, while the deeper inner body keeps initial-text contrast
 * comfortable.
 *
 * See ``avatarGradientPairFor`` and ``AgentAvatar.tsx``.
 */
const OUTER_RING_GRADIENTS: string[] = [
  'from-emerald-400 via-teal-400 via-cyan-500 to-sky-400',
  'from-teal-400 via-emerald-400 via-cyan-400 to-sky-500',
  'from-cyan-400 via-teal-400 via-emerald-500 to-green-400',
  'from-emerald-500 via-teal-400 via-cyan-400 to-sky-500',
  'from-sky-500 via-cyan-400 via-teal-500 to-emerald-400',
  'from-emerald-400 via-green-500 via-teal-400 to-cyan-500',
  'from-cyan-500 via-sky-400 via-blue-400 to-teal-400',
  'from-teal-500 via-emerald-400 via-cyan-500 to-blue-400',
  'from-green-400 via-emerald-500 via-teal-400 to-cyan-400',
  'from-emerald-400 via-cyan-500 via-sky-400 to-teal-500',
  'from-cyan-400 via-teal-500 via-emerald-400 to-green-500',
  'from-teal-400 via-cyan-500 via-emerald-400 to-sky-400',
];

const INNER_BODY_GRADIENTS: string[] = [
  'from-emerald-600 via-teal-600 to-cyan-700',
  'from-teal-700 via-emerald-600 to-cyan-600',
  'from-cyan-700 via-teal-600 to-emerald-600',
  'from-emerald-600 to-teal-700',
  'from-teal-600 via-cyan-700 to-emerald-700',
  'from-cyan-700 via-teal-700 to-emerald-600',
  'from-emerald-700 via-teal-600 to-cyan-700',
  'from-teal-700 to-emerald-600',
  'from-emerald-700 via-cyan-600 to-teal-700',
  'from-cyan-700 via-emerald-700 to-teal-600',
  'from-emerald-600 via-cyan-700 to-teal-700',
  'from-teal-600 via-cyan-600 to-emerald-700',
];

// Back-compat single-gradient export (in case anything still imports it).
const AVATAR_GRADIENTS: string[] = INNER_BODY_GRADIENTS;

function _hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function avatarGradientFor(voiceId: string): string {
  return AVATAR_GRADIENTS[_hash(voiceId) % AVATAR_GRADIENTS.length];
}

/** Two-ring gradient pair (outer ring + inner body). The two indices
 * are deliberately offset so a single id rarely lands on the same
 * gradient twice — avoids "concentric circles in the same hue". */
export function avatarGradientPairFor(id: string): { outer: string; inner: string } {
  const h = _hash(id);
  const outer = OUTER_RING_GRADIENTS[h % OUTER_RING_GRADIENTS.length];
  const inner = INNER_BODY_GRADIENTS[(h + 5) % INNER_BODY_GRADIENTS.length];
  return { outer, inner };
}
