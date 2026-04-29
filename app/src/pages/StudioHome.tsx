import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Play,
  Pause,
  ArrowRight,
  Clock,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { dashboardApi, type StudioHistoryItem, type StudioDesignedVoiceItem } from '../services/dashboardApi';
import { asset } from '../data/assets';
import { MyVoiceCardArt } from '../components/MyVoiceCardArt';
import { DEFAULT_ABSTRACT_CARD_IMAGES } from '../data/abstractCardImages';
import { WelcomeBanner, shouldShowWelcomeBanner } from '../components/WelcomeBanner';

/* ==========================================================================
   Placeholder data — replace with real content later.
   Audio: /samples/audio/<file>.wav
   Images: /samples/images/<file>.webp
   ========================================================================== */

interface VoiceShowcaseItem {
  id: string;
  name: string;
  avatar: string;
  tags: string[];
  description: string;
  audioSrc: string;
}

interface MusicPresetItem {
  id: string;
  genre: string;
  mood: string;
  prompt: string;
  audioSrc: string;
  image: string;
}

interface StyleExampleItem {
  id: string;
  name: string;
  tags: string[];
  description: string;
  text: string;
  audioSrc: string;
  avatar: string;
}

interface CloneExampleItem {
  id: string;
  name: string;
  avatar: string;
  originalLabel: string;
  originalAudio: string;
  clonedLabel: string;
  clonedAudio: string;
}

const VOICE_DESIGN_SAMPLES: VoiceShowcaseItem[] = [
  { id: 'vd1', name: 'Aurora', avatar: asset('voice-design.aurora'), tags: ['Warm', 'Narrative', 'Female'], description: 'Soft, warm storytelling voice ideal for audiobooks and meditation guides.', audioSrc: asset('voice-design-audio.aurora') },
  { id: 'vd2', name: 'Marcus', avatar: asset('voice-design.marcus'), tags: ['Deep', 'Authoritative', 'Male'], description: 'Rich baritone with confident delivery for documentaries and trailers.', audioSrc: asset('voice-design-audio.marcus') },
  { id: 'vd3', name: 'Yuki', avatar: asset('voice-design.yuki'), tags: ['Bright', 'Energetic', 'Female'], description: 'Cheerful and animated voice perfect for gaming and social media.', audioSrc: asset('voice-design-audio.yuki') },
  { id: 'vd4', name: 'Rafael', avatar: asset('voice-design.rafael'), tags: ['Smooth', 'Conversational', 'Male'], description: 'Natural, relaxed tone great for podcasts and casual narration.', audioSrc: asset('voice-design-audio.rafael') },
  { id: 'vd5', name: 'Ember', avatar: asset('voice-design.ember'), tags: ['Dramatic', 'Intense', 'Female'], description: 'Bold and passionate delivery for ads, promos, and dramatic content.', audioSrc: asset('voice-design-audio.ember') },
  { id: 'vd6', name: 'Kai', avatar: asset('voice-design.kai'), tags: ['Calm', 'Soothing', 'Male'], description: 'Gentle, calming presence ideal for wellness apps and ASMR.', audioSrc: asset('voice-design-audio.kai') },
  { id: 'vd7', name: 'Luna', avatar: asset('voice-design.luna'), tags: ['Ethereal', 'Soft', 'Female'], description: 'Dreamy, whispery voice for fantasy narration and ambient content.', audioSrc: asset('voice-design-audio.luna') },
  { id: 'vd8', name: 'Dante', avatar: asset('voice-design.dante'), tags: ['Bold', 'Cinematic', 'Male'], description: 'Powerful voice for movie trailers, epic intros, and announcements.', audioSrc: asset('voice-design-audio.dante') },
  { id: 'vd9', name: 'Aria', avatar: asset('voice-design.aria'), tags: ['Friendly', 'Clear', 'Female'], description: 'Approachable and professional voice for corporate and e-learning.', audioSrc: asset('voice-design-audio.aria') },
];

