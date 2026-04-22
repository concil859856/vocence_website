import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Mic,
  Upload,
  Play,
  Pause,
  Download,
  Volume2,
  X,
  Send,
  Square,
  Search,
  Copy,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  LayoutGrid,
  Trash2,
} from 'lucide-react';
import gsap from 'gsap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AuthModal } from '../components/AuthModal';
import { VoiceDesignWavePlayer } from '../components/VoiceDesignWavePlayer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MyVoiceCardArt } from '../components/MyVoiceCardArt';
import { StudioShell } from '../components/StudioShell';
import { STUDIO_VIEWS, type StudioView } from '../studio/studioNav';
import { DEFAULT_ABSTRACT_CARD_IMAGES } from '../data/abstractCardImages';
import { asset } from '../data/assets';
import {
  CREDIT_STT,
  CREDIT_TTS,
  CREDIT_VOICE_CLONE,
  CREDIT_VOICE_DESIGN_PREVIEW,
} from '../studio/creditCosts';
import { blobToCloneReferenceWav } from '../utils/cloneReferenceAudio';
import {
  dashboardApi,
  type StudioDesignedVoiceItem,
  type StudioTopModel,
  type StudioHistoryItem,
  type StudioVoiceDesignConfig,
  type StudioVoiceDesignPreviewResponse,
} from '../services/dashboardApi';
import { StudioMusic } from './StudioMusic';
import { StudioHome } from './StudioHome';
import { StudioPlaybooks } from './StudioPlaybooks';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { api } from '../services/api';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { cn } from '@/lib/utils';

const USER_FACING_TRY_AGAIN = 'Something went wrong. Please try again later.';

// Temporary flag: while launching, only Text-to-Speech is enabled in Studio.
// Flip back to `true` to re-enable the other Studio views.
const ENABLE_NON_TTS_STUDIO_VIEWS = false;

const STUDIO_VIEW_LABELS: Record<StudioView, string> = {
  home: 'Studio Home',
  tts: 'Text-to-Speech',
  stt: 'Speech-to-Text',
  chat: 'Voice Chat',
  cloning: 'Voice Cloning',
  'voice-design': 'Voice Design',
  'my-voices': 'My Voices',
  music: 'Text-to-Music',
  playbooks: 'Playbooks',
  history: 'History',
};

function ComingSoonView({ view }: { view: StudioView }) {
  const label = STUDIO_VIEW_LABELS[view] ?? 'This feature';
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="card-vocence max-w-md w-full p-10 text-center">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[#DFFF00]/30 bg-[#DFFF00]/10 text-[#DFFF00] text-xs font-medium tracking-wide mb-5">
          Coming soon
        </div>
        <h2 className="text-2xl font-semibold mb-3">{label}</h2>
        <p className="text-sm text-[#A7B0B7]">
          We're putting the finishing touches on this feature. In the meantime,
          try out Text-to-Speech — it's live now.
        </p>
        <Link to="/studio/tts" className="btn-primary inline-flex mt-6">
          Go to Text-to-Speech
        </Link>
      </div>
    </div>
  );
}

function userFacingApiError(_e: unknown): string {
  return USER_FACING_TRY_AGAIN;
}

interface HistoryItem {
  id: string;
  type: 'tts' | 'stt' | 'chat' | 'cloning';
  timestamp: string;
  date: string;
  content: string;
  stylePrompt?: string;
  model: string;
  meta: string;
  duration: string;
}

const TTS_STYLE_PRESETS = [
  {
    id: 'neutral-male',
    label: 'Neutral Male',
    description:
      'neutral male voice, calm, clear, natural tone, moderate speed, friendly, professional, casual conversation style, versatile for narration or dialogue',
  },
  {
    id: 'neutral-female',
    label: 'Neutral Female',
    description:
      'neutral female voice, calm, clear, natural tone, moderate speed, friendly, professional, casual conversation style, versatile for narration or dialogue',
  },
  {
    id: 'urgent-support',
    label: 'Urgent Support / Emergency Tone',
    description:
      'clear, serious, urgent, professional, calm yet firm, informative, directing users quickly, empathetic, concise delivery',
  },
  {
    id: 'friendly-ai-assistant',
    label: 'Friendly AI Assistant',
    description:
      'calm, clear, neutral male/female voice, slightly robotic, polite, precise, professional, informative, friendly, digital assistant tone',
  },
  {
    id: 'epic-warrior',
    label: 'Epic Warrior',
    description:
      'intense cinematic warrior voice, deep male, loud, aggressive, heroic, shouting, high energy, fearless, battlefield atmosphere, dramatic, powerful delivery',
  },
  {
    id: 'dark-villain',
    label: 'Dark Villain',
    description:
      'dark villain voice, deep, cold, menacing, slow, evil tone, dramatic, cinematic, confident, threatening, powerful, echoing, fantasy antagonist style',
  },
  {
    id: 'anime-hero',
    label: 'Anime Hero',
    description:
      'anime hero voice, energetic, emotional, youthful male, shouting, determined, heroic, high energy, dramatic, action scene, fighting spirit, intense delivery',
  },
  {
    id: 'military-commander',
    label: 'Military Commander',
    description:
      'military commander voice, strong male, confident, loud, clear, authoritative, battlefield radio tone, commanding, serious, high intensity, tactical atmosphere',
  },
  {
    id: 'narrator-trailer',
    label: 'Narrator / Trailer Voice',
    description:
      'cinematic narrator voice, deep, calm, dramatic, movie trailer tone, slow, powerful, emotional, storytelling, epic atmosphere, clear and professional',
  },
  {
    id: 'cyberpunk-ai',
    label: 'Cyberpunk / AI Voice',
    description:
      'futuristic AI voice, robotic, calm, synthetic, digital tone, sci-fi atmosphere, precise, emotionless, clean, cyberpunk style, controlled delivery',
  },
  {
    id: 'orc-monster',
    label: 'Orc / Monster / Brutal',
    description:
      'brutal monster voice, rough, growling, aggressive, loud, deep, savage, angry, battle roar, fantasy creature, intense, wild, powerful shouting',
  },
  {
    id: 'viking-barbarian',
    label: 'Viking / Barbarian',
    description:
      'viking warrior voice, strong, rough, loud, heroic, shouting, fearless, nordic battle tone, aggressive, epic, dramatic, war cry, powerful energy',
  },
  {
    id: 'little-girl',
    label: 'Little Girl',
    description:
      'cute little girl voice, high-pitched, innocent, cheerful, playful, soft, energetic, happy, emotional, expressive, youthful, friendly, lighthearted delivery',
  },
];
const PRIORITY_PRESET_COUNT = 6;

/** TTS main content: character cap (shown to user only if they try to exceed it). */
const TTS_CONTENT_MAX_CHARS = 500;

// Top 3 models from main validator; loaded in TTS view

