import { useState, useEffect, useRef } from 'react';
import { useLocation, Link, useParams } from 'react-router-dom';
import {
  ChevronRight,
  BookOpen,
  Mic,
  Code,
  Layers,
  Terminal,
  KeyRound,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';
import gsap from 'gsap';
import { formatCreditsCompact } from '../utils/formatCredits';

type DocSection = 'getting-started' | 'core-concepts' | 'architecture' | 'api' | 'pricing' | 'sdk' | 'models' | 'cloning' | 'integration' | 'miner' | 'validator' | 'faq' | 'troubleshooting';

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
  { id: 'pricing', label: 'Pricing', category: 'Development' },
  { id: 'sdk', label: 'SDKs & Libraries', category: 'Development' },
  { id: 'models', label: 'Models', category: 'Development' },
  { id: 'cloning', label: 'Voice Cloning', category: 'Development' },
  { id: 'integration', label: 'Integration Guide', category: 'Guides' },
  { id: 'miner', label: 'Miner Setup', category: 'Guides' },
  { id: 'validator', label: 'Validator Setup', category: 'Guides' },
  { id: 'faq', label: 'FAQ', category: 'Support' },
  { id: 'troubleshooting', label: 'Troubleshooting', category: 'Support' },
];

const DOC_SECTIONS: DocSection[] = ['getting-started', 'core-concepts', 'architecture', 'api', 'pricing', 'sdk', 'models', 'cloning', 'integration', 'miner', 'validator', 'faq', 'troubleshooting'];

