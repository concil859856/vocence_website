import { useState, useRef, useEffect } from 'react';
import {
  Mic,
  MessageSquare,
  Users,
  History,
  Upload,
  Play,
  MoreHorizontal,
  ChevronDown,
  Send,
  Square,
} from 'lucide-react';
import gsap from 'gsap';
import { useAuth } from '../contexts/AuthContext';
import { AuthModal } from '../components/AuthModal';
import { useNavigate } from 'react-router-dom';
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
  const { user, isAuthenticated, updateCredits } = useAuth();
  const navigate = useNavigate();
  const [activeView, setActiveView] = useState<StudioView>('tts');
  const [topModels, setTopModels] = useState<StudioTopModel[]>([]);
  const [topModelsLoading, setTopModelsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<StudioTopModel | null>(null);
  const [generateLoading, setGenerateLoading] = useState(false);
  const [studioHistory, setStudioHistory] = useState<StudioHistoryItem[]>([]);
  const [studioHistoryLoading, setStudioHistoryLoading] = useState(false);
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

      setGenerateLoading(true);
      dashboardApi
        .generateStudioTts({
          user_id: user.id,
          miner_hotkey: selectedModel.miner_hotkey,
          model_name: selectedModel.model_name,
          chute_id: selectedModel.chute_id,
          chute_slug: selectedModel.chute_slug,
          text: ttsText.trim(),
          style_instruction: ttsStylePrompt.trim() || undefined,
        })
        .then((res) => {
          navigate(`/studio/result/${res.id}`);
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
                  <h2 className="text-2xl font-semibold mb-2">TTS History</h2>
                  <p className="text-[#A7B0B7]">
                    Your generated audio. Available for 7 days; after that you can generate a new one.
                  </p>
                </div>
                {!user ? (
                  <div className="card-vocence p-6 text-center">
                    <p className="text-[#A7B0B7] mb-4">Sign in to see your TTS history.</p>
                    <button onClick={() => setIsAuthModalOpen(true)} className="btn-primary">
                      Sign in
                    </button>
                  </div>
                ) : studioHistoryLoading ? (
                  <div className="flex items-center justify-center py-12 gap-2 text-[#A7B0B7]">
                    <div className="w-5 h-5 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
                    Loading history...
                  </div>
                ) : studioHistory.length === 0 ? (
                  <div className="card-vocence p-8 text-center">
                    <History size={40} className="mx-auto mb-4 text-[#666]" />
                    <p className="text-[#A7B0B7]">No TTS generations yet.</p>
                    <p className="text-sm text-[#666] mt-1">Generate audio from the Text-to-Speech tab.</p>
                    <button onClick={() => setActiveView('tts')} className="btn-primary mt-4">
                      Go to Text-to-Speech
                    </button>
                  </div>
                ) : (
                  <div className="card-vocence p-6">
                    <ul className="space-y-4">
                      {studioHistory.map((item) => (
                        <li
                          key={item.id}
                          className="flex flex-wrap items-center justify-between gap-4 py-4 border-b border-white/10 last:border-0"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{item.display_name}</p>
                            <p className="text-sm text-[#A7B0B7] truncate mt-0.5">{item.prompt_text}</p>
                            <p className="text-xs text-[#666] mt-1">
                              {new Date(item.created_at).toLocaleString()} · Style: {item.style_instruction}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {item.expired ? (
                              <span className="text-xs text-[#666]">Expired</span>
                            ) : item.audio_url ? (
                              <>
                                <a
                                  href={item.audio_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="btn-outline text-sm py-2"
                                >
                                  Play / Download
                                </a>
                                <button
                                  onClick={() => navigate(`/studio/result/${item.id}`)}
                                  className="btn-outline text-sm py-2"
                                >
                                  Open player
                                </button>
                              </>
                            ) : (
                              <span className="text-xs text-[#666]">Unavailable</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
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
