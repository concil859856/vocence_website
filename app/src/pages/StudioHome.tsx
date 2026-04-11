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
import { dashboardApi, type StudioHistoryItem } from '../services/dashboardApi';

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
  style: string;
  text: string;
  audioSrc: string;
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
  { id: 'vd1', name: 'Aurora', avatar: '/samples/images/voice_1.webp', tags: ['Warm', 'Narrative', 'Female'], description: 'Soft, warm storytelling voice ideal for audiobooks and meditation guides.', audioSrc: '/samples/audio/aurora.wav' },
  { id: 'vd2', name: 'Marcus', avatar: '/samples/images/voice_2.webp', tags: ['Deep', 'Authoritative', 'Male'], description: 'Rich baritone with confident delivery for documentaries and trailers.', audioSrc: '/samples/audio/marcus.wav' },
  { id: 'vd3', name: 'Yuki', avatar: '/samples/images/voice_3.webp', tags: ['Bright', 'Energetic', 'Female'], description: 'Cheerful and animated voice perfect for gaming and social media.', audioSrc: '/samples/audio/yuki.wav' },
  { id: 'vd4', name: 'Rafael', avatar: '/samples/images/voice_4.webp', tags: ['Smooth', 'Conversational', 'Male'], description: 'Natural, relaxed tone great for podcasts and casual narration.', audioSrc: '/samples/audio/rafael.wav' },
  { id: 'vd5', name: 'Ember', avatar: '/samples/images/voice_5.webp', tags: ['Dramatic', 'Intense', 'Female'], description: 'Bold and passionate delivery for ads, promos, and dramatic content.', audioSrc: '/samples/audio/ember.wav' },
  { id: 'vd6', name: 'Kai', avatar: '/samples/images/voice_6.webp', tags: ['Calm', 'Soothing', 'Male'], description: 'Gentle, calming presence ideal for wellness apps and ASMR.', audioSrc: '/samples/audio/kai.wav' },
  { id: 'vd7', name: 'Luna', avatar: '/samples/images/voice_7.webp', tags: ['Ethereal', 'Soft', 'Female'], description: 'Dreamy, whispery voice for fantasy narration and ambient content.', audioSrc: '/samples/audio/luna.wav' },
  { id: 'vd8', name: 'Dante', avatar: '/samples/images/voice_8.webp', tags: ['Bold', 'Cinematic', 'Male'], description: 'Powerful voice for movie trailers, epic intros, and announcements.', audioSrc: '/samples/audio/dante.wav' },
  { id: 'vd9', name: 'Aria', avatar: '/samples/images/voice_9.webp', tags: ['Friendly', 'Clear', 'Female'], description: 'Approachable and professional voice for corporate and e-learning.', audioSrc: '/samples/audio/aria.wav' },
];