export function Docs() {
  const location = useLocation();
  const params = useParams<{ section?: string }>();
  const sectionParamRaw = (params.section || '').toLowerCase();
  const [activeSection, setActiveSection] = useState<DocSection>('getting-started');
  const docsRef = useRef<HTMLDivElement>(null);

  // Open section from route param (e.g. /docs/api)
  useEffect(() => {
    if (!sectionParamRaw) return;
    if (DOC_SECTIONS.includes(sectionParamRaw as DocSection)) {
      setActiveSection(sectionParamRaw as DocSection);
    }
  }, [sectionParamRaw]);

  // Back-compat: Open section from hash (e.g. /docs#api) only when no route param exists.
  useEffect(() => {
    if (sectionParamRaw) return;
    const hash = location.hash.slice(1) as DocSection;
    if (hash && DOC_SECTIONS.includes(hash)) setActiveSection(hash);
  }, [location.hash, sectionParamRaw]);

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
          <Link
            to="/docs/api"
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
          </Link>

          <Link
            to="/docs/cloning"
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
          </Link>
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

  const apiCodeBlock = (label: string, children: string) => (
    <div className="mb-6 overflow-hidden rounded-lg border border-white/[0.08] bg-[#0c0c0e] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-4 py-2">
        <span className="font-mono text-[11px] font-medium uppercase tracking-wide text-[#787f87]">{label}</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed text-[#b8c0cc] whitespace-pre-wrap">
        {children}
      </pre>
    </div>
  );

  const apiEndpointCard = (
    method: string,
    path: string,
    description: string,
    methodColor: string
  ) => (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
        <span
          className={`rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${methodColor}`}
        >
          {method}
        </span>
        <code className="text-sm text-zinc-200">{path}</code>
      </div>
      <p className="px-4 py-3 text-sm leading-relaxed text-[#9ca3af]">{description}</p>
    </div>
  );

  const renderAPI = () => (
    <div className="space-y-14">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">API Reference</span>
      </nav>

      <header className="space-y-6 border-b border-white/[0.06] pb-12">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight text-white md:text-[2.25rem] md:leading-tight">
            API Reference
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-zinc-400 md:text-lg">
            Generate speech with the Vocence Developer API. Keys are created in your account; authenticate with{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">Bearer</code> and call{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">POST /v1/tts/generate</code>.
          </p>
        </div>

        <div className="flex flex-col gap-4 rounded-xl border border-white/[0.08] bg-gradient-to-br from-white/[0.05] via-transparent to-white/[0.02] p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium text-white">Get your API key</p>
            <p className="mt-1 text-sm text-zinc-500">
              Open <span className="text-zinc-400">Account → Developer</span> after signing in. Premium unlocks API access.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Link
              to="/account/developer"
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#DFFF00] px-4 py-2.5 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90"
            >
              <KeyRound size={16} strokeWidth={2} />
              Create API key
              <ArrowRight size={16} />
            </Link>
            <Link
              to="/pricing"
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/[0.04] px-4 py-2.5 text-sm font-medium text-zinc-200 transition-colors hover:border-white/25 hover:bg-white/[0.08]"
            >
              View pricing
              <ExternalLink size={14} className="opacity-70" />
            </Link>
          </div>
        </div>
      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">Base URLs</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Website backend</p>
            <p className="mt-2 text-xs text-zinc-500">Account, billing, key management</p>
            <code className="mt-3 block break-all font-mono text-sm text-emerald-400/90">
              https://backend.vocence.ai/api
            </code>
          </div>
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-4">
            <p className="text-xs font-medium uppercase tracking-wider text-zinc-500">Developer API</p>
            <p className="mt-2 text-xs text-zinc-500">TTS generation</p>
            <code className="mt-3 block break-all font-mono text-sm text-emerald-400/90">https://api.vocence.ai</code>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">Authentication</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Send your secret key in the <code className="text-zinc-200">Authorization</code> header. Keys start with{' '}
          <code className="text-zinc-200">voc_live_</code>.
        </p>
        {apiCodeBlock(
          'Header',
          'Authorization: Bearer voc_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
        )}
      </section>

      <section className="space-y-5">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-white">Key management</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            These routes are on the website backend and require a signed-in user (session/JWT). Manage keys in the{' '}
            <Link to="/account/developer" className="font-medium text-[#DFFF00] underline-offset-2 hover:underline">
              Developer
            </Link>{' '}
            tab or via HTTP below.
          </p>
        </div>
        <div className="grid gap-4">
          {apiEndpointCard(
            'POST',
            '/api/developer/keys',
            'Create a key. Body: { "name": "My Key" }. Plaintext secret is returned once in the response.',
            'bg-emerald-500/15 text-emerald-400'
          )}
          {apiEndpointCard(
            'GET',
            '/api/developer/keys',
            'List keys: prefix, tier, rate limit, revoked status, timestamps.',
            'bg-sky-500/15 text-sky-400'
          )}
          {apiEndpointCard(
            'POST',
            '/api/developer/keys/{id}/revoke',
            'Revoke a key immediately.',
            'bg-emerald-500/15 text-emerald-400'
          )}
          {apiEndpointCard(
            'GET',
            '/api/developer/usage',
            'Recent request logs for your account.',
            'bg-sky-500/15 text-sky-400'
          )}
        </div>
      </section>

      <section className="space-y-6">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
              POST
            </span>
            <code className="text-sm text-zinc-200">/v1/tts/generate</code>
          </div>
          <div className="space-y-6 p-5">
            <p className="text-sm leading-relaxed text-zinc-400">
              Generate TTS audio from text and optional style instruction. Credits are deducted from your prepaid balance
              from character usage (text + style instruction).
            </p>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Request body</h3>
              <ul className="space-y-4 text-sm text-zinc-400">
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">text</code>
                  <span className="mt-1 block">Required. Content to synthesize.</span>
                </li>
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">
                    style_instruction
                  </code>
                  <span className="mt-1 block">
                    Optional. Voice/style guidance. Defaults to <code className="text-zinc-300">&quot;neutral voice&quot;</code>.
                  </span>
                </li>
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">model</code>
                  <span className="mt-1 block">Optional. Provider alias when multiple backends are configured.</span>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Examples</h3>
              {apiCodeBlock(
                'cURL',
                `curl -X POST "https://api.vocence.ai/v1/tts/generate" \\
  -H "Authorization: Bearer voc_live_xxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "text": "Welcome to Vocence",
    "style_instruction": "female, warm, clear, medium pace"
  }'`
              )}
              {apiCodeBlock(
                'JavaScript',
                `const res = await fetch("https://api.vocence.ai/v1/tts/generate", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + process.env.VOCENCE_API_KEY,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    text: "Your script here",
    style_instruction: "neutral voice"
  })
});

const data = await res.json();
console.log(data.audio_url, data.credits_remaining);`
              )}
              {apiCodeBlock(
                'Python',
                `import requests

url = "https://api.vocence.ai/v1/tts/generate"
headers = {
    "Authorization": "Bearer " + API_KEY,
    "Content-Type": "application/json",
}
payload = {
    "text": "Hello from Vocence",
    "style_instruction": "neutral voice",
}
resp = requests.post(url, headers=headers, json=payload, timeout=120)
print(resp.status_code, resp.json())`
              )}
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Response</h3>
              {apiCodeBlock(
                'JSON',
                `{
  "request_id": "0f6d0c9f4f2c4b2f8f0e8d1a5b123abc",
  "audio_url": "https://s3.hippius.com/...",
  "provider": "PromptTTS API",
  "credits_remaining": 9784,
  "latency_ms": 1420,
  "credits_used": 1,
  "request_chars": 27
}`
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">HTTP errors</h2>
        <div className="overflow-hidden rounded-xl border border-white/[0.08]">
          <table className="w-full text-sm">
            <thead className="border-b border-white/[0.06] bg-white/[0.03] text-left text-xs font-medium uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Code</th>
                <th className="px-4 py-3 font-medium">Meaning</th>
                <th className="px-4 py-3 font-medium">What to do</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06] text-zinc-400">
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">400</td>
                <td className="px-4 py-3">Invalid payload</td>
                <td className="px-4 py-3">Send required fields and valid JSON.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">401</td>
                <td className="px-4 py-3">Invalid or missing API key</td>
                <td className="px-4 py-3">Check <code className="text-zinc-300">Authorization: Bearer</code>.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">402</td>
                <td className="px-4 py-3">Insufficient credits / Premium required</td>
                <td className="px-4 py-3">
                  <Link to="/pricing" className="text-[#DFFF00] underline-offset-2 hover:underline">
                    Upgrade or top up credits
                  </Link>
                  .
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">403</td>
                <td className="px-4 py-3">Key revoked</td>
                <td className="px-4 py-3">
                  <Link to="/account/developer" className="text-[#DFFF00] underline-offset-2 hover:underline">
                    Create a new key
                  </Link>
                  .
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">429</td>
                <td className="px-4 py-3">Rate limit</td>
                <td className="px-4 py-3">Default: 4 requests per minute per key. Retry after a short wait.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">502</td>
                <td className="px-4 py-3">Provider error</td>
                <td className="px-4 py-3">Retry; check status or simplify the request.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">Production checklist</h2>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>Purchase Premium (see <Link to="/docs/pricing" className="text-[#DFFF00] hover:underline">Pricing</Link>).</li>
          <li>
            <Link to="/account/developer" className="text-[#DFFF00] hover:underline">
              Create an API key
            </Link>{' '}
            and store it as a secret.
          </li>
          <li>Call <code className="text-zinc-300">POST /v1/tts/generate</code> with your Bearer token.</li>
          <li>Monitor usage and rotate keys from Account → Developer if needed.</li>
        </ol>
      </section>
    </div>
  );

  const renderPricing = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Pricing</h1>
        <p className="text-xl text-[#A7B0B7]">
          Detailed pricing and billing rules for Studio and Developer API.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Current Plans</h2>
        <p className="text-[#A7B0B7] mb-6 max-w-3xl leading-7">
          One-time credit packs are sold through two separate checkouts:{' '}
          <span className="text-white font-medium">Stripe</span> (card) and{' '}
          <span className="text-white font-medium">NOWPayments</span> (crypto). They use{' '}
          <span className="text-white font-medium">different USD prices and different numbers of credits</span> for the
          same plan name (Normal vs Premium). What you pay and what you receive match the button you complete on the
          pricing page. After purchase, credits behave the same for Studio and API usage.
        </p>
        <div className="overflow-x-auto border border-white/10 rounded-xl mb-6">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7] text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Card (Stripe)</th>
                <th className="px-4 py-3 font-medium">Crypto (NOWPayments)</th>
              </tr>
            </thead>
            <tbody className="text-[#C6CDD4]">
              <tr className="border-t border-white/10">
                <td className="px-4 py-3 text-white font-medium">Normal</td>
                <td className="px-4 py-3">$12 → {formatCreditsCompact(4000)} credits</td>
                <td className="px-4 py-3">$20 → {formatCreditsCompact(7000)} credits</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3 text-white font-medium">Premium</td>
                <td className="px-4 py-3">$24 → {formatCreditsCompact(10000)} credits</td>
                <td className="px-4 py-3">$40 → {formatCreditsCompact(16000)} credits</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-6">
            <h3 className="text-lg font-semibold mb-2">Normal</h3>
            <p className="text-[#A7B0B7] text-sm">Best for standard Studio usage.</p>
          </div>
          <div className="card-vocence p-6 border-[#DFFF00]/30">
            <h3 className="text-lg font-semibold mb-2">Premium</h3>
            <p className="text-[#A7B0B7] text-sm">Required to unlock Developer API access (after a successful Premium purchase via either checkout).</p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">How Credits Are Used</h2>
        <div className="space-y-3 text-[#A7B0B7] leading-7">
          <p>
            <span className="text-white font-medium">Studio generation:</span> currently consumes credits per generation in the website flow.
          </p>
          <p>
            <span className="text-white font-medium">Developer API metering:</span> <code className="text-white/90">2,000 credits per 1,000,000 characters</code>.
          </p>
          <p>
            Character count formula:
            <code className="text-white/90"> len(text) + len(style_instruction) </code>
          </p>
          <p>
            If <code className="text-white/90">style_instruction</code> is missing, system uses
            <code className="text-white/90"> "neutral voice" </code>
            and includes it in character counting.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">API Cost Examples</h2>
        <div className="overflow-x-auto border border-white/10 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Input</th>
                <th className="text-left px-4 py-3">Character Count</th>
                <th className="text-left px-4 py-3">Credits Used</th>
              </tr>
            </thead>
            <tbody className="text-[#C6CDD4]">
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">`text=120`, `style_instruction=30`</td>
                <td className="px-4 py-3">150</td>
                <td className="px-4 py-3">ceil(150 * 2000 / 1,000,000) = 1</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">`text=2,500`, no style provided</td>
                <td className="px-4 py-3">2,513 (`neutral voice`=13)</td>
                <td className="px-4 py-3">ceil(2513 * 2000 / 1,000,000) = 6</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">`text + style = 100,000`</td>
                <td className="px-4 py-3">100,000</td>
                <td className="px-4 py-3">200</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Access Rules</h2>
        <ul className="space-y-2 text-[#A7B0B7] leading-7">
          <li>Developer API access requires at least one successful Premium purchase.</li>
          <li>User creates API key after Premium purchase.</li>
          <li>All API keys have same limit: 4 requests per minute per key.</li>
          <li>When credits are insufficient, API returns `402` and request is not processed.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Billing Flow (End-to-End)</h2>
        <ol className="space-y-2 text-[#A7B0B7] leading-7 list-decimal list-inside">
          <li>Sign in and purchase credits from pricing page (Stripe or Crypto).</li>
          <li>Purchase Premium pack to unlock Developer API.</li>
          <li>Create API key in Account → Developer tab.</li>
          <li>Call `POST /v1/tts/generate` with Bearer key.</li>
          <li>Credits reduce based on character usage.</li>
          <li>View logs and spend in Account → Developer tab.</li>
        </ol>
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
        <div className="mt-6">
          <Link to="/docs/pricing" className="btn-primary inline-flex items-center">
            Go to Pricing
            <ChevronRight size={16} className="ml-2" />
          </Link>
        </div>
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
      case 'pricing':
        return renderPricing();
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
    <div ref={docsRef} className="min-h-screen bg-[#07080A] pt-[4.5rem]">
      <div className="flex">
        <aside className="docs-sidebar sticky top-[4.5rem] hidden h-[calc(100vh-4.5rem)] w-[260px] shrink-0 overflow-y-auto border-r border-white/[0.06] bg-[#07080A] px-4 py-8 lg:block">
          <div className="space-y-8 pr-2">
            <Link
              to="/"
              className="mb-2 block text-xs font-medium uppercase tracking-[0.12em] text-zinc-500 hover:text-zinc-400"
            >
              ← Vocence
            </Link>
            {Object.entries(groupedLinks).map(([category, links]) => (
              <div key={category}>
                <h4 className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                  {category}
                </h4>
                <ul className="space-y-0.5">
                  {links.map((link) => (
                    <li key={link.id}>
                      <Link
                        to={`/docs/${link.id}`}
                        className={`block w-full rounded-lg px-3 py-2 text-left text-[13px] leading-snug transition-colors ${
                          activeSection === link.id
                            ? 'bg-white/[0.07] font-medium text-white shadow-[inset_2px_0_0_0_#DFFF00]'
                            : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                        }`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>

        <main className="docs-content min-h-[calc(100vh-4.5rem)] flex-1 border-l border-transparent lg:border-l-0">
          <div
            className={`mx-auto px-5 py-8 sm:px-8 sm:py-12 lg:px-14 lg:py-14 ${
              activeSection === 'api' ? 'max-w-4xl' : 'max-w-3xl'
            }`}
          >
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