const CLONE_EXAMPLES: CloneExampleItem[] = [
  { id: 'cl1', name: 'Const', avatar: asset('clone.const'), originalLabel: 'Reference', originalAudio: asset('clone-audio.const'), clonedLabel: 'Cloned', clonedAudio: asset('clone-audio.clone_const') },
  { id: 'cl2', name: 'Mark Jeffery', avatar: asset('clone.mark_jeffery'), originalLabel: 'Reference', originalAudio: asset('clone-audio.mark_jeffery'), clonedLabel: 'Cloned', clonedAudio: asset('clone-audio.clone_mark') },
  { id: 'cl3', name: 'Micaela', avatar: asset('clone.micaela'), originalLabel: 'Reference', originalAudio: asset('clone-audio.micaela'), clonedLabel: 'Cloned', clonedAudio: asset('clone-audio.clone_micaela') },
  { id: 'cl4', name: 'Sophia', avatar: asset('clone.sophia'), originalLabel: 'Reference', originalAudio: asset('clone-audio.sophia'), clonedLabel: 'Cloned', clonedAudio: asset('clone-audio.clone_sophia') },
];

const MUSIC_PRESETS: MusicPresetItem[] = [
  { id: 'mp1', genre: 'Neon Nights', mood: 'Upbeat Pop', prompt: 'pop, synth, drums, guitar, 120 bpm, upbeat, catchy, vibrant, female vocals, polished vocals', audioSrc: '/samples/audios/pop.wav', image: '/samples/images/music_1.webp' },
  { id: 'mp2', genre: 'Rebel Road', mood: 'Hard Rock', prompt: 'rock, electric guitar, drums, bass, 130 bpm, energetic, rebellious, gritty, male vocals, raw vocals', audioSrc: '/samples/audios/rock.wav', image: '/samples/images/music_2.webp' },
  { id: 'mp3', genre: 'Urban Flow', mood: 'Street Rap', prompt: 'hip hop, 808 bass, hi-hats, synth, 90 bpm, bold, urban, intense, male vocals, rhythmic vocals', audioSrc: '/samples/audios/street.wav', image: '/samples/images/music_3.webp' },
  { id: 'mp4', genre: 'Pulse Drop', mood: 'Club EDM', prompt: 'edm, synth, bass, kick drum, 128 bpm, euphoric, pulsating, energetic, instrumental', audioSrc: '/samples/audios/club.wav', image: '/samples/images/music_4.webp' },
  { id: 'mp5', genre: 'Midnight Blues', mood: 'Smooth Jazz', prompt: 'jazz, saxophone, piano, double bass, 110 bpm, smooth, improvisational, soulful, instrumental', audioSrc: '/samples/audios/jazz.wav', image: '/samples/images/music_5.webp' },
  { id: 'mp6', genre: 'Code & Coffee', mood: 'Chill Lo-fi', prompt: 'lo-fi, piano, soft drums, vinyl crackle, 75 bpm, chill, mellow, warm, instrumental', audioSrc: '/samples/audios/chill.wav', image: '/samples/images/music_7.webp' },
];

