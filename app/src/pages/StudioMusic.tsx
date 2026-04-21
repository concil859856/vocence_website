import { useState, useRef, useEffect } from 'react';
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronUp, Loader2, Music,
  Upload, X, Download, Clock, Disc3, Wand2, Repeat, Paintbrush, Scissors, ArrowRightFromLine,
  Play, Pause, Check,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { dashboardApi, type StudioMusicGenerateResponse } from '../services/dashboardApi';
import { CREDIT_MUSIC } from '../studio/creditCosts';
import { asset } from '../data/assets';

type MusicTask = 'text2music' | 'audio2audio' | 'retake' | 'repaint' | 'edit' | 'extend';

interface GenrePreset {
  label: string;
  value: string;
  emoji: string;
  image: string;
}

const GENRE_PRESETS: GenrePreset[] = [
  { label: 'Upbeat Pop', value: 'pop, synth, drums, guitar, 120 bpm, upbeat, catchy, vibrant, female vocals, polished vocals', emoji: '🎤', image: '/samples/images/genre_1.webp' },
  { label: 'Hard Rock', value: 'rock, electric guitar, drums, bass, 130 bpm, energetic, rebellious, gritty, male vocals, raw vocals', emoji: '🎸', image: '/samples/images/genre_2.webp' },
  { label: 'Street Rap', value: 'hip hop, 808 bass, hi-hats, synth, 90 bpm, bold, urban, intense, male vocals, rhythmic vocals', emoji: '🎧', image: '/samples/images/genre_3.webp' },
  { label: 'Club EDM', value: 'edm, synth, bass, kick drum, 128 bpm, euphoric, pulsating, energetic, instrumental', emoji: '⚡', image: '/samples/images/genre_4.webp' },
  { label: 'Smooth Jazz', value: 'jazz, saxophone, piano, double bass, 110 bpm, smooth, improvisational, soulful, instrumental', emoji: '🎷', image: '/samples/images/genre_5.webp' },
  { label: 'Orchestral', value: 'classical, orchestral, strings, piano, 60 bpm, elegant, emotive, timeless, instrumental', emoji: '🎻', image: '/samples/images/genre_6.webp' },
  { label: 'Chill Lo-fi', value: 'lo-fi, piano, soft drums, vinyl crackle, 75 bpm, chill, mellow, warm, instrumental', emoji: '☕', image: '/samples/images/genre_7.webp' },
  { label: 'Soulful R&B', value: 'r&b, synth, bass, drums, 85 bpm, sultry, groovy, romantic, female vocals, silky vocals', emoji: '💜', image: '/samples/images/genre_8.webp' },
];

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
  const { user, isAuthenticated, updateCredits } = useAuth();
  const { play: playAudio } = useStudioPlayer();

  const [activeTask, setActiveTask] = useState<MusicTask>('text2music');
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [resultAudioUrl, setResultAudioUrl] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Text2Music
  const [prompt, setPrompt] = useState(GENRE_PRESETS[0].value);
  const [lyrics, setLyrics] = useState(`[verse]
Neon lights they flicker bright
City hums in dead of night
Rhythms pulse through concrete veins
Lost in echoes of refrains

[chorus]
Turn it up and let it flow
Feel the fire let it grow
In this rhythm we belong
Hear the night sing out our song

[verse]
Shadows dance on broken walls
Whispered secrets down the halls
Every heartbeat tells a tale
Chasing thunder through the gale

[bridge]
We are the sound that never fades
Burning through the barricades
Electric souls and midnight dreams
Nothing's ever what it seems

[chorus]
Turn it up and let it flow
Feel the fire let it grow
In this rhythm we belong
Hear the night sing out our song`);
  const [duration, setDuration] = useState(90);
  const [format, setFormat] = useState('wav');
  const [selectedGenre, setSelectedGenre] = useState<string | null>(GENRE_PRESETS[0].label);

  // Basic
  const [showSettings, setShowSettings] = useState(false);
  const [inferStep, setInferStep] = useState(60);
  const [guidanceScale, setGuidanceScale] = useState(15);
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

  const startTimer = () => { setElapsed(0); timerRef.current = setInterval(() => setElapsed(p => p + 1), 1000); };
  const stopTimer = () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };

  const handleGenerate = async () => {
    if (!isAuthenticated || !user) { setStatus({ type: 'error', message: 'Please sign in to generate music.' }); return; }
    if (needsAudioFile && !audioFile) { setStatus({ type: 'error', message: 'Please select a source audio file.' }); return; }
    if (!prompt.trim()) { setStatus({ type: 'error', message: 'Please enter a prompt.' }); return; }

    setStatus(null); setResultAudioUrl(null); setLoading(true); startTimer();
    const token = localStorage.getItem('vocence_token');

    try {
      let res: StudioMusicGenerateResponse;
      if (activeTask === 'text2music') {
        res = await dashboardApi.generateStudioMusicText2Music({
          user_id: user.id, prompt, lyrics, audio_duration: duration, format,
          infer_step: inferStep, guidance_scale: guidanceScale, scheduler_type: schedulerType,
          cfg_type: cfgType, omega_scale: omegaScale, manual_seeds: manualSeeds,
          guidance_interval: guidanceInterval, guidance_interval_decay: guidanceIntervalDecay,
          min_guidance_scale: minGuidanceScale, use_erg_tag: useErgTag, use_erg_lyric: useErgLyric,
          use_erg_diffusion: useErgDiffusion, oss_steps: ossSteps,
          guidance_scale_text: guidanceScaleText, guidance_scale_lyric: guidanceScaleLyric,
          lora_name_or_path: loraPath,
        }, token);
      } else {
        const fd = new FormData();
        fd.append('user_id', user.id); fd.append('prompt', prompt); fd.append('lyrics', lyrics);
        fd.append('format', format); fd.append('infer_step', String(inferStep)); fd.append('guidance_scale', String(guidanceScale));
        if (activeTask === 'audio2audio') { fd.append('ref_audio', audioFile!); fd.append('audio_duration', String(duration)); fd.append('ref_audio_strength', String(refAudioStrength)); }
        else if (activeTask === 'retake') { fd.append('src_audio', audioFile!); fd.append('retake_variance', String(retakeVariance)); fd.append('retake_seeds', retakeSeeds); }
        else if (activeTask === 'repaint') { fd.append('src_audio', audioFile!); fd.append('repaint_start', String(repaintStart)); fd.append('repaint_end', String(repaintEnd)); fd.append('retake_variance', String(retakeVariance)); }
        else if (activeTask === 'edit') { fd.append('src_audio', audioFile!); fd.append('edit_target_prompt', editTargetPrompt); fd.append('edit_target_lyrics', editTargetLyrics); fd.append('edit_n_min', String(editNMin)); fd.append('edit_n_max', String(editNMax)); fd.append('retake_seeds', retakeSeeds); }
        else if (activeTask === 'extend') { fd.append('src_audio', audioFile!); fd.append('left_extend_length', String(leftExtend)); fd.append('right_extend_length', String(rightExtend)); fd.append('extend_seeds', extendSeeds); }
        res = await dashboardApi.generateStudioMusicWithAudio(activeTask, fd, token);
      }
      updateCredits(res.credits);
      setResultAudioUrl(res.audio_url);
      setStatus({ type: 'success', message: 'Music generated successfully!' });
      playAudio({ src: res.audio_url, title: prompt.slice(0, 60), subtitle: `Music · ${activeTask}` });
    } catch (e: unknown) {
      setStatus({ type: 'error', message: e instanceof Error ? e.message : 'Something went wrong.' });
    } finally { setLoading(false); stopTimer(); }
  };

  const activeTabInfo = TASK_TABS.find(t => t.id === activeTask)!;
  const inputCls = 'w-full bg-[#1c1d21] border border-[#2e2f33] rounded-xl px-4 py-2.5 text-sm text-white placeholder-[#9ca3af] outline-none focus:border-[#DFFF00]/50 transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none';
  const labelCls = 'text-[11px] text-[#9ca3af] uppercase tracking-wider font-medium';

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold mb-1">Text-to-Music</h2>
        <p className="text-sm text-[#9ca3af]">Generate original music with AI — describe a style, add lyrics, and create.</p>
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
                    onClick={() => { setPrompt(g.value); setSelectedGenre(g.label); }}
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

          {/* Prompt */}
          <div>
            <label className={labelCls}>Prompt / Tags</label>
            <input
              type="text"
              className={`${inputCls} mt-1.5`}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setSelectedGenre(null); }}
              placeholder="genre, instruments, tempo, mood, vocal style..."
            />
          </div>

          {/* Lyrics */}
          <div>
            <div className="flex items-center justify-between">
              <label className={labelCls}>Lyrics</label>
              <span className="text-[10px] text-[#666]">[verse] [chorus] [bridge] [instrumental]</span>
            </div>
            <textarea
              rows={16}
              className={`${inputCls} mt-1.5 resize-y font-mono text-[13px] leading-relaxed`}
              value={lyrics}
              onChange={(e) => setLyrics(e.target.value)}
              placeholder={"[verse]\nYour lyrics here...\n\n[chorus]\nThe hook goes here..."}
            />
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
              <Field label="Duration (sec)">
                <input type="number" className={inputCls} value={duration} onChange={(e) => setDuration(Number(e.target.value))} min={-1} max={240} />
              </Field>
              <Field label="Format">
                <CustomSelect value={format} onChange={setFormat}
                  options={[{ value: 'wav', label: 'WAV' }, { value: 'mp3', label: 'MP3' }, { value: 'ogg', label: 'OGG' }, { value: 'flac', label: 'FLAC' }]} />
              </Field>
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
                <Field label="Infer Steps"><input type="number" className={inputCls} value={inferStep} onChange={(e) => setInferStep(Number(e.target.value))} min={1} max={200} /></Field>
                <Field label="Guidance Scale"><input type="number" className={inputCls} value={guidanceScale} onChange={(e) => setGuidanceScale(Number(e.target.value))} step={0.1} /></Field>
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

          {/* Generate button */}
          <button
            onClick={handleGenerate}
            disabled={loading}
            className="w-full py-3 rounded-xl font-semibold text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed bg-white text-[#07080A] hover:bg-white/90 active:scale-[0.98]"
          >
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Generating... <span className="tabular-nums">{elapsed}s</span></span>
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
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-white font-medium">{prompt.slice(0, 80)}{prompt.length > 80 ? '...' : ''}</p>
              <p className="text-xs text-[#9ca3af] mt-0.5 flex items-center gap-1"><Clock size={11} /> Generated in {elapsed}s</p>
            </div>
            <button
              onClick={async () => {
                const url = resultAudioUrl!;
                try {
                  const resp = await fetch(url);
                  if (!resp.ok) throw new Error('fetch failed');
                  const blob = await resp.blob();
                  const blobUrl = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = blobUrl;
                  a.download = `vocence-${Date.now()}.${format}`;
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#2e2f33] text-xs text-[#9ca3af] hover:text-white hover:bg-[#3a3b3f] transition-colors"
            >
              <Download size={13} />
              Download
            </button>
          </div>
        </div>
      )}

      {/* Sample music */}
      <SampleMusicSection />
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
