import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  Mic,
  Upload,
  Play,
  Pause,
  Download,
  Send,
  Square,
  Search,
  Copy,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  LayoutGrid,
  Trash2,
  Lightbulb,
  Plus,
  X,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Check,
} from 'lucide-react';
import gsap from 'gsap';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AuthModal } from '../components/AuthModal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MyVoiceCardArt } from '../components/MyVoiceCardArt';
import { StudioShell } from '../components/StudioShell';
import { VoiceCloneConsent } from '../components/VoiceCloneConsent';
import { useGenerations } from '../contexts/GenerationsContext';
import { STUDIO_VIEWS, type StudioView } from '../studio/studioNav';
import { DEFAULT_ABSTRACT_CARD_IMAGES } from '../data/abstractCardImages';
import { asset } from '../data/assets';
import {
  CREDIT_STT,
  CREDIT_TTS,
  CREDIT_VOICE_CLONE,
  CREDIT_VOICE_DESIGN_PREVIEW,
} from '../studio/creditCosts';
import { blobToCloneReferenceWav, getAudioDurationSec } from '../utils/cloneReferenceAudio';
import {
  dashboardApi,
  humanizeApiError,
  type StudioDesignedVoiceItem,
  type StudioTopModel,
  type StudioHistoryItem,
  type StudioVoiceDesignConfig,
  type StudioVoiceDesignPreviewResponse,
} from '../services/dashboardApi';
import { StudioMusic } from './StudioMusic';
import { StudioDubbing } from './StudioDubbing';
import { StudioHome } from './StudioHome';
import { StudioPlaybooks } from './StudioPlaybooks';
import { StudioTtsGeneral } from '../components/studio/StudioTtsGeneral';
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

/**
 * Languages the Qwen3-ASR self-hosted transcription engine accepts.
 * The backend forwards whatever we send as ``language`` verbatim to
 * the miner; the miner rejects anything not in this exact spelling
 * (e.g. "en" → 500, "US" → 500). Keep this list in sync with the
 * miner's ``Supported:`` enumeration — surfacing it as a dropdown
 * means users can't type something invalid in the first place.
 */
const STT_LANGUAGES: readonly string[] = [
  'English',
  'Chinese',
  'Cantonese',
  'Arabic',
  'German',
  'French',
  'Spanish',
  'Portuguese',
  'Indonesian',
  'Italian',
  'Korean',
  'Russian',
  'Thai',
  'Vietnamese',
  'Japanese',
  'Turkish',
  'Hindi',
  'Malay',
  'Dutch',
  'Swedish',
  'Danish',
  'Finnish',
] as const;

/**
 * Dark-themed language picker for the Upload Voice modal. Replaces a
 * native ``<select>`` so the menu surface (border, hover, checkmark)
 * matches our UI — the OS popup looks wrong on every Windows / Linux
 * browser we tested. Handles click-outside to close and scrolls when
 * the option list overflows.
 */
