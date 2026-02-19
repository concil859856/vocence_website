import { useState, useEffect, useRef } from 'react';
import { useLocation, Link } from 'react-router-dom';
import { ChevronRight, Copy, BookOpen, Mic, Code, Layers, Terminal } from 'lucide-react';
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
  const [copiedCode, setCopiedCode] = useState(false);
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

  const handleCopyCode = () => {
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

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
          Introduction to the Vocence decentralized voice protocol and its place in the Bittensor ecosystem.
        </p>
      </div>

      {/* What is Vocence */}
      <section>
        <h2 className="text-2xl font-semibold mb-4">What is Vocence?</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Vocence is a Bittensor subnet dedicated to training, evaluating, and improving prompt-based text-to-speech (PromptTTS) models. Unlike traditional TTS systems that merely convert text into audio, PromptTTS models generate speech from all-in prompts that combine transcription with explicit control signals, including voice characteristics (gender, age, emotion, tone), speaking style, accent and non-native speech patterns, as well as environmental attributes such as background noise, recording conditions, and overall acoustic context.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          Our protocol incentivizes miners to host the latest open-source voice models and fine-tune them for specific use cases, creating a competitive marketplace for AI voice generation.
        </p>
      </section>

      {/* Whitepaper CTA */}
      <section className="bg-white/5 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-3">Full technical overview</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          For the complete picture—including PromptTTS, evaluation pipeline, roadmap, and governance—see the whitepaper.
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
          Understand the fundamental concepts behind the Vocence protocol.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Prompt-to-Speech</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Unlike traditional TTS systems that only convert text into audio, PromptTTS models
          generate speech from rich prompts that include transcription plus explicit voice
          characteristics such as gender, age, emotion, tone, speaking style, and other
          vocal traits.
        </p>
        <div className="card-vocence p-6 mt-6">
          <h3 className="font-medium mb-3">Example Prompt</h3>
          <code className="block bg-[#0a0a0a] p-4 rounded-lg text-sm text-[#A7B0B7]">
            "A calm, middle-aged male voice, neutral accent, slow pace, warm tone, reading
            the following sentence..."
          </code>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Decentralized Training</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Vocence introduces a decentralized incentive system where miners compete to produce
          PromptTTS models that best follow voice-trait prompts, while validators objectively
          evaluate audio quality, content correctness, and prompt adherence.
        </p>
        <div className="grid md:grid-cols-3 gap-4 mt-6">
          {[
            { title: 'Miners', desc: 'Train and serve TTS models', icon: Layers },
            { title: 'Validators', desc: 'Evaluate and score outputs', icon: Terminal },
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
          High-level overview of the Vocence system architecture.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">System Overview</h2>
        <p className="text-[#A7B0B7] leading-7 mb-6">
          Miners train or fine-tune PromptTTS models and serve inference endpoints.
          Validators generate tasks, score outputs, and distribute rewards. Datasets are
          sourced from open speech corpora and enriched with structured voice-trait
          annotations.
        </p>

        <div className="card-vocence p-8">
          <div className="grid md:grid-cols-3 gap-8 text-center">
            <div>
              <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
                <Layers size={28} className="text-[#DFFF00]" />
              </div>
              <h3 className="font-semibold mb-2">Miners</h3>
              <p className="text-sm text-[#A7B0B7]">
                Train models and serve inference endpoints
              </p>
            </div>
            <div>
              <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
                <Terminal size={28} className="text-[#DFFF00]" />
              </div>
              <h3 className="font-semibold mb-2">Validators</h3>
              <p className="text-sm text-[#A7B0B7]">
                Generate tasks and evaluate outputs
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
          Validator scoring focuses on three core dimensions: content correctness, audio
          quality, and prompt adherence. These scores are combined into a single reward
          signal.
        </p>
        <ul className="space-y-3 mt-4">
          {[
            'Content Correctness - Word Error Rate (WER) and transcription accuracy',
            'Audio Quality - Mean Opinion Score (MOS) and naturalness metrics',
            'Prompt Adherence - How well the output matches the voice trait description',
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
        q: 'What makes Vocence different from existing TTS subnets?',
        a: 'Vocence explicitly evaluates prompt adherence, not just audio quality or intelligibility.',
      },
      {
        q: 'Do miners need to train models from scratch?',
        a: 'No. Miners may fine-tune existing models or develop new architectures.',
      },
      {
        q: 'Is the evaluation model public?',
        a: 'Yes. All evaluation logic is open and reproducible.',
      },
      {
        q: 'Can Vocence support commercial use cases?',
        a: 'Yes. Outputs are suitable for voice agents, games, assistants, and accessibility tools.',
      },
      {
        q: 'How does Vocence prevent prompt cheating?',
        a: 'Through adversarial prompts, cross-validation, and multi-axis scoring.',
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

  const renderValidatorSetup = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Validator Setup</h1>
        <p className="text-xl text-[#A7B0B7]">
          How to set up and run a Vocence validator: environment, credentials, and CLI.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Overview</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Validators evaluate miners by sending PromptTTS tasks (reference audio + text + voice traits) to miner Chutes, collecting generated speech, and scoring outputs for content correctness, audio quality, and prompt adherence. Scores are stored in the validator&apos;s own S3 bucket and used to set on-chain weights so that better-performing miners receive more TAO.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          The validator runs two loops: (1) a sample generation loop that pulls reference audio from the corpus, queries miners via the Chutes API, scores with GPT-4o, and uploads results to S3; (2) a weight-setting loop that reads recent evaluations, computes scores, and sets weights on the Bittensor chain. You need a registered coldkey/hotkey, access to the corpus (read-only), and your own storage for samples.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Environment Setup</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Clone the Vocence repo, install dependencies, and copy <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">env.example</code> to <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">.env</code>. Then set the variables below. All other options (cycle length, timeouts, bucket names, etc.) have defaults and can be left unset for a standard run.
        </p>

        <h3 className="text-lg font-semibold text-white mt-6 mb-3">Required credentials in <code className="text-[#DFFF00]">.env</code></h3>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-4">
          <div className="px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-[#666]">.env (main ones)</div>
          <div className="p-4 space-y-3 font-mono text-sm text-[#A7B0B7]">
            <div><span className="text-[#DFFF00]">NETWORK</span>=finney          <span className="text-[#666]"># finney (mainnet) or test (testnet)</span></div>
            <div><span className="text-[#DFFF00]">NETUID</span>=22              <span className="text-[#666]"># Subnet ID (22 mainnet, 385 testnet)</span></div>
            <div><span className="text-[#DFFF00]">WALLET_NAME</span>=default   <span className="text-[#666]"># Coldkey name</span></div>
            <div><span className="text-[#DFFF00]">HOTKEY_NAME</span>=default    <span className="text-[#666]"># Hotkey name</span></div>
            <div><span className="text-[#DFFF00]">CHUTES_API_KEY</span>=...     <span className="text-[#666]"># Chutes API key (query miner Chutes)</span></div>
            <div><span className="text-[#DFFF00]">OPENAI_AUTH_KEY</span>=...   <span className="text-[#666]"># OpenAI API key (GPT-4o for scoring)</span></div>
            <div><span className="text-[#DFFF00]">HIPPIUS_CORPUS_ACCESS_KEY</span>=...   <span className="text-[#666]"># Owner-provided read-only key for corpus bucket</span></div>
            <div><span className="text-[#DFFF00]">HIPPIUS_CORPUS_SECRET_KEY</span>=...</div>
            <div><span className="text-[#DFFF00]">HIPPIUS_VALIDATOR_ACCESS_KEY</span>=... <span className="text-[#666]"># Your Hippius key for samples bucket</span></div>
            <div><span className="text-[#DFFF00]">HIPPIUS_VALIDATOR_SECRET_KEY</span>=...</div>
          </div>
        </div>
        <p className="text-[#A7B0B7] leading-7 text-sm">
          Corpus credentials are read-only (owner gives you a sub_key for the evaluation corpus). Validator credentials are for your own Hippius bucket where evaluation samples and metadata are stored. Get keys at <a href="https://console.hippius.com/dashboard/settings" target="_blank" rel="noopener noreferrer" className="text-[#DFFF00] hover:underline">console.hippius.com</a>.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Run the Validator</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          From the project root (with <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">.env</code> in place):
        </p>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-4">
          <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
            <span className="text-xs font-mono text-[#666]">bash</span>
            <button type="button" onClick={handleCopyCode} className="text-xs text-[#666] hover:text-white flex items-center gap-1">
              <Copy size={14} /> {copiedCode ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="p-4">
            <pre className="font-mono text-sm text-[#A7B0B7]">vocence serve</pre>
          </div>
        </div>
        <p className="text-[#A7B0B7] leading-7">
          This starts the full validator: sample generation (corpus → miners → score → upload to your S3) and weight setting (read scores from S3 → set weights on chain). Run until you stop it (e.g. Ctrl+C). For advanced setups you can run the generator and weight setter as separate services via <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">vocence services generator</code> and <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">vocence services validator</code>.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">How the Validator Works (Simple)</h2>
        <ul className="list-disc list-inside space-y-2 text-[#A7B0B7] leading-7">
          <li>Reads the list of valid miners from the subnet (commitments on chain + optional centralized API).</li>
          <li>Pulls reference audio from the shared corpus bucket (owner-populated).</li>
          <li>Builds tasks: reference clip + extracted text + voice traits; sends each task to miner Chutes via the Chutes API.</li>
          <li>Collects generated audio, scores it with GPT-4o (content, quality, prompt adherence), and uploads results to the validator&apos;s own S3 bucket.</li>
          <li>Periodically computes scores from the most recent evaluations and sets weights on-chain so higher-scoring miners get a larger share of rewards.</li>
        </ul>
      </section>
    </div>
  );

  const renderMinerSetup = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Miner Setup</h1>
        <p className="text-xl text-[#A7B0B7]">
          What miners need to do to run a valid PromptTTS miner: deploy to Chutes, commit on chain, and stay eligible.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">What You Need to Be a Valid Miner</h2>
        <ul className="list-disc list-inside space-y-2 text-[#A7B0B7] leading-7 mb-4">
          <li>A Bittensor wallet (coldkey + hotkey) with enough TAO for transaction fees.</li>
          <li>A PromptTTS-capable model (e.g. HuggingFace repo). You can fine-tune an existing model or train your own.</li>
          <li>A Chutes account and API key so you can deploy your model as a Chute and expose it for inference.</li>
        </ul>
        <p className="text-[#A7B0B7] leading-7">
          Validators will discover you only after you commit your model info and Chute ID on-chain. Until then, you will not receive evaluation traffic or rewards.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Environment setup (.env)</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Copy <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">env.example</code> to <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">.env</code> in the project root. For miner commands you only need the following (other variables are for validators or owner services).
        </p>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-4">
          <div className="px-4 py-2 bg-white/5 border-b border-white/10 text-xs font-mono text-[#666]">.env (miner)</div>
          <div className="p-4 space-y-3 font-mono text-sm text-[#A7B0B7]">
            <div><span className="text-[#DFFF00]">NETWORK</span>=finney          <span className="text-[#666]"># finney (mainnet) or test (testnet)</span></div>
            <div><span className="text-[#DFFF00]">NETUID</span>=22              <span className="text-[#666]"># Subnet ID (22 mainnet, 385 testnet)</span></div>
            <div><span className="text-[#DFFF00]">WALLET_NAME</span>=default   <span className="text-[#666]"># Coldkey name (for commit)</span></div>
            <div><span className="text-[#DFFF00]">HOTKEY_NAME</span>=default    <span className="text-[#666]"># Hotkey name (for commit)</span></div>
            <div><span className="text-[#DFFF00]">CHUTES_API_KEY</span>=...     <span className="text-[#666]"># Chutes API key (for deploy); also accepts CHUTES_AUTH_KEY</span></div>
            <div><span className="text-[#DFFF00]">CHUTE_USER</span>=...         <span className="text-[#666]"># Chutes username (optional, for deploy)</span></div>
          </div>
        </div>
        <p className="text-[#A7B0B7] leading-7 text-sm">
          Wallet names can also be passed per-command with <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">--coldkey</code> and <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">--hotkey</code>.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">What Miners Need to Do</h2>

        <h3 className="text-lg font-semibold text-white mt-6 mb-3">1. Deploy your model to Chutes</h3>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Deploy your TTS model so it is callable via the Chutes API. You need the HuggingFace repository ID and the exact commit (revision) you want to serve. Ensure <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">CHUTES_AUTH_KEY</code> (or <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">CHUTES_API_KEY</code>) and optionally <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">CHUTE_USER</code> are set in your <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">.env</code>, then run:
        </p>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-4">
          <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
            <span className="text-xs font-mono text-[#666]">bash</span>
            <button type="button" onClick={handleCopyCode} className="text-xs text-[#666] hover:text-white flex items-center gap-1">
              <Copy size={14} /> {copiedCode ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="p-4">
            <pre className="font-mono text-sm text-[#A7B0B7]">{`vocence miner push --model-name owner/prompt-tts-model --model-revision <commit_sha>`}</pre>
          </div>
        </div>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          This deploys the model to Chutes and returns a <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">chute_id</code>. Save it for the next step.
        </p>

        <h3 className="text-lg font-semibold text-white mt-6 mb-3">2. Commit model info to the chain</h3>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Register your deployment on the Bittensor subnet so validators can find and query your Chute. Use the same <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">model-name</code>, <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">model-revision</code>, and the <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">chute_id</code> from the push step. Wallet is read from <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">COLDKEY_NAME</code> / <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">HOTKEY_NAME</code> or pass <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">--coldkey</code> and <code className="bg-white/10 px-1.5 py-0.5 rounded text-sm">--hotkey</code>.
        </p>
        <div className="bg-[#0a0a0a] border border-white/10 rounded-xl overflow-hidden mb-4">
          <div className="flex items-center justify-between px-4 py-2 bg-white/5 border-b border-white/10">
            <span className="text-xs font-mono text-[#666]">bash</span>
            <button type="button" onClick={handleCopyCode} className="text-xs text-[#666] hover:text-white flex items-center gap-1">
              <Copy size={14} /> {copiedCode ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="p-4">
            <pre className="font-mono text-sm text-[#A7B0B7]">{`vocence miner commit --model-name owner/prompt-tts-model --model-revision <commit_sha> --chute-id <chute_id>`}</pre>
          </div>
        </div>
        <p className="text-[#A7B0B7] leading-7">
          After a successful commit, validators will include you in evaluation rounds. When you update the model or redeploy, run push again (new revision or same), then commit again with the new chute_id or revision so the chain reflects the current deployment.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">What to Care About</h2>
        <ul className="list-disc list-inside space-y-2 text-[#A7B0B7] leading-7">
          <li><strong className="text-white">Uptime and latency</strong> — Your Chute must respond to validator requests within the expected timeout. Frequent failures or slow responses can reduce your score.</li>
          <li><strong className="text-white">Prompt adherence</strong> — Validators score how well your output matches the requested voice traits and content. Models that ignore the prompt will rank lower.</li>
          <li><strong className="text-white">Correctness and quality</strong> — Speech should be intelligible, match the transcript, and sound natural. Overfitting to a narrow set of prompts can hurt you as evaluation tasks vary.</li>
          <li><strong className="text-white">Keeping commitments up to date</strong> — If you change model or Chute, re-commit so the chain points to the correct chute_id and revision.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">How It Will Be Used</h2>
        <p className="text-[#A7B0B7] leading-7">
          Validators send you tasks with a <strong className="text-white">description only</strong>: the text to speak and voice/style traits (e.g. gender, age, emotion, tone, accent). No reference audio is sent. Your Chute should synthesize speech that matches the text and the requested characteristics. The validator compares your output to the prompt and to other miners, then assigns scores. Those scores drive on-chain weights: higher scores mean a larger share of TAO rewards. Your goal is to run a stable, prompt-faithful PromptTTS endpoint that validators can call reliably.
        </p>
      </section>
    </div>
  );

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
        return renderMinerSetup();
      case 'validator':
        return renderValidatorSetup();
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
