import { useState, useRef, useEffect } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Music,
  Upload, X, Download, Clock, Disc3, Wand2, Repeat, Paintbrush, Scissors, ArrowRightFromLine,
  Play, Pause, Check, BookOpen, Sparkles,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { dashboardApi, humanizeApiError } from '../services/dashboardApi';
import { useGenerations } from '../contexts/GenerationsContext';
import { CREDIT_MUSIC } from '../studio/creditCosts';
import { asset } from '../data/assets';

type MusicTask = 'text2music' | 'audio2audio' | 'retake' | 'repaint' | 'edit' | 'extend';

interface GenrePreset {
  label: string;
  /** Tag string for the prompt field. */
  value: string;
  /** Lyric template that matches the genre's vibe — full song structure
   * with proper [verse]/[chorus]/[bridge] tags. Instrumental presets
   * use [inst]. Loaded into the lyrics textarea when the genre tile is
   * picked. */
  lyrics: string;
  emoji: string;
  image: string;
}

const GENRE_PRESETS: GenrePreset[] = [
  {
    label: 'Upbeat Pop',
    // Curated: Disco — danceable, glamorous, female vocals.
    value: 'disco, four-on-the-floor drums, slap bass, strings, hi-hats, 120 bpm, danceable, glamorous, female vocals',
    emoji: '🎤',
    image: '/samples/images/genre_1.webp',
    lyrics: `[verse]
Streetlights paint the city wide
Got my heart out for the ride
Every spark turns into gold
Tell me everything you hold

[chorus]
Light it up, light it up tonight
Feel it flicker in the strobe light
Light it up, light it up tonight
Bring it back, bring it back to life

[verse]
Echoes calling down the line
Yours and mine and intertwined
Every moment hits the floor
Tell me what we're waiting for

[bridge]
Don't you let it slip away
Hold the rhythm, find the way
This is everything we made
Promise me it doesn't fade

[chorus]
Light it up, light it up tonight
Feel it flicker in the strobe light
Light it up, light it up tonight
Bring it back, bring it back to life

[outro]
Light it up, light it up
Light it up tonight`,
  },
  {
    label: 'Hard Rock',
    value: 'rock, electric guitar, drums, bass, 130 bpm, energetic, rebellious, gritty, male vocals, raw vocals',
    emoji: '🎸',
    image: '/samples/images/genre_2.webp',
    lyrics: `[verse]
Burned the bridges I walked across
Counted every gain and loss
Loud guitars and borrowed pride
Nothing left for me to hide

[chorus]
Tear it down, tear it down to the bone
We're the noise that won't go home
Tear it down, tear it down all night
Standing in the strobe-light fight

[verse]
Asphalt cracked beneath the heat
Drumbeats pounding to my feet
Black leather and a borrowed flame
Nothing's ever gonna be the same

[bridge]
We don't quit, we don't ask why
Cut the wire, take the sky
Burn the page, write our name
This is bigger than the game

[chorus]
Tear it down, tear it down to the bone
We're the noise that won't go home
Tear it down, tear it down all night
Standing in the strobe-light fight

[outro]
Tear it down, tear it down
Tear it down tonight`,
  },
  {
    label: 'Street Rap',
    // Curated: Drill — aggressive, sliding 808s, sparse hats, rapid flow.
    value: 'drill, dark trap, sliding 808s, sparse hi-hats, 140 bpm, aggressive, menacing, male vocals, rapid flow',
    emoji: '🎧',
    image: '/samples/images/genre_3.webp',
    lyrics: `[verse]
Came from the ground with the dirt on my shoes
Wrote my own page from the cracks in the news
Every block knows the way that I move
Voice on the speaker, you know that I do

[chorus]
Run it back, run it back, that's the wave
Built the whole thing from the moves that I made
Run it back, run it back, count the days
Living in color in a black-and-white maze

[verse]
808s bouncing off the walls of the room
Echoes of every kid that I knew
Hard work soaking through the cuffs of my shoes
City still spinning in a different view

[bridge]
No, I never sleep when the deal on the line
Pen to the paper, getting one of a kind
Stack 'em up high till the sky goes blind
Anything they say, leave it all behind

[chorus]
Run it back, run it back, that's the wave
Built the whole thing from the moves that I made
Run it back, run it back, count the days
Living in color in a black-and-white maze`,
  },
  {
    label: 'Club EDM',
    // Curated: House / Electro House — actual club music.
    value: 'electronic, house, electro house, synthesizer, drums, bass, percussion, 128 bpm, energetic, uplifting, exciting, instrumental',
    emoji: '⚡',
    image: '/samples/images/genre_4.webp',
    lyrics: '[inst]',
  },
  {
    label: 'Smooth Jazz',
    // Curated: Lounge / Cocktail Jazz — sophisticated, instrumental.
    value: 'lounge jazz, soft piano, brushed drums, double bass, vibraphone, 90 bpm, smooth, relaxing, sophisticated, instrumental',
    emoji: '🎷',
    image: '/samples/images/genre_5.webp',
    lyrics: '[inst]',
  },
  {
    label: 'Orchestral',
    // Curated: Cinematic / Film Score — epic, dramatic, choir + brass.
    value: 'cinematic, orchestral, full strings, brass swells, choir, percussion, 80 bpm, epic, dramatic, instrumental',
    emoji: '🎻',
    image: '/samples/images/genre_6.webp',
    lyrics: '[inst]',
  },
  {
    label: 'Chill Lo-fi',
    // Curated: Lo-Fi Hip-Hop — canonical "lofi beats" vibe.
    value: 'lofi hip hop, mellow piano, jazz drums, vinyl crackle, soft bass, 80 bpm, chill, nostalgic, instrumental',
    emoji: '☕',
    image: '/samples/images/genre_7.webp',
    lyrics: '[inst]',
  },
  {
    label: 'Soulful R&B',
    // Curated: Neo-Soul — electric piano, jazz chords, soulful vocals.
    value: 'neo-soul, electric piano, bass, drums, jazz chords, 85 bpm, smooth, warm, female vocals, soulful vocals',
    emoji: '💜',
    image: '/samples/images/genre_8.webp',
    lyrics: `[verse]
Slow down, baby, take your time
Got the city humming on a dime
Every word you say, I'm caught inside
Nowhere I would rather hide

[chorus]
Tell me how it feels, oh, oh
Tell me what is real, oh, oh
Got me right where I should be
Falling in your gravity

[verse]
Soft light spilling through the blinds
Memories that wouldn't leave my mind
Every kiss a melody I've found
Every silence has a sound

[bridge]
Stay a little longer, please don't go
Got a thousand things I've yet to know
You're the only place I rest my head
Everything you said

[chorus]
Tell me how it feels, oh, oh
Tell me what is real, oh, oh
Got me right where I should be
Falling in your gravity

[outro]
Falling in your gravity
Falling in your gravity`,
  },
];