const TTS_STYLE_EXAMPLES: StyleExampleItem[] = [
  {
    id: 'neutral-male',
    name: 'Neutral Male',
    tags: ['Calm', 'Natural', 'Male'],
    description: 'Versatile everyday voice for narration, dialogue, and conversational delivery.',
    text: "The best part of a morning run isn't the exercise — it's the ten minutes afterwards when everything feels quiet, and you remember why you started.",
    audioSrc: asset('tts-demo.neutral-male'),
    avatar: asset('tts-style.neutral-male'),
  },
  {
    id: 'epic-warrior',
    name: 'Epic Warrior',
    tags: ['Heroic', 'Shouting', 'Male'],
    description: 'Cinematic battle voice — loud, aggressive, high energy. Perfect for action scenes.',
    text: 'For every brother we have lost, a thousand of theirs will fall! Raise your shields! Tonight — we end this war!',
    audioSrc: asset('tts-demo.epic-warrior'),
    avatar: asset('tts-style.epic-warrior'),
  },
  {
    id: 'friendly-ai-assistant',
    name: 'AI Assistant',
    tags: ['Polite', 'Clear', 'Female'],
    description: 'Friendly digital assistant — precise, professional, slightly robotic.',
    text: "Of course — I've rescheduled your meeting to Thursday at 3 PM and notified your team. Would you like a summary of tomorrow's agenda?",
    audioSrc: asset('tts-demo.friendly-ai-assistant'),
    avatar: asset('tts-style.friendly-ai-assistant'),
  },
  {
    id: 'military-commander',
    name: 'Military Commander',
    tags: ['Authoritative', 'Tactical', 'Male'],
    description: 'Commanding battlefield voice — strong, confident, radio-clear delivery.',
    text: 'All units, hold position and await my signal. Recon reports hostiles two klicks east. On my mark — we move fast, we move clean. Execute.',
    audioSrc: asset('tts-demo.military-commander'),
    avatar: asset('tts-style.military-commander'),
  },
  {
    id: 'little-girl',
    name: 'Little Girl',
    tags: ['Cheerful', 'Playful', 'Child'],
    description: 'Cute, high-pitched, innocent voice — youthful and expressive.',
    text: 'Look at my dragon drawing! He breathes rainbow fire, and his name is Mister Sparkles. Isn\u2019t he the best?',
    audioSrc: asset('tts-demo.little-girl'),
    avatar: asset('tts-style.little-girl'),
  },
  {
    id: 'happy-female',
    name: 'Happy Female',
    tags: ['Bright', 'Upbeat', 'Female'],
    description: 'Warm, cheerful, energetic — natural smile-in-the-voice delivery.',
    text: "Oh my god, you got the job?! I'm so proud of you — we are absolutely going out to celebrate tonight, my treat, no arguments!",
    audioSrc: asset('tts-demo.happy-female'),
    avatar: asset('tts-style.neutral-female'),
  },
];

/* ==========================================================================
   Play button — triggers the global studio player bar
   ========================================================================== */