function LanguagePicker({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  const displayLabel = value || 'Auto-detect';
  return (
    <div ref={ref} className="relative w-full">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white hover:bg-white/[0.06] hover:border-white/20 focus:outline-none focus:border-white/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className={value ? 'text-white' : 'text-[#A7B0B7]'}>{displayLabel}</span>
        <ChevronDown size={14} className={`text-[#A7B0B7] transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-white/10 bg-[#0B0D10] shadow-2xl shadow-black/60 py-1"
        >
          {/* Auto-detect option pinned at the top — matches the previous
              "leave blank" semantic. */}
          <LanguageOption value="" current={value} label="Auto-detect" onPick={(v) => { onChange(v); setOpen(false); }} muted />
          <div className="border-t border-white/[0.05] my-1" />
          {STT_LANGUAGES.map((lang) => (
            <LanguageOption
              key={lang}
              value={lang}
              current={value}
              label={lang}
              onPick={(v) => { onChange(v); setOpen(false); }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LanguageOption({
  value,
  current,
  label,
  onPick,
  muted,
}: {
  value: string;
  current: string;
  label: string;
  onPick: (v: string) => void;
  muted?: boolean;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      className={`w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors ${
        active
          ? 'bg-white/[0.08] text-white'
          : muted
            ? 'text-[#A7B0B7] hover:text-white hover:bg-white/[0.04]'
            : 'text-[#C5CAD1] hover:text-white hover:bg-white/[0.04]'
      }`}
      role="option"
      aria-selected={active}
    >
      <span>{label}</span>
      {active && <Check size={14} className="text-[#DFFF00]" />}
    </button>
  );
}

// Temporary flag: while launching, only Text-to-Speech is enabled in Studio.
// Flip back to `true` to re-enable the other Studio views.
const ENABLE_VOICE_CHAT = false;

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
  agents: 'Agents',
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
    description: 'A calm, friendly male voice speaking at a natural pace.',
  },
  {
    id: 'neutral-female',
    label: 'Neutral Female',
    description: 'A calm, friendly female voice speaking at a natural pace.',
  },
  {
    id: 'urgent-support',
    label: 'Urgent Support / Emergency Tone',
    description: 'A firm, focused voice speaking quickly and clearly, calm but urgent.',
  },
  {
    id: 'friendly-ai-assistant',
    label: 'Friendly AI Assistant',
    description: 'A polite, slightly synthetic assistant voice — warm, precise, and helpful.',
  },
  {
    id: 'epic-warrior',
    label: 'Dragon Warrior',
    description: 'A deep male voice roaring like a dragon warrior, fierce and powerful.',
  },
  {
    id: 'dark-villain',
    label: 'Dark Villain',
    description: 'A deep, cold male voice speaking slowly with menacing confidence.',
  },
  {
    id: 'anime-hero',
    label: 'Anime Hero',
    description: 'An energetic young male voice shouting with passion and determination.',
  },
  {
    id: 'military-commander',
    label: 'Military Commander',
    description: 'A loud, authoritative male voice giving commands sharply and directly.',
  },
  {
    id: 'narrator-trailer',
    label: 'Narrator / Trailer Voice',
    description: 'A deep, cinematic male voice speaking slowly and dramatically.',
  },
  {
    id: 'cyberpunk-ai',
    label: 'Cyberpunk / AI Voice',
    description: 'A robotic synthetic voice — cold, precise, and emotionless.',
  },
  {
    id: 'orc-monster',
    label: 'Orc / Monster / Brutal',
    description: 'A rough, growling monster voice, brutal and aggressive.',
  },
  {
    id: 'viking-barbarian',
    label: 'Viking / Barbarian',
    description: 'A rough male voice shouting fiercely like a battle cry.',
  },
  {
    id: 'little-girl',
    label: 'Little Girl',
    description: "A bright, cheerful young girl's voice, playful and excited.",
  },
];
const PRIORITY_PRESET_COUNT = 6;

/** TTS main content: character cap (shown to user only if they try to exceed it).
 *  Raised from 300 → 2000 now that PromptTTS routes through the local
 *  qwen3-voice-design server (Qwen3-TTS-12Hz-1.7B-VoiceDesign on RTX 4090)
 *  instead of Chutes. Match the server's QWEN3_VD_MAX_CHARS. */
const TTS_CONTENT_MAX_CHARS = 2000;

/** Voice cloning target text: character cap (shown to user only if they try to exceed it). */
const CLONE_TARGET_MAX_CHARS = 2000;

/** Voice cloning reference audio: duration window (seconds). */
const CLONE_REF_MIN_SEC = 5;
const CLONE_REF_MAX_SEC = 20;

// Top 3 models from main validator; loaded in TTS view

export function Studio() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user, isAuthenticated, setLocalCredits } = useAuth();
  const player = useStudioPlayer();
  const generations = useGenerations();
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
  const [studioHistoryDateRange, setStudioHistoryDateRange] = useState<'all' | '24h' | '7d' | '30d'>('all');
  const [studioHistorySelected, setStudioHistorySelected] = useState<Set<string>>(new Set());
  // Music rows on the Studio history table are expandable — click to
  // open a details panel that shows lyrics + mode-specific knobs
  // (variance, repaint window, edit target, etc.) with per-field copy
  // buttons. Mirrors the behavior on the Account History page.
  const [studioHistoryExpandedIds, setStudioHistoryExpandedIds] = useState<Set<string>>(new Set());
  const [studioHistoryCopiedKey, setStudioHistoryCopiedKey] = useState<string | null>(null);
  const toggleStudioHistoryExpanded = (key: string) =>
    setStudioHistoryExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  const studioHistoryCopyValue = async (fieldKey: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setStudioHistoryCopiedKey(fieldKey);
      window.setTimeout(
        () => setStudioHistoryCopiedKey((c) => (c === fieldKey ? null : c)),
        1200,
      );
    } catch { /* clipboard unavailable */ }
  };
  const [studioHistoryAddTarget, setStudioHistoryAddTarget] = useState<number | null>(null);
  const [studioHistoryBulkBusy, setStudioHistoryBulkBusy] = useState(false);
  const [studioHistoryAddOpen, setStudioHistoryAddOpen] = useState(false);
  const [studioPlaybooksList, setStudioPlaybooksList] = useState<{ id: number; title: string }[]>([]);
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
  // Subpage tab inside the TTS view: 'general' = sample-voice picker (voice
  // cloning under the hood), 'prompt' = the style-prompt PromptTTS flow.
  const [ttsTab, setTtsTab] = useState<'general' | 'prompt'>('general');
  const [selectedLanguage, setSelectedLanguage] = useState('auto-detect');
  const [sttFile, setSttFile] = useState<File | null>(null);
  const [sttMode, setSttMode] = useState<'upload' | 'record'>('upload');
  const [sttIsRecording, setSttIsRecording] = useState(false);
  const [sttRecordingSec, setSttRecordingSec] = useState(0);
  const sttMediaRecorderRef = useRef<MediaRecorder | null>(null);
  const sttStreamRef = useRef<MediaStream | null>(null);
  const sttTimerRef = useRef<number | null>(null);
  const [isSttDragActive, setIsSttDragActive] = useState(false);
  const [sttResult, setSttResult] = useState<{ text: string; language?: string | null; fileName?: string } | null>(null);
  const [sttStatus, setSttStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [sttCopied, setSttCopied] = useState(false);
  const [cloningFile, setCloningFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [cloningMode, setCloningMode] = useState<'upload' | 'record'>('upload');
  const [cloneTargetText, setCloneTargetText] = useState('');
  const [cloneTargetLimitNotice, setCloneTargetLimitNotice] = useState(false);
  const [cloneReferenceScript, setCloneReferenceScript] = useState('');
  const [cloneLanguage, setCloneLanguage] = useState('');
  const [cloneLoading, setCloneLoading] = useState(false);
  const [cloneStatus, setCloneStatus] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [showCloneConsent, setShowCloneConsent] = useState(false);
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
  // "Upload your voice" modal — saves a real-voice reference clip as a
  // reusable cloned voice. Server transcribes once on save.
  const [uploadVoiceOpen, setUploadVoiceOpen] = useState(false);
  const [uploadVoiceFile, setUploadVoiceFile] = useState<File | null>(null);
  const [uploadVoiceName, setUploadVoiceName] = useState('');
  const [uploadVoiceLanguage, setUploadVoiceLanguage] = useState('');
  const [uploadVoiceBusy, setUploadVoiceBusy] = useState(false);
  const [uploadVoiceError, setUploadVoiceError] = useState<string | null>(null);
  const [uploadVoiceMode, setUploadVoiceMode] = useState<'upload' | 'record'>('upload');
  const [uploadVoiceRecording, setUploadVoiceRecording] = useState(false);
  const [uploadVoiceRecordSec, setUploadVoiceRecordSec] = useState(0);
  const uploadVoiceMrRef = useRef<MediaRecorder | null>(null);
  const uploadVoiceStreamRef = useRef<MediaStream | null>(null);
  const uploadVoiceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [vdSaveNameInvalid, setVdSaveNameInvalid] = useState(false);
  const [abstractImagePool, setAbstractImagePool] = useState<string[]>(DEFAULT_ABSTRACT_CARD_IMAGES);
  const highlightedVoiceRef = useRef<HTMLDivElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const cloneStreamRef = useRef<MediaStream | null>(null);
  const [getVoiceDescription, setGetVoiceDescription] = useState(false);
  const studioRef = useRef<HTMLDivElement>(null);
  const sttFileInputRef = useRef<HTMLInputElement>(null);
  const cloningFileInputRef = useRef<HTMLInputElement>(null);

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
    const cutoff = (() => {
      if (studioHistoryDateRange === 'all') return 0;
      const ms = studioHistoryDateRange === '24h' ? 86_400_000
        : studioHistoryDateRange === '7d' ? 7 * 86_400_000
        : 30 * 86_400_000;
      return Date.now() - ms;
    })();
    return studioHistory.filter((h) => {
      if (studioHistoryCategory !== 'all' && h.entry_type !== studioHistoryCategory) {
        return false;
      }
      if (cutoff > 0) {
        const ts = h.created_at ? new Date(h.created_at + 'Z').getTime() : 0;
        if (!ts || ts < cutoff) return false;
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
  }, [studioHistory, studioHistorySearch, studioHistoryCategory, studioHistoryDateRange]);

  useEffect(() => {
    setStudioHistoryPage(1);
    setStudioHistorySelected(new Set());
  }, [studioHistorySearch, studioHistoryCategory, studioHistoryDateRange]);

  const _historyKey = (e: { entry_type: string; id: number }) => `${e.entry_type}-${e.id}`;
  const toggleHistorySelected = (key: string) => {
    setStudioHistorySelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const togglePageAllSelected = () => {
    setStudioHistorySelected((prev) => {
      const visibleKeys = studioHistoryFiltered
        .slice(0, STUDIO_HISTORY_PAGE_SIZE * 1) // selection scope: visible page
        .map(_historyKey);
      const next = new Set(prev);
      const allSelected = visibleKeys.every((k) => next.has(k));
      if (allSelected) visibleKeys.forEach((k) => next.delete(k));
      else visibleKeys.forEach((k) => next.add(k));
      return next;
    });
  };

  const handleBulkDeleteHistory = async () => {
    if (studioHistorySelected.size === 0) return;
    if (!confirm(`Delete ${studioHistorySelected.size} item${studioHistorySelected.size === 1 ? '' : 's'}? This cannot be undone.`)) return;
    setStudioHistoryBulkBusy(true);
    try {
      const items = Array.from(studioHistorySelected).map((k) => {
        const [type, idStr] = k.split('-');
        return { type: type as 'tts' | 'stt' | 'clone' | 'voice_design' | 'music', id: parseInt(idStr, 10) };
      }).filter((x) => Number.isFinite(x.id));
      const token = localStorage.getItem('vocence_token');
      await dashboardApi.deleteStudioHistory(items, token);
      // Optimistically prune
      const removed = new Set(items.map((i) => `${i.type}-${i.id}`));
      setStudioHistory((prev) => prev.filter((h) => !removed.has(`${h.entry_type}-${h.id}`)));
      setStudioHistorySelected(new Set());
    } catch {
      alert('Could not delete some items. Please try again.');
    } finally {
      setStudioHistoryBulkBusy(false);
    }
  };

  const openBulkAddToPlaybook = async () => {
    if (studioHistorySelected.size === 0) return;
    setStudioHistoryAddOpen(true);
    setStudioHistoryAddTarget(null);
    if (studioPlaybooksList.length === 0) {
      try {
        const token = localStorage.getItem('vocence_token');
        const r = await dashboardApi.listPlaybooks(token);
        setStudioPlaybooksList(r.playbooks.map((p) => ({ id: p.id, title: p.title })));
      } catch { /* ignore */ }
    }
  };

  const handleBulkAddToPlaybook = async () => {
    if (!studioHistoryAddTarget || studioHistorySelected.size === 0) return;
    setStudioHistoryBulkBusy(true);
    try {
      const items = Array.from(studioHistorySelected)
        .map((k) => studioHistory.find((h) => _historyKey(h) === k))
        .filter((h): h is StudioHistoryItem => !!h && !!h.audio_url && h.entry_type !== 'stt');
      if (items.length === 0) {
        alert('No playable audio in selection (STT and expired items skipped).');
        return;
      }
      const tracks = items.map((h) => ({
        title: (h.prompt_text || h.target_text || h.transcribed_text || h.display_name || `Track`).slice(0, 80),
        subtitle: h.entry_type.toUpperCase(),
        audio_url: h.audio_url!,
        source_type: 'generated' as const,
      }));
      const token = localStorage.getItem('vocence_token');
      await dashboardApi.addPlaybookTracks(studioHistoryAddTarget, tracks, token);
      setStudioHistorySelected(new Set());
      setStudioHistoryAddOpen(false);
    } catch {
      alert('Could not add to playbook. Please try again.');
    } finally {
      setStudioHistoryBulkBusy(false);
    }
  };

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

  const acceptCloneReferenceFile = useCallback(async (file: File) => {
    let durationSec: number;
    try {
      durationSec = await getAudioDurationSec(file);
    } catch {
      setCloningFile(null);
      setCloneStatus({
        type: 'error',
        message:
          'Could not read this audio file. Please upload a standard audio format (WAV, MP3, M4A, FLAC, or WEBM).',
      });
      return;
    }
    if (durationSec < CLONE_REF_MIN_SEC || durationSec > CLONE_REF_MAX_SEC) {
      setCloningFile(null);
      setCloneStatus({
        type: 'error',
        message: `Reference audio must be between ${CLONE_REF_MIN_SEC} and ${CLONE_REF_MAX_SEC} seconds (this clip is ${durationSec.toFixed(1)}s). Please upload or record another clip.`,
      });
      return;
    }
    setCloneStatus(null);
    setCloningFile(file);
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
            await acceptCloneReferenceFile(wavFile);
          } catch {
            setCloningFile(null);
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

  // ---- STT browser recording (max 3 min) ----
  const STT_MAX_RECORDING_SEC = 180;

  const startSttRecording = async () => {
    setSttStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      sttStreamRef.current = stream;
      const chunks: BlobPart[] = [];
      const mr = new MediaRecorder(stream);
      sttMediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        sttStreamRef.current = null;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('mp4') ? 'm4a' : 'wav';
        setSttFile(new File([blob], `recording.${ext}`, { type: blob.type || 'audio/webm' }));
        setSttIsRecording(false);
        sttMediaRecorderRef.current = null;
      };
      mr.start();
      setSttIsRecording(true);
      setSttRecordingSec(0);
      // Timer + auto-stop at 3 min
      sttTimerRef.current = window.setInterval(() => {
        setSttRecordingSec((prev) => {
          const next = prev + 1;
          if (next >= STT_MAX_RECORDING_SEC) {
            stopSttRecording();
          }
          return next;
        });
      }, 1000);
    } catch {
      setSttStatus({ type: 'error', message: 'Microphone access denied or unavailable.' });
      setSttIsRecording(false);
    }
  };

  const stopSttRecording = () => {
    if (sttTimerRef.current != null) {
      clearInterval(sttTimerRef.current);
      sttTimerRef.current = null;
    }
    if (sttMediaRecorderRef.current && sttMediaRecorderRef.current.state !== 'inactive') {
      sttMediaRecorderRef.current.stop();
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
      if (cloneTargetText.length > CLONE_TARGET_MAX_CHARS) {
        setCloneTargetLimitNotice(true);
        return;
      }
      // Consent gate — shown EVERY time, not cached. Voice cloning's
      // abuse risk doesn't get cheaper with familiarity; one past
      // acceptance shouldn't stand in for fresh attestation about a
      // possibly-different voice the user is about to clone now.
      setShowCloneConsent(true);
    });
  };

  const doCloneGenerate = async () => {
    if (!user) return;
    const target = cloneTargetText.trim();
    if (!target || !cloningFile) return;
    const token = localStorage.getItem('vocence_token');
    setCloneLoading(true);
    setCloneStatus(null);
    setCloneResult(null);
    try {
      // Browser → R2 directly via presigned PUT, then submit job with the
      // R2 key only. Sidesteps the per-request body limit on the API's
      // Cloudflare proxy — works for big reference recordings.
      const uploaded = await dashboardApi.uploadDirectToR2('voice-clone-ref', cloningFile, token);
      const submission = await dashboardApi.startJob({
        type: 'clone',
        credits: CREDIT_VOICE_CLONE,
        payload: {
          target_text: target,
          ref_source: cloningMode,
          language: cloneLanguage.trim() || null,
          reference_text: cloneReferenceScript.trim() || null,
          source_audio_filename: uploaded.filename || cloningFile.name,
          audio_bucket: uploaded.bucket,
          audio_key: uploaded.key,
        },
      }, token);
      setLocalCredits((user.credits ?? 0) - CREDIT_VOICE_CLONE);
      setCloneStatus({
        type: submission.load_warning ? 'info' : 'info',
        message: submission.load_warning
          ? `Queued (position ${submission.queue_position}). Capacity is heavy — this might take roughly 2× as long as usual.`
          : `Queued (position ${submission.queue_position}). Cloning…`,
      });
      generations.trackServerJob({
        serverJobId: submission.job_id,
        type: 'clone',
        label: target.slice(0, 80),
        toastResult: {
          navigateTo: '/studio/cloning',
          playerTitle: target.slice(0, 80) || 'Cloned voice',
          playerSubtitle: 'Voice clone result',
          downloadFilename: `vocence-clone-${submission.job_id.slice(0, 8)}.wav`,
        },
      });
      // Local poll for in-page Result card
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const job = await dashboardApi.getJob(submission.job_id, token);
          if (job.status === 'completed') {
            const audioUrl = (job.result?.audio_url as string | undefined) || '';
            const referenceText = (job.result?.reference_text as string | undefined) || '';
            const detectedLang = (job.result?.detected_language as string | undefined) || null;
            const historyId = (job.result?.history_id as number | undefined) || Date.now();
            setCloneResult({ id: historyId, audioUrl, referenceText, language: detectedLang });
            if (audioUrl) {
              player.play({
                src: audioUrl,
                title: target.slice(0, 80) || 'Cloned voice',
                subtitle: 'Voice clone result',
                downloadFilename: `vocence-clone-${historyId}.wav`,
              });
            }
            setCloneStatus({ type: 'success', message: 'Cloned audio is ready.' });
            done = true;
          } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
            setCloneStatus({ type: 'error', message: job.error_message || 'Voice cloning failed.' });
            setLocalCredits((user.credits ?? 0) + CREDIT_VOICE_CLONE);
            done = true;
          } else if (job.phase) {
            setCloneStatus({ type: 'info', message: job.phase });
          }
        } catch { /* keep polling */ }
      }
    } catch (e) {
      setCloneStatus({ type: 'error', message: humanizeApiError(e, 'Voice cloning failed. Please try again.') });
    } finally {
      setCloneLoading(false);
    }
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

  const handleCloneTargetChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    if (v.length <= CLONE_TARGET_MAX_CHARS) {
      setCloneTargetText(v);
      setCloneTargetLimitNotice(false);
    } else {
      setCloneTargetText(v.slice(0, CLONE_TARGET_MAX_CHARS));
      setCloneTargetLimitNotice(true);
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
      const text = ttsText.trim();
      const instruction = ttsStylePrompt.trim();
      const label = text.slice(0, 80) || 'Generated audio';

      void (async () => {
        try {
          const submission = await dashboardApi.startJob({
            type: 'tts',
            credits: CREDIT_TTS,
            payload: {
              text,
              style_instruction: instruction || 'neutral voice',
              miner_hotkey: selectedModel.miner_hotkey,
              model_name: selectedModel.model_name,
              chute_slug: selectedModel.chute_slug,
              chute_id: selectedModel.chute_id,
            },
          }, token);
          setLocalCredits((user.credits ?? 0) - CREDIT_TTS);
          generations.trackServerJob({
            serverJobId: submission.job_id,
            type: 'tts',
            label,
            toastResult: {
              navigateTo: '/studio/tts',
              playerTitle: label,
              playerSubtitle: instruction || 'neutral voice',
              downloadFilename: `vocence-tts-${submission.job_id.slice(0, 8)}.wav`,
            },
          });
          // Local optimistic poll: when complete, push into history + auto-play
          let done = false;
          while (!done) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const job = await dashboardApi.getJob(submission.job_id, token);
              if (job.status === 'completed') {
                const audioUrl = (job.result?.audio_url as string | undefined) || '';
                const historyId = (job.result?.history_id as number | undefined) || 0;
                if (audioUrl) {
                  player.play({
                    src: audioUrl,
                    title: label,
                    subtitle: instruction || 'neutral voice',
                    downloadFilename: `vocence-tts-${historyId || submission.job_id.slice(0, 8)}.wav`,
                  });
                  setStudioHistory((prev) => [
                    {
                      id: historyId || Date.now(),
                      entry_type: 'tts',
                      miner_hotkey: selectedModel.miner_hotkey,
                      model_name: selectedModel.model_name,
                      display_name: selectedModel.display_name,
                      prompt_text: text,
                      style_instruction: instruction || 'neutral voice',
                      audio_url: audioUrl,
                      expires_at: '',
                      created_at: new Date().toISOString(),
                      expired: false,
                    },
                    ...prev,
                  ]);
                }
                done = true;
              } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
                setLocalCredits((user.credits ?? 0) + CREDIT_TTS);
                done = true;
              }
            } catch { /* keep polling on transient errors */ }
          }
        } catch (e) {
          alert(humanizeApiError(e, 'Generation failed. Please try again.'));
        } finally {
          setGenerateLoading(false);
        }
      })();
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
      const fileRef = sttFile;
      const lang = selectedLanguage === 'auto-detect' ? null : selectedLanguage;
      void (async () => {
        try {
          // Browser → R2 directly via presigned PUT, then submit job
          // with the R2 key only — sidesteps the API Cloudflare proxy's
          // body-size limit for long recordings.
          const uploaded = await dashboardApi.uploadDirectToR2('stt-source', fileRef, token);
          const submission = await dashboardApi.startJob({
            type: 'stt',
            credits: CREDIT_STT,
            payload: { audio_bucket: uploaded.bucket, audio_key: uploaded.key, language: lang, filename: uploaded.filename || fileRef.name },
          }, token);
          setLocalCredits((user.credits ?? 0) - CREDIT_STT);
          setSttStatus({ type: 'info', message: `Queued (position ${submission.queue_position}). Transcribing…` });
          generations.trackServerJob({
            serverJobId: submission.job_id,
            type: 'stt',
            label: fileRef.name,
            toastResult: { navigateTo: '/studio/stt' },
          });
          // Local poll for in-page result + history insert
          let done = false;
          while (!done) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const job = await dashboardApi.getJob(submission.job_id, token);
              if (job.status === 'completed') {
                const text = (job.result?.text as string | undefined) || '';
                const language = (job.result?.language as string | undefined) || selectedLanguage;
                const historyId = (job.result?.history_id as number | undefined) || Date.now();
                setSttResult({ text, language, fileName: fileRef.name });
                setSttStatus({ type: 'success', message: 'Transcription completed successfully.' });
                setStudioHistory((prev) => [
                  {
                    id: historyId,
                    entry_type: 'stt',
                    miner_hotkey: '',
                    model_name: 'Speech-to-Text',
                    display_name: 'Speech-to-Text',
                    prompt_text: null,
                    style_instruction: '',
                    audio_url: null,
                    expires_at: '',
                    created_at: new Date().toISOString(),
                    expired: false,
                    transcribed_text: text,
                    source_audio_filename: fileRef.name,
                    source_language: language ?? null,
                    duration_seconds: null,
                  },
                  ...prev,
                ]);
                done = true;
              } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
                setSttStatus({ type: 'error', message: job.error_message || 'Transcription failed.' });
                setLocalCredits((user.credits ?? 0) + CREDIT_STT);
                done = true;
              } else if (job.phase) {
                setSttStatus({ type: 'info', message: job.phase });
              }
            } catch { /* keep polling */ }
          }
        } catch (e) {
          setSttStatus({ type: 'error', message: humanizeApiError(e, 'Transcription failed. Please try again.') });
        } finally {
          setGenerateLoading(false);
        }
      })();
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

      // Local-only deduction. We deliberately do NOT call the server
      // /credits PATCH endpoint here — that endpoint is admin-only (see
      // routers/auth.py:update_credits) after the 2026-05-14 incident
      // where a user used it to grant themselves 100k credits. This
      // chat is a UI demo and not a real LLM call, so deducting in
      // local state is fine; on refresh the server-side balance wins.
      if (user) {
        setLocalCredits(user.credits - 0.5);
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
      void (async () => {
        try {
          const submission = await dashboardApi.startJob({
            type: 'voice_design',
            credits: vdPreviewCredits,
            payload: {
              mode: 'preview',
              voice_description: desc,
              miner_hotkey: selectedModel.miner_hotkey,
              model_name: selectedModel.model_name,
              chute_slug: selectedModel.chute_slug,
            },
          }, token);
          setLocalCredits((user.credits ?? 0) - vdPreviewCredits);
          setVdStatus({
            type: 'info',
            message: submission.load_warning
              ? `Queued (position ${submission.queue_position}). Capacity is heavy — this might take roughly 2× as long as usual.`
              : `Queued (position ${submission.queue_position}). Designing voice…`,
          });
          generations.trackServerJob({
            serverJobId: submission.job_id,
            type: 'voice_design',
            label: desc.slice(0, 80),
            toastResult: { navigateTo: '/studio/voice-design' },
          });
          // Local poll for vdPreview state
          let done = false;
          while (!done) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const job = await dashboardApi.getJob(submission.job_id, token);
              if (job.status === 'completed' && job.result) {
                const result = job.result as Record<string, unknown>;
                setVdPreview({
                  preview_token: (result.preview_token as string) || '',
                  voice_description: desc,
                  revised_instruction: (result.revised_instruction as string) || '',
                  sample_script: (result.sample_script as string) || '',
                  audio_a_url: (result.audio_a_url as string) || '',
                  audio_b_url: (result.audio_b_url as string) || '',
                  expires_at: '',
                  credits: user.credits ?? 0,
                  miner_hotkey: selectedModel.miner_hotkey,
                  model_name: selectedModel.model_name,
                  chute_slug: selectedModel.chute_slug,
                });
                setVdChosen('revised');
                setVdDisplayName('');
                setVdSaveNameInvalid(false);
                setVdStatus({ type: 'success', message: 'Listen to both samples and pick the one that fits.' });
                done = true;
              } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
                setVdStatus({ type: 'error', message: job.error_message || 'Voice design failed.' });
                setLocalCredits((user.credits ?? 0) + vdPreviewCredits);
                done = true;
              } else if (job.phase) {
                setVdStatus({ type: 'info', message: job.phase });
              }
            } catch { /* keep polling */ }
          }
        } catch (e) {
          setVdStatus({ type: 'error', message: humanizeApiError(e, 'Voice design failed. Please try again.') });
        } finally {
          setVdLoading(false);
        }
      })();
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
        setLocalCredits(res.credits);
        setVdSavedVoiceId(res.voice_id);
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

  // Reset the upload-voice modal state on open/close so a previous
  // attempt doesn't bleed into the next.
  const openUploadVoice = () => {
    setUploadVoiceFile(null);
    setUploadVoiceName('');
    setUploadVoiceLanguage('');
    setUploadVoiceError(null);
    setUploadVoiceBusy(false);
    setUploadVoiceMode('upload');
    setUploadVoiceRecording(false);
    setUploadVoiceRecordSec(0);
    setUploadVoiceOpen(true);
  };
  const closeUploadVoice = () => {
    if (uploadVoiceBusy) return;
    stopUploadVoiceRecording();
    setUploadVoiceOpen(false);
    setUploadVoiceError(null);
  };

  const startUploadVoiceRecording = async () => {
    setUploadVoiceError(null);
    setUploadVoiceFile(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      uploadVoiceStreamRef.current = stream;
      const chunks: BlobPart[] = [];
      const mr = new MediaRecorder(stream);
      uploadVoiceMrRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        uploadVoiceStreamRef.current = null;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        void (async () => {
          try {
            const wavFile = await blobToCloneReferenceWav(blob, 'recording.wav');
            setUploadVoiceFile(wavFile);
          } catch {
            setUploadVoiceError('Could not convert recording to WAV. Try again or upload a file.');
          } finally {
            setUploadVoiceRecording(false);
            uploadVoiceMrRef.current = null;
            if (uploadVoiceTimerRef.current) { clearInterval(uploadVoiceTimerRef.current); uploadVoiceTimerRef.current = null; }
          }
        })();
      };
      mr.start();
      setUploadVoiceRecording(true);
      setUploadVoiceRecordSec(0);
      uploadVoiceTimerRef.current = setInterval(() => {
        setUploadVoiceRecordSec((s) => s + 1);
      }, 1000);
    } catch {
      setUploadVoiceError('Microphone access denied or unavailable.');
    }
  };

  const stopUploadVoiceRecording = () => {
    if (uploadVoiceMrRef.current && uploadVoiceMrRef.current.state === 'recording') {
      uploadVoiceMrRef.current.stop();
    }
    if (uploadVoiceStreamRef.current) {
      uploadVoiceStreamRef.current.getTracks().forEach((t) => t.stop());
      uploadVoiceStreamRef.current = null;
    }
    if (uploadVoiceTimerRef.current) {
      clearInterval(uploadVoiceTimerRef.current);
      uploadVoiceTimerRef.current = null;
    }
    setUploadVoiceRecording(false);
  };

  const submitUploadVoice = async () => {
    setUploadVoiceError(null);
    const name = uploadVoiceName.trim();
    if (!name) {
      setUploadVoiceError('Give your voice a name.');
      return;
    }
    if (name.length > 40) {
      setUploadVoiceError('Name must be 40 characters or less.');
      return;
    }
    if (!uploadVoiceFile) {
      setUploadVoiceError('Pick an audio file (.wav / .mp3 / .m4a / .webm).');
      return;
    }
    const token = localStorage.getItem('vocence_token');
    setUploadVoiceBusy(true);
    try {
      const res = await dashboardApi.saveStudioClonedVoice(
        {
          displayName: name,
          audioFile: uploadVoiceFile,
          language: uploadVoiceLanguage.trim() || undefined,
        },
        token,
      );
      // Refresh the list so the new card shows immediately. (We could
      // splice it into ``designedVoices`` directly, but a refetch also
      // re-syncs presigned URLs and is simpler.)
      try {
        const r = await dashboardApi.listStudioDesignedVoices(token);
        setDesignedVoices(r.voices);
      } catch {
        /* non-fatal */
      }
      setUploadVoiceOpen(false);
      setMyVoicesNotice({
        type: 'success',
        message: `Saved “${res.display_name}” to My Voices. You can pick it on any agent or Studio call.`,
      });
      window.setTimeout(() => setMyVoicesNotice(null), 6000);
    } catch (e) {
      setUploadVoiceError(userFacingApiError(e));
    } finally {
      setUploadVoiceBusy(false);
    }
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
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <h1 className="text-2xl sm:text-3xl font-semibold text-white tracking-tight">Voice Design</h1>
            <p className="text-[10px] uppercase tracking-[0.16em] text-[#DFFF00]/80">Tips</p>
            <p className="text-sm text-[#9CA3AF] leading-relaxed">
              Describe the character you want - include age, gender, emotion, pacing, speaking speed, use case, and other details in neutral language.
            </p>
          </div>
          <a
            href="/docs/guide-tts"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
          >
            <BookOpen size={14} />
            Guide
          </a>
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

            {vdPreview && (
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
                      {opt.url ? (() => {
                        const isThis = player.track?.src === opt.url;
                        const isPlaying = isThis && player.playing;
                        const onPlayPause = (e: React.MouseEvent) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (isPlaying) { player.pause(); return; }
                          if (isThis) { player.resume(); return; }
                          player.play({
                            src: opt.url,
                            title: `Voice option ${opt.key}`,
                            subtitle: opt.instruction.slice(0, 80),
                            downloadFilename: `vocence-voice-design-${opt.key}.wav`,
                          });
                        };
                        return (
                          <button
                            type="button"
                            onClick={onPlayPause}
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-full text-xs font-medium transition-colors ${
                              isPlaying ? 'bg-[#DFFF00] text-[#07080A]' : 'bg-white/10 text-white hover:bg-white/20'
                            }`}
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                          >
                            {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} className="ml-0.5" fill="currentColor" />}
                            {isPlaying ? 'Playing' : 'Play preview'}
                          </button>
                        );
                      })() : (
                        <p className="text-xs text-red-300/90">Audio unavailable.</p>
                      )}
                    </label>
                  ))}
                </div>

                {vdSavedVoiceId != null ? (
                  <div className="card-vocence p-6 space-y-4 border border-emerald-500/30 bg-emerald-500/[0.06]">
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="text-emerald-400 shrink-0" size={22} />
                      <div>
                        <p className="font-semibold text-white">Voice saved as “{vdDisplayName}”</p>
                        <p className="text-sm text-[#A7B0B7] mt-1">Use it now or design another.</p>
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
                          setVdPreview(null);
                          setVdDescription('');
                          setVdDisplayName('');
                        }}
                      >
                        Design another
                      </button>
                    </div>
                  </div>
                ) : (
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
                )}
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
            <div className="flex shrink-0 items-center gap-2 self-start sm:mt-1">
              <a
                href="/docs/guide-cloning"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
              >
                <BookOpen size={14} />
                Guide
              </a>
              <button
                type="button"
                onClick={() => (user ? openUploadVoice() : setIsAuthModalOpen(true))}
                className="rounded-xl border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/[0.08] hover:border-white/25 active:scale-[0.99]"
              >
                Upload my voice
              </button>
              <button
                type="button"
                onClick={() => navigate('/studio/voice-design')}
                className="rounded-xl border border-white/15 bg-white px-5 py-2.5 text-sm font-semibold text-[#07080A] shadow-sm shadow-black/10 transition-colors hover:bg-white/95 active:scale-[0.99]"
              >
                Create my voice
              </button>
            </div>
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
                      <button
                        type="button"
                        onClick={() => setDeleteConfirmVoiceId(v.id)}
                        className="absolute right-2 top-2 flex h-9 w-9 items-center justify-center rounded-full border border-white/10 bg-black/50 text-white backdrop-blur-sm transition-colors hover:border-red-400/30 hover:bg-red-500/20 hover:text-red-200"
                        aria-label="Delete voice"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                    <div className="px-4 pt-3 pb-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-white text-base leading-tight tracking-tight truncate flex-1 min-w-0">
                          {v.display_name || `Voice #${v.id}`}
                        </h3>
                        {v.source === 'cloned' ? (
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-200 border border-purple-400/30 shrink-0">
                            Cloned
                          </span>
                        ) : (
                          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[#DFFF00]/10 text-[#DFFF00]/85 border border-[#DFFF00]/25 shrink-0">
                            Designed
                          </span>
                        )}
                      </div>
                      {v.model_name ? (
                        <p className="text-[11px] text-[#6B7280] mt-0.5 truncate">{v.model_name}</p>
                      ) : null}
                    </div>

                    <div className="flex flex-1 flex-col gap-3 px-4 pt-2 pb-4">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#DFFF00]/85 mb-1">
                          Sample
                        </p>
                        <p className="text-sm text-[#C5CAD1] leading-relaxed line-clamp-3">“{v.ref_script}”</p>
                      </div>
                      {v.audio_url && !v.expired ? (() => {
                        const isThis = player.track?.src === v.audio_url;
                        const isPlaying = isThis && player.playing;
                        const onPlayPause = (e: React.MouseEvent) => {
                          e.stopPropagation();
                          if (isPlaying) { player.pause(); return; }
                          if (isThis) { player.resume(); return; }
                          player.play({
                            src: v.audio_url ?? '',
                            title: v.display_name || `My Voice ${v.id}`,
                            subtitle: v.ref_script?.slice(0, 80),
                            downloadFilename: `vocence-voice-design-${v.id}.wav`,
                          });
                        };
                        return (
                          <button
                            type="button"
                            onClick={onPlayPause}
                            className={`inline-flex items-center gap-2 px-3 py-2 rounded-full text-xs font-medium transition-colors ${
                              isPlaying ? 'bg-[#DFFF00] text-[#07080A]' : 'bg-white/10 text-white hover:bg-white/20'
                            }`}
                            aria-label={isPlaying ? 'Pause' : 'Play'}
                          >
                            {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} className="ml-0.5" fill="currentColor" />}
                            {isPlaying ? 'Playing' : 'Play sample'}
                          </button>
                        );
                      })() : (
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

        {uploadVoiceOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
            <div className="bg-[#0B0D10] border border-white/15 rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden shadow-2xl shadow-black/60">
              <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
                <h3 className="text-base font-semibold text-white">Add my voice</h3>
                <button
                  type="button"
                  onClick={closeUploadVoice}
                  disabled={uploadVoiceBusy}
                  className="text-[#666] hover:text-white p-1.5 rounded-md hover:bg-white/5 disabled:opacity-40"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-5 space-y-4">
                <p className="text-sm text-[#A7B0B7] leading-relaxed">
                  Upload or record a clear voice clip (5–30 seconds works best) and we'll save it as a reusable voice.
                  You can pick it on any agent or Studio call without re-uploading. We transcribe the clip
                  once on save so the reference text is ready when the voice is used.
                </p>

                <div>
                  <label className="block text-xs uppercase tracking-wider text-[#A7B0B7] mb-1.5">Voice name</label>
                  <input
                    type="text"
                    value={uploadVoiceName}
                    onChange={(e) => setUploadVoiceName(e.target.value)}
                    maxLength={40}
                    placeholder="e.g. My founder voice"
                    disabled={uploadVoiceBusy}
                    className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm text-white placeholder-[#666] focus:outline-none focus:border-white/30"
                  />
                </div>

                <div>
                  <label className="block text-xs uppercase tracking-wider text-[#A7B0B7] mb-1.5">Audio</label>
                  <div className="flex gap-2 mb-2">
                    <button
                      type="button"
                      onClick={() => { setUploadVoiceMode('upload'); stopUploadVoiceRecording(); }}
                      disabled={uploadVoiceBusy}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        uploadVoiceMode === 'upload'
                          ? 'border-[#DFFF00]/40 bg-[#DFFF00]/10 text-[#DFFF00]'
                          : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
                      }`}
                    >
                      Upload file
                    </button>
                    <button
                      type="button"
                      onClick={() => { setUploadVoiceMode('record'); setUploadVoiceFile(null); }}
                      disabled={uploadVoiceBusy}
                      className={`flex-1 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        uploadVoiceMode === 'record'
                          ? 'border-[#DFFF00]/40 bg-[#DFFF00]/10 text-[#DFFF00]'
                          : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
                      }`}
                    >
                      Record
                    </button>
                  </div>

                  {uploadVoiceMode === 'upload' ? (
                    <>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => setUploadVoiceFile(e.target.files?.[0] || null)}
                        disabled={uploadVoiceBusy}
                        className="block w-full text-sm text-[#A7B0B7] file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-semibold file:bg-white/[0.06] file:text-white hover:file:bg-white/[0.12]"
                      />
                      {uploadVoiceFile ? (
                        <p className="text-[11px] text-[#666] mt-1.5">
                          {uploadVoiceFile.name} · {(uploadVoiceFile.size / 1024 / 1024).toFixed(2)} MB
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <div className="flex flex-col items-center gap-3 py-4 rounded-lg border border-white/10 bg-white/[0.02]">
                      {uploadVoiceRecording ? (
                        <>
                          <div className="flex items-center gap-2">
                            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-sm font-mono text-white">
                              {String(Math.floor(uploadVoiceRecordSec / 60)).padStart(2, '0')}:{String(uploadVoiceRecordSec % 60).padStart(2, '0')}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={stopUploadVoiceRecording}
                            className="px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm font-medium hover:bg-red-500/30"
                          >
                            Stop recording
                          </button>
                        </>
                      ) : (
                        <>
                          {uploadVoiceFile ? (
                            <p className="text-xs text-[#A7B0B7]">
                              Recorded · {(uploadVoiceFile.size / 1024).toFixed(0)} KB
                            </p>
                          ) : (
                            <p className="text-xs text-[#A7B0B7]">5–30 seconds works best</p>
                          )}
                          <button
                            type="button"
                            onClick={startUploadVoiceRecording}
                            disabled={uploadVoiceBusy}
                            className="px-4 py-2 rounded-lg bg-[#DFFF00]/10 border border-[#DFFF00]/30 text-[#DFFF00] text-sm font-medium hover:bg-[#DFFF00]/20 disabled:opacity-40"
                          >
                            {uploadVoiceFile ? 'Re-record' : 'Start recording'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs uppercase tracking-wider text-[#A7B0B7] mb-1.5">
                    Language <span className="text-[#666] normal-case">(optional — leave on Auto-detect if unsure)</span>
                  </label>
                  {/* Fully-custom dropdown so the menu styling matches
                      the modal — native <select> opens a browser-themed
                      menu that clashes with our dark UI, especially on
                      Windows. The options list scrolls when it overflows. */}
                  <LanguagePicker
                    value={uploadVoiceLanguage}
                    onChange={setUploadVoiceLanguage}
                    disabled={uploadVoiceBusy}
                  />
                </div>

                {uploadVoiceError ? (
                  <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-200 text-sm px-3 py-2">
                    {uploadVoiceError}
                  </div>
                ) : null}
              </div>

              <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-white/10 bg-white/[0.02]">
                <button
                  type="button"
                  onClick={closeUploadVoice}
                  disabled={uploadVoiceBusy}
                  className="px-3 py-2 rounded-lg border border-white/10 text-sm text-[#A7B0B7] hover:text-white hover:border-white/20 disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submitUploadVoice()}
                  disabled={uploadVoiceBusy || !uploadVoiceFile || !uploadVoiceName.trim()}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 disabled:opacity-40"
                >
                  {uploadVoiceBusy ? 'Saving…' : 'Save voice'}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </>
    );
  };

  const renderTTSView = () => (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Text-to-Speech</h2>
          <p className="text-[#A7B0B7]">Synthesize natural sounding speech from text using top miners.</p>
        </div>
        <a
          href="/docs/guide-tts"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
        >
          <BookOpen size={14} />
          Guide
        </a>
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
                <div className="flex items-center justify-end mt-2 -mb-1">
                  <span
                    className={`text-[11px] tabular-nums ${
                      ttsText.length >= TTS_CONTENT_MAX_CHARS
                        ? 'text-amber-400'
                        : ttsText.length >= TTS_CONTENT_MAX_CHARS * 0.9
                          ? 'text-amber-300/70'
                          : 'text-[#666]'
                    }`}
                  >
                    {ttsText.length.toLocaleString()} / {TTS_CONTENT_MAX_CHARS.toLocaleString()}
                  </span>
                </div>
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Speech-to-Text</h2>
          <p className="text-[#A7B0B7]">
            Highly accurate transcription and translation for audio files.
          </p>
        </div>
        <a
          href="/docs/guide-stt"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
        >
          <BookOpen size={14} />
          Guide
        </a>
      </div>

      <div className="card-vocence p-6 space-y-6">
        {/* Upload / Record toggle */}
        <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {([
            { id: 'upload' as const, label: 'Upload file' },
            { id: 'record' as const, label: 'Record now' },
          ]).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (sttIsRecording) stopSttRecording();
                setSttMode(m.id);
                setSttFile(null);
              }}
              className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                sttMode === m.id ? 'bg-white/10 text-white' : 'text-[#A7B0B7] hover:text-white'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Source Zone */}
        {sttMode === 'upload' ? (
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
                  <p className="text-sm text-[#666]">MP3, WAV, M4A · max 3 minutes</p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="border-2 border-dashed border-white/10 rounded-2xl p-12 text-center">
            {sttIsRecording ? (
              <>
                <div className="flex items-center justify-center gap-3 mb-4">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
                  </span>
                  <span className="text-2xl font-mono tabular-nums text-white">
                    {Math.floor(sttRecordingSec / 60)}:{String(sttRecordingSec % 60).padStart(2, '0')}
                  </span>
                  <span className="text-sm text-[#666]">/ 3:00</span>
                </div>
                <button
                  type="button"
                  onClick={stopSttRecording}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90"
                >
                  Stop recording
                </button>
              </>
            ) : sttFile ? (
              <>
                <p className="mb-2 text-[#DFFF00]">{sttFile.name}</p>
                <p className="text-sm text-[#666] mb-4">{(sttFile.size / 1024 / 1024).toFixed(2)} MB</p>
                <button
                  type="button"
                  onClick={() => { setSttFile(null); void startSttRecording(); }}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/15 text-sm text-white hover:bg-white/5"
                >
                  <Mic size={14} /> Record again
                </button>
              </>
            ) : (
              <>
                <Mic size={40} className="mx-auto mb-4 text-[#666]" />
                <p className="mb-2 text-white">Record up to 3 minutes</p>
                <p className="text-sm text-[#666] mb-4">We'll ask for microphone permission.</p>
                <button
                  type="button"
                  onClick={() => void startSttRecording()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110"
                >
                  <Mic size={14} /> Start recording
                </button>
              </>
            )}
          </div>
        )}

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Voice Cloning</h2>
          <p className="text-[#A7B0B7] max-w-3xl">
            Upload a reference recording or capture one with your microphone. We transcribe the reference audio automatically,
            then synthesize your target text in that voice. Output is stored for 7 days — play or download below. Each run
            uses {CREDIT_VOICE_CLONE} credits.
          </p>
        </div>
        <a
          href="/docs/guide-cloning"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
        >
          <BookOpen size={14} />
          Guide
        </a>
      </div>

      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.04] p-4 text-sm text-cyan-100/90 flex gap-3">
        <Lightbulb size={16} className="shrink-0 mt-0.5 text-cyan-300" />
        <div className="space-y-1">
          <p><span className="font-semibold text-cyan-200">For best results:</span> use 5–10 seconds of a single speaker, with no background music and no clipping or distortion.</p>
          <p className="text-cyan-100/70 text-xs">If you know exactly what was said, type it as the reference script below — that's more accurate than auto-transcription. Leave it empty and we'll transcribe automatically.</p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="card-vocence p-6 space-y-4">
          <label className="label-mono block">Reference audio</label>
          <p className="text-xs text-[#666]">
            Choose one source: file upload (drag-and-drop) or microphone recording. Reference clip must be{' '}
            {CLONE_REF_MIN_SEC}–{CLONE_REF_MAX_SEC} seconds long.
          </p>
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
                  if (file) void acceptCloneReferenceFile(file);
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
                  if (file) void acceptCloneReferenceFile(file);
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

          <div>
            <label className="label-mono mb-2 block text-xs">Reference script (optional)</label>
            <textarea
              value={cloneReferenceScript}
              onChange={(e) => setCloneReferenceScript(e.target.value)}
              rows={3}
              placeholder="What is said in the reference clip — improves cloning accuracy. Leave empty and we'll auto-transcribe."
              className="w-full bg-[#0a0a0a] border border-white/10 rounded-xl px-3 py-2 text-sm text-white placeholder-[#666] outline-none resize-y"
            />
          </div>
        </div>

        <div className="card-vocence p-6 flex flex-col gap-4">
          <label className="label-mono block">Text to speak (target)</label>
          <p className="text-xs text-[#666]">
            This is what the cloned voice will say. Reference words come from your audio via automatic transcription.
          </p>
          <div
            className={cn(
              'bg-[#0a0a0a] rounded-xl p-4 border transition-colors flex-1 flex flex-col',
              cloneTargetLimitNotice
                ? 'border-amber-500/45 ring-1 ring-amber-500/20'
                : 'border-white/10'
            )}
          >
            <textarea
              rows={8}
              value={cloneTargetText}
              onChange={handleCloneTargetChange}
              placeholder="Type the sentence or paragraph you want to hear in the reference voice…"
              className="w-full flex-1 min-h-[200px] bg-transparent text-white placeholder-[#666] resize-y outline-none"
              aria-invalid={cloneTargetLimitNotice}
              aria-describedby={cloneTargetLimitNotice ? 'clone-target-limit-hint' : undefined}
            />
            <div className="flex items-center justify-end mt-2 -mb-1">
              <span
                className={`text-[11px] tabular-nums ${
                  cloneTargetText.length >= CLONE_TARGET_MAX_CHARS
                    ? 'text-amber-400'
                    : cloneTargetText.length >= CLONE_TARGET_MAX_CHARS * 0.9
                      ? 'text-amber-300/70'
                      : 'text-[#666]'
                }`}
              >
                {cloneTargetText.length.toLocaleString()} / {CLONE_TARGET_MAX_CHARS.toLocaleString()}
              </span>
            </div>
          </div>
          {cloneTargetLimitNotice ? (
            <p
              id="clone-target-limit-hint"
              className="text-xs text-amber-400/95 flex items-start gap-2 leading-relaxed"
              role="alert"
            >
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
              <span>
                Voice cloning text is limited to {CLONE_TARGET_MAX_CHARS.toLocaleString()} characters. Anything beyond
                that wasn&apos;t added—shorten your text or split it into multiple generations.
              </span>
            </p>
          ) : null}
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
      <StudioShell activeView={activeView}>
        <div className="max-w-6xl mx-auto">
            {activeView === 'chat' && !ENABLE_VOICE_CHAT && <ComingSoonView view={activeView} />}
            {activeView === 'home' && <StudioHome />}
            {activeView === 'tts' && (
              <div className="space-y-6">
                {/* Subpage tabs: General (sample-voice picker) / Style Prompt (PromptTTS) */}
                <div className="flex items-center gap-1 border-b border-white/10">
                  <button
                    type="button"
                    onClick={() => setTtsTab('general')}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      ttsTab === 'general'
                        ? 'border-[#DFFF00] text-white'
                        : 'border-transparent text-[#A7B0B7] hover:text-white'
                    }`}
                  >
                    General
                  </button>
                  <button
                    type="button"
                    onClick={() => setTtsTab('prompt')}
                    className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                      ttsTab === 'prompt'
                        ? 'border-[#DFFF00] text-white'
                        : 'border-transparent text-[#A7B0B7] hover:text-white'
                    }`}
                  >
                    Style Prompt
                  </button>
                </div>
                {ttsTab === 'general' ? <StudioTtsGeneral /> : renderTTSView()}
              </div>
            )}
            {activeView === 'stt' && renderSTTView()}
            {ENABLE_VOICE_CHAT && activeView === 'chat' && renderChatView()}
            {activeView === 'cloning' && renderCloningView()}
            {activeView === 'voice-design' && renderVoiceDesignView()}
            {activeView === 'my-voices' && renderMyVoicesView()}
            {activeView === 'music' && <StudioMusic />}
            {activeView === 'dubbing' && <StudioDubbing />}
            {activeView === 'playbooks' && <StudioPlaybooks />}
            {activeView === 'history' && (
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
                    <div className="rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.04] to-white/[0.01] p-3 mb-6">
                      <div className="flex flex-col sm:flex-row gap-2.5">
                        {/* Search */}
                        <div className="flex-1 min-w-[200px] group flex items-center gap-2.5 rounded-xl bg-[#0a0a0a] border border-white/[0.07] px-3.5 h-11 transition-colors focus-within:border-[#DFFF00]/40 focus-within:bg-[#0d0d0d]">
                          <Search size={16} className="text-[#666] group-focus-within:text-[#DFFF00]/80 transition-colors" />
                          <input
                            type="text"
                            placeholder="Search prompts, transcripts, clone text…"
                            value={studioHistorySearch}
                            onChange={(e) => setStudioHistorySearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm outline-none text-white placeholder-[#666]"
                          />
                          {studioHistorySearch && (
                            <button
                              type="button"
                              onClick={() => setStudioHistorySearch('')}
                              className="text-[#555] hover:text-white transition-colors"
                              aria-label="Clear search"
                            >
                              <X size={14} />
                            </button>
                          )}
                        </div>
                        {/* Category */}
                        <Select
                          value={studioHistoryCategory}
                          onValueChange={(v) =>
                            setStudioHistoryCategory(v as typeof studioHistoryCategory)
                          }
                        >
                          <SelectTrigger className="w-full sm:w-[210px] h-11 px-3.5 rounded-xl bg-[#0a0a0a] border border-white/[0.07] text-sm text-white transition-all hover:border-white/[0.18] data-[state=open]:border-[#DFFF00]/40 data-[state=open]:bg-[#0d0d0d]">
                            <SelectValue placeholder="All types" />
                          </SelectTrigger>
                          <SelectContent
                            position="popper"
                            sideOffset={6}
                            className="rounded-xl border border-white/[0.10] bg-[#0c0c0c] text-white shadow-2xl shadow-black/40 overflow-hidden p-1 [&_[data-slot=select-item]]:rounded-lg [&_[data-slot=select-item]]:focus:!bg-transparent [&_[data-slot=select-item]]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[state=checked]:!text-[#DFFF00] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!bg-white/[0.06] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!text-white [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!text-[#DFFF00]"
                          >
                            <SelectItem value="all">All types</SelectItem>
                            <SelectItem value="tts">Text-to-Speech</SelectItem>
                            <SelectItem value="stt">Speech-to-Text</SelectItem>
                            <SelectItem value="clone">Voice clone</SelectItem>
                            <SelectItem value="voice_design">My voice (Voice Design)</SelectItem>
                            <SelectItem value="music">Music Generation</SelectItem>
                          </SelectContent>
                        </Select>
                        {/* Date */}
                        <Select
                          value={studioHistoryDateRange}
                          onValueChange={(v) => setStudioHistoryDateRange(v as 'all' | '24h' | '7d' | '30d')}
                        >
                          <SelectTrigger className="w-full sm:w-[170px] h-11 px-3.5 rounded-xl bg-[#0a0a0a] border border-white/[0.07] text-sm text-white transition-all hover:border-white/[0.18] data-[state=open]:border-[#DFFF00]/40 data-[state=open]:bg-[#0d0d0d]">
                            <SelectValue placeholder="All time" />
                          </SelectTrigger>
                          <SelectContent
                            position="popper"
                            sideOffset={6}
                            className="rounded-xl border border-white/[0.10] bg-[#0c0c0c] text-white shadow-2xl shadow-black/40 overflow-hidden p-1 [&_[data-slot=select-item]]:rounded-lg [&_[data-slot=select-item]]:focus:!bg-transparent [&_[data-slot=select-item]]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[state=checked]:!text-[#DFFF00] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!bg-white/[0.06] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!text-white [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!text-[#DFFF00]"
                          >
                            <SelectItem value="all">All time</SelectItem>
                            <SelectItem value="24h">Last 24 hours</SelectItem>
                            <SelectItem value="7d">Last 7 days</SelectItem>
                            <SelectItem value="30d">Last 30 days</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    {/* Bulk-action bar */}
                    {studioHistorySelected.size > 0 && (
                      <div className="card-vocence px-4 py-3 mb-4 flex flex-wrap items-center gap-3">
                        <span className="text-sm text-white">
                          <span className="font-semibold">{studioHistorySelected.size}</span> selected
                        </span>
                        <button
                          type="button"
                          disabled={studioHistoryBulkBusy}
                          onClick={() => void openBulkAddToPlaybook()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-xs text-white hover:bg-white/5 disabled:opacity-50"
                        >
                          <Plus size={12} /> Add to playbook
                        </button>
                        <button
                          type="button"
                          disabled={studioHistoryBulkBusy}
                          onClick={() => void handleBulkDeleteHistory()}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-400/30 bg-red-500/10 text-xs text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                        >
                          <Trash2 size={12} /> Delete
                        </button>
                        <button
                          type="button"
                          onClick={() => setStudioHistorySelected(new Set())}
                          className="text-xs text-[#A7B0B7] hover:text-white ml-auto"
                        >
                          Clear selection
                        </button>
                      </div>
                    )}
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
                                <th className="px-3 py-3">
                                  <input
                                    type="checkbox"
                                    aria-label="Select page"
                                    onChange={togglePageAllSelected}
                                    checked={
                                      studioHistoryPageItems.length > 0 &&
                                      studioHistoryPageItems.every((it) => studioHistorySelected.has(_historyKey(it)))
                                    }
                                    className="w-4 h-4 accent-[#DFFF00]"
                                  />
                                </th>
                                <th className="px-4 py-3 text-left">Timestamp</th>
                                <th className="px-4 py-3 text-left">Type</th>
                                <th className="px-4 py-3 text-left">Content</th>
                                <th className="px-4 py-3 text-left">Style Prompt</th>
                                <th className="px-4 py-3 text-left">Model</th>
                                <th className="px-4 py-3 text-right">Actions</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5">
                              {studioHistoryPageItems.flatMap((item) => {
                                  const created = new Date(item.created_at);
                                  const timestamp = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                                  const date = created.toLocaleDateString();
                                  const isCloneLike =
                                    item.entry_type === 'clone' || item.entry_type === 'voice_design';
                                  const isMusic = item.entry_type === 'music';
                                  const rowKey = `${item.entry_type}-${item.id}`;
                                  const isExpanded = isMusic && studioHistoryExpandedIds.has(rowKey);
                                  const typeBadge =
                                    item.entry_type === 'stt'
                                      ? 'bg-green-500/15 text-green-400'
                                      : item.entry_type === 'clone'
                                        ? 'bg-cyan-500/15 text-cyan-400'
                                        : item.entry_type === 'voice_design'
                                          ? 'bg-violet-500/15 text-violet-300'
                                          : isMusic
                                            ? 'bg-pink-500/15 text-pink-300'
                                            : 'bg-[#DFFF00]/15 text-[#DFFF00]';
                                  const typeLabel =
                                    item.entry_type === 'voice_design'
                                      ? 'MY VOICE'
                                      : isMusic
                                        ? 'MUSIC'
                                        : item.entry_type.toUpperCase();
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
                                  // Parse music metadata lazily — only when this row is music.
                                  // The schema field is a JSON string ({}-default).
                                  const musicMeta: Record<string, unknown> = (() => {
                                    if (!isMusic) return {};
                                    try {
                                      return JSON.parse(item.music_metadata_json || '{}');
                                    } catch {
                                      return {};
                                    }
                                  })();
                                  const musicTask = item.music_task || 'text2music';
                                  const dlName = isCloneLike
                                    ? item.entry_type === 'voice_design'
                                      ? `vocence-voice-design-${item.id}.wav`
                                      : `vocence-clone-${item.id}.wav`
                                    : item.entry_type === 'music'
                                      ? `vocence-music-${item.id}.wav`
                                      : `vocence-tts-${item.id}.wav`;
                                  // Music rows are clickable to toggle the details
                                  // panel. We don't fire that on the checkbox click,
                                  // the play/download buttons, or anywhere we use
                                  // stopPropagation below.
                                  return [
                                    <tr
                                      key={rowKey}
                                      onClick={isMusic ? () => toggleStudioHistoryExpanded(rowKey) : undefined}
                                      className={`hover:bg-white/5 transition-colors ${isMusic ? 'cursor-pointer' : ''} ${studioHistorySelected.has(_historyKey(item)) ? 'bg-[#DFFF00]/[0.04]' : ''}`}
                                    >
                                      <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          aria-label="Select item"
                                          checked={studioHistorySelected.has(_historyKey(item))}
                                          onChange={() => toggleHistorySelected(_historyKey(item))}
                                          className="w-4 h-4 accent-[#DFFF00]"
                                        />
                                      </td>
                                      <td className="px-4 py-4">
                                        <div className="font-medium flex items-center gap-1.5">
                                          {isMusic && (
                                            isExpanded ? <ChevronDown size={14} className="text-[#A7B0B7]" /> : <ChevronRight size={14} className="text-[#A7B0B7]" />
                                          )}
                                          {timestamp}
                                        </div>
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
                                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(contentCopy); }}
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
                                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(styleCopy); }}
                                            >
                                              <Copy size={14} />
                                            </button>
                                          ) : null}
                                        </div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <span className="px-2 py-1 bg-[#0a0a0a] rounded text-xs">{item.display_name}</span>
                                      </td>
                                      <td
                                        className="px-4 py-4 text-right"
                                        onClick={(e) => e.stopPropagation()}
                                      >
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
                                              {(() => {
                                                const isThis = player.track?.src === item.audio_url;
                                                const isPlaying = isThis && player.playing;
                                                return (
                                                  <button
                                                    type="button"
                                                    onClick={() => {
                                                      if (isPlaying) { player.pause(); return; }
                                                      if (isThis) { player.resume(); return; }
                                                      player.play({
                                                        src: item.audio_url!,
                                                        title: (contentCopy || styleCopy || dlName).slice(0, 80),
                                                        subtitle: typeLabel,
                                                        downloadFilename: dlName,
                                                      });
                                                    }}
                                                    className={`p-1.5 ${isPlaying ? 'text-[#DFFF00]' : 'text-[#666] hover:text-white'}`}
                                                    title={isPlaying ? 'Pause' : 'Play'}
                                                  >
                                                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                                                  </button>
                                                );
                                              })()}
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
                                    </tr>,
                                    isExpanded ? (
                                      <tr key={`${rowKey}-details`} className="bg-[#0a0a0a]">
                                        <td colSpan={7} className="p-0">
                                          {(() => {
                                            // Mode-specific rows.
                                            const rows: { label: string; value: string; mono?: boolean }[] = [
                                              { label: 'Mode', value: musicTask.replace('2', ' to ').replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase()) },
                                              { label: 'Prompt', value: item.prompt_text || '' },
                                              { label: 'Lyrics', value: item.lyrics || '', mono: true },
                                            ];
                                            if (musicTask === 'audio2audio') {
                                              if (musicMeta.ref_audio_strength != null) rows.push({ label: 'Ref strength', value: String(musicMeta.ref_audio_strength) });
                                            } else if (musicTask === 'retake') {
                                              if (musicMeta.retake_variance != null) rows.push({ label: 'Variance', value: String(musicMeta.retake_variance) });
                                              if (musicMeta.retake_seeds) rows.push({ label: 'Seeds', value: String(musicMeta.retake_seeds) });
                                            } else if (musicTask === 'repaint') {
                                              if (musicMeta.repaint_start != null) rows.push({ label: 'Window start', value: `${musicMeta.repaint_start}s` });
                                              if (musicMeta.repaint_end != null) rows.push({ label: 'Window end', value: `${musicMeta.repaint_end}s` });
                                              if (musicMeta.retake_variance != null) rows.push({ label: 'Variance', value: String(musicMeta.retake_variance) });
                                            } else if (musicTask === 'edit') {
                                              if (musicMeta.edit_target_prompt) rows.push({ label: 'Target prompt', value: String(musicMeta.edit_target_prompt) });
                                              if (musicMeta.edit_target_lyrics) rows.push({ label: 'Target lyrics', value: String(musicMeta.edit_target_lyrics), mono: true });
                                              if (musicMeta.edit_n_min != null) rows.push({ label: 'n_min', value: String(musicMeta.edit_n_min) });
                                              if (musicMeta.edit_n_max != null) rows.push({ label: 'n_max', value: String(musicMeta.edit_n_max) });
                                            } else if (musicTask === 'extend') {
                                              if (musicMeta.left_extend_length != null) rows.push({ label: 'Left (sec)', value: String(musicMeta.left_extend_length) });
                                              if (musicMeta.right_extend_length != null) rows.push({ label: 'Right (sec)', value: String(musicMeta.right_extend_length) });
                                              if (musicMeta.extend_seeds) rows.push({ label: 'Seeds', value: String(musicMeta.extend_seeds) });
                                            }
                                            if (musicMeta.infer_step != null) rows.push({ label: 'Infer step', value: String(musicMeta.infer_step) });
                                            if (musicMeta.guidance_scale != null) rows.push({ label: 'Guidance', value: String(musicMeta.guidance_scale) });
                                            return (
                                              <div className="bg-white/[0.02] border-t border-white/5 px-6 py-3">
                                                <div className="text-[10px] uppercase tracking-wider text-[#666] mb-2">Generation details</div>
                                                <div className="space-y-0">
                                                  {rows.map((r) => {
                                                    if (!r.value) return null;
                                                    const fkey = `${rowKey}:${r.label}`;
                                                    const copied = studioHistoryCopiedKey === fkey;
                                                    return (
                                                      <div key={r.label} className="flex items-start gap-3 py-1.5">
                                                        <div className="text-[10px] uppercase tracking-wider text-[#666] w-32 shrink-0 pt-0.5">{r.label}</div>
                                                        <div className={`flex-1 min-w-0 text-sm text-[#C5CAD1] ${r.mono ? 'font-mono text-xs' : ''} whitespace-pre-wrap break-words`}>{r.value}</div>
                                                        <button
                                                          type="button"
                                                          onClick={(e) => { e.stopPropagation(); void studioHistoryCopyValue(fkey, r.value); }}
                                                          className={`shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
                                                            copied
                                                              ? 'border-[#DFFF00]/40 text-[#DFFF00] bg-[#DFFF00]/10'
                                                              : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/30'
                                                          }`}
                                                          title={`Copy ${r.label.toLowerCase()}`}
                                                        >
                                                          {copied ? <Check size={12} /> : <Copy size={12} />}
                                                          {copied ? 'Copied' : 'Copy'}
                                                        </button>
                                                      </div>
                                                    );
                                                  })}
                                                </div>
                                              </div>
                                            );
                                          })()}
                                        </td>
                                      </tr>
                                    ) : null,
                                  ];
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

      {/* Voice cloning consent (one-time) */}
      {showCloneConsent && (
        <VoiceCloneConsent
          onCancel={() => setShowCloneConsent(false)}
          onAccept={() => {
            setShowCloneConsent(false);
            void doCloneGenerate();
          }}
        />
      )}

      {/* Bulk add-to-playbook (history) */}
      {studioHistoryAddOpen && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setStudioHistoryAddOpen(false)}>
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0f1115] p-5 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-white">Add to playbook</h3>
              <button onClick={() => setStudioHistoryAddOpen(false)} className="text-[#666] hover:text-white" aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-[#A7B0B7]">
              Adding {studioHistorySelected.size} item{studioHistorySelected.size === 1 ? '' : 's'}. STT and expired items will be skipped.
            </p>
            {studioPlaybooksList.length === 0 ? (
              <p className="text-sm text-[#A7B0B7]">No playbooks yet — create one first from the Playbooks page.</p>
            ) : (
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {studioPlaybooksList.map((pb) => (
                  <button
                    key={pb.id}
                    type="button"
                    onClick={() => setStudioHistoryAddTarget(pb.id)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                      studioHistoryAddTarget === pb.id
                        ? 'bg-[#DFFF00]/10 border border-[#DFFF00]/35 text-white'
                        : 'border border-transparent hover:bg-white/[0.04] text-[#C5CAD1]'
                    }`}
                  >
                    {pb.title}
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setStudioHistoryAddOpen(false)} className="px-4 py-2 text-sm rounded-xl text-[#A7B0B7] hover:text-white hover:bg-white/5">Cancel</button>
              <button
                onClick={() => void handleBulkAddToPlaybook()}
                disabled={!studioHistoryAddTarget || studioHistoryBulkBusy}
                className="px-4 py-2 text-sm rounded-xl bg-[#DFFF00] text-[#07080A] font-semibold hover:brightness-110 disabled:opacity-50"
              >
                {studioHistoryBulkBusy ? 'Adding…' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Clone samples section — shown at bottom of voice cloning page
   ========================================================================== */

const CLONE_SAMPLE_TRACKS = [
  { id: 'cs1', name: 'Const', avatar: asset('clone.const'), originalAudio: asset('clone-audio.const'), clonedAudio: asset('clone-audio.clone_const'), originalLabel: 'Reference', clonedLabel: 'Cloned' },
  { id: 'cs2', name: 'Mark Jeffery', avatar: asset('clone.mark_jeffery'), originalAudio: asset('clone-audio.mark_jeffery'), clonedAudio: asset('clone-audio.clone_mark'), originalLabel: 'Reference', clonedLabel: 'Cloned' },
  { id: 'cs3', name: 'Micaela', avatar: asset('clone.micaela'), originalAudio: asset('clone-audio.micaela'), clonedAudio: asset('clone-audio.clone_micaela'), originalLabel: 'Reference', clonedLabel: 'Cloned' },
  { id: 'cs4', name: 'Sophia', avatar: asset('clone.sophia'), originalAudio: asset('clone-audio.sophia'), clonedAudio: asset('clone-audio.clone_sophia'), originalLabel: 'Reference', clonedLabel: 'Cloned' },
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