export function Studio() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isAuthenticated, updateCredits } = useAuth();
  const routeParams = useParams<{ view?: string; playbookId?: string }>();
  const routeViewRaw = routeParams.playbookId ? 'playbooks' : (routeParams.view || 'home').toLowerCase();
  const activeView: StudioView = STUDIO_VIEWS.includes(routeViewRaw as StudioView)
    ? (routeViewRaw as StudioView)
    : 'home';
  const [topModels, setTopModels] = useState<StudioTopModel[]>([]);
  const [topModelsLoading, setTopModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<StudioTopModel | null>(null);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [studioHistory, setStudioHistory] = useState<StudioHistoryItem[]>([]);
  const [studioHistoryLoading, setStudioHistoryLoading] = useState(false);
  const [studioHistorySearch, setStudioHistorySearch] = useState('');
  const [studioHistoryCategory, setStudioHistoryCategory] = useState<
    'all' | 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'
  >('all');
  const [studioHistoryPage, setStudioHistoryPage] = useState(1);
  const [resultOverlay, setResultOverlay] = useState<{
    id: number;
    audioUrl: string;
    promptText: string;
    styleInstruction: string;
    modelName: string;
  } | null>(null);
  const [chatMessages, setChatMessages] = useState([
    { role: 'ai', content: "Hello! I'm your Vocence voice assistant. How can I help you today?" },
    { role: 'user', content: 'Tell me about the Bittensor network rewards for this subnet.' },
    {
      role: 'ai',
      content:
        'Subnet 28 rewards miners based on the quality of their TTS outputs, measured by Mean Opinion Score (MOS) and prompt adherence. Top miners currently earn approx 12-15 TAO daily.',
    },
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatCreditsToday, setChatCreditsToday] = useState<number>(0);
  const [chatCreditsLoading, setChatCreditsLoading] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [ttsText, setTtsText] = useState('');
  const [ttsContentLimitNotice, setTtsContentLimitNotice] = useState(false);
  const [ttsStylePrompt, setTtsStylePrompt] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('auto-detect');
  const [sttFile, setSttFile] = useState<File | null>(null);
  const [isSttDragActive, setIsSttDragActive] = useState(false);
  const [sttResult, setSttResult] = useState<{ text: string; language?: string | null; fileName?: string } | null>(null);
  const [sttStatus, setSttStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [sttCopied, setSttCopied] = useState(false);
  const [cloningFile, setCloningFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [cloningMode, setCloningMode] = useState<'upload' | 'record'>('upload');
  const [cloneTargetText, setCloneTargetText] = useState('');
  const [cloneLanguage, setCloneLanguage] = useState('');
  const [cloneLoading, setCloneLoading] = useState(false);
  const [cloneStatus, setCloneStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [cloneResult, setCloneResult] = useState<{
    id: number;
    audioUrl: string;
    referenceText: string;
    language?: string | null;
  } | null>(null);
  const [isCloneDragActive, setIsCloneDragActive] = useState(false);
  /** Blob URL for `<audio>` preview of upload or recorded reference. */
  const [cloneReferencePreviewUrl, setCloneReferencePreviewUrl] = useState<string | null>(null);
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [vdConfig, setVdConfig] = useState<StudioVoiceDesignConfig | null>(null);
  const [vdDescription, setVdDescription] = useState('');
  const [vdLoading, setVdLoading] = useState(false);
  const [vdPreview, setVdPreview] = useState<StudioVoiceDesignPreviewResponse | null>(null);
  const [vdChosen, setVdChosen] = useState<'original' | 'revised'>('revised');
  const [vdDisplayName, setVdDisplayName] = useState('');
  const [vdSaveLoading, setVdSaveLoading] = useState(false);
  const [vdStatus, setVdStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [vdSavedVoiceId, setVdSavedVoiceId] = useState<number | null>(null);
  const [designedVoices, setDesignedVoices] = useState<StudioDesignedVoiceItem[]>([]);
  const [designedVoicesLoading, setDesignedVoicesLoading] = useState(false);
  const [deleteConfirmVoiceId, setDeleteConfirmVoiceId] = useState<number | null>(null);
  const [deleteVoiceLoading, setDeleteVoiceLoading] = useState(false);
  const [myVoicesNotice, setMyVoicesNotice] = useState<{ type: 'error' | 'success'; message: string } | null>(null);
  const [vdSaveNameInvalid, setVdSaveNameInvalid] = useState(false);
  const [abstractImagePool, setAbstractImagePool] = useState<string[]>(DEFAULT_ABSTRACT_CARD_IMAGES);
  const highlightedVoiceRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cloneStreamRef = useRef<MediaStream | null>(null);
  const [getVoiceDescription, setGetVoiceDescription] = useState(false);
  const studioRef = useRef<HTMLDivElement>(null);
  const sttFileInputRef = useRef<HTMLInputElement>(null);
  const cloningFileInputRef = useRef<HTMLInputElement>(null);
  const cloneAudioRef = useRef<HTMLAudioElement>(null);
  const overlayAudioRef = useRef<HTMLAudioElement>(null);
  const [overlayPlaying, setOverlayPlaying] = useState(false);
  const [overlayCurrentTime, setOverlayCurrentTime] = useState(0);
  const [overlayDuration, setOverlayDuration] = useState(0);

  useEffect(() => {
    gsap.fromTo(
      '.studio-sidebar',
      { opacity: 0, x: -20 },
      { opacity: 1, x: 0, duration: 0.5 }
    );
    gsap.fromTo(
      '.studio-content',
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, delay: 0.2 }
    );
  }, []);

  useEffect(() => {
    if (resultOverlay) {
      setOverlayCurrentTime(0);
      setOverlayDuration(0);
    }
  }, [resultOverlay?.id]);

  useEffect(() => {
    if (activeView === 'history' && user) {
      setStudioHistoryLoading(true);
      dashboardApi
        .getStudioHistory(user.id)
        .then((res) => setStudioHistory(res.items))
        .catch(() => setStudioHistory([]))
        .finally(() => setStudioHistoryLoading(false));
    }
  }, [activeView, user]);

  useEffect(() => {
    if (activeView !== 'tts') setTtsContentLimitNotice(false);
  }, [activeView]);

  const STUDIO_HISTORY_PAGE_SIZE = 10;

  const studioHistoryFiltered = useMemo(() => {
    return studioHistory.filter((h) => {
      if (studioHistoryCategory !== 'all' && h.entry_type !== studioHistoryCategory) {
        return false;
      }
      if (!studioHistorySearch.trim()) return true;
      const q = studioHistorySearch.toLowerCase();
      return (
        (h.prompt_text || '').toLowerCase().includes(q) ||
        (h.style_instruction || '').toLowerCase().includes(q) ||
        (h.transcribed_text || '').toLowerCase().includes(q) ||
        (h.source_audio_filename || '').toLowerCase().includes(q) ||
        (h.reference_text || '').toLowerCase().includes(q) ||
        (h.target_text || '').toLowerCase().includes(q) ||
        (h.clone_source || '').toLowerCase().includes(q) ||
        (h.display_name || '').toLowerCase().includes(q) ||
        (h.model_name || '').toLowerCase().includes(q)
      );
    });
  }, [studioHistory, studioHistorySearch, studioHistoryCategory]);

  useEffect(() => {
    setStudioHistoryPage(1);
  }, [studioHistorySearch, studioHistoryCategory]);

  const studioHistoryTotalPages = Math.max(
    1,
    Math.ceil(studioHistoryFiltered.length / STUDIO_HISTORY_PAGE_SIZE)
  );
  const studioHistoryEffectivePage = Math.min(studioHistoryPage, studioHistoryTotalPages);

  const studioHistoryPageItems = useMemo(() => {
    return studioHistoryFiltered.slice(
      (studioHistoryEffectivePage - 1) * STUDIO_HISTORY_PAGE_SIZE,
      studioHistoryEffectivePage * STUDIO_HISTORY_PAGE_SIZE
    );
  }, [studioHistoryFiltered, studioHistoryEffectivePage]);

  useEffect(() => {
    if (DEFAULT_ABSTRACT_CARD_IMAGES.length > 0) {
      setAbstractImagePool(DEFAULT_ABSTRACT_CARD_IMAGES);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    DEFAULT_ABSTRACT_CARD_IMAGES.slice(0, 6).forEach((path) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = path;
    });
  }, []);

  useEffect(() => {
    if (activeView !== 'chat' || !user) return;
    const token = localStorage.getItem('vocence_token');
    if (!token) return;
    setChatCreditsLoading(true);
    api
      .getDailyCreditsUsage(token, 1)
      .then((res) => {
        const dayRow = res.days?.[0];
        setChatCreditsToday(dayRow?.creditsUsed ?? 0);
      })
      .catch(() => setChatCreditsToday(0))
      .finally(() => setChatCreditsLoading(false));
  }, [activeView, user]);

  // Preload only above-the-fold style preset images to speed first paint.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    TTS_STYLE_PRESETS.slice(0, PRIORITY_PRESET_COUNT).forEach((preset) => {
      const img = new Image();
      img.src = asset(`tts-style.${preset.id}`);
      img.decoding = 'async';
    });
  }, []);

  useEffect(() => {
    if (activeView !== 'tts' && activeView !== 'voice-design') return;
    setTopModelsLoading(true);
    dashboardApi
      .getStudioTopModels(3)
      .then((res) => {
        setTopModels(res.models);
        setSelectedModel((prev) =>
          res.models.length > 0
            ? res.models.find((m) => m.miner_hotkey === prev?.miner_hotkey) ?? res.models[0]
            : null
        );
      })
      .catch(() => setTopModels([]))
      .finally(() => setTopModelsLoading(false));
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'voice-design') return;
    dashboardApi
      .getStudioVoiceDesignConfig()
      .then(setVdConfig)
      .catch(() => setVdConfig(null));
  }, [activeView]);

  useEffect(() => {
    if (activeView !== 'my-voices' || !user) return;
    const token = localStorage.getItem('vocence_token');
    setDesignedVoicesLoading(true);
    dashboardApi
      .listStudioDesignedVoices(token)
      .then((r) => setDesignedVoices(r.voices))
      .catch(() => setDesignedVoices([]))
      .finally(() => setDesignedVoicesLoading(false));
  }, [activeView, user]);

  useEffect(() => {
    if (activeView !== 'my-voices') return;
    const raw = searchParams.get('voice');
    if (!raw) return;
    const id = parseInt(raw, 10);
    if (!Number.isFinite(id)) return;
    window.setTimeout(() => {
      highlightedVoiceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 400);
  }, [activeView, searchParams]);

  const requireAuth = (callback: () => void) => {
    if (!isAuthenticated) {
      setIsAuthModalOpen(true);
      return;
    }
    callback();
  };

  useEffect(() => {
    if (cloningMode === 'upload') {
      cloneStreamRef.current?.getTracks().forEach((t) => t.stop());
      cloneStreamRef.current = null;
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  }, [cloningMode]);

  useEffect(() => {
    if (!cloningFile) {
      setCloneReferencePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(cloningFile);
    setCloneReferencePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [cloningFile]);

  useEffect(() => {
    return () => {
      cloneStreamRef.current?.getTracks().forEach((t) => t.stop());
      cloneStreamRef.current = null;
    };
  }, []);

  const startCloneRecording = async () => {
    setCloneStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      cloneStreamRef.current = stream;
      const chunks: BlobPart[] = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        cloneStreamRef.current = null;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        void (async () => {
          try {
            const wavFile = await blobToCloneReferenceWav(blob, 'reference.wav');
            setCloningFile(wavFile);
          } catch {
            const ext = blob.type.includes('webm') ? 'webm' : 'dat';
            setCloningFile(new File([blob], `reference.${ext}`, { type: blob.type || 'application/octet-stream' }));
            setCloneStatus({
              type: 'error',
              message:
                'Could not convert this recording to WAV. Try again, upload a .wav file, or use another browser.',
            });
          } finally {
            setIsRecording(false);
            mediaRecorderRef.current = null;
          }
        })();
      };
      mr.start();
      setIsRecording(true);
    } catch {
      setCloneStatus({ type: 'error', message: 'Microphone access denied or unavailable.' });
      setIsRecording(false);
    }
  };

  const stopCloneRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const handleCloneGenerate = () => {
    requireAuth(async () => {
      if (!user) return;
      if (user.credits < CREDIT_VOICE_CLONE) {
        setCloneStatus({
          type: 'error',
          message: `Insufficient credits. Voice cloning requires ${CREDIT_VOICE_CLONE} credits.`,
        });
        return;
      }
      if (!cloningFile) {
        setCloneStatus({ type: 'error', message: 'Add reference audio via upload or recording.' });
        return;
      }
      const target = cloneTargetText.trim();
      if (!target) {
        setCloneStatus({ type: 'error', message: 'Enter the text you want the cloned voice to speak.' });
        return;
      }
      const token = localStorage.getItem('vocence_token');
      setCloneLoading(true);
      setCloneStatus(null);
      setCloneResult(null);
      try {
        const res = await dashboardApi.generateStudioClone(
          {
            user_id: user.id,
            target_text: target,
            ref_source: cloningMode,
            language: cloneLanguage.trim() || null,
            audio_file: cloningFile,
          },
          token
        );
        updateCredits(res.credits);
        setCloneResult({
          id: res.id,
          audioUrl: res.audio_url,
          referenceText: res.reference_text,
          language: res.detected_language,
        });
        setCloneStatus({ type: 'success', message: 'Cloned audio is ready. Play or download below.' });
      } catch (e) {
        setCloneStatus({ type: 'error', message: userFacingApiError(e) });
      } finally {
        setCloneLoading(false);
      }
    });
  };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const handleOverlayPlayPause = () => {
    const el = overlayAudioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setOverlayPlaying(true);
    } else {
      el.pause();
      setOverlayPlaying(false);
    }
  };

  const handleOverlaySeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = overlayAudioRef.current;
    if (!el) return;
    const v = parseFloat(e.target.value);
    el.currentTime = v;
    setOverlayCurrentTime(v);
  };

  const handleOverlayVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    if (overlayAudioRef.current) overlayAudioRef.current.volume = v;
  };

  const triggerBrowserDownload = async (url: string | null, filename: string) => {
    if (!url?.trim()) return;
    try {
      // Align download behavior with AudioPlayerBar: fetch as blob, then force a download
      const res = await fetch(url, { mode: 'cors' });
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch {
      // Fallback: open in new tab if fetch or download fails
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleOverlayDownload = () => {
    if (!resultOverlay?.audioUrl) return;
    void triggerBrowserDownload(resultOverlay.audioUrl, `vocence-tts-${resultOverlay.id}.wav`);
  };

  const saveToHistory = (item: Omit<HistoryItem, 'id' | 'timestamp' | 'date'>) => {
    if (!user) return;
    
    const historyItem: HistoryItem = {
      ...item,
      id: Date.now().toString(),
      timestamp: new Date().toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
      }),
      date: new Date().toLocaleDateString(),
    };

    const existingHistory = JSON.parse(
      localStorage.getItem(`vocence_history_${user.id}`) || '[]'
    );
    existingHistory.unshift(historyItem);
    localStorage.setItem(
      `vocence_history_${user.id}`,
      JSON.stringify(existingHistory.slice(0, 100)) // Keep last 100 items
    );
  };

  const handleTtsContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    if (v.length <= TTS_CONTENT_MAX_CHARS) {
      setTtsText(v);
      setTtsContentLimitNotice(false);
    } else {
      setTtsText(v.slice(0, TTS_CONTENT_MAX_CHARS));
      setTtsContentLimitNotice(true);
    }
  }, []);

  const handleGenerateAudio = () => {
    requireAuth(() => {
      if (!ttsText.trim()) {
        alert('Please enter text to generate audio');
        return;
      }
      if (ttsText.length > TTS_CONTENT_MAX_CHARS) {
        setTtsContentLimitNotice(true);
        return;
      }
      if (!selectedModel || !user) {
        alert('Please select a model');
        return;
      }
      if (user.credits < CREDIT_TTS) {
        alert(
          `Insufficient credits. TTS generation costs ${CREDIT_TTS} credits. Please add more credits.`,
        );
        return;
      }

      const token = localStorage.getItem('vocence_token');
      setGenerateLoading(true);
      dashboardApi
        .generateStudioTts(
          {
            user_id: user.id,
            miner_hotkey: selectedModel.miner_hotkey,
            model_name: selectedModel.model_name,
            chute_id: selectedModel.chute_id,
            chute_slug: selectedModel.chute_slug,
            text: ttsText.trim(),
            style_instruction: ttsStylePrompt.trim() || undefined,
          },
          token
        )
        .then((res) => {
          setResultOverlay({
            id: res.id,
            audioUrl: res.audio_url,
            promptText: ttsText.trim(),
            styleInstruction: (ttsStylePrompt.trim() || 'neutral voice'),
            modelName: selectedModel.display_name,
          });
          setStudioHistory((prev) => [
            {
              id: res.id,
              entry_type: 'tts',
              miner_hotkey: selectedModel.miner_hotkey,
              model_name: selectedModel.model_name,
              display_name: selectedModel.display_name,
              prompt_text: ttsText.trim(),
              style_instruction: ttsStylePrompt.trim() || 'neutral voice',
              audio_url: res.audio_url,
              expires_at: res.expires_at,
              created_at: new Date().toISOString(),
              expired: false,
            },
            ...prev,
          ]);
          if (res.credits != null) updateCredits(res.credits);
        })
        .catch((err) => {
          alert(err?.message || 'Generation failed. The miner may be offline.');
        })
        .finally(() => setGenerateLoading(false));
    });
  };

  const handleStartTranscription = () => {
    requireAuth(() => {
      if (!user) return;
      if (!sttFile) {
        alert('Please upload an audio file first.');
        return;
      }
      if (user && user.credits < CREDIT_STT) {
        alert(`Insufficient credits. Speech-to-Text requires ${CREDIT_STT} credits.`);
        return;
      }
      setSttStatus(null);
      const token = localStorage.getItem('vocence_token');
      setGenerateLoading(true);
      dashboardApi
        .generateStudioStt(
          {
            user_id: user.id,
            language: selectedLanguage === 'auto-detect' ? null : selectedLanguage,
            audio_file: sttFile,
          },
          token
        )
        .then((res) => {
          setSttResult({
            text: res.text || '',
            language: res.language ?? selectedLanguage,
            fileName: sttFile.name,
          });
          setSttStatus({
            type: 'success',
            message: 'Transcription completed successfully.',
          });
          const createdAt = new Date().toISOString();
          setStudioHistory((prev) => [
            {
              id: res.id,
              entry_type: 'stt',
              miner_hotkey: '',
              model_name: 'Speech-to-Text',
              display_name: 'Speech-to-Text',
              prompt_text: null,
              style_instruction: '',
              audio_url: null,
              expires_at: '',
              created_at: createdAt,
              expired: false,
              transcribed_text: res.text,
              source_audio_filename: sttFile.name,
              source_language: res.language ?? null,
              duration_seconds: res.duration_seconds ?? null,
            },
            ...prev,
          ]);
          if (res.credits != null) updateCredits(res.credits);
        })
        .catch((err) => {
          setSttStatus({
            type: 'error',
            message: userFacingApiError(err),
          });
        })
        .finally(() => setGenerateLoading(false));
    });
  };

  const handleSttDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsSttDragActive(true);
  };

  const handleSttDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsSttDragActive(false);
  };

  const handleSttDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsSttDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setSttFile(file);
      setSttStatus(null);
    }
  };

  const handleSendMessage = () => {
    if (!chatInput.trim()) return;
    
    requireAuth(() => {
      if (user && user.credits < 0.5) {
        alert('Insufficient credits. Voice Chat requires 0.5 credits per message.');
        return;
      }

      setChatMessages([...chatMessages, { role: 'user', content: chatInput }]);
      const messageContent = chatInput;
      setChatInput('');
      
      setTimeout(() => {
        setChatMessages((prev) => [
          ...prev,
          {
            role: 'ai',
            content:
              'I understand. The network uses a dual-axis evaluation system focusing on content correctness, audio quality, and prompt adherence.',
          },
        ]);
      }, 1000);

      // Save to history
      saveToHistory({
        type: 'chat',
        content: messageContent,
        model: 'Voice Chat',
        meta: 'Real-time',
        duration: '0:00',
      });

      // Deduct credits
      if (user) {
        updateCredits(user.credits - 0.5);
      }
    });
  };

  const vdPreviewCredits = vdConfig?.preview_credits ?? CREDIT_VOICE_DESIGN_PREVIEW;

  const handleVoiceDesignPreview = () => {
    requireAuth(async () => {
      if (!user) return;
      if (!vdConfig?.llm_configured) {
        setVdStatus({
          type: 'info',
          message: 'Voice Design is not available right now. Please try again later or contact support.',
        });
        return;
      }
      if (!selectedModel) {
        setVdStatus({
          type: 'error',
          message: 'No synthesis model is available. Check studio configuration or try again in a moment.',
        });
        return;
      }
      const desc = vdDescription.trim();
      if (desc.length < 4) {
        setVdStatus({ type: 'error', message: 'Add a slightly longer voice description (a short paragraph is ideal).' });
        return;
      }
      if (user.credits < vdPreviewCredits) {
        setVdStatus({
          type: 'error',
          message: `You need ${vdPreviewCredits} credits for voice design (preview / creation). You have ${user.credits}.`,
        });
        return;
      }
      const token = localStorage.getItem('vocence_token');
      setVdLoading(true);
      setVdStatus(null);
      setVdSavedVoiceId(null);
      try {
        const res = await dashboardApi.studioVoiceDesignPreview(
          {
            user_id: user.id,
            voice_description: desc,
            miner_hotkey: selectedModel.miner_hotkey,
            model_name: selectedModel.model_name,
            chute_id: selectedModel.chute_id,
            chute_slug: selectedModel.chute_slug,
          },
          token
        );
        updateCredits(res.credits);
        setVdPreview(res);
        setVdChosen('revised');
        setVdDisplayName('');
        setVdSaveNameInvalid(false);
        setVdStatus({
          type: 'success',
          message: 'Listen to both samples and pick the one that fits.',
        });
      } catch (e) {
        setVdStatus({ type: 'error', message: userFacingApiError(e) });
      } finally {
        setVdLoading(false);
      }
    });
  };

  const handleVoiceDesignSave = () => {
    requireAuth(async () => {
      if (!user || !vdPreview) return;
      const name = vdDisplayName.trim();
      if (!name) {
        setVdSaveNameInvalid(true);
        setVdStatus({ type: 'error', message: 'Please enter a name to save this voice.' });
        return;
      }
      setVdSaveNameInvalid(false);
      const token = localStorage.getItem('vocence_token');
      setVdSaveLoading(true);
      try {
        const res = await dashboardApi.studioVoiceDesignSave(
          {
            user_id: user.id,
            preview_token: vdPreview.preview_token,
            chosen_variant: vdChosen,
            display_name: name,
          },
          token
        );
        updateCredits(res.credits);
        setVdSavedVoiceId(res.voice_id);
        setVdPreview(null);
        setVdDescription('');
        setVdStatus({
          type: 'success',
          message: `Voice saved as “${name}”.`,
        });
      } catch (e) {
        setVdStatus({ type: 'error', message: userFacingApiError(e) });
      } finally {
        setVdSaveLoading(false);
      }
    });
  };

  const executeDeleteDesignedVoice = useCallback(async () => {
    const voiceId = deleteConfirmVoiceId;
    if (voiceId == null || !user) return;
    const token = localStorage.getItem('vocence_token');
    setDeleteVoiceLoading(true);
    setMyVoicesNotice(null);
    try {
      await dashboardApi.deleteStudioDesignedVoice(voiceId, token);
      setDesignedVoices((prev) => prev.filter((v) => v.id !== voiceId));
      setDeleteConfirmVoiceId(null);
      setMyVoicesNotice({ type: 'success', message: 'Voice removed.' });
      window.setTimeout(() => setMyVoicesNotice(null), 4000);
    } catch (e) {
      setMyVoicesNotice({ type: 'error', message: userFacingApiError(e) });
    } finally {
      setDeleteVoiceLoading(false);
    }
  }, [deleteConfirmVoiceId, user]);

  const renderVoiceDesignView = () => {
    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">Voice Design</h1>
          <p className="text-[10px] uppercase tracking-[0.16em] text-[#DFFF00]/80">Tips</p>
          <p className="text-sm text-[#9CA3AF] leading-relaxed">
            Describe the character you want - include age, gender, emotion, pacing, speaking speed, use case, and other details in neutral language.
          </p>
        </header>

        {vdConfig !== null && !vdConfig.llm_configured && (
          <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.08] px-4 py-3 text-sm text-amber-100 flex gap-3 items-start">
            <AlertCircle className="shrink-0 mt-0.5" size={18} />
            <div>
              <p className="font-medium text-amber-50">Voice Design is unavailable</p>
              <p className="text-amber-100/80 mt-1 text-xs leading-relaxed">
                This feature is not turned on for this workspace yet. Please try again later or contact support.
              </p>
            </div>
          </div>
        )}

        {vdSavedVoiceId != null && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.08] p-6 space-y-4">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="text-emerald-400 shrink-0" size={22} />
              <div>
                <p className="font-semibold text-white">Voice saved</p>
                <p className="text-sm text-[#A7B0B7] mt-1">Open My voices to generate new lines in this style.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                className="btn-primary"
                onClick={() => navigate(`/studio/my-voices/${vdSavedVoiceId}`)}
              >
                Use this voice now
              </button>
              <button
                type="button"
                className="btn-outline text-sm"
                onClick={() => {
                  setVdSavedVoiceId(null);
                  setVdStatus(null);
                }}
              >
                Design another
              </button>
            </div>
          </div>
        )}

        <div className="space-y-6">
          <div className="space-y-6">
            <div className="card-vocence p-6 space-y-6">
              {topModelsLoading ? (
                <div className="flex items-center gap-2 text-sm text-[#A7B0B7]">
                  <div className="w-4 h-4 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
                  Preparing preview…
                </div>
              ) : null}
              {!topModelsLoading && topModels.length === 0 ? (
                <p className="text-sm text-amber-200/90 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
                  No TTS models are configured for this workspace. Voice Design previews need a synthesis model.
                </p>
              ) : null}

              <div>
                <label className="label-mono mb-3 block">How should this voice sound?</label>
                <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4 focus-within:border-[#DFFF00]/35 transition-colors">
                  <textarea
                    rows={5}
                    disabled={!!vdPreview && !vdSavedVoiceId}
                    placeholder="Example: Deep male dragon warrior, commanding and confident, measured pace, gravelly timbre, epic fantasy game narrator…"
                    value={vdDescription}
                    onChange={(e) => setVdDescription(e.target.value)}
                    className="w-full bg-transparent text-white placeholder-[#5c6370] resize-none outline-none text-[15px] leading-relaxed disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                {vdPreview && !vdSavedVoiceId ? (
                  <button
                    type="button"
                    className="text-sm text-[#DFFF00] hover:underline"
                    onClick={() => {
                      setVdPreview(null);
                      setVdStatus(null);
                    }}
                  >
                    Clear previews & edit description
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  onClick={() => void handleVoiceDesignPreview()}
                  disabled={
                    vdLoading ||
                    !vdConfig?.llm_configured ||
                    topModels.length === 0 ||
                    !selectedModel ||
                    !!vdSavedVoiceId
                  }
                  className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {vdLoading ? (
                    <>
                      <div className="w-4 h-4 border-2 border-[#07080A] border-t-transparent rounded-full animate-spin mr-2 inline-block" />
                      Generating previews…
                    </>
                  ) : (
                    <>
                      <Sparkles size={16} className="mr-2 inline" />
                      Generate previews ({vdPreviewCredits} cr)
                    </>
                  )}
                </button>
              </div>
            </div>

            {vdPreview && !vdSavedVoiceId && (
              <div className="space-y-6">
                <div className="max-w-lg rounded-xl border border-[#DFFF00]/25 bg-gradient-to-br from-[#DFFF00]/[0.07] to-transparent px-4 py-3">
                  <p className="text-[10px] uppercase tracking-[0.18em] text-[#DFFF00]/90 mb-1.5">Shared sample line</p>
                  <p className="text-base sm:text-lg text-white font-medium leading-snug font-serif tracking-tight">
                    “{vdPreview.sample_script}”
                  </p>
                </div>

                <div>
                  <h3 className="text-lg font-semibold text-white tracking-tight">Select the voice you prefer</h3>
                  <p className="text-sm text-[#6B7280] mt-1">Listen to both, then choose the one that fits your project.</p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  {(
                    [
                      {
                        key: 'original' as const,
                        title: 'Your description',
                        sub: 'Uses your wording as written',
                        instruction: vdPreview.voice_description,
                        url: vdPreview.audio_a_url,
                      },
                      {
                        key: 'revised' as const,
                        title: 'Refined version',
                        sub: 'Adjusted for clearer results',
                        instruction: vdPreview.revised_instruction,
                        url: vdPreview.audio_b_url,
                      },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={opt.key}
                      className={`relative block cursor-pointer rounded-2xl border p-5 transition-all ${
                        vdChosen === opt.key
                          ? 'border-[#DFFF00] bg-[#DFFF00]/[0.06] ring-1 ring-[#DFFF00]/30'
                          : 'border-white/10 bg-[#0c0d10] hover:border-white/20'
                      }`}
                    >
                      <input
                        type="radio"
                        name="vd-variant"
                        className="sr-only"
                        checked={vdChosen === opt.key}
                        onChange={() => setVdChosen(opt.key)}
                      />
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <div>
                          <p className="font-semibold text-white">{opt.title}</p>
                          <p className="text-xs text-[#6B7280]">{opt.sub}</p>
                        </div>
                        <span
                          className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                            vdChosen === opt.key ? 'bg-[#DFFF00] text-[#07080A]' : 'bg-white/10 text-[#A7B0B7]'
                          }`}
                        >
                          {vdChosen === opt.key ? 'Selected' : 'Option'}
                        </span>
                      </div>
                      <p className="text-sm text-[#A7B0B7] leading-relaxed line-clamp-4 mb-4">{opt.instruction}</p>
                      {opt.url ? (
                        <VoiceDesignWavePlayer src={opt.url} variantKey={opt.key} />
                      ) : (
                        <p className="text-xs text-red-300/90">Audio unavailable.</p>
                      )}
                    </label>
                  ))}
                </div>

                <div className="card-vocence p-6 space-y-4 border border-white/[0.07]">
                  <label className="label-mono block">Save as</label>
                  <input
                    type="text"
                    value={vdDisplayName}
                    maxLength={20}
                    onChange={(e) => {
                      const next = e.target.value.slice(0, 20);
                      setVdDisplayName(next);
                      if (vdSaveNameInvalid) setVdSaveNameInvalid(false);
                    }}
                    placeholder="Enter a name for this voice"
                    autoComplete="off"
                    aria-invalid={vdSaveNameInvalid}
                    aria-required
                    className={`w-full bg-[#0a0a0a] border rounded-xl px-4 py-3 text-white placeholder-[#5c6370] outline-none focus:border-[#DFFF00]/40 ${
                      vdSaveNameInvalid ? 'border-red-400/50 ring-1 ring-red-400/20' : 'border-white/10'
                    }`}
                  />
                  {vdSaveNameInvalid ? (
                    <p className="text-xs text-red-300/90">A name is required to save.</p>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void handleVoiceDesignSave()}
                    disabled={vdSaveLoading}
                    className="btn-primary w-full sm:w-auto disabled:opacity-50"
                  >
                    {vdSaveLoading ? (
                      <>
                        <div className="w-4 h-4 border-2 border-[#07080A] border-t-transparent rounded-full animate-spin mr-2 inline-block" />
                        Saving…
                      </>
                    ) : (
                      'Save chosen voice'
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {vdStatus && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
              vdStatus.type === 'success'
                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
                : vdStatus.type === 'error'
                  ? 'border-red-400/30 bg-red-500/10 text-red-200'
                  : 'border-amber-300/30 bg-amber-400/10 text-amber-100'
            }`}
          >
            {vdStatus.type === 'success' ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" /> : <AlertCircle size={16} className="shrink-0 mt-0.5" />}
            <span>{vdStatus.message}</span>
          </div>
        )}
      </div>
    );
  };

  const renderMyVoicesView = () => {
    const pendingDelete =
      deleteConfirmVoiceId != null ? designedVoices.find((x) => x.id === deleteConfirmVoiceId) : null;
    return (
      <>
        <div className="space-y-8">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <h2 className="text-3xl font-semibold text-white tracking-tight mb-2">My voices</h2>
              <p className="text-[#A7B0B7] leading-relaxed text-balance">
                Voices you saved from Voice Design. Open a card, enter new text, and generate speech in that style.
              </p>
            </div>
            <button
              type="button"
              onClick={() => navigate('/studio/voice-design')}
              className="shrink-0 self-start rounded-xl border border-white/15 bg-white px-5 py-2.5 text-sm font-semibold text-[#07080A] shadow-sm shadow-black/10 transition-colors hover:bg-white/95 active:scale-[0.99] sm:mt-1"
            >
              Create my voice
            </button>
          </div>

          {myVoicesNotice ? (
            <div
              className={`rounded-xl border px-4 py-3 text-sm flex items-start gap-2 ${
                myVoicesNotice.type === 'success'
                  ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
                  : 'border-red-400/30 bg-red-500/10 text-red-200'
              }`}
            >
              {myVoicesNotice.type === 'success' ? (
                <CheckCircle2 size={16} className="shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={16} className="shrink-0 mt-0.5" />
              )}
              <span>{myVoicesNotice.message}</span>
            </div>
          ) : null}

          {!user ? (
            <div className="card-vocence p-10 text-center">
              <p className="text-[#A7B0B7] mb-4">Sign in to see voices you have saved.</p>
              <button type="button" onClick={() => setIsAuthModalOpen(true)} className="btn-primary">
                Sign in
              </button>
            </div>
          ) : designedVoicesLoading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-[#A7B0B7]">
              <div className="w-5 h-5 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
              Loading your voices…
            </div>
          ) : designedVoices.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] p-12 text-center">
              <LayoutGrid className="mx-auto mb-4 text-[#4B5563]" size={40} />
              <p className="text-white font-medium mb-2">No saved voices yet</p>
              <p className="text-sm text-[#6B7280] mb-6 max-w-md mx-auto">
                Save a voice from Voice Design to see it here.
              </p>
              <button type="button" className="btn-primary" onClick={() => navigate('/studio/voice-design')}>
                Go to Voice Design
              </button>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-6">
              {designedVoices.map((v) => {
                const isHighlight = searchParams.get('voice') === String(v.id);
                return (
                  <div
                    key={v.id}
                    ref={isHighlight ? highlightedVoiceRef : undefined}
                    className={`group flex flex-col overflow-hidden rounded-2xl border bg-[#0f131a] transition-all ${
                      isHighlight
                        ? 'border-[#DFFF00]/35 ring-1 ring-[#DFFF00]/20'
                        : 'border-white/[0.1] hover:border-white/20 hover:shadow-lg hover:shadow-black/20'
                    }`}
                  >
                    <div className="relative h-40 w-full shrink-0 overflow-hidden">
                      <MyVoiceCardArt
                        urls={abstractImagePool}
                        seed={v.id}
                        eager
                        className="h-full w-full transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0f131a]/95 via-[#0f131a]/40 to-black/18 pointer-events-none" />
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmVoiceId(v.id)}
                        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/50 text-[#A7B0B7] backdrop-blur-sm transition-colors hover:border-red-400/30 hover:bg-red-500/20 hover:text-red-200"
                        aria-label="Delete voice"
                      >
                        <Trash2 size={16} />
                      </button>
                      <div className="absolute bottom-3 left-4 right-4">
                        <h3 className="font-semibold text-white text-lg leading-tight drop-shadow-md">{v.display_name}</h3>
                        {v.model_name ? (
                          <p className="text-[10px] text-[#A7B0B7]/90 mt-1 truncate">{v.model_name}</p>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex flex-1 flex-col gap-3 border-t border-white/[0.08] p-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#DFFF00]/85 mb-1">
                          Sample
                        </p>
                        <p className="text-sm text-[#C5CAD1] leading-relaxed line-clamp-3">“{v.ref_script}”</p>
                      </div>
                      {v.audio_url && !v.expired ? (
                        <VoiceDesignWavePlayer src={v.audio_url} variantKey={`my-voice-${v.id}`} />
                      ) : (
                        <p className="text-xs text-amber-200/85 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2">
                          Sample audio is no longer available. Create a new voice in Voice Design.
                        </p>
                      )}
                      <button
                        type="button"
                        disabled={v.expired}
                        onClick={() => navigate(`/studio/my-voices/${v.id}`)}
                        className="mt-auto w-full rounded-xl border border-white/15 bg-white py-2.5 text-sm font-semibold text-[#07080A] shadow-sm shadow-black/10 transition-colors hover:bg-white/95 active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none"
                      >
                        Use this voice
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <ConfirmDialog
          open={deleteConfirmVoiceId != null}
          title="Delete saved voice?"
          message={
            pendingDelete
              ? `Remove “${pendingDelete.display_name}”? This cannot be undone.`
              : 'Remove this voice? This cannot be undone.'
          }
          confirmLabel="Delete"
          cancelLabel="Cancel"
          confirmVariant="danger"
          busy={deleteVoiceLoading}
          onConfirm={() => void executeDeleteDesignedVoice()}
          onCancel={() => {
            if (!deleteVoiceLoading) setDeleteConfirmVoiceId(null);
          }}
        />
      </>
    );
  };

  const renderTTSView = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Text-to-Speech</h2>
        <p className="text-[#A7B0B7]">Synthesize natural sounding speech from text using top miners.</p>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-stretch lg:gap-3">
        {/* Main TTS card */}
        <div className="w-full lg:flex-1 lg:min-w-0">
          <div className="card-vocence p-6 space-y-6">
            {/* Model Selection */}
            <div>
              <label className="label-mono mb-3 block">Select Model</label>
              {topModelsLoading ? (
                <div className="flex items-center gap-2 text-[#A7B0B7]">
                  <div className="w-4 h-4 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
                  Loading top models...
                </div>
              ) : topModels.length === 0 ? (
                <p className="text-[#A7B0B7] text-sm">No models available. Ensure validators have run evaluations.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {topModels.map((model) => (
                    <button
                      key={model.miner_hotkey}
                      onClick={() => setSelectedModel(model)}
                      className={`p-3 rounded-xl border text-sm text-center transition-all ${
                        selectedModel?.miner_hotkey === model.miner_hotkey
                          ? 'border-[#DFFF00] bg-[#DFFF00]/5'
                          : 'border-white/10 bg-white/[0.02] hover:border-white/20'
                      }`}
                    >
                      {model.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Content Input */}
            <div>
              <label className="label-mono mb-3 block">Content</label>
              <div
                className={cn(
                  'bg-[#0a0a0a] rounded-xl p-4 border transition-colors',
                  ttsContentLimitNotice
                    ? 'border-amber-500/45 ring-1 ring-amber-500/20'
                    : 'border-white/10'
                )}
              >
                <textarea
                  rows={6}
                  placeholder="Type or paste your text here..."
                  value={ttsText}
                  onChange={handleTtsContentChange}
                  className="w-full bg-transparent text-white placeholder-[#666] resize-none outline-none"
                  aria-invalid={ttsContentLimitNotice}
                  aria-describedby={ttsContentLimitNotice ? 'tts-content-limit-hint' : undefined}
                />
              </div>
              {ttsContentLimitNotice ? (
                <p
                  id="tts-content-limit-hint"
                  className="text-xs text-amber-400/95 mt-2 flex items-start gap-2 leading-relaxed"
                  role="alert"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                  <span>
                    Text-to-Speech content is limited to {TTS_CONTENT_MAX_CHARS} characters. Anything beyond that
                    wasn&apos;t added—shorten your text or split it into multiple generations.
                  </span>
                </p>
              ) : null}
            </div>

            {/* Style Instruction (keeps main layout intact) */}
            <div>
              <label className="label-mono mb-3 block">Style Instruction (Optional)</label>
              <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                <input
                  type="text"
                  placeholder="e.g. neutral voice, epic warrior battle shout, anime hero speech..."
                  value={ttsStylePrompt}
                  onChange={(e) => setTtsStylePrompt(e.target.value)}
                  className="w-full bg-transparent text-white placeholder-[#666] outline-none"
                />
              </div>
              <p className="text-xs text-[#666] mt-1">
                Choose a preset from the right panel or write your own description. Defaults to &quot;neutral voice&quot; if left empty.
              </p>
            </div>

            {/* Actions */}
            <div className="flex justify-end">
              <button
                onClick={handleGenerateAudio}
                disabled={generateLoading || topModels.length === 0 || !selectedModel}
                className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generateLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-[#07080A] border-t-transparent rounded-full animate-spin mr-2 inline-block" />
                    Generating...
                  </>
                ) : (
                  <>
                    <Play size={16} className="mr-2" />
                    Generate Audio ({CREDIT_TTS} cr)
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Style presets panel, sits to the right on large screens */}
        <div className="mt-4 lg:mt-0 w-full lg:w-96 flex-shrink-0">
          <div className="h-full bg-gradient-to-b from-[#0b0b10] to-[#050506] border border-[#2b2b35] rounded-xl p-3 space-y-3">
            <p className="text-[11px] uppercase tracking-[0.16em] text-[#DFFF00] mb-1">
              Style presets
            </p>
            <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
              {TTS_STYLE_PRESETS.map((preset, index) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setTtsStylePrompt(preset.description)}
                  className="w-full flex items-center gap-4 px-2 py-3 rounded-lg hover:bg-white/[0.04] border border-transparent hover:border-[#DFFF00]/40 text-left transition-colors"
                >
                  <div className="flex-shrink-0 w-24 h-24 rounded-full overflow-hidden bg-transparent border border-white/10">
                    <img
                      src={asset(`tts-style.${preset.id}`)}
                      alt={preset.label}
                      className="w-full h-full object-cover"
                      loading={index < PRIORITY_PRESET_COUNT ? 'eager' : 'lazy'}
                      fetchPriority={index < 3 ? 'high' : 'auto'}
                      decoding="async"
                    />
                  </div>
                  <div className="min-w-0">
                    <p className="text-base font-semibold text-white tracking-tight">
                      {preset.label}
                    </p>
                    <p className="text-xs text-[#6B7280] leading-snug">
                      {preset.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  const renderSTTView = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Speech-to-Text</h2>
        <p className="text-[#A7B0B7]">
          Highly accurate transcription and translation for audio files.
        </p>
      </div>

      <div className="card-vocence p-6 space-y-6">
        {/* Upload Zone */}
        <div>
          <input
            ref={sttFileInputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                setSttFile(file);
              }
            }}
          />
          <div
            onClick={() => sttFileInputRef.current?.click()}
            onDragOver={handleSttDragOver}
            onDragLeave={handleSttDragLeave}
            onDrop={handleSttDrop}
            className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer ${
              isSttDragActive
                ? 'border-[#DFFF00] bg-[#DFFF00]/10'
                : 'border-white/10 hover:border-white/20'
            }`}
          >
            <Upload size={40} className="mx-auto mb-4 text-[#666]" />
            {sttFile ? (
              <>
                <p className="mb-2 text-[#DFFF00]">{sttFile.name}</p>
                <p className="text-sm text-[#666]">{(sttFile.size / 1024 / 1024).toFixed(2)} MB</p>
              </>
            ) : (
              <>
                <p className="mb-2">
                  Drag and drop audio files or{' '}
                  <span className="text-[#DFFF00]">browse</span>
                </p>
                <p className="text-sm text-[#666]">MP3, WAV, M4A up to 50MB</p>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="w-full md:w-[260px]">
            <label className="label-mono mb-2 block">Language</label>
            <Select value={selectedLanguage} onValueChange={setSelectedLanguage}>
              <SelectTrigger className="h-10 bg-[#0a0a0a] border-white/15 rounded-xl px-3 text-sm text-white hover:bg-[#111] focus:border-[#DFFF00]/60 focus:ring-[#DFFF00]/20">
                <SelectValue placeholder="Auto-detect" />
              </SelectTrigger>
              <SelectContent className="bg-[#0a0a0a] border-white/15 text-white max-h-72">
                <SelectItem value="auto-detect">Auto-detect</SelectItem>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Spanish</SelectItem>
                <SelectItem value="pt">Portuguese</SelectItem>
                <SelectItem value="ja">Japanese</SelectItem>
                <SelectItem value="zh">Chinese</SelectItem>
                <SelectItem value="fr">French</SelectItem>
                <SelectItem value="de">German</SelectItem>
                <SelectItem value="it">Italian</SelectItem>
                <SelectItem value="ru">Russian</SelectItem>
                <SelectItem value="ko">Korean</SelectItem>
                <SelectItem value="ar">Arabic</SelectItem>
                <SelectItem value="hi">Hindi</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-3 cursor-pointer group rounded-xl border border-white/10 bg-white/[0.02] px-3 py-2 md:self-end">
            <div className="relative">
              <input
                type="checkbox"
                checked={getVoiceDescription}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSttStatus({
                      type: 'info',
                      message: 'Get voice description is under development and not available yet.',
                    });
                    setGetVoiceDescription(false);
                    return;
                  }
                  setGetVoiceDescription(false);
                }}
                className="sr-only"
              />
              <div className={`w-5 h-5 border-2 rounded-md transition-all flex items-center justify-center ${
                getVoiceDescription
                  ? 'bg-[#DFFF00] border-[#DFFF00]'
                  : 'bg-transparent border-white/20 group-hover:border-white/40'
              }`}>
                {getVoiceDescription && (
                  <svg
                    className="w-3 h-3 text-[#07080A]"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
            </div>
            <span className="text-sm text-[#A7B0B7] group-hover:text-white transition-colors">Get voice description</span>
          </label>
        </div>

        {/* Actions */}
        <div className="flex justify-end">
          <button onClick={handleStartTranscription} disabled={generateLoading} className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
            <Mic size={16} className="mr-2" />
            {generateLoading ? 'Transcribing...' : `Start Transcription (${CREDIT_STT} cr)`}
          </button>
        </div>

        {sttStatus && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-2 ${
              sttStatus.type === 'success'
                ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-200'
                : sttStatus.type === 'error'
                  ? 'border-red-400/30 bg-red-500/10 text-red-200'
                  : 'border-amber-300/30 bg-amber-300/10 text-amber-100'
            }`}
          >
            {sttStatus.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{sttStatus.message}</span>
          </div>
        )}

        {sttResult && (
          <div className="rounded-2xl border border-white/10 bg-gradient-to-b from-white/[0.05] to-white/[0.02] p-5 space-y-4 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.14em] text-[#DFFF00]">Transcription</p>
                <p className="text-sm text-[#A7B0B7] mt-1">
                  {sttResult.fileName || 'Audio file'}
                </p>
              </div>
              <button
                type="button"
                className="text-xs font-medium text-[#DFFF00] hover:underline inline-flex items-center gap-1"
                onClick={() => {
                  navigator.clipboard.writeText(sttResult.text || '');
                  setSttCopied(true);
                  window.setTimeout(() => setSttCopied(false), 1400);
                }}
              >
                {sttCopied ? (
                  <>
                    <CheckCircle2 size={13} />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy size={13} />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-sm leading-7 text-white whitespace-pre-wrap rounded-xl border border-white/10 bg-[#050608] p-4">
              {sttResult.text || '(empty transcription)'}
            </p>
            {sttResult.language && (
              <p className="text-xs text-[#8A93A3]">
                Language: <span className="text-white">{sttResult.language}</span>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const renderChatView = () => (
    <div className="space-y-6 relative">
      <div className="blur-[2px] pointer-events-none select-none">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Voice Chat</h2>
          <p className="text-[#A7B0B7]">
            Interact with AI using real-time voice synthesis and recognition.
          </p>
          <p className="text-xs text-[#666] mt-3">
            {chatCreditsLoading ? (
              'Today: Loading credits...'
            ) : (
              <>
                Today: <span className="text-white font-medium">{chatCreditsToday.toLocaleString()}</span> credits consumed
              </>
            )}
          </p>
        </div>

        <div className="card-vocence p-6">
        {/* Chat Messages */}
        <div className="h-96 overflow-y-auto space-y-4 mb-6 pr-2">
          {chatMessages.map((msg, index) => (
            <div
              key={index}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] p-4 rounded-2xl text-sm ${
                  msg.role === 'user'
                    ? 'bg-[#2E7D32] text-white rounded-br-md'
                    : 'bg-[#0a0a0a] text-white rounded-bl-md'
                }`}
              >
                {msg.content}
              </div>
            </div>
          ))}
        </div>

        {/* Input */}
        <div className="flex gap-3">
          <div className="flex-1 bg-[#0a0a0a] border border-white/10 rounded-xl px-4 py-3">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSendMessage()}
              placeholder="Type a message or click mic to speak..."
              className="w-full bg-transparent text-white placeholder-[#666] outline-none"
            />
          </div>
          <button
            onClick={() => {
              setIsMicRecording(!isMicRecording);
              // TODO: Implement voice recording
            }}
            className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors ${
              isMicRecording
                ? 'bg-red-500 text-white hover:bg-red-600'
                : 'bg-white/10 text-white hover:bg-white/20'
            }`}
          >
            <Mic size={18} />
          </button>
          <button
            onClick={handleSendMessage}
            className="w-11 h-11 bg-white text-[#07080A] rounded-full flex items-center justify-center hover:bg-[#DFFF00] transition-colors"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
      </div>
      
      {/* Coming Soon Overlay */}
      <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
        <div className="rounded-2xl border border-[#DFFF00]/25 bg-[#0b0f14]/70 px-7 py-5 text-center backdrop-blur-sm">
          <h3 className="text-2xl md:text-3xl font-bold text-[#DFFF00] mb-1">Coming Soon</h3>
          <p className="text-sm text-[#A7B0B7]">This feature is under development</p>
        </div>
      </div>
    </div>
  );

  const renderCloningView = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Voice Cloning</h2>
        <p className="text-[#A7B0B7] max-w-3xl">
          Upload a reference recording or capture one with your microphone. We transcribe the reference audio automatically,
          then synthesize your target text in that voice. Output is stored for 7 days — play or download below. Each run
          uses {CREDIT_VOICE_CLONE} credits.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card-vocence p-6 space-y-4">
          <label className="label-mono block">Reference audio</label>
          <p className="text-xs text-[#666]">Choose one source: file upload (drag-and-drop) or microphone recording.</p>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setCloningMode('upload');
                setIsRecording(false);
              }}
              className={`p-3 rounded-xl border text-sm text-center transition-all ${
                cloningMode === 'upload'
                  ? 'border-[#DFFF00] bg-[#DFFF00]/5 text-white'
                  : 'border-white/10 bg-white/[0.02] text-[#A7B0B7] hover:border-white/20'
              }`}
            >
              Upload
            </button>
            <button
              type="button"
              onClick={() => {
                setCloningMode('record');
                setCloningFile(null);
              }}
              className={`p-3 rounded-xl border text-sm text-center transition-all ${
                cloningMode === 'record'
                  ? 'border-[#DFFF00] bg-[#DFFF00]/5 text-white'
                  : 'border-white/10 bg-white/[0.02] text-[#A7B0B7] hover:border-white/20'
              }`}
            >
              Record
            </button>
          </div>

          {cloningMode === 'upload' && (
            <>
              <input
                ref={cloningFileInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.flac,.webm"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) setCloningFile(file);
                }}
              />
              <div
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') cloningFileInputRef.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsCloneDragActive(true);
                }}
                onDragLeave={() => setIsCloneDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsCloneDragActive(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) setCloningFile(file);
                }}
                onClick={() => cloningFileInputRef.current?.click()}
                className={`border-2 border-dashed rounded-2xl p-10 text-center transition-colors cursor-pointer ${
                  isCloneDragActive ? 'border-[#DFFF00] bg-[#DFFF00]/5' : 'border-white/10 hover:border-white/25'
                }`}
              >
                {cloningFile ? (
                  <>
                    <Upload size={32} className="mx-auto mb-3 text-[#DFFF00]" />
                    <p className="text-sm mb-1 text-[#DFFF00]">{cloningFile.name}</p>
                    <p className="text-xs text-[#666]">{(cloningFile.size / 1024 / 1024).toFixed(2)} MB</p>
                    {cloneReferencePreviewUrl ? (
                      <div className="mt-4 pt-4 border-t border-white/10 text-left" onClick={(e) => e.stopPropagation()}>
                        <p className="text-[11px] text-[#6B7280] mb-2">Preview reference</p>
                        <audio
                          key={cloneReferencePreviewUrl}
                          src={cloneReferencePreviewUrl}
                          controls
                          className="w-full h-9 rounded-lg"
                          preload="metadata"
                        />
                      </div>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Upload size={32} className={`mx-auto mb-3 ${isCloneDragActive ? 'text-[#DFFF00]' : 'text-[#666]'}`} />
                    <p className="text-sm mb-1">Drop audio here or click to browse</p>
                    <p className="text-xs text-[#666]">WAV, MP3, FLAC, WebM…</p>
                  </>
                )}
              </div>
            </>
          )}

          {cloningMode === 'record' && (
            <div className="border-2 border-dashed border-white/10 rounded-2xl p-10 text-center">
              <div className="mb-4">
                {isRecording ? (
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-red-500/20 flex items-center justify-center border-2 border-red-500">
                    <div className="w-12 h-12 rounded-full bg-red-500 animate-pulse" />
                  </div>
                ) : (
                  <div className="w-20 h-20 mx-auto mb-4 rounded-full bg-white/10 flex items-center justify-center">
                    <Mic size={32} className="text-[#666]" />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  if (isRecording) stopCloneRecording();
                  else void startCloneRecording();
                }}
                className={`px-6 py-3 rounded-full font-medium transition-all ${
                  isRecording
                    ? 'bg-red-500 text-white hover:bg-red-600'
                    : 'bg-[#DFFF00] text-[#07080A] hover:bg-[#DFFF00]/90'
                }`}
              >
                {isRecording ? (
                  <>
                    <Square size={16} className="inline mr-2" />
                    Stop &amp; use recording
                  </>
                ) : (
                  <>
                    <Mic size={16} className="inline mr-2" />
                    Start recording
                  </>
                )}
              </button>
              {isRecording && <p className="text-xs text-[#666] mt-3">Recording… stop when you are done.</p>}
              {cloningMode === 'record' && cloningFile && !isRecording && (
                <div className="mt-4 text-left max-w-md mx-auto space-y-2">
                  <p className="text-xs text-[#DFFF00]">Ready: {cloningFile.name}</p>
                  <p className="text-[11px] text-[#6B7280]">Play back your recording before generating.</p>
                  {cloneReferencePreviewUrl ? (
                    <audio
                      key={cloneReferencePreviewUrl}
                      src={cloneReferencePreviewUrl}
                      controls
                      className="w-full h-9 rounded-lg"
                      preload="metadata"
                    />
                  ) : null}
                </div>
              )}
            </div>
          )}

          <div>
            <label className="label-mono mb-2 block text-xs">Reference language (optional)</label>
            <input
              value={cloneLanguage}
              onChange={(e) => setCloneLanguage(e.target.value)}
              placeholder="e.g. en — helps STT for non-English references"
              className="w-full bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-[#666] outline-none"
            />
          </div>
        </div>

        <div className="card-vocence p-6 flex flex-col gap-4">
          <label className="label-mono block">Text to speak (target)</label>
          <p className="text-xs text-[#666]">
            This is what the cloned voice will say. Reference words come from your audio via automatic transcription.
          </p>
          <textarea
            rows={8}
            value={cloneTargetText}
            onChange={(e) => setCloneTargetText(e.target.value)}
            placeholder="Type the sentence or paragraph you want to hear in the reference voice…"
            className="w-full flex-1 min-h-[200px] bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-white placeholder-[#666] resize-y outline-none"
          />
          <button
            type="button"
            onClick={() => void handleCloneGenerate()}
            disabled={cloneLoading}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {cloneLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-[#07080A] border-t-transparent rounded-full animate-spin mr-2 inline-block" />
                Cloning…
              </>
            ) : (
              <>
                <Play size={16} className="inline mr-2" />
                Generate cloned speech ({CREDIT_VOICE_CLONE} cr)
              </>
            )}
          </button>
        </div>
      </div>

      {cloneStatus && (
        <div
          className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${
            cloneStatus.type === 'success'
              ? 'border-green-500/40 bg-green-500/10 text-green-100'
              : cloneStatus.type === 'error'
                ? 'border-red-500/40 bg-red-500/10 text-red-100'
                : 'border-white/15 bg-white/5 text-[#A7B0B7]'
          }`}
        >
          {cloneStatus.type === 'success' ? <CheckCircle2 size={16} className="shrink-0 mt-0.5" /> : <AlertCircle size={16} className="shrink-0 mt-0.5" />}
          <span>{cloneStatus.message}</span>
        </div>
      )}

      {cloneResult && (
        <div className="card-vocence p-6 space-y-4 border border-[#DFFF00]/20">
          <h3 className="font-semibold text-white">Result</h3>
          <div className="rounded-xl bg-[#0a0a0a] border border-white/10 p-4">
            <p className="text-xs text-[#666] uppercase tracking-wide mb-1">Transcribed reference</p>
            <p className="text-sm text-[#A7B0B7] leading-relaxed whitespace-pre-wrap">{cloneResult.referenceText}</p>
            {cloneResult.language && (
              <p className="text-xs text-[#666] mt-2">Language: {cloneResult.language}</p>
            )}
          </div>
          <audio ref={cloneAudioRef} src={cloneResult.audioUrl} className="w-full" controls />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="btn-outline text-sm"
              onClick={() =>
                void triggerBrowserDownload(cloneResult.audioUrl, `vocence-clone-${cloneResult.id}.wav`)
              }
            >
              <Download size={16} className="inline mr-2" />
              Download
            </button>
            {user && (
              <button
                type="button"
                className="btn-outline text-sm"
                onClick={() =>
                  navigate(`/studio/result/${cloneResult.id}?entry_type=clone`)
                }
              >
                Open player page
              </button>
            )}
          </div>
        </div>
      )}

      {/* Sample clones */}
      <CloneSamplesSection />
    </div>
  );

  return (
    <div ref={studioRef} className="min-h-screen bg-[#07080A] pt-20">
      {/* TTS result overlay – raised panel with prompt + capsule player */}
      {resultOverlay && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setResultOverlay(null)}>
          <div
            className="bg-[#0f1114] border border-white/10 rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <div className="flex items-start justify-between gap-4 mb-4">
                <h3 className="text-lg font-semibold text-white">Your generated audio</h3>
                <button
                  onClick={() => setResultOverlay(null)}
                  className="p-1.5 rounded-lg text-[#666] hover:text-white hover:bg-white/10 transition-colors"
                  aria-label="Close"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="space-y-2 mb-4">
                <p className="text-sm text-[#A7B0B7]">
                  <span className="text-[#666]">Content:</span> {resultOverlay.promptText}
                </p>
                <p className="text-sm text-[#A7B0B7]">
                  <span className="text-[#666]">Style:</span> {resultOverlay.styleInstruction}
                </p>
                <p className="text-xs text-[#666]">Model: {resultOverlay.modelName}</p>
              </div>
              <audio
                ref={overlayAudioRef}
                src={resultOverlay.audioUrl}
                onLoadedMetadata={() => setOverlayDuration(overlayAudioRef.current?.duration ?? 0)}
                onTimeUpdate={() => setOverlayCurrentTime(overlayAudioRef.current?.currentTime ?? 0)}
                onEnded={() => setOverlayPlaying(false)}
                onPlay={() => setOverlayPlaying(true)}
                onPause={() => setOverlayPlaying(false)}
              />
              {/* Capsule-style player: play, time, progress, volume, download */}
              <div className="flex items-center gap-3 p-3 rounded-full bg-[#0a0a0a] border border-white/10">
                <button
                  onClick={handleOverlayPlayPause}
                  className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 shrink-0"
                  aria-label={overlayPlaying ? 'Pause' : 'Play'}
                >
                  {overlayPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} className="ml-0.5" fill="currentColor" />}
                </button>
                <span className="text-sm text-white tabular-nums shrink-0">
                  {formatTime(overlayCurrentTime)} / {formatTime(overlayDuration)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={overlayDuration || 1}
                  step={0.1}
                  value={overlayCurrentTime}
                  onChange={handleOverlaySeek}
                  className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-[#DFFF00]"
                />
                <Volume2 size={18} className="text-[#A7B0B7] shrink-0" />
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  defaultValue={1}
                  onChange={handleOverlayVolume}
                  className="w-16 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-[#DFFF00] shrink-0"
                />
                <button
                  onClick={handleOverlayDownload}
                  className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 shrink-0"
                  aria-label="Download"
                >
                  <Download size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <StudioShell activeView={activeView}>
        <div className="max-w-6xl mx-auto">
            {activeView !== 'tts' && <ComingSoonView view={activeView} />}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'home' && <StudioHome />}
            {activeView === 'tts' && renderTTSView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'stt' && renderSTTView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'chat' && renderChatView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'cloning' && renderCloningView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'voice-design' && renderVoiceDesignView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'my-voices' && renderMyVoicesView()}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'music' && <StudioMusic />}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'playbooks' && <StudioPlaybooks />}
            {ENABLE_NON_TTS_STUDIO_VIEWS && activeView === 'history' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-2">History</h2>
                  <p className="text-[#A7B0B7]">
                    View and manage your Studio activity: TTS, STT, voice cloning, music generation, and My voice (Voice Design) generations.
                    Audio is available for 7 days for Normal users. Premium users enjoy never-expiring history.
                  </p>
                </div>
                {!user ? (
                  <div className="card-vocence p-6 text-center">
                    <p className="text-[#A7B0B7] mb-4">Sign in to see your history.</p>
                    <button onClick={() => setIsAuthModalOpen(true)} className="btn-primary">
                      Sign in
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="card-vocence p-4 mb-6">
                      <div className="flex flex-wrap gap-4">
                        <div className="flex-1 min-w-[200px] bg-[#0a0a0a] border border-white/10 rounded-lg px-4 py-2 flex items-center gap-2">
                          <Search size={16} className="text-[#666]" />
                          <input
                            type="text"
                            placeholder="Search prompts, transcription, clone text..."
                            value={studioHistorySearch}
                            onChange={(e) => setStudioHistorySearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm outline-none text-white placeholder-[#666]"
                          />
                        </div>
                        <Select
                          value={studioHistoryCategory}
                          onValueChange={(v) =>
                            setStudioHistoryCategory(v as typeof studioHistoryCategory)
                          }
                        >
                          <SelectTrigger className="w-full sm:w-[200px] h-10 bg-[#0a0a0a] border border-white/10 rounded-lg px-3 text-sm text-white">
                            <SelectValue placeholder="Category" />
                          </SelectTrigger>
                          <SelectContent
                            position="popper"
                            sideOffset={4}
                            className="bg-[#0a0a0a] border border-white/10 text-white [&_[data-slot=select-item]]:focus:!bg-transparent [&_[data-slot=select-item]]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[state=checked]:!text-[#DFFF00] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!bg-white/[0.06] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!text-white [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!text-[#DFFF00]"
                          >
                            <SelectItem value="all">All types</SelectItem>
                            <SelectItem value="tts">Text-to-Speech</SelectItem>
                            <SelectItem value="stt">Speech-to-Text</SelectItem>
                            <SelectItem value="clone">Voice clone</SelectItem>
                            <SelectItem value="voice_design">My voice (Voice Design)</SelectItem>
                            <SelectItem value="music">Music Generation</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    {studioHistoryLoading ? (
                      <div className="flex items-center justify-center py-12 gap-2 text-[#A7B0B7]">
                        <div className="w-5 h-5 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
                        Loading history...
                      </div>
                    ) : studioHistoryFiltered.length === 0 ? (
                      <div className="card-vocence p-12 text-center">
                        <p className="text-[#A7B0B7] mb-4">No history found</p>
                        <p className="text-sm text-[#666]">
                          {studioHistory.length === 0
                            ? "You haven't generated any studio audio yet. Use TTS, STT, cloning, or Voice Design."
                            : 'Try adjusting your search or category filter.'}
                        </p>
                        {studioHistory.length === 0 && (
                          <button type="button" onClick={() => navigate('/studio/tts')} className="btn-primary mt-4">
                            Go to Text-to-Speech
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="card-vocence overflow-hidden">
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead className="text-xs text-[#666] uppercase bg-white/5">
                              <tr>
                                <th className="px-4 py-3 text-left">Timestamp</th>
                                <th className="px-4 py-3 text-left">Type</th>
                                <th className="px-4 py-3 text-left">Content</th>
                                <th className="px-4 py-3 text-left">Style Prompt</th>
                                <th className="px-4 py-3 text-left">Model</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {studioHistoryPageItems.map((item) => {
                                  const created = new Date(item.created_at);
                                  const timestamp = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                                  const date = created.toLocaleDateString();
                                  const isCloneLike =
                                    item.entry_type === 'clone' || item.entry_type === 'voice_design';
                                  const typeBadge =
                                    item.entry_type === 'stt'
                                      ? 'bg-green-500/15 text-green-400'
                                      : item.entry_type === 'clone'
                                        ? 'bg-cyan-500/15 text-cyan-400'
                                        : item.entry_type === 'voice_design'
                                          ? 'bg-violet-500/15 text-violet-300'
                                          : 'bg-[#DFFF00]/15 text-[#DFFF00]';
                                  const typeLabel =
                                    item.entry_type === 'voice_design' ? 'MY VOICE' : item.entry_type.toUpperCase();
                                  const contentCell =
                                    item.entry_type === 'stt'
                                      ? item.transcribed_text || item.source_audio_filename || '-'
                                      : isCloneLike
                                        ? item.target_text || item.prompt_text || '-'
                                        : item.prompt_text || '-';
                                  const contentCopy =
                                    item.entry_type === 'stt'
                                      ? item.transcribed_text || ''
                                      : isCloneLike
                                        ? item.target_text || item.prompt_text || ''
                                        : item.prompt_text || '';
                                  const styleCell =
                                    item.entry_type === 'stt'
                                      ? item.source_language || 'auto-detect'
                                      : isCloneLike
                                        ? (item.reference_text || '').slice(0, 80) +
                                          ((item.reference_text || '').length > 80 ? '…' : '')
                                        : item.style_instruction;
                                  const styleCopy =
                                    item.entry_type === 'stt'
                                      ? item.source_language || ''
                                      : isCloneLike
                                        ? item.reference_text || ''
                                        : item.style_instruction;
                                  const resultQs =
                                    item.entry_type === 'clone'
                                      ? '?entry_type=clone'
                                      : item.entry_type === 'voice_design'
                                        ? '?entry_type=voice_design'
                                        : item.entry_type === 'music'
                                          ? '?entry_type=music'
                                          : '';
                                  const dlName = isCloneLike
                                    ? item.entry_type === 'voice_design'
                                      ? `vocence-voice-design-${item.id}.wav`
                                      : `vocence-clone-${item.id}.wav`
                                    : item.entry_type === 'music'
                                      ? `vocence-music-${item.id}.wav`
                                      : `vocence-tts-${item.id}.wav`;
                                  return (
                                    <tr key={`${item.entry_type}-${item.id}`} className="hover:bg-white/5 transition-colors">
                                      <td className="px-4 py-4">
                                        <div className="font-medium">{timestamp}</div>
                                        <div className="text-xs text-[#666]">{date}</div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${typeBadge}`}>
                                          {typeLabel}
                                        </span>
                                      </td>
                                      <td className="px-4 py-4">
                                        <div className="flex items-center gap-2">
                                          <span className="truncate max-w-[200px]">{contentCell}</span>
                                          <button
                                            type="button"
                                            className="text-[#666] hover:text-white"
                                            onClick={() => navigator.clipboard.writeText(contentCopy)}
                                          >
                                            <Copy size={14} />
                                          </button>
                                        </div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <div className="flex items-center gap-2">
                                          <span className="text-[#A7B0B7] truncate max-w-[150px]">{styleCell}</span>
                                          {styleCopy ? (
                                            <button
                                              type="button"
                                              className="text-[#666] hover:text-white"
                                              onClick={() => navigator.clipboard.writeText(styleCopy)}
                                            >
                                              <Copy size={14} />
                                            </button>
                                          ) : null}
                                        </div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <span className="px-2 py-1 bg-[#0a0a0a] rounded text-xs">{item.display_name}</span>
                                      </td>
                                      <td className="px-4 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                          {item.entry_type === 'stt' ? (
                                            <span className="text-xs text-[#A7B0B7]">Text only</span>
                                          ) : item.expired ? (
                                            <>
                                              <button
                                                type="button"
                                                onClick={() => navigate(`/studio/result/${item.id}${resultQs}`)}
                                                className="p-1.5 text-[#666] hover:text-white"
                                                title="View result"
                                              >
                                                <Play size={16} />
                                              </button>
                                              <span className="text-xs text-[#666]">Expired</span>
                                            </>
                                          ) : item.audio_url ? (
                                            <>
                                              <button
                                                type="button"
                                                onClick={() => navigate(`/studio/result/${item.id}${resultQs}`)}
                                                className="p-1.5 text-[#666] hover:text-white"
                                                title="Play"
                                              >
                                                <Play size={16} />
                                              </button>
                                              <button
                                                type="button"
                                                onClick={() => void triggerBrowserDownload(item.audio_url, dlName)}
                                                className="p-1.5 text-[#666] hover:text-white"
                                                title="Download"
                                              >
                                                <Download size={16} />
                                              </button>
                                            </>
                                          ) : (
                                            <span className="text-xs text-[#666]">Unavailable</span>
                                          )}
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                            </tbody>
                          </table>
                        </div>
                        {studioHistoryTotalPages > 1 ? (
                          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-t border-white/5 text-sm text-[#A7B0B7]">
                            <span>
                              Showing {(studioHistoryEffectivePage - 1) * STUDIO_HISTORY_PAGE_SIZE + 1}–
                              {Math.min(
                                studioHistoryEffectivePage * STUDIO_HISTORY_PAGE_SIZE,
                                studioHistoryFiltered.length
                              )}{' '}
                              of {studioHistoryFiltered.length}
                            </span>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={studioHistoryEffectivePage <= 1}
                                onClick={() => setStudioHistoryPage((p) => Math.max(1, p - 1))}
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                              >
                                Previous
                              </button>
                              <span className="tabular-nums text-xs">
                                Page {studioHistoryEffectivePage} / {studioHistoryTotalPages}
                              </span>
                              <button
                                type="button"
                                disabled={studioHistoryEffectivePage >= studioHistoryTotalPages}
                                onClick={() =>
                                  setStudioHistoryPage((p) => Math.min(studioHistoryTotalPages, p + 1))
                                }
                                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                              >
                                Next
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
      </StudioShell>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />
    </div>
  );
}

/* ==========================================================================
   Clone samples section — shown at bottom of voice cloning page
   ========================================================================== */

const CLONE_SAMPLE_TRACKS = [
  { id: 'cs1', name: 'Studio Interview', avatar: '/samples/images/clone_1.webp', originalAudio: '/samples/audio/clone1_original.wav', clonedAudio: '/samples/audio/clone1_cloned.wav', originalLabel: 'Original Recording', clonedLabel: 'Cloned — New Script' },
  { id: 'cs2', name: 'Podcast Host', avatar: '/samples/images/clone_2.webp', originalAudio: '/samples/audio/clone2_original.wav', clonedAudio: '/samples/audio/clone2_cloned.wav', originalLabel: 'Reference Clip', clonedLabel: 'Cloned Output' },
  { id: 'cs3', name: 'Voiceover Artist', avatar: '/samples/images/clone_3.webp', originalAudio: '/samples/audio/clone3_original.wav', clonedAudio: '/samples/audio/clone3_cloned.wav', originalLabel: 'Original Sample', clonedLabel: 'Cloned — Ad Read' },
  { id: 'cs4', name: 'Audiobook Narrator', avatar: '/samples/images/clone_4.webp', originalAudio: '/samples/audio/clone4_original.wav', clonedAudio: '/samples/audio/clone4_cloned.wav', originalLabel: 'Reference', clonedLabel: 'Cloned — Chapter Read' },
];

function CloneSamplesSection() {
  const { track, playing, play, pause, resume } = useStudioPlayer();

  const PlayBtn = ({ src, title, subtitle, image }: { src: string; title: string; subtitle?: string; image?: string }) => {
    const isThis = track?.src === src;
    const isPlaying = isThis && playing;
    return (
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (isPlaying) { pause(); return; }
          if (isThis) { resume(); return; }
          play({ src, title, subtitle, image });
        }}
        className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
          isPlaying ? 'bg-[#DFFF00] text-[#07080A]' : 'bg-white/10 text-white hover:bg-white/20'
        }`}
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
      </button>
    );
  };

  return (
    <section className="pt-4">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-white">Sample Clones</h3>
        <p className="text-xs text-[#A7B0B7] mt-0.5">Hear the original and the cloned result side by side.</p>
      </div>
      <div className="space-y-2">
        {CLONE_SAMPLE_TRACKS.map((c) => (
          <div key={c.id} className="flex items-center gap-4 px-3 py-3 rounded-xl border border-white/[0.06] bg-white/[0.02] hover:border-white/[0.12] transition-all">
            {/* Avatar */}
            <div className="w-[72px] h-[72px] rounded-xl overflow-hidden shrink-0 group/avatar">
              <img loading="lazy" src={c.avatar} alt={c.name} className="w-full h-full object-cover transition-transform duration-300 group-hover/avatar:scale-110" />
            </div>

            {/* Info + play buttons */}
            <div className="flex-1 min-w-0">
              <h4 className="text-sm text-white font-medium mb-2">{c.name}</h4>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <PlayBtn src={c.originalAudio} title={`${c.name} — Original`} subtitle={c.originalLabel} image={c.avatar} />
                  <span className="text-xs text-[#A7B0B7]">{c.originalLabel}</span>
                </div>
                <div className="flex items-center gap-2">
                  <PlayBtn src={c.clonedAudio} title={`${c.name} — Cloned`} subtitle={c.clonedLabel} image={c.avatar} />
                  <span className="text-xs text-[#A7B0B7]">{c.clonedLabel}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