function PlayBtn({ src, title, subtitle, image }: { src: string; title: string; subtitle?: string; image?: string }) {
  const { track, playing, play, pause, resume } = useStudioPlayer();
  const isThis = track?.src === src;
  const isPlaying = isThis && playing;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isPlaying) { pause(); return; }
    if (isThis) { resume(); return; }
    play({ src, title, subtitle, image });
  };

  return (
    <button
      onClick={handleClick}
      className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
        isPlaying
          ? 'bg-[#DFFF00] text-[#07080A]'
          : 'bg-white/10 text-white hover:bg-white/20'
      }`}
      aria-label={isPlaying ? 'Pause' : 'Play'}
    >
      {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
    </button>
  );
}

/* ==========================================================================
   Section heading
   ========================================================================== */

function SectionHeading({ title, subtitle, action }: { title: string; subtitle: string; action?: { label: string; to: string } }) {
  const navigate = useNavigate();
  return (
    <div className="flex items-end justify-between mb-6">
      <div>
        <h2 className="text-xl md:text-2xl font-semibold text-white">{title}</h2>
        <p className="text-sm text-[#A7B0B7] mt-1">{subtitle}</p>
      </div>
      {action && (
        <button onClick={() => navigate(action.to)} className="text-sm text-[#DFFF00] hover:text-[#DFFF00]/80 flex items-center gap-1 transition-colors shrink-0">
          {action.label} <ArrowRight size={14} />
        </button>
      )}
    </div>
  );
}

/* ==========================================================================
   StudioHome
   ========================================================================== */

export function StudioHome() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [recentHistory, setRecentHistory] = useState<StudioHistoryItem[]>([]);
  const [designedVoices, setDesignedVoices] = useState<StudioDesignedVoiceItem[]>([]);

  useEffect(() => {
    if (!user) return;
    dashboardApi
      .getStudioHistory(user.id)
      .then((res) => setRecentHistory(res.items.slice(0, 6)))
      .catch(() => {});
  }, [user]);

  useEffect(() => {
    if (!user) {
      setDesignedVoices([]);
      return;
    }
    const token = localStorage.getItem('vocence_token');
    dashboardApi
      .listStudioDesignedVoices(token)
      .then((r) => {
        const sorted = [...r.voices].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
        setDesignedVoices(sorted);
      })
      .catch(() => setDesignedVoices([]));
  }, [user]);

  const showWelcome = !!user && shouldShowWelcomeBanner(user.credits ?? 0);
  const [welcomeOpen, setWelcomeOpen] = useState(showWelcome);

  return (
    <div className="space-y-14">
      {/* First-time welcome */}
      {welcomeOpen && (
        <WelcomeBanner onDismiss={() => setWelcomeOpen(false)} />
      )}

      {/* ---- Hero ---- */}
      <div className="text-center py-6">
        <h1 className="text-3xl md:text-4xl font-bold mb-3">Vocence Studio</h1>
        <p className="text-[#A7B0B7] text-base md:text-lg mx-auto leading-relaxed">
          Create speech, design your favorite characters with prompt, clone voice and generate music.
          <br />
          Powered by decentralized AI on Bittensor.
        </p>
      </div>

      {/* ================================================================
          1. VOICE DESIGN SHOWCASE
          ================================================================ */}
      <section>
        <SectionHeading
          title="Voice Design"
          subtitle="AI-designed voice characters — describe a voice and bring it to life."
          action={{ label: 'Design a voice', to: '/studio/voice-design' }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {VOICE_DESIGN_SAMPLES.map((v) => (
            <div
              key={v.id}
              className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 hover:border-white/20 transition-all group"
            >
              <div className="flex items-center gap-4 mb-3">
                <div className="w-[72px] h-[72px] rounded-xl bg-gradient-to-br from-violet-500/30 to-indigo-500/30 overflow-hidden flex items-center justify-center shrink-0 relative group/avatar">
                  <img
                    loading="lazy"
                    src={v.avatar}
                    alt={v.name}
                    className="w-full h-full object-cover relative z-10 transition-transform duration-300 group-hover/avatar:scale-110"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-xl font-bold text-violet-300 absolute">{v.name[0]}</span>
                </div>
                <div className="min-w-0">
                  <h3 className="text-white font-semibold text-sm">{v.name}</h3>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {v.tags.map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[#A7B0B7]">{tag}</span>
                    ))}
                  </div>
                  <p className="text-xs text-[#A7B0B7] leading-relaxed mt-1.5">{v.description}</p>
                </div>
              </div>
              <PlayBtn src={v.audioSrc} title={v.name} subtitle={v.tags.join(' · ')} image={v.avatar} />
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================
          2. TEXT-TO-SPEECH STYLE EXAMPLES
          ================================================================ */}
      <section>
        <SectionHeading
          title="Text-to-Speech"
          subtitle="Style-controlled speech — the same model, six very different deliveries."
          action={{ label: 'Try TTS', to: '/studio/tts' }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {TTS_STYLE_EXAMPLES.map((s) => (
            <div
              key={s.id}
              className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 hover:border-white/20 transition-all group flex flex-col"
            >
              <div className="flex items-center gap-4 mb-3">
                <div className="w-[72px] h-[72px] rounded-xl bg-gradient-to-br from-[#DFFF00]/20 to-emerald-500/20 overflow-hidden flex items-center justify-center shrink-0 relative group/avatar">
                  <img
                    loading="lazy"
                    src={s.avatar}
                    alt={s.name}
                    className="w-full h-full object-cover relative z-10 transition-transform duration-300 group-hover/avatar:scale-110"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-xl font-bold text-[#DFFF00]/80 absolute">{s.name[0]}</span>
                </div>
                <div className="min-w-0">
                  <h3 className="text-white font-semibold text-sm">{s.name}</h3>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {s.tags.map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[#A7B0B7]">{tag}</span>
                    ))}
                  </div>
                  <p className="text-xs text-[#A7B0B7] leading-relaxed mt-1.5">{s.description}</p>
                </div>
              </div>
              <p className="text-xs italic text-white/60 leading-relaxed mb-3 flex-1 line-clamp-3">
                &ldquo;{s.text}&rdquo;
              </p>
              <PlayBtn src={s.audioSrc} title={s.name} subtitle={s.tags.join(' · ')} image={s.avatar} />
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================
          3. SPEECH-TO-TEXT SHOWCASE
          ================================================================ */}
      <section>
        <SectionHeading
          title="Speech-to-Text"
          subtitle="Transcribe audio into text with automatic language detection."
          action={{ label: 'Transcribe audio', to: '/studio/stt' }}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[
            {
              id: 'stt1',
              lang: 'English',
              transcript: 'I left my laptop charger at home, so I\u2019m going to work from the caf\u00e9 for a bit and come back after lunch.',
              audioSrc: asset('stt-demo.stt-english'),
              bg: '/samples/images/stt_1.webp',
            },
            {
              id: 'stt2',
              lang: 'Japanese',
              transcript: '\u4ffa\u306f\u9003\u3052\u306a\u3044\uff01\u305f\u3068\u3048\u3053\u306e\u8eab\u304c\u7815\u3051\u3066\u3082\u3001\u4ef2\u9593\u306e\u305f\u3081\u306b\u524d\u3078\u9032\u3080\uff01\u6050\u308c\u308b\u306a\u3001\u53eb\u3079\uff01\u52dd\u5229\u306f\u4ffa\u305f\u3061\u306e\u3082\u306e\u3060\uff01',
              audioSrc: asset('stt-demo.stt-japanese'),
              bg: '/samples/images/stt_2.webp',
            },
            {
              id: 'stt3',
              lang: 'Spanish',
              transcript: 'El tren sale en quince minutos, as\u00ed que compremos los boletos ahora y busquemos la plataforma antes de que se llene.',
              audioSrc: asset('stt-demo.stt-spanish'),
              bg: '/samples/images/stt_3.webp',
            },
            {
              id: 'stt4',
              lang: 'Chinese',
              transcript: '\u4eca\u5929\u7684\u4f1a\u8bae\u5148\u63a8\u8fdf\u4e00\u4e0b\uff0c\u6211\u9700\u8981\u518d\u68c0\u67e5\u4e00\u904d\u6570\u636e,\u786e\u8ba4\u6ca1\u6709\u95ee\u9898\u4e4b\u540e\u518d\u53d1\u7ed9\u5927\u5bb6\u3002',
              audioSrc: asset('stt-demo.stt-chinese'),
              bg: '/samples/images/stt_4.webp',
            },
          ].map((item) => (
            <div key={item.id} className="rounded-2xl border border-white/10 overflow-hidden relative p-5 hover:border-white/20 transition-all">
              <img loading="lazy" src={item.bg} alt="" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/60" />
              <div className="relative z-10">
                <div className="flex items-center justify-end mb-3">
                  <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400">{item.lang}</span>
                </div>
                <div className="flex items-center gap-3">
                  <PlayBtn src={item.audioSrc} title={item.lang} subtitle="Speech-to-Text demo" />
                  <span className="text-xs text-white/60">Listen</span>
                </div>
                <p className="text-sm text-white mt-3 leading-relaxed italic">{item.transcript}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================
          4. VOICE CLONING SHOWCASE
          ================================================================ */}
      <section>
        <SectionHeading
          title="Voice Cloning"
          subtitle="Clone any voice from a short reference clip — hear the original and the clone side by side."
          action={{ label: 'Clone a voice', to: '/studio/cloning' }}
        />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {CLONE_EXAMPLES.map((c) => (
            <div
              key={c.id}
              className="rounded-2xl border border-white/10 bg-white/[0.02] flex overflow-hidden hover:border-white/20 transition-all"
            >
              <div className="w-[160px] shrink-0 bg-gradient-to-br from-cyan-500/30 to-blue-500/30 relative group/avatar overflow-hidden">
                <img
                  loading="lazy"
                  src={c.avatar}
                  alt={c.name}
                  className="absolute inset-0 w-full h-full object-cover transition-transform duration-300 group-hover/avatar:scale-110"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              </div>
              <div className="flex-1 p-5 flex flex-col justify-center min-w-0">
                <h3 className="text-white font-semibold text-sm mb-3 truncate">{c.name}</h3>
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <PlayBtn src={c.originalAudio} title={`${c.name} — Original`} subtitle={c.originalLabel} />
                    <span className="text-xs text-[#A7B0B7]">{c.originalLabel}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <PlayBtn src={c.clonedAudio} title={`${c.name} — Cloned`} subtitle={c.clonedLabel} />
                    <span className="text-xs text-[#A7B0B7]">{c.clonedLabel}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ================================================================
          5. MUSIC GENERATION SHOWCASE
          ================================================================ */}
      <section>
        <SectionHeading
          title="Music Generation"
          subtitle="Generate original music from text — pick a genre or describe your own."
          action={{ label: 'Create music', to: '/studio/music' }}
        />
        <MusicPresetGrid presets={MUSIC_PRESETS} />
      </section>

      {/* ================================================================
          6. MY VOICES SHOWCASE — real saved voices for logged-in users
          ================================================================ */}
      {user && designedVoices.length > 0 && (
        <section>
          <SectionHeading
            title="My Voices"
            subtitle="Your saved custom voices — generate speech in any character you've designed."
            action={{ label: 'View my voices', to: '/studio/my-voices' }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {designedVoices.slice(0, 6).map((v) => (
              <div
                key={v.id}
                className="group flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0f131a] hover:border-white/20 transition-all cursor-pointer"
                onClick={() => navigate(`/studio/my-voices/${v.id}`)}
              >
                <div className="relative h-32 w-full shrink-0 overflow-hidden">
                  <MyVoiceCardArt
                    urls={DEFAULT_ABSTRACT_CARD_IMAGES}
                    seed={v.id}
                    className="h-full w-full transition-transform duration-500 group-hover:scale-[1.03]"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[#0f131a]/95 via-[#0f131a]/40 to-black/10 pointer-events-none" />
                  <div className="absolute bottom-3 left-4 right-4 drop-shadow-[0_2px_8px_rgba(0,0,0,0.85)]">
                    <h3 className="font-bold text-white text-base leading-tight tracking-tight truncate">
                      {v.display_name || `Voice #${v.id}`}
                    </h3>
                    {v.model_name ? (
                      <p className="text-[10px] text-white/75 mt-0.5 truncate">{v.model_name}</p>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4">
                  {v.audio_url && !v.expired ? (
                    <PlayBtn src={v.audio_url} title={v.display_name || `My Voice ${v.id}`} subtitle={v.ref_script?.slice(0, 80)} />
                  ) : (
                    <span className="text-[10px] text-amber-200/85 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1">
                      Sample expired
                    </span>
                  )}
                  <p className="text-xs text-[#A7B0B7] leading-relaxed line-clamp-2 flex-1">
                    {v.ref_script ? `“${v.ref_script}”` : 'Click to generate speech in this voice.'}
                  </p>
                </div>
                <div className="px-4 pb-4 -mt-1">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); navigate(`/studio/my-voices/${v.id}`); }}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-white text-[#07080A] py-2 text-xs font-semibold hover:bg-white/90 transition-all"
                  >
                    <Play size={12} fill="currentColor" /> Speak with this voice
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ================================================================
          RECENT CREATIONS (logged-in users only)
          ================================================================ */}
      {user && recentHistory.length > 0 && (
        <section>
          <SectionHeading
            title="Your Recent Creations"
            subtitle="Continue where you left off."
            action={{ label: 'View all history', to: '/studio/history' }}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentHistory.map((item) => {
              const typeColors: Record<string, string> = {
                tts: 'bg-[#DFFF00]/15 text-[#DFFF00]',
                stt: 'bg-green-500/15 text-green-400',
                clone: 'bg-cyan-500/15 text-cyan-400',
                voice_design: 'bg-violet-500/15 text-violet-300',
                music: 'bg-indigo-500/15 text-indigo-300',
              };
              const typeLabels: Record<string, string> = {
                tts: 'TTS',
                stt: 'STT',
                clone: 'Clone',
                voice_design: 'Voice Design',
                music: 'Music',
              };
              const badge = typeColors[item.entry_type] || 'bg-white/10 text-[#A7B0B7]';
              const label = typeLabels[item.entry_type] || item.entry_type;
              const preview = item.prompt_text || item.display_name || item.transcribed_text || '';
              const ts = item.created_at ? new Date(item.created_at + 'Z') : null;
              const ago = ts ? formatTimeAgo(ts) : '';

              return (
                <div
                  key={`${item.entry_type}-${item.id}`}
                  className="rounded-xl border border-white/10 bg-white/[0.02] p-4 hover:border-white/20 transition-all cursor-pointer"
                  onClick={() => {
                    const et = item.entry_type === 'clone' ? '?entry_type=clone'
                      : item.entry_type === 'voice_design' ? '?entry_type=voice_design'
                      : item.entry_type === 'music' ? '?entry_type=music' : '';
                    navigate(`/studio/result/${item.id}${et}`);
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[10px] font-semibold uppercase px-2 py-0.5 rounded ${badge}`}>{label}</span>
                    {ago && <span className="text-[10px] text-[#666] flex items-center gap-1"><Clock size={10} />{ago}</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    {item.audio_url && item.entry_type !== 'stt' && (
                      <PlayBtn src={item.audio_url} title={preview || 'Untitled'} subtitle={label} />
                    )}
                    <p className="text-sm text-[#A7B0B7] line-clamp-2 min-w-0">{preview || 'Untitled'}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

    </div>
  );
}

/* ==========================================================================
   Music preset grid — click card to play
   ========================================================================== */

function MusicPresetGrid({ presets }: { presets: MusicPresetItem[] }) {
  const { track, playing, play, pause, resume } = useStudioPlayer();

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
      {presets.map((m) => {
        const isThis = track?.src === m.audioSrc;
        const isPlaying = isThis && playing;
        const handleClick = () => {
          if (isPlaying) { pause(); return; }
          if (isThis) { resume(); return; }
          play({ src: m.audioSrc, title: m.genre, subtitle: m.mood, image: m.image });
        };
        return (
          <div
            key={m.id}
            onClick={handleClick}
            className={`rounded-2xl border overflow-hidden hover:-translate-y-0.5 transition-all group cursor-pointer ${
              isPlaying ? 'border-[#DFFF00]/50 shadow-[0_0_12px_rgba(223,255,0,0.15)]' : 'border-white/10 hover:border-white/20'
            }`}
          >
            <div className="relative aspect-square overflow-hidden">
              <img loading="lazy" src={m.image} alt={m.genre} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300" />
              <div className={`absolute inset-0 transition-colors ${isPlaying ? 'bg-black/40' : 'bg-gradient-to-t from-black/60 to-transparent'}`} />
              <div className="absolute bottom-2 left-2 right-2">
                <h3 className="text-white font-semibold text-sm leading-tight">{m.genre}</h3>
                <p className="text-[10px] text-white/60">{m.mood}</p>
              </div>
              {isPlaying && (
                <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-[#DFFF00] flex items-center justify-center">
                  <Pause size={10} className="text-[#07080A]" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ==========================================================================
   Helpers
   ========================================================================== */

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
