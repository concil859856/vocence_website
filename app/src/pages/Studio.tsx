import { useState, useRef, useEffect } from 'react';
import {
  Mic,
  MessageSquare,
  Users,
  History,
  Upload,
  Play,
  Pause,
  Download,
  Volume2,
  X,
  MoreHorizontal,
  ChevronDown,
  Send,
  Square,
  Search,
  Copy,
} from 'lucide-react';
import gsap from 'gsap';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { AuthModal } from '../components/AuthModal';
import { dashboardApi, type StudioTopModel, type StudioHistoryItem } from '../services/dashboardApi';

type StudioView = 'tts' | 'stt' | 'chat' | 'cloning' | 'history';

interface ClonedVoice {
  id: string;
  name: string;
  status: 'active' | 'processing';
  createdAt: string;
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

const sidebarItems = [
  { id: 'tts' as StudioView, label: 'Text-to-Speech', icon: Mic },
  { id: 'stt' as StudioView, label: 'Speech-to-Text', icon: MessageSquare },
  { id: 'chat' as StudioView, label: 'Voice Chat', icon: MessageSquare },
  { id: 'cloning' as StudioView, label: 'Voice Cloning', icon: Users },
  { id: 'history' as StudioView, label: 'History', icon: History },
];

// Top 3 models from main validator; loaded in TTS view

const clonedVoices: ClonedVoice[] = [
  { id: '1', name: 'Podcast Host Alpha', status: 'active', createdAt: '2d ago' },
  { id: '2', name: 'Marketing Narrator', status: 'active', createdAt: '1w ago' },
  { id: '3', name: 'Professional Voice', status: 'processing', createdAt: 'Just now' },
];

export function Studio() {
  const navigate = useNavigate();
  const { user, isAuthenticated, updateCredits } = useAuth();
  const [activeView, setActiveView] = useState<StudioView>('tts');
  const [topModels, setTopModels] = useState<StudioTopModel[]>([]);
  const [topModelsLoading, setTopModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<StudioTopModel | null>(null);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [studioHistory, setStudioHistory] = useState<StudioHistoryItem[]>([]);
  const [studioHistoryLoading, setStudioHistoryLoading] = useState(false);
  const [studioHistorySearch, setStudioHistorySearch] = useState('');
  const [resultOverlay, setResultOverlay] = useState<{
    id: number;
    audioUrl: string;
    promptText: string;
    styleInstruction: string;
    modelName: string;
  } | null>(null);
  const [similarityBoost, setSimilarityBoost] = useState(85);
  const [stability, setStability] = useState(60);
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
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [ttsText, setTtsText] = useState('');
  const [ttsStylePrompt, setTtsStylePrompt] = useState('');
  const [selectedLanguage, setSelectedLanguage] = useState('auto-detect');
  const [sttFile, setSttFile] = useState<File | null>(null);
  const [cloningFile, setCloningFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [cloningMode, setCloningMode] = useState<'upload' | 'record'>('upload');
  const [isMicRecording, setIsMicRecording] = useState(false);
  const [getVoiceDescription, setGetVoiceDescription] = useState(false);
  const studioRef = useRef<HTMLDivElement>(null);
  const sttFileInputRef = useRef<HTMLInputElement>(null);
  const cloningFileInputRef = useRef<HTMLInputElement>(null);
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
    if (activeView !== 'tts') return;
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

  const requireAuth = (callback: () => void) => {
    if (!isAuthenticated) {
      setIsAuthModalOpen(true);
      return;
    }
    callback();
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

  const handleOverlayDownload = () => {
    if (!resultOverlay?.audioUrl) return;
    const a = document.createElement('a');
    a.href = resultOverlay.audioUrl;
    a.download = `vocence-tts-${resultOverlay.id}.wav`;
    a.click();
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

  const handleGenerateAudio = () => {
    requireAuth(() => {
      if (!ttsText.trim()) {
        alert('Please enter text to generate audio');
        return;
      }
      if (!selectedModel || !user) {
        alert('Please select a model');
        return;
      }
      if (user.credits < 10) {
        alert('Insufficient credits. TTS generation costs 10 credits. Please add more credits.');
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
      if (user && user.credits < 2) {
        alert('Insufficient credits. Speech-to-Text requires 2 credits.');
        return;
      }

      alert('Starting transcription... (This is a demo)');
      
      // Save to history
      saveToHistory({
        type: 'stt',
        content: 'audio_file.mp3',
        model: 'English',
        meta: 'Auto-detect',
        duration: '0:00',
      });

      // Deduct credits
      if (user) {
        updateCredits(user.credits - 2);
      }
    });
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

  const handleBeginCloning = () => {
    requireAuth(() => {
      if (user && user.credits < 10) {
        alert('Insufficient credits. Voice Cloning requires 10 credits.');
        return;
      }

      alert('Starting voice cloning process... (This is a demo)');
      
      // Save to history
      saveToHistory({
        type: 'cloning',
        content: 'Voice Clone',
        model: 'Cloning Model',
        meta: `${similarityBoost}% similarity`,
        duration: 'Processing...',
      });

      // Deduct credits
      if (user) {
        updateCredits(user.credits - 10);
      }
    });
  };

  const renderTTSView = () => (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Text-to-Speech</h2>
        <p className="text-[#A7B0B7]">
          Synthesize natural sounding speech from text using top miners (ranked by main validator).
        </p>
      </div>

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
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
            <textarea
              rows={6}
              placeholder="Type or paste your text here..."
              value={ttsText}
              onChange={(e) => setTtsText(e.target.value)}
              className="w-full bg-transparent text-white placeholder-[#666] resize-none outline-none"
            />
          </div>
        </div>

        {/* Style Instruction */}
        <div>
          <label className="label-mono mb-3 block">Style Instruction (Optional)</label>
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
            <input
              type="text"
              placeholder="e.g. neutral voice, excited, high-pitch, american accent..."
              value={ttsStylePrompt}
              onChange={(e) => setTtsStylePrompt(e.target.value)}
              className="w-full bg-transparent text-white placeholder-[#666] outline-none"
            />
          </div>
          <p className="text-xs text-[#666] mt-1">Defaults to &quot;neutral voice&quot; if left empty.</p>
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
                Generate Audio
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );

  const renderSTTView = () => (
    <div className="space-y-6 relative">
      <div className="blur-[2px] pointer-events-none select-none">
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
            className="border-2 border-dashed border-white/10 rounded-2xl p-12 text-center hover:border-white/20 transition-colors cursor-pointer"
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

        {/* Language Selection */}
        <div>
          <label className="label-mono mb-3 block">Language Selection</label>
          <div className="relative">
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value)}
              className="w-full bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-white cursor-pointer appearance-none pr-10"
            >
              <option value="auto-detect">Auto-detect</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="ru">Russian</option>
              <option value="ko">Korean</option>
              <option value="ar">Arabic</option>
              <option value="hi">Hindi</option>
            </select>
            <ChevronDown
              size={16}
              className="absolute right-4 top-1/2 -translate-y-1/2 text-[#666] pointer-events-none"
            />
          </div>
        </div>

        {/* Checkbox */}
        <label className="flex items-center gap-3 cursor-pointer group">
          <div className="relative">
            <input
              type="checkbox"
              checked={getVoiceDescription}
              onChange={(e) => setGetVoiceDescription(e.target.checked)}
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

        {/* Actions */}
        <div className="flex justify-end">
          <button onClick={handleStartTranscription} className="btn-primary">
            <Mic size={16} className="mr-2" />
            Start Transcription
          </button>
        </div>
      </div>
      </div>
      
      {/* Coming Soon Overlay */}
      <div className="absolute inset-0 flex items-start justify-end z-10 pt-4 pr-4">
        <div className="text-right translate-x-[250px] -translate-y-[70px]">
          <h3 className="text-2xl md:text-3xl font-bold text-[#DFFF00] mb-1">Coming Soon</h3>
          <p className="text-sm text-[#A7B0B7]">This feature is under development</p>
        </div>
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
      <div className="absolute inset-0 flex items-start justify-end z-10 pt-4 pr-4">
        <div className="text-right translate-x-[250px] -translate-y-[70px]">
          <h3 className="text-2xl md:text-3xl font-bold text-[#DFFF00] mb-1">Coming Soon</h3>
          <p className="text-sm text-[#A7B0B7]">This feature is under development</p>
        </div>
      </div>
    </div>
  );

  const renderCloningView = () => (
    <div className="space-y-6 relative">
      <div className="blur-[2px] pointer-events-none select-none">
        <div>
          <h2 className="text-2xl font-semibold mb-2">Voice Cloning</h2>
          <p className="text-[#A7B0B7]">
            Create high-fidelity digital twins of any voice using just 30 seconds of audio.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
        {/* Step 1: Upload or Record */}
        <div className="card-vocence p-6">
          <label className="label-mono mb-4 block">Step 1: Upload Samples or Record</label>
          
          {/* Mode Toggle */}
          <div className="grid grid-cols-2 gap-2 mb-4">
            <button
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

          {/* Upload Mode */}
          {cloningMode === 'upload' && (
            <>
              <input
                ref={cloningFileInputRef}
                type="file"
                accept="audio/*,.wav,.mp3,.flac"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    setCloningFile(file);
                  }
                }}
              />
              <div
                onClick={() => cloningFileInputRef.current?.click()}
                className="border-2 border-dashed border-white/10 rounded-2xl p-10 text-center hover:border-white/20 transition-colors cursor-pointer mb-6"
              >
                {cloningFile ? (
                  <>
                    <Upload size={32} className="mx-auto mb-3 text-[#DFFF00]" />
                    <p className="text-sm mb-1 text-[#DFFF00]">{cloningFile.name}</p>
                    <p className="text-xs text-[#666]">{(cloningFile.size / 1024 / 1024).toFixed(2)} MB</p>
                  </>
                ) : (
                  <>
                    <Upload size={32} className="mx-auto mb-3 text-[#666]" />
                    <p className="text-sm mb-1">Drop audio files or click to upload</p>
                    <p className="text-xs text-[#666]">WAV, MP3 or FLAC (Min. 30s recommended)</p>
                  </>
                )}
              </div>
            </>
          )}

          {/* Record Mode */}
          {cloningMode === 'record' && (
            <div className="border-2 border-dashed border-white/10 rounded-2xl p-10 text-center mb-6">
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
                onClick={() => {
                  setIsRecording(!isRecording);
                  // TODO: Implement audio recording
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
                    Stop Recording
                  </>
                ) : (
                  <>
                    <Mic size={16} className="inline mr-2" />
                    Start Recording
                  </>
                )}
              </button>
              {isRecording && (
                <p className="text-xs text-[#666] mt-3">Recording in progress...</p>
              )}
            </div>
          )}

          <div>
            <label className="label-mono mb-2 block">Voice Name</label>
            <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-3">
              <input
                type="text"
                placeholder="e.g. My Professional Avatar"
                className="w-full bg-transparent text-white placeholder-[#666] outline-none text-sm"
              />
            </div>
          </div>
        </div>

        {/* Step 2: Parameters */}
        <div className="card-vocence p-6">
          <label className="label-mono mb-4 block">Step 2: Parameters</label>

          <div className="space-y-6">
            <div>
              <div className="flex justify-between mb-2">
                <span className="label-mono">Similarity Boost</span>
                <span className="text-sm">{similarityBoost}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={similarityBoost}
                onChange={(e) => setSimilarityBoost(Number(e.target.value))}
                className="w-full accent-[#DFFF00]"
              />
              <p className="text-xs text-[#666] mt-1">
                Higher values capture more nuance but may introduce artifacts.
              </p>
            </div>

            <div>
              <div className="flex justify-between mb-2">
                <span className="label-mono">Stability</span>
                <span className="text-sm">{stability}%</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={stability}
                onChange={(e) => setStability(Number(e.target.value))}
                className="w-full accent-[#DFFF00]"
              />
              <p className="text-xs text-[#666] mt-1">
                Controls how much the voice varies across generations.
              </p>
            </div>

            <div>
              <label className="label-mono mb-3 block">Privacy Level</label>
              <div className="grid grid-cols-2 gap-3">
                <button className="p-4 rounded-xl border border-[#DFFF00] bg-[#DFFF00]/5 text-sm">
                  Private
                </button>
                <button className="p-4 rounded-xl border border-white/10 bg-white/[0.02] text-sm opacity-50">
                  Public (Earn TAO)
                </button>
              </div>
            </div>
          </div>

          <button onClick={handleBeginCloning} className="btn-primary w-full mt-6">
            Begin Cloning Process
          </button>
        </div>
      </div>

      {/* Cloned Voices */}
      <div className="card-vocence p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="font-semibold">Your Cloned Voices</h3>
          <span className="text-xs text-[#666]">3 OF 5 SLOTS USED</span>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          {clonedVoices.map((voice) => (
            <div
              key={voice.id}
              className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4"
            >
              {voice.status === 'processing' ? (
                <div className="flex flex-col items-center justify-center h-full py-6">
                  <div className="w-8 h-8 rounded-full bg-[#07080A] flex items-center justify-center mb-2">
                    <span className="text-lg">⟳</span>
                  </div>
                  <p className="text-sm">Processing Clone...</p>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h4 className="text-sm font-medium mb-1">{voice.name}</h4>
                      <span className="inline-block px-2 py-0.5 bg-[#DFFF00]/20 rounded text-[10px] text-[#DFFF00] font-medium">
                        ACTIVE
                      </span>
                    </div>
                    <button className="text-[#666] hover:text-white">
                      <MoreHorizontal size={18} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1 h-10 mb-3">
                    {Array.from({ length: 20 }).map((_, i) => (
                      <div
                        key={i}
                        className="w-1 bg-[#DFFF00] rounded-full"
                        style={{ height: `${20 + Math.random() * 60}%`, opacity: 0.6 }}
                      />
                    ))}
                  </div>
                  <p className="text-xs text-[#666] mb-3">Created {voice.createdAt}</p>
                  <button className="w-8 h-8 bg-white text-[#07080A] rounded-full flex items-center justify-center hover:bg-[#DFFF00] transition-colors">
                    <Play size={14} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
      </div>
      
      {/* Coming Soon Overlay */}
      <div className="absolute inset-0 flex items-start justify-end z-10 pt-4 pr-4">
        <div className="text-right translate-x-[250px] -translate-y-[70px]">
          <h3 className="text-2xl md:text-3xl font-bold text-[#DFFF00] mb-1">Coming Soon</h3>
          <p className="text-sm text-[#A7B0B7]">This feature is under development</p>
        </div>
      </div>
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

      <div className="flex">
        {/* Sidebar */}
        <aside className="studio-sidebar w-64 border-r border-white/5 bg-[#07080A] min-h-screen p-4 hidden lg:block">
          <div className="space-y-1">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeView === item.id
                    ? 'bg-white/10 text-white'
                    : 'text-[#A7B0B7] hover:bg-white/5 hover:text-white'
                }`}
              >
                <item.icon size={18} />
                {item.label}
              </button>
            ))}
          </div>

          {/* Credit Balance */}
          <div className="mt-16 p-4 bg-white/[0.03] rounded-xl">
            <div className="text-xs text-[#666] uppercase tracking-wider mb-2">
              Credit Balance
            </div>
            <div className="text-xl font-semibold mb-1">
              {user?.credits || 0} <span className="text-sm text-[#A7B0B7] font-normal">credits</span>
            </div>
            <button className="btn-outline w-full mt-3 text-xs py-2">Add Credits</button>
          </div>
        </aside>

        {/* Mobile Sidebar */}
        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#07080A] border-t border-white/5 p-2 z-50">
          <div className="flex justify-around">
            {sidebarItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveView(item.id)}
                className={`p-3 rounded-lg ${
                  activeView === item.id ? 'text-[#DFFF00]' : 'text-[#666]'
                }`}
              >
                <item.icon size={20} />
              </button>
            ))}
          </div>
        </div>

        {/* Main Content */}
        <main className="studio-content flex-1 p-6 lg:p-10 pb-24 lg:pb-10">
          <div className="max-w-4xl mx-auto">
            {activeView === 'tts' && renderTTSView()}
            {activeView === 'stt' && renderSTTView()}
            {activeView === 'chat' && renderChatView()}
            {activeView === 'cloning' && renderCloningView()}
            {activeView === 'history' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-2xl font-semibold mb-2">History</h2>
                  <p className="text-[#A7B0B7]">View and manage your TTS generations. Available for 7 days.</p>
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
                            placeholder="Search prompts or style..."
                            value={studioHistorySearch}
                            onChange={(e) => setStudioHistorySearch(e.target.value)}
                            className="flex-1 bg-transparent text-sm outline-none text-white placeholder-[#666]"
                          />
                        </div>
                      </div>
                    </div>
                    {studioHistoryLoading ? (
                      <div className="flex items-center justify-center py-12 gap-2 text-[#A7B0B7]">
                        <div className="w-5 h-5 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
                        Loading history...
                      </div>
                    ) : studioHistory.filter((h) => !studioHistorySearch.trim() || h.prompt_text.toLowerCase().includes(studioHistorySearch.toLowerCase()) || h.style_instruction.toLowerCase().includes(studioHistorySearch.toLowerCase())).length === 0 ? (
                      <div className="card-vocence p-12 text-center">
                        <p className="text-[#A7B0B7] mb-4">No history found</p>
                        <p className="text-sm text-[#666]">
                          {studioHistory.length === 0
                            ? "You haven't generated any audio yet. Use the Text-to-Speech tab to get started."
                            : 'Try adjusting your search.'}
                        </p>
                        {studioHistory.length === 0 && (
                          <button onClick={() => setActiveView('tts')} className="btn-primary mt-4">
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
                              {studioHistory
                                .filter((h) => !studioHistorySearch.trim() || h.prompt_text.toLowerCase().includes(studioHistorySearch.toLowerCase()) || h.style_instruction.toLowerCase().includes(studioHistorySearch.toLowerCase()))
                                .map((item) => {
                                  const created = new Date(item.created_at);
                                  const timestamp = created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                                  const date = created.toLocaleDateString();
                                  return (
                                    <tr key={item.id} className="hover:bg-white/5 transition-colors">
                                      <td className="px-4 py-4">
                                        <div className="font-medium">{timestamp}</div>
                                        <div className="text-xs text-[#666]">{date}</div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-[#DFFF00]/15 text-[#DFFF00]">TTS</span>
                                      </td>
                                      <td className="px-4 py-4">
                                        <div className="flex items-center gap-2">
                                          <span className="truncate max-w-[200px]">{item.prompt_text}</span>
                                          <button className="text-[#666] hover:text-white" onClick={() => navigator.clipboard.writeText(item.prompt_text)}>
                                            <Copy size={14} />
                                          </button>
                                        </div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <div className="flex items-center gap-2">
                                          <span className="text-[#A7B0B7] truncate max-w-[150px]">{item.style_instruction}</span>
                                          <button className="text-[#666] hover:text-white" onClick={() => navigator.clipboard.writeText(item.style_instruction)}>
                                            <Copy size={14} />
                                          </button>
                                        </div>
                                      </td>
                                      <td className="px-4 py-4">
                                        <span className="px-2 py-1 bg-[#0a0a0a] rounded text-xs">{item.display_name}</span>
                                      </td>
                                      <td className="px-4 py-4 text-right">
                                        <div className="flex items-center justify-end gap-2">
                                          {item.expired ? (
                                            <>
                                              <button
                                                type="button"
                                                onClick={() => navigate(`/studio/result/${item.id}`)}
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
                                                onClick={() => navigate(`/studio/result/${item.id}`)}
                                                className="p-1.5 text-[#666] hover:text-white"
                                                title="Play"
                                              >
                                                <Play size={16} />
                                              </button>
                                              <a href={item.audio_url} download={`vocence-tts-${item.id}.wav`} className="p-1.5 text-[#666] hover:text-white" title="Download">
                                                <Download size={16} />
                                              </a>
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
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Auth Modal */}
      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
      />
    </div>
  );
}