function slugify(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const TASK_TABS: { id: MusicTask; label: string; icon: typeof Music; desc: string }[] = [
  { id: 'text2music', label: 'Text to Music', icon: Wand2, desc: 'Create original music from a text description and lyrics' },
  { id: 'audio2audio', label: 'Style Transfer', icon: Disc3, desc: 'Transform existing audio into a new style' },
  { id: 'retake', label: 'Retake', icon: Repeat, desc: 'Generate variations of your track' },
  { id: 'repaint', label: 'Repaint', icon: Paintbrush, desc: 'Regenerate a specific section of audio' },
  { id: 'edit', label: 'Edit', icon: Scissors, desc: 'Change lyrics or style tags of existing audio' },
  { id: 'extend', label: 'Extend', icon: ArrowRightFromLine, desc: 'Lengthen audio from either end' },
];

interface StatusMsg { type: 'success' | 'error' | 'info'; message: string; }

export function StudioMusic() {
  const { user, isAuthenticated, setLocalCredits } = useAuth();
  const { play: playAudio } = useStudioPlayer();
  const generations = useGenerations();

  const [activeTask, setActiveTask] = useState<MusicTask>('text2music');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [resultAudioUrl, setResultAudioUrl] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Text2Music
  const [title, setTitle] = useState('');
  const [titleInvalid, setTitleInvalid] = useState(false);
  const [prompt, setPrompt] = useState(GENRE_PRESETS[0].value);
  // Initial lyrics match the first preset so the page loads in a
  // self-consistent state. Switching genre tiles overwrites this.
  const [lyrics, setLyrics] = useState(GENRE_PRESETS[0].lyrics);
  const [duration, setDuration] = useState(90);
  const [format, setFormat] = useState('wav');
  const [selectedGenre, setSelectedGenre] = useState<string | null>(GENRE_PRESETS[0].label);

  // Basic
  const [showSettings, setShowSettings] = useState(false);
  const [inferStep, setInferStep] = useState(60);
  const [guidanceScale, setGuidanceScale] = useState(15);
  // Quality mode is a preset for inferStep + guidanceScale. ``custom``
  // means the user touched the Advanced panel directly so we don't
  // overwrite their numbers.
  const [qualityMode, setQualityMode] = useState<'fast' | 'balanced' | 'max' | 'custom'>('balanced');
  const [schedulerType, setSchedulerType] = useState('euler');
  const [cfgType, setCfgType] = useState('apg');
  const [manualSeeds, setManualSeeds] = useState('');

  // Advanced
  const [omegaScale, setOmegaScale] = useState(10);
  const [guidanceInterval, setGuidanceInterval] = useState(0.5);
  const [guidanceIntervalDecay] = useState(0);
  const [minGuidanceScale, setMinGuidanceScale] = useState(3);
  const [guidanceScaleText] = useState(0);
  const [guidanceScaleLyric] = useState(0);
  const [useErgTag, setUseErgTag] = useState(true);
  const [useErgLyric, setUseErgLyric] = useState(false);
  const [useErgDiffusion, setUseErgDiffusion] = useState(true);
  const [ossSteps] = useState('');
  const [loraPath] = useState('none');

  // Audio tasks
  const [refAudioStrength, setRefAudioStrength] = useState(0.5);
  const [retakeVariance, setRetakeVariance] = useState(0.2);
  const [retakeSeeds, setRetakeSeeds] = useState('');
  const [repaintStart, setRepaintStart] = useState(0);
  const [repaintEnd, setRepaintEnd] = useState(30);
  const [editTargetPrompt, setEditTargetPrompt] = useState('');
  const [editTargetLyrics, setEditTargetLyrics] = useState('');
  const [editNMin, setEditNMin] = useState(0.6);
  const [editNMax, setEditNMax] = useState(1.0);
  const [leftExtend, setLeftExtend] = useState(0);
  const [rightExtend, setRightExtend] = useState(30);
  const [extendSeeds, setExtendSeeds] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const needsAudioFile = activeTask !== 'text2music';

  // Lyric textarea ref so the structure-tag helper buttons can insert
  // tags at the user's cursor position rather than always appending.
  const lyricsRef = useRef<HTMLTextAreaElement | null>(null);

  // ``userEditedLyrics`` flips true the moment the user types into the
  // lyric box. Programmatic writes (genre tile, AI generator, instrumental
  // toggle) reset it. Switching genre while this is true triggers a
  // confirm so we never silently throw away the user's own lyrics.
  const [userEditedLyrics, setUserEditedLyrics] = useState(false);

  // ``Instrumental only`` toggle — when on, locks the lyric box to the
  // sentinel ``[inst]`` tag. Required by the music engine: empty lyrics
  // is an error; ``[inst]`` is the official "no vocals" signal.
  const [instrumentalOnly, setInstrumentalOnly] = useState(false);
  useEffect(() => {
    if (instrumentalOnly && lyrics !== '[inst]') setLyrics('[inst]');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentalOnly]);

  // Insert a structure tag at the cursor with proper blank-line padding,
  // collapsing extra blank lines so repeated clicks don't pile up.
  const insertStructureTag = (tag: string) => {
    if (instrumentalOnly) return;
    const ta = lyricsRef.current;
    const cur = lyrics;
    const start = ta?.selectionStart ?? cur.length;
    const end = ta?.selectionEnd ?? cur.length;
    const before = cur.slice(0, start).replace(/\n*$/, '');
    const after = cur.slice(end).replace(/^\n*/, '');
    const insert = `${before ? '\n\n' : ''}${tag}\n${after ? '\n' + after : ''}`;
    const next = before + insert;
    setLyrics(next);
    setUserEditedLyrics(true);
    // Move cursor to the line right after the tag
    requestAnimationFrame(() => {
      if (!lyricsRef.current) return;
      const pos = before.length + insert.indexOf('\n', tag.length + (before ? 2 : 0)) + 1;
      lyricsRef.current.focus();
      try { lyricsRef.current.setSelectionRange(pos, pos); } catch { /* ignore */ }
    });
  };

  const STRUCTURE_TAGS = ['[verse]', '[chorus]', '[bridge]', '[inst]', '[solo]', '[outro]'];

  // ---- AI lyric generation modal ---------------------------------------
  const [lyricGenOpen, setLyricGenOpen] = useState(false);
  const [lyricGenTopic, setLyricGenTopic] = useState('');
  const [lyricGenBusy, setLyricGenBusy] = useState(false);
  const [lyricGenError, setLyricGenError] = useState<string | null>(null);

  const runLyricGeneration = async () => {
    const topic = lyricGenTopic.trim();
    if (!topic) {
      setLyricGenError('Tell me what the song should be about.');
      return;
    }
    setLyricGenBusy(true);
    setLyricGenError(null);
    try {
      const token = localStorage.getItem('vocence_token');
      const res = await dashboardApi.generateStudioMusicLyrics(
        { topic, prompt },
        token,
      );
      const out = (res.lyrics || '').trim();
      if (!out) throw new Error('Empty lyrics returned.');
      setLyrics(out);
      setInstrumentalOnly(false);
      // AI-generated lyrics are user intent (they typed the topic and
      // asked for them), so treat them as "user content" — don't let a
      // subsequent genre tile click silently overwrite them.
      setUserEditedLyrics(true);
      setLyricGenOpen(false);
      setLyricGenTopic('');
    } catch (e: unknown) {
      setLyricGenError(humanizeApiError(e, 'Lyric generation failed.'));
    } finally {
      setLyricGenBusy(false);
    }
  };
  const ALLOWED_STRUCTURE_RE = /\[(intro|verse|chorus|bridge|outro|end|inst|solo|hook|pre-chorus|break)\]/i;
  const ANY_BRACKET_RE = /\[[^\]\n]+\]/g;
  // Keywords that strongly suggest someone pasted prompt-style tags into
  // the lyrics box. Not exhaustive — just the common cases the doc warns
  // about: BPM, vocal qualifiers, common instruments / genres.
  const PROMPTY_IN_LYRICS_RE = /\b(\d{2,3}\s*bpm|electric guitar|drums|piano|synth|808|bass|hi-hats|saxophone|female vocals|male vocals|polished vocals|raw vocals|smooth vocals|silky vocals)\b/i;

  // Lint: prompt should NOT contain structure tags
  const promptHasStructureTag = !!prompt.match(ALLOWED_STRUCTURE_RE);
  // Lint: lyrics shouldn't read like a prompt
  const lyricsLooksLikePrompt = !instrumentalOnly && PROMPTY_IN_LYRICS_RE.test(lyrics);
  // Lint: lyrics should only use the 11 known structure tokens
  const unknownBracketInLyrics = (() => {
    if (instrumentalOnly) return null;
    const matches = lyrics.match(ANY_BRACKET_RE) ?? [];
    const offending = matches.find((m) => !ALLOWED_STRUCTURE_RE.test(m));
    return offending ?? null;
  })();

  const startTimer = () => { setElapsed(0); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000); };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  // True from the moment Generate is clicked until the music job
  // completes (or fails). Drives the Generate button's disabled +
  // spinner state so a user can't queue a second job while one is
  // already in flight. The local ``loading`` flag now only covers the
  // initial /startJob HTTP call; ``hasPending('music')`` covers the
  // longer polling phase after the job is queued.
  const isGenerating = loading || generations.hasPending('music');

  // Per-quality duration caps. Higher quality multiplies compute time,
  // so we shorten the allowed song length to stay inside the music-engine
  // phase timeout. Mirrors the backend tiers in routers/studio.py.
  const MAX_DURATION_BY_MODE = { fast: 400, balanced: 300, max: 200 } as const;
  // For Custom (user touched Advanced manually) fall back to the strictest
  // tier so we don't let exotic combos sneak past.
  const currentDurationCap = qualityMode === 'custom'
    ? MAX_DURATION_BY_MODE.max
    : MAX_DURATION_BY_MODE[qualityMode];

  // Quality mode → infer_step + guidance_scale presets. Picked from the
  // ACE-Step integration guide §6 ("Sensible modes"). Also clamps the
  // duration if the new mode's cap is tighter than the current value.
  const applyQualityMode = (mode: 'fast' | 'balanced' | 'max') => {
    setQualityMode(mode);
    if (mode === 'fast')     { setInferStep(27);  setGuidanceScale(12); }
    if (mode === 'balanced') { setInferStep(60);  setGuidanceScale(15); }
    if (mode === 'max')      { setInferStep(120); setGuidanceScale(18); }
    setDuration((d) => (d !== -1 && d > MAX_DURATION_BY_MODE[mode] ? MAX_DURATION_BY_MODE[mode] : d));
  };

  const handleGenerate = async () => {
    if (!isAuthenticated || !user) { setStatus({ type: 'error', message: 'Please sign in to generate music.' }); return; }
    if (!title.trim()) { setTitleInvalid(true); setStatus({ type: 'error', message: 'Please enter a title.' }); return; }
    setTitleInvalid(false);
    if (needsAudioFile && !audioFile) { setStatus({ type: 'error', message: 'Please select a source audio file.' }); return; }
    if (!prompt.trim()) { setStatus({ type: 'error', message: 'Please enter a prompt.' }); return; }
    // Lyrics required — empty lyrics is an engine error. ``[inst]`` is
    // the official instrumental sentinel.
    if (!lyrics.trim()) {
      setStatus({ type: 'error', message: 'Lyrics is required — use [inst] for an instrumental track.' });
      return;
    }
    // Soft block on the cross-field warnings — not catastrophic but
    // results will likely be wrong, so confirm before burning credits.
    if (promptHasStructureTag || lyricsLooksLikePrompt || unknownBracketInLyrics) {
      const ok = window.confirm(
        "Heads up: your prompt and lyrics may be mixed up. Generate anyway?"
      );
      if (!ok) return;
    }
    if (activeTask !== 'text2music') {
      setStatus({ type: 'error', message: `${activeTask} is not yet supported via the queued backend. Coming soon.` });
      return;
    }

    if (generations.hasPending('music')) {
      const ok = window.confirm('You already have a music generation in progress. Start another anyway?');
      if (!ok) return;
    }

    setStatus(null); setResultAudioUrl(null); setLoading(true); startTimer();
    const token = localStorage.getItem('vocence_token');
    try {
      const submission = await dashboardApi.startJob({
        type: 'music',
        credits: CREDIT_MUSIC,
        payload: {
          title: title.trim(),
          prompt,
          lyrics,
          audio_duration: duration,
          format,
          infer_step: inferStep,
          guidance_scale: guidanceScale,
          scheduler_type: schedulerType,
          cfg_type: cfgType,
          omega_scale: omegaScale,
          manual_seeds: manualSeeds,
          guidance_interval: guidanceInterval,
          guidance_interval_decay: guidanceIntervalDecay,
          min_guidance_scale: minGuidanceScale,
          use_erg_tag: useErgTag,
          use_erg_lyric: useErgLyric,
          use_erg_diffusion: useErgDiffusion,
          oss_steps: ossSteps,
          guidance_scale_text: guidanceScaleText,
          guidance_scale_lyric: guidanceScaleLyric,
          lora_name_or_path: loraPath,
        },
      }, token);
      setLocalCredits((user.credits ?? 0) - CREDIT_MUSIC);
      setStatus({
        type: submission.load_warning ? 'info' : 'success',
        message: submission.load_warning
          ? `Queued (position ${submission.queue_position}). Capacity is heavy right now — this may take roughly 2× as long as usual.`
          : `Queued (position ${submission.queue_position}). Generating…`,
      });
      generations.trackServerJob({
        serverJobId: submission.job_id,
        type: 'music',
        label: title.trim() || prompt.slice(0, 60),
        toastResult: {
          navigateTo: '/studio/music',
          playerTitle: title.trim() || prompt.slice(0, 60),
          playerSubtitle: `Music · ${activeTask}`,
          downloadFilename: `${slugify(title)}-${Date.now()}.${format}`,
        },
      });
      // The result will be set by the polling helper below.
      // ``loading`` only covers the queueing HTTP call; the long-running
      // polling phase relies on ``isGenerating`` (loading || hasPending)
      // so the Generate button stays disabled + spinning the WHOLE time
      // until the music job completes.
      setLoading(false);
      void pollMusicJobUntilDone(submission.job_id);
    } catch (e: unknown) {
      const msg = humanizeApiError(e, 'Music generation failed. Please try again.');
      setStatus({ type: 'error', message: msg });
      setLoading(false);
      stopTimer();
    }
  };

  /** Mirror the job's progress into the local Result card (separate from the global pill). */
  const pollMusicJobUntilDone = async (jobId: string) => {
    const token = localStorage.getItem('vocence_token');
    while (true) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const job = await dashboardApi.getJob(jobId, token);
        if (job.status === 'completed') {
          const audioUrl = (job.result?.audio_url as string | undefined) || '';
          setResultAudioUrl(audioUrl);
          setStatus({ type: 'success', message: 'Music ready.' });
          if (audioUrl) {
            playAudio({
              src: audioUrl,
              title: title.trim() || prompt.slice(0, 60),
              subtitle: `Music · ${activeTask}`,
              downloadFilename: `${slugify(title)}-${Date.now()}.${format}`,
            });
          }
          stopTimer();
          return;
        }
        if (job.status === 'failed' || job.status === 'timeout' || job.status === 'cancelled') {
          setStatus({ type: 'error', message: job.error_message || 'Music generation failed.' });
          setLocalCredits((user?.credits ?? 0) + CREDIT_MUSIC);
          stopTimer();
          return;
        }
        // pending or processing — keep polling. Surface phase + queue position.
        const sub = job.phase
          ? job.phase
          : job.status === 'pending'
            ? `Queued (position ${job.queue_position})`
            : 'Generating…';
        setStatus({ type: 'info', message: sub });
      } catch {
        // transient — keep polling
      }
    }
  };

  const activeTabInfo = TASK_TABS.find(t => t.id === activeTask)!;
  const inputCls = 'w-full bg-[#1c1d21] border border-[#2e2f33] rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#9ca3af] outline-none focus:border-[#DFFF00]/50 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';
  const labelCls = 'text-[11px] text-[#9ca3af] uppercase tracking-wider font-medium';

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold mb-1">Text-to-Music</h2>
          <p className="text-sm text-[#9ca3af]">Generate original music with AI — describe a style, add lyrics, and create.</p>
        </div>
        <a
          href="/docs/guide-music"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
        >
          <BookOpen size={14} />
          Guide
        </a>
      </div>

      {/* Task tabs — icon + label */}
      <div className="flex gap-2 flex-wrap">
        {TASK_TABS.map((tab) => {
          const Icon = tab.icon;
          const active = activeTask === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                if (tab.id !== 'text2music') {
                  setStatus({ type: 'info', message: `${tab.label} is currently under development. Stay tuned!` });
                  setResultAudioUrl(null);
                  return;
                }
                setActiveTask(tab.id); setStatus(null); setResultAudioUrl(null);
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                active
                  ? 'bg-white text-[#07080A]'
                  : 'bg-white/[0.06] text-[#9ca3af] hover:bg-white/[0.10] hover:text-white border border-[#2e2f33]'
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab description */}
      <p className="text-xs text-[#9ca3af] -mt-4">{activeTabInfo.desc}</p>

      {/* Two-column layout */}
      <div className="flex flex-col lg:flex-row gap-6">
        {/* LEFT — Main input area */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Audio upload for non-text2music */}
          {needsAudioFile && (
            <div
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[#2e2f33] rounded-2xl p-8 text-center cursor-pointer hover:border-[#444] transition-colors group"
            >
              <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={(e) => setAudioFile(e.target.files?.[0] || null)} />
              {audioFile ? (
                <div className="flex items-center justify-center gap-3">
                  <Music size={20} className="text-[#DFFF00]" />
                  <div className="text-left">
                    <p className="text-sm text-white font-medium">{audioFile.name}</p>
                    <p className="text-xs text-[#9ca3af]">{(audioFile.size / 1024 / 1024).toFixed(1)} MB</p>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); setAudioFile(null); }} className="text-[#555] hover:text-white ml-2"><X size={16} /></button>
                </div>
              ) : (
                <>
                  <Upload size={24} className="mx-auto text-[#666] group-hover:text-[#999] mb-2" />
                  <p className="text-sm text-[#9ca3af]">Drop {activeTask === 'audio2audio' ? 'reference' : 'source'} audio here or click to browse</p>
                  <p className="text-xs text-[#666] mt-1">WAV, MP3, OGG, FLAC — max 100MB</p>
                </>
              )}
            </div>
          )}

          {/* Genre presets — only for text2music */}
          {activeTask === 'text2music' && (
            <div>
              <label className={labelCls}>Genre</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-1.5 mt-2">
                {GENRE_PRESETS.map((g) => (
                  <button
                    key={g.label}
                    onClick={() => {
                      // Always update prompt + selected tile — the two
                      // fields are independent and the user clearly
                      // wants the new tag string.
                      setPrompt(g.value);
                      setSelectedGenre(g.label);

                      // Lyric overwrite policy:
                      //   • Clean (untouched preset / [inst] / freshly
                      //     generated text) → swap to the new genre's
                      //     template, including the instrumental flag.
                      //   • User has typed → leave the lyrics alone
                      //     entirely. They've put effort in; switching
                      //     genre shouldn't destroy that. The prompt
                      //     update above is enough — they can apply a
                      //     different style to their own lyrics.
                      if (userEditedLyrics) return;
                      const isInstrumental = g.lyrics.trim() === '[inst]';
                      setInstrumentalOnly(isInstrumental);
                      setLyrics(g.lyrics);
                    }}
                    className={`rounded-lg px-2 py-1.5 text-center transition-all border-2 relative overflow-hidden ${
                      selectedGenre === g.label
                        ? 'border-[#DFFF00] shadow-[0_0_8px_rgba(223,255,0,0.25)]'
                        : 'border-transparent hover:border-[#444]'
                    }`}
                  >
                    <img loading="lazy" src={g.image} alt="" className="absolute inset-0 w-full h-full object-cover opacity-50" />
                    <div className="absolute inset-0 bg-black/30" />
                    <div className="relative z-10">
                      <span className="text-xl">{g.emoji}</span>
                      <p className="text-xs text-white font-medium leading-tight mt-0.5">{g.label}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Title (required) */}
          <div>
            <label className={labelCls}>Title <span className="text-red-400">*</span></label>
            <input
              type="text"
              className={`${inputCls} mt-1.5 ${titleInvalid ? 'border-red-500/60' : ''}`}
              value={title}
              onChange={(e) => { setTitle(e.target.value); if (titleInvalid && e.target.value.trim()) setTitleInvalid(false); }}
              placeholder="Name this track…"
              maxLength={120}
            />
            {titleInvalid ? <p className="text-[11px] text-red-400 mt-1">Title is required.</p> : null}
          </div>

          {/* Prompt */}
          <div>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <label className={labelCls}>Prompt / Tags</label>
              <p className="text-[11px] text-[#666]">
                Replace this with what you want to design.{' '}
                <a
                  href="/docs/guide-music"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#DFFF00]/80 hover:text-[#DFFF00] underline-offset-2 hover:underline"
                >
                  Check guide
                </a>{' '}
                for best practice.
              </p>
            </div>
            <input
              type="text"
              className={`${inputCls} mt-1.5`}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setSelectedGenre(null); }}
              placeholder="genre, instruments, tempo, mood, vocal style..."
            />
            {promptHasStructureTag && (
              <p className="text-[11px] text-amber-300 mt-1.5 flex items-center gap-1.5">
                <AlertCircle size={11} />
                Structure tags like [verse] / [chorus] belong in the lyrics box, not here.
              </p>
            )}
          </div>

          {/* Lyrics */}
          <div>
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-3 flex-wrap">
                <label className={labelCls}>Lyrics</label>
                <p className="text-[11px] text-[#666]">
                  Replace this with what you want sung.{' '}
                  <a
                    href="/docs/guide-music"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[#DFFF00]/80 hover:text-[#DFFF00] underline-offset-2 hover:underline"
                  >
                    Check guide
                  </a>{' '}
                  for best practice.
                </p>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] text-[#9ca3af] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={instrumentalOnly}
                  onChange={(e) => setInstrumentalOnly(e.target.checked)}
                  className="w-3.5 h-3.5 accent-[#DFFF00] rounded"
                />
                Instrumental only
              </label>
            </div>

            {/* Structure tag helper bar + Generate-with-AI button */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <div className={`flex flex-wrap gap-1.5 ${instrumentalOnly ? 'opacity-40 pointer-events-none' : ''}`}>
                {STRUCTURE_TAGS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => insertStructureTag(t)}
                    className="text-[11px] font-mono px-2 py-1 rounded-md border border-white/10 bg-white/[0.03] text-[#A7B0B7] hover:border-[#DFFF00]/40 hover:text-white transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => { if (instrumentalOnly) return; setLyricGenError(null); setLyricGenOpen(true); }}
                disabled={instrumentalOnly}
                title={instrumentalOnly ? 'Disabled while Instrumental only is on' : 'Generate lyrics with AI'}
                className="ml-auto inline-flex items-center gap-2 text-xs font-semibold px-3.5 py-2 rounded-lg border border-[#DFFF00]/40 bg-[#DFFF00]/[0.10] text-[#DFFF00] hover:bg-[#DFFF00]/[0.18] hover:border-[#DFFF00]/60 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              >
                <Sparkles size={14} />
                Generate lyrics with AI
              </button>
            </div>

            <textarea
              ref={lyricsRef}
              rows={16}
              disabled={instrumentalOnly}
              className={`${inputCls} mt-2 resize-y font-mono text-[13px] leading-relaxed disabled:opacity-50 disabled:cursor-not-allowed`}
              value={lyrics}
              onChange={(e) => { setLyrics(e.target.value); setUserEditedLyrics(true); }}
              placeholder={"[verse]\nYour lyrics here...\n\n[chorus]\nThe hook goes here..."}
            />
            {instrumentalOnly && (
              <p className="text-[11px] text-[#9ca3af] mt-1.5">
                Locked to <span className="font-mono">[inst]</span> — uncheck "Instrumental only" to write lyrics.
              </p>
            )}
            {!instrumentalOnly && lyricsLooksLikePrompt && (
              <p className="text-[11px] text-amber-300 mt-1.5 flex items-center gap-1.5">
                <AlertCircle size={11} />
                Looks like genre / instrument tags — those go in the prompt above. Lyrics is what gets sung.
              </p>
            )}
            {!instrumentalOnly && unknownBracketInLyrics && (
              <p className="text-[11px] text-amber-300 mt-1.5 flex items-center gap-1.5">
                <AlertCircle size={11} />
                <span>
                  <span className="font-mono">{unknownBracketInLyrics}</span> isn't a known structure tag —
                  it'll be sung out loud. Use one of the buttons above.
                </span>
              </p>
            )}
          </div>

          {/* Task-specific fields */}
          {activeTask === 'audio2audio' && (
            <Field label="Reference Audio Strength" hint="0 = ignore reference, 1 = follow closely">
              <input type="range" min={0} max={1} step={0.05} value={refAudioStrength}
                onChange={(e) => setRefAudioStrength(Number(e.target.value))}
                className="w-full accent-[#DFFF00]" />
              <span className="text-xs text-[#DFFF00] tabular-nums ml-2 w-8">{refAudioStrength}</span>
            </Field>
          )}

          {activeTask === 'retake' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Variance"><input type="number" className={inputCls} value={retakeVariance} onChange={(e) => setRetakeVariance(Number(e.target.value))} min={0} max={1} step={0.05} /></Field>
              <Field label="Seeds"><input type="text" className={inputCls} value={retakeSeeds} onChange={(e) => setRetakeSeeds(e.target.value)} placeholder="e.g. 42" /></Field>
            </div>
          )}

          {activeTask === 'repaint' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Start (sec)"><input type="number" className={inputCls} value={repaintStart} onChange={(e) => setRepaintStart(Number(e.target.value))} min={0} step={0.5} /></Field>
              <Field label="End (sec)"><input type="number" className={inputCls} value={repaintEnd} onChange={(e) => setRepaintEnd(Number(e.target.value))} min={0} step={0.5} /></Field>
              <Field label="Variance"><input type="number" className={inputCls} value={retakeVariance} onChange={(e) => setRetakeVariance(Number(e.target.value))} min={0} max={1} step={0.05} /></Field>
            </div>
          )}

          {activeTask === 'edit' && (
            <div className="space-y-4 rounded-xl border border-[#2e2f33] bg-[#1c1d21]/50 p-4">
              <p className="text-[11px] text-[#DFFF00] uppercase tracking-wider font-semibold">Target output</p>
              <Field label="Target Prompt"><input type="text" className={inputCls} value={editTargetPrompt} onChange={(e) => setEditTargetPrompt(e.target.value)} /></Field>
              <Field label="Target Lyrics"><textarea rows={3} className={`${inputCls} resize-y`} value={editTargetLyrics} onChange={(e) => setEditTargetLyrics(e.target.value)} /></Field>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Field label="Type">
                  <CustomSelect value="only_lyrics" onChange={(v) => { if (v === 'only_lyrics') { setEditNMin(0.6); setEditNMax(1.0); } else { setEditNMin(0.2); setEditNMax(0.4); } }}
                    options={[{ value: 'only_lyrics', label: 'Lyrics only' }, { value: 'remix', label: 'Remix' }]} />
                </Field>
                <Field label="n_min"><input type="number" className={inputCls} value={editNMin} onChange={(e) => setEditNMin(Number(e.target.value))} min={0} max={1} step={0.01} /></Field>
                <Field label="n_max"><input type="number" className={inputCls} value={editNMax} onChange={(e) => setEditNMax(Number(e.target.value))} min={0} max={1} step={0.01} /></Field>
              </div>
            </div>
          )}

          {activeTask === 'extend' && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field label="Left (sec)"><input type="number" className={inputCls} value={leftExtend} onChange={(e) => setLeftExtend(Number(e.target.value))} min={0} max={240} /></Field>
              <Field label="Right (sec)"><input type="number" className={inputCls} value={rightExtend} onChange={(e) => setRightExtend(Number(e.target.value))} min={0} max={240} /></Field>
              <Field label="Seeds"><input type="text" className={inputCls} value={extendSeeds} onChange={(e) => setExtendSeeds(e.target.value)} placeholder="e.g. 42" /></Field>
            </div>
          )}
        </div>

        {/* RIGHT — Settings panel */}
        <div className="lg:w-72 shrink-0 space-y-4">
          {/* Duration + Format */}
          {(activeTask === 'text2music' || activeTask === 'audio2audio') && (
            <div className="rounded-xl border border-[#2e2f33] bg-[#1c1d21]/50 p-4 space-y-3">
              <Field
                label="Duration (sec)"
                hint={
                  qualityMode === 'custom'
                    ? `Capped at ${currentDurationCap}s on Custom (uses the strictest tier).`
                    : `Capped at ${currentDurationCap}s on ${qualityMode === 'fast' ? 'Fast' : qualityMode === 'balanced' ? 'Balanced' : 'Max'} quality. Use -1 for random.`
                }
              >
                <input
                  type="number"
                  className={inputCls}
                  value={duration}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (v === -1) { setDuration(-1); return; }
                    setDuration(Math.min(currentDurationCap, Math.max(-1, v)));
                  }}
                  min={-1}
                  max={currentDurationCap}
                />
              </Field>
              <Field label="Format">
                <CustomSelect value={format} onChange={setFormat}
                  options={[{ value: 'wav', label: 'WAV' }, { value: 'mp3', label: 'MP3' }, { value: 'ogg', label: 'OGG' }, { value: 'flac', label: 'FLAC' }]} />
              </Field>
            </div>
          )}

          {/* Quality mode — preset for infer_step + guidance_scale.
              Most users pick a mode and never expand Advanced. */}
          {activeTask === 'text2music' && (
            <div className="rounded-xl border border-[#2e2f33] bg-[#1c1d21]/50 p-4 space-y-2">
              <p className={labelCls}>Quality</p>
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { id: 'fast',     label: 'Fast',     hint: '~1 min' },
                  { id: 'balanced', label: 'Balanced', hint: 'default' },
                  { id: 'max',      label: 'Max',      hint: 'slowest' },
                ] as const).map((m) => {
                  const active = qualityMode === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => applyQualityMode(m.id)}
                      className={`rounded-lg border px-2 py-2 text-center transition-all ${
                        active
                          ? 'border-[#DFFF00] bg-[#DFFF00]/[0.08] text-white'
                          : 'border-[#2e2f33] bg-white/[0.02] text-[#9ca3af] hover:text-white hover:border-[#444]'
                      }`}
                    >
                      <div className="text-xs font-semibold">{m.label}</div>
                      <div className="text-[10px] text-[#666] mt-0.5">{m.hint}</div>
                    </button>
                  );
                })}
              </div>
              {qualityMode === 'custom' && (
                <p className="text-[10px] text-[#666] mt-1">Custom values from Advanced — pick a mode to reset.</p>
              )}
            </div>
          )}

          {/* Generation settings (collapsible) */}
          <div className="rounded-xl border border-[#2e2f33] bg-[#1c1d21]/50 overflow-hidden">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center justify-between w-full px-4 py-3 text-[11px] text-[#9ca3af] uppercase tracking-wider font-medium hover:text-white transition-colors"
            >
              Generation Settings
              {showSettings ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {showSettings && (
              <div className="px-4 pb-4 space-y-3 border-t border-[#2e2f33] pt-3">
                <Field label="Infer Steps"><input type="number" className={inputCls} value={inferStep} onChange={(e) => { setInferStep(Number(e.target.value)); setQualityMode('custom'); }} min={1} max={200} /></Field>
                <Field label="Guidance Scale"><input type="number" className={inputCls} value={guidanceScale} onChange={(e) => { setGuidanceScale(Number(e.target.value)); setQualityMode('custom'); }} step={0.1} /></Field>
                <Field label="Scheduler">
                  <CustomSelect value={schedulerType} onChange={setSchedulerType}
                    options={[{ value: 'euler', label: 'Euler' }, { value: 'heun', label: 'Heun' }, { value: 'pingpong', label: 'Pingpong' }]} />
                </Field>
                <Field label="CFG Type">
                  <CustomSelect value={cfgType} onChange={setCfgType}
                    options={[{ value: 'apg', label: 'APG' }, { value: 'cfg', label: 'CFG' }, { value: 'cfg_star', label: 'CFG Star' }]} />
                </Field>
                <Field label="Seeds"><input type="text" className={inputCls} value={manualSeeds} onChange={(e) => setManualSeeds(e.target.value)} placeholder="e.g. 42" /></Field>
                <Field label="Omega Scale"><input type="number" className={inputCls} value={omegaScale} onChange={(e) => setOmegaScale(Number(e.target.value))} step={0.1} /></Field>
                <Field label="Guidance Interval"><input type="number" className={inputCls} value={guidanceInterval} onChange={(e) => setGuidanceInterval(Number(e.target.value))} min={0} max={1} step={0.01} /></Field>
                <Field label="Min Guidance"><input type="number" className={inputCls} value={minGuidanceScale} onChange={(e) => setMinGuidanceScale(Number(e.target.value))} step={0.1} /></Field>
                <div className="flex flex-wrap gap-3 pt-1">
                  <label className="flex items-center gap-1.5 text-xs text-[#666]">
                    <input type="checkbox" checked={useErgTag} onChange={(e) => setUseErgTag(e.target.checked)} className="w-3.5 h-3.5 accent-[#DFFF00] rounded" /> ERG Tag
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[#666]">
                    <input type="checkbox" checked={useErgLyric} onChange={(e) => setUseErgLyric(e.target.checked)} className="w-3.5 h-3.5 accent-[#DFFF00] rounded" /> ERG Lyric
                  </label>
                  <label className="flex items-center gap-1.5 text-xs text-[#666]">
                    <input type="checkbox" checked={useErgDiffusion} onChange={(e) => setUseErgDiffusion(e.target.checked)} className="w-3.5 h-3.5 accent-[#DFFF00] rounded" /> ERG Diffusion
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Generate button — disabled (and spinning) for the WHOLE
              music-generation lifecycle, not just the queueing call.
              ``isGenerating`` = local ``loading`` (initial /startJob)
              OR ``generations.hasPending('music')`` (polling phase). */}
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-white text-[#07080A] hover:bg-white/90 active:scale-[0.98]"
          >
            {isGenerating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Generating… <span className="tabular-nums">{elapsed}s</span></span>
              </>
            ) : (
              <>
                <Music size={16} />
                Generate ({CREDIT_MUSIC} credits)
              </>
            )}
          </button>

          {/* Credits */}
          {user && (
            <p className="text-center text-[11px] text-[#666]">
              Balance: <span className="text-[#9ca3af]">{user.credits?.toLocaleString() ?? 0} credits</span>
            </p>
          )}

          {isGenerating && (
            <p className="text-center text-xs text-[#A7B0B7] mt-1">
              {qualityMode === 'fast'
                ? 'Usually around a minute — first run after the engine warms up may be longer.'
                : qualityMode === 'max'
                  ? 'Max quality takes 2–4 minutes — feel free to leave the page open.'
                  : 'Usually 1–2 minutes — feel free to leave the page open.'}
            </p>
          )}
        </div>
      </div>

      {/* Status */}
      {status && (
        <div className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
          status.type === 'success' ? 'border-emerald-400/20 bg-emerald-500/[0.06] text-emerald-200'
            : status.type === 'error' ? 'border-red-400/20 bg-red-500/[0.06] text-red-200'
            : 'border-amber-300/20 bg-amber-400/[0.06] text-amber-200'
        }`}>
          {status.type === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <AlertCircle size={16} className="mt-0.5 shrink-0" />}
          <span>{status.message}</span>
        </div>
      )}

      {/* Result */}
      {resultAudioUrl && (
        <div className="rounded-2xl border border-[#2e2f33] bg-[#1c1d21] p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-white font-medium truncate">{title.trim() || prompt.slice(0, 80) || 'Generated track'}</p>
              <p className="text-xs text-[#9ca3af] mt-0.5 flex items-center gap-1"><Clock size={11} /> Generated in {elapsed}s · plays in the bottom player</p>
            </div>
            <button
              onClick={async () => {
                const url = resultAudioUrl!;
                const filename = `${slugify(title) || 'vocence-music'}-${Date.now()}.${format}`;
                try {
                  const resp = await fetch(url);
                  if (!resp.ok) throw new Error('fetch failed');
                  const blob = await resp.blob();
                  const blobUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = blobUrl;
                  a.download = filename;
                  a.style.display = 'none';
                  document.body.appendChild(a);
                  a.click();
                  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(blobUrl); }, 1000);
                } catch {
                  // CORS blocked — open directly
                  const a = document.createElement('a');
                  a.href = url;
                  a.target = '_blank';
                  a.rel = 'noopener noreferrer';
                  a.click();
                }
              }}
              className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 transition-all"
            >
              <Download size={16} />
              Download
            </button>
          </div>
        </div>
      )}

      {/* Sample music */}
      <SampleMusicSection />

      {/* AI lyric generation modal */}
      {lyricGenOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 backdrop-blur-sm p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Generate lyrics with AI"
          onClick={(e) => {
            if (e.target === e.currentTarget && !lyricGenBusy) setLyricGenOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !lyricGenBusy) setLyricGenOpen(false);
          }}
        >
          <div className="w-full max-w-md bg-[#0B0D10] border border-white/10 rounded-2xl shadow-2xl shadow-black/60 p-5">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles size={16} className="text-[#DFFF00]" />
              <h3 className="text-sm font-semibold text-white">Generate lyrics with AI</h3>
              <button
                type="button"
                onClick={() => !lyricGenBusy && setLyricGenOpen(false)}
                disabled={lyricGenBusy}
                className="ml-auto text-[#A7B0B7] hover:text-white p-1 rounded-md hover:bg-white/5 disabled:opacity-50"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </div>

            <p className="text-xs text-[#9ca3af] mb-3 leading-relaxed">
              Tell me what the song is about. I'll write lyrics in the right structure
              and match the style of your prompt
              <span className="text-[#666]"> ({prompt.split(',').slice(0, 3).join(',').trim() || 'no style set'}…)</span>.
            </p>

            <textarea
              autoFocus
              rows={4}
              value={lyricGenTopic}
              onChange={(e) => { setLyricGenTopic(e.target.value); if (lyricGenError) setLyricGenError(null); }}
              placeholder="A driving night in the city, feeling alive — turning headlights into freedom"
              disabled={lyricGenBusy}
              className="w-full bg-[#1c1d21] border border-[#2e2f33] rounded-xl px-3 py-2.5 text-sm text-white placeholder-[#666] outline-none focus:border-[#DFFF00]/50 transition-colors resize-y disabled:opacity-50"
            />

            {lyricGenError && (
              <p className="mt-2 text-[11px] text-red-300 flex items-start gap-1.5">
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                <span>{lyricGenError}</span>
              </p>
            )}

            <div className="flex items-center justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => !lyricGenBusy && setLyricGenOpen(false)}
                disabled={lyricGenBusy}
                className="px-3 py-1.5 text-xs text-[#A7B0B7] hover:text-white rounded-lg hover:bg-white/5 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={runLyricGeneration}
                disabled={lyricGenBusy || !lyricGenTopic.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[#DFFF00] text-[#07080A] text-xs font-semibold hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {lyricGenBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {lyricGenBusy ? 'Writing…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Sample music list — placeholder audio, replace later
   ========================================================================== */

const SAMPLE_TRACKS = [
  { id: 's1', title: 'Neon Nights', style: 'pop, synth, drums, guitar, 120 bpm, upbeat, catchy, vibrant, female vocals, polished vocals', audioSrc: asset('music.pop'), image: '/samples/images/music_1.webp' },
  { id: 's2', title: 'Rebel Road', style: 'rock, electric guitar, drums, bass, 130 bpm, energetic, rebellious, gritty, male vocals, raw vocals', audioSrc: asset('music.rock'), image: '/samples/images/music_2.webp' },
  { id: 's3', title: 'Urban Flow', style: 'hip hop, 808 bass, hi-hats, synth, 90 bpm, bold, urban, intense, male vocals, rhythmic vocals', audioSrc: asset('music.street'), image: '/samples/images/music_3.webp' },
  { id: 's4', title: 'Pulse Drop', style: 'edm, synth, bass, kick drum, 128 bpm, euphoric, pulsating, energetic, instrumental', audioSrc: asset('music.club'), image: '/samples/images/music_4.webp' },
  { id: 's5', title: 'Midnight Blues', style: 'jazz, saxophone, piano, double bass, 110 bpm, smooth, improvisational, soulful, instrumental', audioSrc: asset('music.jazz'), image: '/samples/images/music_5.webp' },
  { id: 's6', title: 'Final Boss', style: 'classical, orchestral, strings, piano, 60 bpm, elegant, emotive, timeless, instrumental', audioSrc: asset('music.orchestral'), image: '/samples/images/music_6.webp' },
  { id: 's7', title: 'Code & Coffee', style: 'lo-fi, piano, soft drums, vinyl crackle, 75 bpm, chill, mellow, warm, instrumental', audioSrc: asset('music.chill'), image: '/samples/images/music_7.webp' },
  { id: 's8', title: 'Velvet Touch', style: 'r&b, synth, bass, drums, 85 bpm, sultry, groovy, romantic, female vocals, silky vocals', audioSrc: asset('music.soundful'), image: '/samples/images/music_8.webp' },
];

function SampleMusicSection() {
  const { track, playing, play, pause, resume } = useStudioPlayer();

  return (
    <section className="pt-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-white">Sample Generations</h3>
        <p className="text-xs text-[#9ca3af] mt-0.5">Listen to what Vocence can create. Click any track to preview.</p>
      </div>
      <div className="space-y-1">
        {SAMPLE_TRACKS.map((t) => {
          const isThis = track?.src === t.audioSrc;
          const isPlaying = isThis && playing;
          const handleClick = () => {
            if (isPlaying) { pause(); return; }
            if (isThis) { resume(); return; }
            play({ src: t.audioSrc, title: t.title, subtitle: t.style.slice(0, 60), image: t.image });
          };
          return (
            <button
              key={t.id}
              onClick={handleClick}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                isThis ? 'bg-[#1c1d21] border border-[#2e2f33]' : 'hover:bg-[#1c1d21]/50 border border-transparent'
              }`}
            >
              {/* Artwork thumbnail */}
              <div className="w-[72px] h-[72px] rounded-xl shrink-0 relative overflow-hidden group/thumb">
                <img loading="lazy" src={t.image} alt={t.title} className="w-full h-full object-cover transition-transform duration-300 group-hover/thumb:scale-110" />
                <div className={`absolute inset-0 flex items-center justify-center transition-all ${
                  isPlaying ? 'bg-black/40' : 'bg-black/0 group-hover/thumb:bg-black/30'
                }`}>
                  {isPlaying ? (
                    <Pause size={16} className="text-white" />
                  ) : (
                    <Play size={16} className="text-white opacity-0 group-hover/thumb:opacity-100 ml-0.5 transition-opacity" />
                  )}
                </div>
              </div>

              {/* Title */}
              <span className={`text-sm font-medium w-24 sm:w-32 shrink-0 truncate ${isThis ? 'text-[#DFFF00]' : 'text-white/80'}`}>{t.title}</span>

              {/* Style prompt */}
              <span className="text-xs text-[#666] flex-1 truncate hidden sm:block">{t.style}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-[11px] text-[#9ca3af] uppercase tracking-wider font-medium">{label}</label>
      {hint && <span className="text-[10px] text-[#666] ml-2">{hint}</span>}
      <div className="mt-1 flex items-center">{children}</div>
    </div>
  );
}

function CustomSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const selected = options.find(o => o.value === value);

  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full bg-[#1c1d21] border border-[#2e2f33] rounded-xl px-4 py-2.5 text-sm text-white outline-none focus:border-[#DFFF00]/50 transition-colors flex items-center justify-between"
      >
        <span>{selected?.label || value}</span>
        <ChevronDown size={14} className={`text-[#9ca3af] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-xl border border-[#2e2f33] bg-[#1c1d21] shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden py-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onChange(opt.value); setOpen(false); }}
              className={`w-full px-4 py-2.5 text-sm text-left flex items-center justify-between transition-colors ${
                value === opt.value
                  ? 'text-white bg-white/[0.08]'
                  : 'text-[#9ca3af] hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {opt.label}
              {value === opt.value && <Check size={14} className="text-white" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