const CLONE_EXAMPLES: CloneExampleItem[] = [
  { id: 'cl1', name: 'Studio Interview', avatar: '/samples/images/clone_1.webp', originalLabel: 'Original Recording', originalAudio: '/samples/audio/clone1_original.wav', clonedLabel: 'Cloned — New Script', clonedAudio: '/samples/audio/clone1_cloned.wav' },
  { id: 'cl2', name: 'Podcast Host', avatar: '/samples/images/clone_2.webp', originalLabel: 'Reference Clip', originalAudio: '/samples/audio/clone2_original.wav', clonedLabel: 'Cloned Output', clonedAudio: '/samples/audio/clone2_cloned.wav' },
  { id: 'cl3', name: 'Voiceover Artist', avatar: '/samples/images/clone_3.webp', originalLabel: 'Original Sample', originalAudio: '/samples/audio/clone3_original.wav', clonedLabel: 'Cloned — Ad Read', clonedAudio: '/samples/audio/clone3_cloned.wav' },
  { id: 'cl4', name: 'Audiobook Narrator', avatar: '/samples/images/clone_4.webp', originalLabel: 'Reference', originalAudio: '/samples/audio/clone4_original.wav', clonedLabel: 'Cloned — Chapter Read', clonedAudio: '/samples/audio/clone4_cloned.wav' },
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
  { id: 'ts1', style: 'Neutral', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_neutral.wav' },
  { id: 'ts2', style: 'Whisper', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_whisper.wav' },
  { id: 'ts3', style: 'Dramatic', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_dramatic.wav' },
  { id: 'ts4', style: 'Cheerful', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_cheerful.wav' },
  { id: 'ts5', style: 'News Anchor', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_news.wav' },
  { id: 'ts6', style: 'Storyteller', text: 'The quarterly results exceeded all expectations, showing a 15% increase in revenue.', audioSrc: '/samples/audio/style_storyteller.wav' },
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

  useEffect(() => {
    if (!user) return;
    dashboardApi
      .getStudioHistory(user.id)
      .then((res) => setRecentHistory(res.items.slice(0, 6)))
      .catch(() => {});
  }, [user]);

  return (
    <div className="space-y-14">
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
          subtitle="Same text, different styles — hear how style control transforms delivery."
          action={{ label: 'Try TTS', to: '/studio/tts' }}
        />
        <div className="rounded-2xl border border-white/10 overflow-hidden relative p-5 md:p-6">
          <img loading="lazy" src="/samples/images/tts_bg.webp" alt="" className="absolute inset-0 w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/60" />
          <div className="relative z-10">
            <p className="text-sm text-white/80 italic mb-5 max-w-2xl">
              "{TTS_STYLE_EXAMPLES[0]?.text}"
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {TTS_STYLE_EXAMPLES.map((s) => (
                <div key={s.id} className="rounded-xl border border-white/10 bg-black/30 backdrop-blur-sm p-3 flex items-center gap-3">
                  <PlayBtn src={s.audioSrc} title={`TTS — ${s.style}`} subtitle="Style example" />
                  <span className="text-xs font-semibold text-[#DFFF00] uppercase tracking-wider">{s.style}</span>
                </div>
              ))}
            </div>
          </div>
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
            { id: 'stt1', label: 'English Interview', lang: 'English', transcript: 'The future of artificial intelligence lies not in replacing human creativity, but in amplifying it beyond what we ever thought possible.', audioSrc: '/samples/audio/stt_english.wav', bg: '/samples/images/stt_1.webp' },
            { id: 'stt2', label: 'Spanish Podcast', lang: 'Spanish', transcript: 'La inteligencia artificial est\u00e1 transformando la manera en que creamos y consumimos contenido de audio en todo el mundo.', audioSrc: '/samples/audio/stt_spanish.wav', bg: '/samples/images/stt_2.webp' },
            { id: 'stt3', label: 'Meeting Notes', lang: 'English', transcript: 'Let\'s circle back on the Q3 roadmap. I think we need to prioritize the voice agent integration before the API launch.', audioSrc: '/samples/audio/stt_meeting.wav', bg: '/samples/images/stt_3.webp' },
            { id: 'stt4', label: 'Japanese Narration', lang: 'Japanese', transcript: '\u97f3\u58f0AI\u306e\u6280\u8853\u306f\u3001\u79c1\u305f\u3061\u306e\u30b3\u30df\u30e5\u30cb\u30b1\u30fc\u30b7\u30e7\u30f3\u306e\u3042\u308a\u65b9\u3092\u6839\u672c\u7684\u306b\u5909\u3048\u3088\u3046\u3068\u3057\u3066\u3044\u307e\u3059\u3002', audioSrc: '/samples/audio/stt_japanese.wav', bg: '/samples/images/stt_4.webp' },
          ].map((item) => (
            <div key={item.id} className="rounded-2xl border border-white/10 overflow-hidden relative p-5 hover:border-white/20 transition-all">
              <img loading="lazy" src={item.bg} alt="" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/60" />
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-white font-semibold text-sm">{item.label}</h3>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400">{item.lang}</span>
                </div>
                <div className="flex items-center gap-3">
                  <PlayBtn src={item.audioSrc} title={item.label} subtitle={item.lang} />
                  <span className="text-xs text-white/60">Listen</span>
                </div>
                <p className="text-xs text-white/50 mt-3 leading-relaxed italic">"{item.transcript}"</p>
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
              className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 hover:border-white/20 transition-all"
            >
              <div className="flex items-center gap-4 mb-4">
                <div className="w-[72px] h-[72px] rounded-xl bg-gradient-to-br from-cyan-500/30 to-blue-500/30 overflow-hidden flex items-center justify-center shrink-0 relative group/avatar">
                  <img
                    loading="lazy"
                    src={c.avatar}
                    alt={c.name}
                    className="w-full h-full object-cover relative z-10 transition-transform duration-300 group-hover/avatar:scale-110"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  <span className="text-xl font-bold text-cyan-300 absolute">{c.name[0]}</span>
                </div>
                <h3 className="text-white font-semibold text-sm">{c.name}</h3>
              </div>
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
          6. MY VOICES SHOWCASE
          ================================================================ */}
      <section>
        <SectionHeading
          title="My Voices"
          subtitle="Your saved custom voices — generate speech in any character you've designed."
          action={{ label: 'View my voices', to: '/studio/my-voices' }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            { id: 'mv1', name: 'Corporate Sarah', desc: 'Professional female voice for business presentations and e-learning.', tags: ['Professional', 'Clear', 'Female'], audioSrc: '/samples/audio/myvoice_sarah.wav' },
            { id: 'mv2', name: 'Pirate Pete', desc: 'Fun character voice for gaming, storytelling, and entertainment.', tags: ['Character', 'Gruff', 'Male'], audioSrc: '/samples/audio/myvoice_pete.wav' },
            { id: 'mv3', name: 'Zen Master', desc: 'Calm, meditative voice for wellness apps and guided relaxation.', tags: ['Calm', 'Spiritual', 'Male'], audioSrc: '/samples/audio/myvoice_zen.wav' },
          ].map((v) => (
            <div key={v.id} className="rounded-2xl border border-white/10 bg-white/[0.02] p-5 hover:border-white/20 transition-all">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-amber-500/30 to-orange-500/30 flex items-center justify-center shrink-0">
                  <span className="text-sm font-bold text-amber-300">{v.name[0]}</span>
                </div>
                <div>
                  <h3 className="text-white font-semibold text-sm">{v.name}</h3>
                  <div className="flex gap-1 mt-0.5">
                    {v.tags.map((t) => (
                      <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-[#A7B0B7]">{t}</span>
                    ))}
                  </div>
                </div>
              </div>
              <p className="text-xs text-[#A7B0B7] leading-relaxed mb-3">{v.desc}</p>
              <PlayBtn src={v.audioSrc} title={v.name} subtitle={v.tags.join(' · ')} />
            </div>
          ))}
        </div>
      </section>

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
