import { useState, useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { ChevronRight, BookOpen, Mic, Code, Layers, Terminal } from 'lucide-react';
import gsap from 'gsap';

type DocSection = 'getting-started' | 'core-concepts' | 'architecture' | 'api' | 'sdk' | 'models' | 'cloning' | 'integration' | 'miner' | 'validator' | 'faq' | 'troubleshooting';

interface DocLink {
  id: DocSection;
  label: string;
  category: string;
}

const docLinks: DocLink[] = [
  { id: 'getting-started', label: 'Getting Started', category: 'Introduction' },
  { id: 'core-concepts', label: 'Core Concepts', category: 'Introduction' },
  { id: 'architecture', label: 'Architecture', category: 'Introduction' },
  { id: 'api', label: 'API Reference', category: 'Development' },
  { id: 'sdk', label: 'SDKs & Libraries', category: 'Development' },
  { id: 'models', label: 'Models', category: 'Development' },
  { id: 'cloning', label: 'Voice Cloning', category: 'Development' },
  { id: 'integration', label: 'Integration Guide', category: 'Guides' },
  { id: 'miner', label: 'Miner Setup', category: 'Guides' },
  { id: 'validator', label: 'Validator Setup', category: 'Guides' },
  { id: 'faq', label: 'FAQ', category: 'Support' },
  { id: 'troubleshooting', label: 'Troubleshooting', category: 'Support' },
];

const DOC_SECTIONS: DocSection[] = ['getting-started', 'core-concepts', 'architecture', 'api', 'sdk', 'models', 'cloning', 'integration', 'miner', 'validator', 'faq', 'troubleshooting'];

export function Docs() {
  const location = useLocation();
  const [activeSection, setActiveSection] = useState<DocSection>('getting-started');
  const docsRef = useRef<HTMLDivElement>(null);

  // Open section from hash (e.g. /docs#api)
  useEffect(() => {
    const hash = location.hash.slice(1) as DocSection;
    if (hash && DOC_SECTIONS.includes(hash)) {
      setActiveSection(hash);
    }
  }, [location.hash]);

  useEffect(() => {
    gsap.fromTo(
      '.docs-sidebar',
      { opacity: 0, x: -20 },
      { opacity: 1, x: 0, duration: 0.5 }
    );
    gsap.fromTo(
      '.docs-content',
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, duration: 0.5, delay: 0.2 }
    );
  }, []);

  const renderGettingStarted = () => (
    <div className="space-y-10">
      {/* Header */}
      <div className="border-b border-white/10 pb-8">
        <div className="flex items-center gap-2 text-sm text-[#666] mb-4">
          <span>Docs</span>
          <ChevronRight size={14} />
          <span>Introduction</span>
          <ChevronRight size={14} />
          <span className="text-[#DFFF00]">Getting Started</span>
        </div>
        <h1 className="text-4xl font-bold mb-4">Getting Started with Vocence</h1>
        <p className="text-xl text-[#A7B0B7] leading-relaxed">
          Introduction to the Vocence Voice Intelligence Layer—a decentralized protocol for PromptTTS, STT, STS, voice cloning, TTM, and voice agents—and its place in the Bittensor ecosystem.
        </p>
      </div>

      {/* What is Vocence */}
      <section>
        <h2 className="text-2xl font-semibold mb-4">What is Vocence?</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Vocence is a Bittensor subnet focused on the development, training, evaluation, and improvement of a wide range of voice intelligence models: PromptTTS (text-to-speech), STT (speech-to-text), STS (speech-to-speech), voice cloning, TTM (text-to-music), and voice agents. This decentralized network goes beyond traditional voice synthesis by integrating multiple layers of multimodal voice intelligence, enabling dynamic voice agents with advanced control and adaptability.
        </p>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Miners train and serve models that respond to detailed prompts—voice characteristics (gender, age, emotion, tone), speaking style, accent, and environmental factors. Validators assess performance using public evaluation pipelines, ensuring prompt adherence, content accuracy, and environmental consistency across use cases from natural speech to interactive voice agents and music generation.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          By leveraging a decentralized incentive structure, Vocence fosters an open, permissionless ecosystem where voice models evolve into intelligent, context-aware agents adaptable to a wide array of tasks.
        </p>
      </section>

      {/* Whitepaper CTA */}
      <section className="bg-white/5 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-3">Full technical overview</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          For the complete picture—including all voice domains (PromptTTS, STT, STS, voice cloning, TTM, voice agents), evaluation pipeline, roadmap, and governance—see the whitepaper.
        </p>
        <Link
          to="/whitepaper"
          className="inline-flex items-center gap-2 text-[#DFFF00] hover:underline font-medium"
        >
          Read the Whitepaper
          <ChevronRight size={18} />
        </Link>
      </section>

      {/* Next Steps */}
      <section className="pt-8 border-t border-white/10">
        <h2 className="text-2xl font-semibold mb-6">Next Steps</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <button
            onClick={() => setActiveSection('api')}
            className="group p-5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left"
          >
            <div className="flex items-center justify-between mb-3">
              <BookOpen size={24} className="text-[#DFFF00]" />
              <ChevronRight
                size={18}
                className="text-[#666] group-hover:translate-x-1 transition-transform"
              />
            </div>
            <h3 className="font-semibold mb-1">API Reference</h3>
            <p className="text-sm text-[#A7B0B7]">
              Explore the full capabilities of our REST API and SDK methods.
            </p>
          </button>

          <button
            onClick={() => setActiveSection('cloning')}
            className="group p-5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-left"
          >
            <div className="flex items-center justify-between mb-3">
              <Mic size={24} className="text-[#DFFF00]" />
              <ChevronRight
                size={18}
                className="text-[#666] group-hover:translate-x-1 transition-transform"
              />
            </div>
            <h3 className="font-semibold mb-1">Voice Cloning</h3>
            <p className="text-sm text-[#A7B0B7]">
              Learn how to clone voices with just a few seconds of audio.
            </p>
          </button>
        </div>
      </section>
    </div>
  );

  const renderCoreConcepts = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Core Concepts</h1>
        <p className="text-xl text-[#A7B0B7]">
          Understand the fundamental concepts behind the Vocence Voice Intelligence Layer.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Voice Intelligence Domains</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Vocence spans multiple voice and audio domains: PromptTTS (prompt-based text-to-speech), STT (speech-to-text), STS (speech-to-speech), voice cloning, TTM (text-to-music), and voice agents. Unlike traditional TTS that only converts text to audio, PromptTTS and related models accept rich prompts that specify voice characteristics (gender, age, emotion, tone), speaking style, accent, and environmental context.
        </p>
        <div className="card-vocence p-6 mt-6">
          <h3 className="font-medium mb-3">Example Prompt (PromptTTS)</h3>
          <code className="block bg-[#0a0a0a] p-4 rounded-lg text-sm text-[#A7B0B7]">
            &quot;A calm, middle-aged male voice, neutral accent, slow pace, warm tone, reading
            the following sentence…&quot;
          </code>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Decentralized Training & Evaluation</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Miners train and serve models across PromptTTS, STT, STS, voice cloning, TTM, and voice agents. Validators assess outputs using public evaluation pipelines—content correctness, audio quality, prompt adherence, and environmental consistency—so the best models are rewarded and the ecosystem improves across all voice intelligence domains.
        </p>
        <div className="grid md:grid-cols-3 gap-4 mt-6">
          {[
            { title: 'Miners', desc: 'Train and serve voice models across all domains', icon: Layers },
            { title: 'Validators', desc: 'Evaluate and score outputs with public benchmarks', icon: Terminal },
            { title: 'Consensus', desc: 'On-chain reward distribution', icon: Code },
          ].map((item, i) => (
            <div key={i} className="card-vocence p-5">
              <item.icon size={24} className="text-[#DFFF00] mb-3" />
              <h3 className="font-medium mb-1">{item.title}</h3>
              <p className="text-sm text-[#A7B0B7]">{item.desc}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );

  const renderArchitecture = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Architecture</h1>
        <p className="text-xl text-[#A7B0B7]">
          High-level overview of the Vocence Voice Intelligence Layer and how miners, validators, and Chutes interact.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">System Overview</h2>
        <p className="text-[#A7B0B7] leading-7 mb-6">
          Miners train or fine-tune models across PromptTTS, STT, STS, voice cloning, TTM, and voice agents, and deploy them as inference services on Chutes. Models are exposed via a standardized API. Validators interact with deployed models via the Chutes API to submit evaluation tasks, collect generated outputs, and compute scores. Evaluation tasks are continuously sourced from dynamically updated online data streams (e.g. YouTube and other public platforms) to prevent overfitting and ensure robust, generalizable performance.
        </p>

        <div className="card-vocence p-8">
          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
                <Layers size={28} className="text-[#DFFF00]" />
              </div>
              <h3 className="font-semibold mb-2">Miners</h3>
              <p className="text-sm text-[#A7B0B7]">
                Train/serve voice models on Chutes across all voice domains
              </p>
            </div>
            <div>
              <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
                <Terminal size={28} className="text-[#DFFF00]" />
              </div>
              <h3 className="font-semibold mb-2">Validators</h3>
              <p className="text-sm text-[#A7B0B7]">
                Generate tasks, evaluate outputs, distribute rewards
              </p>
            </div>
            <div>
              <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
                <Code size={28} className="text-[#DFFF00]" />
              </div>
              <h3 className="font-semibold mb-2">Bittensor</h3>
              <p className="text-sm text-[#A7B0B7]">
                On-chain consensus and rewards
              </p>
            </div>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Evaluation Pipeline</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Validator scoring focuses on three core dimensions: content correctness, audio quality, and prompt adherence. These are combined into a single reward signal across TTS, STT, STS, voice cloning, TTM, and voice agents. Evaluation code is open source and metrics are reproducible.
        </p>
        <ul className="space-y-3 mt-4">
          {[
            'Content Correctness – transcription accuracy and semantic fidelity',
            'Audio Quality – naturalness and environmental consistency',
            'Prompt Adherence – how well the output matches the voice trait and style description',
          ].map((item, i) => (
            <li key={i} className="flex items-start gap-3">
              <span className="text-[#DFFF00] mt-1">✓</span>
              <span className="text-[#A7B0B7]">{item}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );

  const renderAPI = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">API Reference</h1>
        <p className="text-xl text-[#A7B0B7]">
          Complete reference for the Vocence REST API.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Authentication</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          All API requests require an API key passed in the Authorization header.
        </p>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden">
          <div className="px-4 py-2 bg-white/5 border-b border-white/10">
            <span className="text-xs font-mono text-[#666]">http</span>
          </div>
          <div className="p-4">
            <code className="text-sm text-[#A7B0B7]">
              Authorization: Bearer{' '}
              <span className="text-green-400">your_api_key_here</span>
            </code>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Generate Speech</h2>
        <div className="flex items-center gap-3 mb-4">
          <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs font-mono rounded">
            POST
          </span>
          <code className="text-sm">/v1/generate</code>
        </div>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Generate speech from a transcript and a style prompt. The model produces audio that speaks the given text with the voice and delivery described in the style prompt.
        </p>

        <h3 className="font-medium mb-3">Request Body Parameters</h3>
        <ul className="space-y-4 mb-6 text-[#A7B0B7] leading-7">
          <li>
            <code className="text-[#DFFF00] bg-white/10 px-1.5 py-0.5 rounded text-sm">text</code>
            <span className="block mt-1">The exact words to be spoken—the transcript or script. Can be a single phrase, a sentence, or a longer passage. The generated audio will articulate this content with the voice, tone, and conditions specified in <code className="text-white/80">style_prompt</code>. Keep punctuation and formatting as you want them reflected in prosody (e.g. pauses, emphasis).</span>
          </li>
          <li>
            <code className="text-[#DFFF00] bg-white/10 px-1.5 py-0.5 rounded text-sm">style_prompt</code>
            <span className="block mt-1">An all-in description of how the speech should sound. Combine transcription intent with explicit control signals. Include: voice characteristics (e.g. gender, age, emotion, tone), speaking style and pace, accent or non-native patterns, and optionally environmental attributes (e.g. background noise, recording conditions, acoustic context). Example: a calm, middle-aged male voice, neutral accent, slow pace, warm tone; or: excited, high-pitch, American accent, whispering, high-noise. The more precise the description, the closer the output matches your intent.</span>
          </li>
        </ul>

        <h3 className="font-medium mb-3">Request Body Example</h3>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-6">
          <div className="p-4">
            <pre className="font-mono text-sm text-[#A7B0B7] whitespace-pre-wrap">
              {`{
  "text": "Welcome to the decentralized future of voice AI. Vocence turns rich, multi-dimensional speech prompts into natural audio.",
  "style_prompt": "A calm, middle-aged male voice, neutral accent, slow pace, warm tone, professional delivery"
}`}
            </pre>
          </div>
        </div>

        <h3 className="font-medium mb-3">Response</h3>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden">
          <div className="p-4">
            <pre className="font-mono text-sm text-[#A7B0B7]">
              {`{
  "id": "gen_123456",
  "status": "completed",
  "audio_url": "https://api.vocence.ai/v1/audio/gen_123456.wav",
  "duration": 2.5,
  "model": "v3-neural"
}`}
            </pre>
          </div>
        </div>
      </section>
    </div>
  );

  const renderFAQ = () => {
    const faqs = [
      {
        q: 'What makes Vocence different from existing voice subnets?',
        a: 'Vocence explicitly evaluates prompt adherence across a wide range of voice technologies, not just audio quality or intelligibility. It supports PromptTTS, STT, STS, voice cloning, TTM, and voice agents, ensuring comprehensive evaluation and development of voice models.',
      },
      {
        q: 'Do miners need to train models from scratch?',
        a: 'No. Miners can fine-tune existing models or develop new architectures, making it easier for contributors to participate and improve upon pre-trained models.',
      },
      {
        q: 'Is the evaluation model public?',
        a: 'Yes. All evaluation logic is open source and reproducible, ensuring transparency and enabling anyone to verify the evaluation process.',
      },
      {
        q: 'Can Vocence support commercial use cases?',
        a: 'Yes. Outputs are suitable for a wide range of commercial applications, including voice agents, interactive games, virtual assistants, and accessibility tools.',
      },
      {
        q: 'How does Vocence prevent prompt cheating?',
        a: 'Through adversarial prompts, cross-validation between validators, and multi-axis scoring, which ensures models adhere to prompts across multiple voice characteristics (e.g., tone, emotion, accent) and reduces the risk of manipulation.',
      },
    ];
    return (
      <div className="space-y-10">
        <div className="border-b border-white/10 pb-8">
          <h1 className="text-4xl font-bold mb-4">FAQ</h1>
          <p className="text-xl text-[#A7B0B7]">
            Frequently asked questions about Vocence.
          </p>
        </div>

        <section className="space-y-6">
          {faqs.map((item, index) => (
            <div
              key={index}
              className="border border-white/10 rounded-xl p-6 bg-white/[0.02] hover:border-white/20 transition-colors"
            >
              <h3 className="text-lg font-semibold text-white mb-3">Q: {item.q}</h3>
              <p className="text-[#A7B0B7] leading-7">A: {item.a}</p>
            </div>
          ))}
        </section>
      </div>
    );
  };

  const renderDefault = (title: string, description: string) => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">{title}</h1>
        <p className="text-xl text-[#A7B0B7]">{description}</p>
      </div>

      <div className="card-vocence p-12 text-center">
        <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
          <Terminal size={28} className="text-[#DFFF00]" />
        </div>
        <h2 className="text-xl font-semibold mb-2">Coming Soon</h2>
        <p className="text-[#A7B0B7]">
          This documentation section is being updated. Check back soon for the latest
          content.
        </p>
      </div>
    </div>
  );

  const renderContent = () => {
    switch (activeSection) {
      case 'getting-started':
        return renderGettingStarted();
      case 'core-concepts':
        return renderCoreConcepts();
      case 'architecture':
        return renderArchitecture();
      case 'api':
        return renderAPI();
      case 'sdk':
        return renderDefault('SDKs & Libraries', 'Official SDKs for various programming languages.');
      case 'models':
        return renderDefault('Models', 'Available voice models and their specifications.');
      case 'cloning':
        return renderDefault('Voice Cloning', 'Learn how to clone voices with the Vocence API.');
      case 'integration':
        return renderDefault('Integration Guide', 'Step-by-step guide to integrate Vocence into your application.');
      case 'miner':
        return renderDefault('Miner Setup', 'How to set up and run a Vocence miner.');
      case 'validator':
        return renderDefault('Validator Setup', 'How to set up and run a Vocence validator.');
      case 'faq':
        return renderFAQ();
      case 'troubleshooting':
        return renderDefault('Troubleshooting', 'Common issues and their solutions.');
      default:
        return renderGettingStarted();
    }
  };

  // Group links by category
  const groupedLinks = docLinks.reduce((acc, link) => {
    if (!acc[link.category]) acc[link.category] = [];
    acc[link.category].push(link);
    return acc;
  }, {} as Record<string, DocLink[]>);

  return (
    <div ref={docsRef} className="min-h-screen bg-[#07080A] pt-20">
      <div className="flex">
        {/* Sidebar */}
        <aside className="docs-sidebar w-64 border-r border-white/5 bg-[#07080A] min-h-screen p-6 hidden lg:block overflow-y-auto">
          <div className="space-y-8">
            {Object.entries(groupedLinks).map(([category, links]) => (
              <div key={category}>
                <h4 className="text-xs font-semibold text-[#666] uppercase tracking-wider mb-3">
                  {category}
                </h4>
                <ul className="space-y-1">
                  {links.map((link) => (
                    <li key={link.id}>
                      <button
                        onClick={() => setActiveSection(link.id)}
                        className={`w-full text-left px-3 py-2 text-sm rounded-md transition-colors ${
                          activeSection === link.id
                            ? 'bg-[#DFFF00]/10 text-[#DFFF00] border-r-2 border-[#DFFF00]'
                            : 'text-[#A7B0B7] hover:text-white'
                        }`}
                      >
                        {link.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        {/* Main Content */}
        <main className="docs-content flex-1 p-6 lg:p-12">
          <div className="max-w-3xl mx-auto">{renderContent()}</div>
        </main>
      </div>
    </div>
  );
}
