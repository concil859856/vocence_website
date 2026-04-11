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
import {
  CREDIT_MUSIC,
  CREDIT_MY_VOICE_GENERATE,
  CREDIT_SIGNUP_BONUS,
  CREDIT_STT,
  CREDIT_TTS,
  CREDIT_VOICE_CLONE,
  CREDIT_VOICE_DESIGN_PREVIEW,
} from '../studio/creditCosts';

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

/** Stable links to the open-source subnet repo (paths use `master` branch). */
const GH = 'https://github.com/vocence-bt/vocence';
const ghBlob = (path: string) => `${GH}/blob/master/${path}`;

function RepoFileLink({ path, label }: { path: string; label: string }) {
  return (
    <a
      href={ghBlob(path)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-[#DFFF00] hover:underline font-medium"
    >
      {label}
      <ExternalLink size={14} className="opacity-80 shrink-0" />
    </a>
  );
}

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
            Use the Vocence Developer API for text-to-speech, speech-to-text, voice cloning, and music generation. Keys are created in your
            account; authenticate with <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">Bearer</code>{' '}
            and call <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">/v1/tts/generate</code>,{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">/v1/stt/transcribe</code>,{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">/v1/voice/clone</code>, or{' '}
            <code className="rounded bg-white/10 px-1.5 py-0.5 text-sm text-zinc-200">/v1/music/generate</code>.{' '}
            <span className="text-zinc-500">
              Voice design (guided A/B in Studio) is not available on the Developer API—use Studio for that workflow.
            </span>
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
            <p className="mt-2 text-xs text-zinc-500">TTS, STT, and voice cloning</p>
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
              Generate TTS audio from text and optional style instruction. Credits are deducted per successful request (
              {CREDIT_TTS} credits, matching Studio). Operators can enable character-based metering instead by setting{' '}
              <code className="text-zinc-300">API_TTS_CREDITS_PER_REQUEST=0</code> on the API service.
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
  "credits_used": ${CREDIT_TTS},
  "request_chars": 27
}`
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
              POST
            </span>
            <code className="text-sm text-zinc-200">/v1/stt/transcribe</code>
          </div>
          <div className="space-y-6 p-5">
            <p className="text-sm leading-relaxed text-zinc-400">
              Transcribe speech to text using Vocence STT. Send base64-encoded audio. Credits are deducted per successful
              request ({CREDIT_STT} credits, matching Studio).
            </p>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Request body</h3>
              <ul className="space-y-4 text-sm text-zinc-400">
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">audio_b64</code>
                  <span className="mt-1 block">Required. Base64-encoded audio bytes.</span>
                </li>
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">language</code>
                  <span className="mt-1 block">
                    Optional hint language code (for example: <code className="text-zinc-300">en</code>, <code className="text-zinc-300">es</code>).
                  </span>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Examples</h3>
              {apiCodeBlock(
                'cURL',
                `curl -X POST "https://api.vocence.ai/v1/stt/transcribe" \\
  -H "Authorization: Bearer voc_live_xxxxxxxxxxxxxxxxx" \\
  -H "Content-Type: application/json" \\
  -d '{
    "audio_b64": "<base64-audio>",
    "language": "en"
  }'`
              )}
              {apiCodeBlock(
                'Python',
                `import base64
import requests

with open("sample.wav", "rb") as f:
    audio_b64 = base64.b64encode(f.read()).decode("utf-8")

resp = requests.post(
    "https://api.vocence.ai/v1/stt/transcribe",
    headers={
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json",
    },
    json={"audio_b64": audio_b64, "language": "en"},
    timeout=180,
)
print(resp.status_code, resp.json())`
              )}
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Response</h3>
              {apiCodeBlock(
                'JSON',
                `{
  "request_id": "b1f89d81f69e4f5b8f1ceabc1df01234",
  "text": "Welcome to Vocence.",
  "language": "en",
  "provider": "Whisper Large v3",
  "credits_remaining": 9782,
  "latency_ms": 1234,
  "credits_used": ${CREDIT_STT}
}`
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="space-y-6">
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
          <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.06] px-4 py-3">
            <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
              POST
            </span>
            <code className="text-sm text-zinc-200">/v1/voice/clone</code>
          </div>
          <div className="space-y-6 p-5">
            <p className="text-sm leading-relaxed text-zinc-400">
              Produce speech in the style of a reference clip: the service transcribes your reference audio, then runs
              voice-clone synthesis for <code className="text-zinc-300">target_text</code>. One charge applies per successful
              call ({CREDIT_VOICE_CLONE} credits, matching Studio). Requires voice-clone backends to be configured on{' '}
              <code className="text-zinc-300">api.vocence.ai</code>; otherwise the API returns{' '}
              <code className="text-zinc-300">503</code>.
            </p>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Request body</h3>
              <ul className="space-y-4 text-sm text-zinc-400">
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">
                    reference_audio_b64
                  </code>
                  <span className="mt-1 block">Required. Base64-encoded reference audio (any common format; WAV preferred).</span>
                </li>
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">target_text</code>
                  <span className="mt-1 block">Required. Text to speak in the cloned voice.</span>
                </li>
                <li>
                  <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-emerald-400/90">language</code>
                  <span className="mt-1 block">
                    Optional hint for transcribing the reference clip (for example{' '}
                    <code className="text-zinc-300">en</code>, <code className="text-zinc-300">es</code>).
                  </span>
                </li>
              </ul>
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Examples</h3>
              {apiCodeBlock(
                'Python',
                `import base64
import requests

with open("reference.wav", "rb") as f:
    ref_b64 = base64.b64encode(f.read()).decode("utf-8")

resp = requests.post(
    "https://api.vocence.ai/v1/voice/clone",
    headers={
        "Authorization": "Bearer " + API_KEY,
        "Content-Type": "application/json",
    },
    json={
        "reference_audio_b64": ref_b64,
        "target_text": "Hello from the cloned voice.",
        "language": "en",
    },
    timeout=300,
)
print(resp.status_code, resp.json())`
              )}
            </div>

            <div>
              <h3 className="mb-3 text-sm font-semibold text-white">Response</h3>
              {apiCodeBlock(
                'JSON',
                `{
  "request_id": "c2a91e…",
  "audio_url": "https://s3.hippius.com/...",
  "reference_text": "Transcript of the reference clip…",
  "language": "en",
  "provider": "clone.example.com",
  "credits_remaining": 9700,
  "latency_ms": 45000,
  "credits_used": ${CREDIT_VOICE_CLONE}
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
                <td className="px-4 py-3 font-mono text-zinc-300">413</td>
                <td className="px-4 py-3">Payload too large</td>
                <td className="px-4 py-3">
                  Reduce audio size for <code className="text-zinc-300">/v1/stt/transcribe</code> and reference audio for{' '}
                  <code className="text-zinc-300">/v1/voice/clone</code>.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-zinc-300">503</td>
                <td className="px-4 py-3">Voice clone unavailable</td>
                <td className="px-4 py-3">
                  Host has not configured clone inference; use TTS/STT or contact support. Studio may still work if only the
                  public API is missing clone routing.
                </td>
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
          <li>
            Call <code className="text-zinc-300">POST /v1/tts/generate</code>,{' '}
            <code className="text-zinc-300">POST /v1/stt/transcribe</code>, and/or{' '}
            <code className="text-zinc-300">POST /v1/voice/clone</code> with your Bearer token.
          </li>
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
            <p className="text-[#A7B0B7] text-sm mb-3">Best for standard Studio usage.</p>
            <ul className="space-y-1.5 text-sm text-[#A7B0B7]">
              <li>Generation history saved for <span className="text-white font-medium">7 days</span></li>
              <li>Up to <span className="text-white font-medium">5 custom voices</span> (Voice Design)</li>
              <li>All Studio features (TTS, STT, Clone, Music)</li>
            </ul>
          </div>
          <div className="card-vocence p-6 border-[#DFFF00]/30">
            <h3 className="text-lg font-semibold mb-2">Premium</h3>
            <p className="text-[#A7B0B7] text-sm mb-3">Required to unlock Developer API access.</p>
            <ul className="space-y-1.5 text-sm text-[#A7B0B7]">
              <li>Generation history <span className="text-white font-medium">never expires</span></li>
              <li><span className="text-white font-medium">Unlimited</span> custom voices (Voice Design)</li>
              <li>Developer API access (TTS, STT, Clone, Music)</li>
              <li>All Studio features</li>
            </ul>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">How Credits Are Used</h2>
        <div className="space-y-3 text-[#A7B0B7] leading-7">
          <p>
            <span className="text-white font-medium">New accounts:</span> {CREDIT_SIGNUP_BONUS} free credits at signup.
          </p>
          <div className="overflow-x-auto border border-white/10 rounded-xl my-4">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-[#A7B0B7] text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Studio action</th>
                  <th className="px-4 py-3 font-medium">Credits</th>
                </tr>
              </thead>
              <tbody className="text-[#C6CDD4]">
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">Text-to-Speech</td>
                  <td className="px-4 py-3">{CREDIT_TTS} per generation</td>
                </tr>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">Speech-to-Text</td>
                  <td className="px-4 py-3">{CREDIT_STT} per transcription</td>
                </tr>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">Voice cloning</td>
                  <td className="px-4 py-3">{CREDIT_VOICE_CLONE} per generation</td>
                </tr>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">Voice design (A/B preview → save)</td>
                  <td className="px-4 py-3">{CREDIT_VOICE_DESIGN_PREVIEW} for preview; saving the voice has no extra charge</td>
                </tr>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">My voice (designed) — generate speech</td>
                  <td className="px-4 py-3">{CREDIT_MY_VOICE_GENERATE} per generation</td>
                </tr>
                <tr className="border-t border-white/10">
                  <td className="px-4 py-3 text-white font-medium">Music generation (Text-to-Music)</td>
                  <td className="px-4 py-3">{CREDIT_MUSIC} per generation</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p>
            <span className="text-white font-medium">Developer API metering</span> (default server configuration, aligned
            with Studio){' '}
            <code className="text-white/90">
              TTS {CREDIT_TTS} credits per request · STT {CREDIT_STT} credits per request · voice clone{' '}
              {CREDIT_VOICE_CLONE} credits per request · music generation {CREDIT_MUSIC} credits per request
            </code>
            . Voice design is <span className="text-white font-medium">not</span> billed on the Developer API (Studio only).
          </p>
          <p className="text-[#A7B0B7] text-sm">
            TTS can optionally use character-based credits instead: set <code className="text-white/80">API_TTS_CREDITS_PER_REQUEST=0</code>{' '}
            on the API service; then metering uses{' '}
            <code className="text-white/80">API_CREDITS_PER_1M_CHARS</code> on{' '}
            <code className="text-white/80">len(text) + len(style_instruction)</code> (default style{' '}
            <code className="text-white/80">neutral voice</code> counts toward length).
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Developer API cost reference</h2>
        <div className="overflow-x-auto border border-white/10 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Endpoint</th>
                <th className="text-left px-4 py-3">Credits (default)</th>
              </tr>
            </thead>
            <tbody className="text-[#C6CDD4]">
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-white/90">POST /v1/tts/generate</code>
                </td>
                <td className="px-4 py-3">{CREDIT_TTS} per successful response</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-white/90">POST /v1/stt/transcribe</code>
                </td>
                <td className="px-4 py-3">{CREDIT_STT} per successful response</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-white/90">POST /v1/voice/clone</code>
                </td>
                <td className="px-4 py-3">{CREDIT_VOICE_CLONE} per successful response</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-white/90">POST /v1/music/generate</code>
                </td>
                <td className="px-4 py-3">{CREDIT_MUSIC} per successful response</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[#A7B0B7] text-sm mt-4">
          With <code className="text-white/80">API_TTS_CREDITS_PER_REQUEST=0</code>, TTS instead uses character-based
          credits via <code className="text-white/80">API_CREDITS_PER_1M_CHARS</code> (see API Reference above).
        </p>
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
          <li>
            Call <code className="text-white/90">POST /v1/tts/generate</code>,{' '}
            <code className="text-white/90">POST /v1/stt/transcribe</code>,{' '}
            <code className="text-white/90">POST /v1/voice/clone</code>, and/or{' '}
            <code className="text-white/90">POST /v1/music/generate</code> with the Bearer key.
          </li>
          <li>Credits reduce per endpoint rules (flat per request by default; optional char-based TTS for operators).</li>
          <li>View logs and spend in Account → Developer tab.</li>
        </ol>
      </section>
    </div>
  );

  const renderCloning = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <h1 className="text-4xl font-bold mb-4">Voice cloning</h1>
        <p className="text-xl text-[#A7B0B7] leading-relaxed max-w-3xl">
          Clone a speaker from a short reference recording, then synthesize new sentences in that voice.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold text-white">Studio</h2>
        <p className="text-[#A7B0B7] leading-7 max-w-3xl">
          Use <Link to="/studio" className="text-[#DFFF00] hover:underline">Studio</Link> for an interactive clone workflow:
          upload reference audio, hear outputs, and browse history. Voice design (guided A/B previews before saving a custom
          voice) stays in Studio only—it is not exposed on the Developer API.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold text-white">Developer API</h2>
        <p className="text-[#A7B0B7] leading-7 max-w-3xl">
          Integrations can call{' '}
          <code className="text-white/90 bg-white/5 px-1.5 py-0.5 rounded">POST https://api.vocence.ai/v1/voice/clone</code>{' '}
          with <code className="text-white/90 bg-white/5 px-1.5 py-0.5 rounded">reference_audio_b64</code> and{' '}
          <code className="text-white/90 bg-white/5 px-1.5 py-0.5 rounded">target_text</code>. The service transcribes the
          reference clip server-side, runs clone synthesis, and returns a presigned URL for the WAV output. See the{' '}
          <Link to="/docs/api" className="text-[#DFFF00] hover:underline">
            API Reference
          </Link>{' '}
          for payloads, errors, and credit costs ({CREDIT_VOICE_CLONE} credits per successful call by default).
        </p>
      </section>
    </div>
  );

  const renderMinerSetup = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <div className="flex items-center gap-2 text-sm text-[#666] mb-4">
          <span>Docs</span>
          <ChevronRight size={14} />
          <span>Guides</span>
          <ChevronRight size={14} />
          <span className="text-[#DFFF00]">Miner Setup</span>
        </div>
        <h1 className="text-4xl font-bold mb-4">Miner setup</h1>
        <p className="text-xl text-[#A7B0B7] leading-relaxed">
          Run a Vocence subnet miner by publishing a PromptTTS model on Hugging Face and serving it on{' '}
          <a href="https://chutes.ai" target="_blank" rel="noopener noreferrer" className="text-[#DFFF00] hover:underline">
            Chutes
          </a>{' '}
          using the canonical wrapper. This page summarizes the{' '}
          <RepoFileLink path="README.md" label="vocence repository" />; for every detail follow the linked docs and sample
          files.
        </p>
      </div>

      <section>
        <h2 className="text-2xl font-semibold mb-4">What miners do</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Miners train and deploy voice models that expose a single{' '}
          <code className="text-white/90 bg-white/10 px-1.5 py-0.5 rounded text-sm">POST /speak</code> API: natural-language{' '}
          <strong className="text-white/90">instruction</strong> plus <strong className="text-white/90">text</strong> → WAV
          audio. In the current quarter the subnet focuses on <strong className="text-white/90">PromptTTS</strong>; the same
          interface will extend to other voice tasks over time.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          Validators call your Chute, score outputs (content, quality, prompt adherence), and incentives follow subnet
          rules. The owner verifies wrapper integrity and participant metadata via the gateway API described in the repo.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Prerequisites</h2>
        <ul className="list-disc pl-5 space-y-2 text-[#A7B0B7] leading-7">
          <li>
            <strong className="text-white/90">Chutes</strong> developer account (build & deploy your chute).
          </li>
          <li>
            <strong className="text-white/90">Hugging Face</strong> account and repo for your model code and weights.
          </li>
          <li>
            <strong className="text-white/90">Bittensor</strong> coldkey + hotkey to register and commit on the subnet once
            your deployment is live.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Repository layout on Hugging Face</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Your HF repo must include the files below. See{' '}
          <RepoFileLink path="miner_sample/example_repo/README.md" label="miner_sample/example_repo/README.md" /> and{' '}
          <RepoFileLink path="miner_sample/example_repo/miner.py" label="miner_sample/example_repo/miner.py" /> for a mock
          layout you replace with a real engine.
        </p>
        <div className="overflow-x-auto border border-white/10 rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">File</th>
                <th className="text-left px-4 py-3">Required</th>
                <th className="text-left px-4 py-3">Role</th>
              </tr>
            </thead>
            <tbody className="text-[#C6CDD4]">
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">miner.py</code>
                </td>
                <td className="px-4 py-3">Yes</td>
                <td className="px-4 py-3">
                  Engine: class <code className="text-white/80">Miner</code>, <code className="text-white/80">warmup()</code>,{' '}
                  <code className="text-white/80">generate_wav(instruction, text)</code> → mono float32 PCM + sample rate.
                </td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">chute_config.yml</code>
                </td>
                <td className="px-4 py-3">Yes</td>
                <td className="px-4 py-3">Image, GPU node selector, Chute metadata for build.</td>
              </tr>
              <tr className="border-t border-white/10">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">vocence_config.yaml</code>
                </td>
                <td className="px-4 py-3">Optional</td>
                <td className="px-4 py-3">PromptTTS options (e.g. sample rate limits) if your engine reads it.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[#A7B0B7] leading-7 mt-4">
          All engine logic must stay in <code className="text-white/90">miner.py</code>; only the Python stdlib and
          installed packages may be imported—no importing other files from the repo in the engine.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Canonical Chute wrapper &amp; approved variables</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Deployment uses the Jinja2 template in{' '}
          <RepoFileLink
            path="miner_sample/chute_template/vocence_chute.py.jinja2"
            label="miner_sample/chute_template/vocence_chute.py.jinja2"
          />
          . You may change <strong className="text-white/90">only</strong> these four values when rendering the script:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-[#A7B0B7] leading-7 mb-4">
          <li>
            <code className="text-white/90">VOCENCE_REPO</code> — Hugging Face repo ID (e.g. <code className="text-white/80">user/model</code>).
          </li>
          <li>
            <code className="text-white/90">VOCENCE_REVISION</code> — revision; a <strong className="text-white/90">commit hash</strong>{' '}
            is strongly recommended.
          </li>
          <li>
            <code className="text-white/90">VOCENCE_CHUTES_USER</code> — your Chutes username.
          </li>
          <li>
            <code className="text-white/90">VOCENCE_CHUTE_ID</code> — the <strong className="text-white/90">Chute deployment name</strong>{' '}
            you choose; it <strong className="text-white/90">must contain &quot;vocence&quot;</strong> (any position, case-insensitive).
            The on-chain Chute UUID is separate and is <em>not</em> checked for that substring.
          </li>
        </ul>
        <p className="text-[#A7B0B7] leading-7">
          Full step-by-step: <RepoFileLink path="miner_sample/MINER_GUIDE.md" label="miner_sample/MINER_GUIDE.md" />.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Build, deploy, and register</h2>
        <ol className="list-decimal list-inside space-y-3 text-[#A7B0B7] leading-7">
          <li>
            Render the template with your four variables (placeholders are documented in the guide).
          </li>
          <li>
            Build with Chutes: <code className="text-white/90 bg-white/10 px-1.5 rounded">chutes build &lt;module&gt;:chute --local</code> or{' '}
            <code className="text-white/90 bg-white/10 px-1.5 rounded">--wait</code> for remote.
          </li>
          <li>
            Deploy: <code className="text-white/90 bg-white/10 px-1.5 rounded">chutes deploy &lt;module&gt;:chute --accept-fee</code>.
          </li>
          <li>
            Commit on chain: model name, model revision, and Chute ID (UUID from Chutes)—via the Vocence CLI or your own flow
            (see below).
          </li>
        </ol>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Vocence CLI (optional automation)</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          From a clone of the repo, install dependencies (e.g. <code className="text-white/90">uv sync</code>) and use:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-[#A7B0B7] leading-7">
          <li>
            <code className="text-white/90">vocence miner push</code> — deploy HF model to Chutes (
            <code className="text-white/80">--model-name</code>, <code className="text-white/80">--model-revision</code>).
          </li>
          <li>
            <code className="text-white/90">vocence miner commit</code> — commit model name, revision, and Chute ID to the chain.
          </li>
        </ul>
        <p className="text-[#A7B0B7] leading-7 mt-4">
          Complete flags and env:{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md" /> (section &quot;Miner commands&quot;). Example env keys for local
          tooling: <RepoFileLink path="env.example" label="env.example" />.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">HTTP API your Chute must expose</h2>
        <ul className="list-disc pl-5 space-y-2 text-[#A7B0B7] leading-7">
          <li>
            <code className="text-white/90">GET /health</code> — status, HF repo/revision, load state, sample rate, adapter.
          </li>
          <li>
            <code className="text-white/90">POST /speak</code> — JSON <code className="text-white/80">{`{ "instruction", "text" }`}</code>
            ; response <code className="text-white/80">audio/wav</code> bytes.
          </li>
        </ul>
      </section>

      <section className="bg-white/5 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-3">Wrapper integrity (owner check)</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          The <strong className="text-white/90">owner</strong> (not validators) fetches your deploy script from the Chutes
          API, masks the four approved variables, normalizes the AST, and compares a hash to the canonical template. Mismatch
          or fetch failure marks the participant invalid. Validators only call <code className="text-white/90">/health</code> and{' '}
          <code className="text-white/90">/speak</code> for scoring—keep the wrapper unchanged except for those variables.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          Details: <RepoFileLink path="miner_sample/MINER_GUIDE.md" label="MINER_GUIDE.md § Wrapper integrity" /> ·{' '}
          <RepoFileLink path="docs/base-model-protocol.md" label="Base model &amp; burn protocol" /> (how reference models and
          burn behave in scoring).
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Scoring context</h2>
        <p className="text-[#A7B0B7] leading-7">
          To understand what validators optimize for (task generation from corpus audio, global aggregation, eligibility
          thresholds), read{' '}
          <RepoFileLink path="docs/scoring.md" label="docs/scoring.md" />.
        </p>
      </section>
    </div>
  );

  const renderValidatorSetup = () => (
    <div className="space-y-10">
      <div className="border-b border-white/10 pb-8">
        <div className="flex items-center gap-2 text-sm text-[#666] mb-4">
          <span>Docs</span>
          <ChevronRight size={14} />
          <span>Guides</span>
          <ChevronRight size={14} />
          <span className="text-[#DFFF00]">Validator Setup</span>
        </div>
        <h1 className="text-4xl font-bold mb-4">Validator setup</h1>
        <p className="text-xl text-[#A7B0B7] leading-relaxed">
          Validators run the subnet evaluation loop: sample generation from the shared corpus, miner queries via Chutes,
          uploads to your Hippius bucket, metadata to the owner API, and on-chain weights using{' '}
          <strong className="text-white/90">global consensus scoring</strong>. This mirrors{' '}
          <RepoFileLink path="README.md" label="README.md" /> and{' '}
          <RepoFileLink path="docs/validator-setup.md" label="docs/validator-setup.md" />.
        </p>
      </div>

      <section className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-3 text-amber-100">Contact the Vocence team first</h2>
        <p className="text-[#E8DDD0] leading-7">
          You need team-provided access before a validator can run in production:{' '}
          <strong className="text-white">Chutes permission</strong> (validators call miners&apos; chutes),{' '}
          <strong className="text-white">owner API URL</strong> (<code className="text-white/90">API_URL</code> — participants,
          blocklist, evaluations, active validators), and <strong className="text-white">Hippius keys</strong> (corpus
          read-only + your validator bucket, plus readonly credentials for other validators&apos; sample buckets for global
          scoring). Without these, setup cannot be completed.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Credentials at a glance</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Align your <code className="text-white/90">.env</code> with{' '}
          <RepoFileLink path="env.example" label="env.example" />. Typical validator variables include:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-[#A7B0B7] leading-7">
          <li>
            <strong className="text-white/90">Bittensor:</strong>{' '}
            <code className="text-white/80">NETWORK</code>, <code className="text-white/80">NETUID</code> (mainnet subnet{' '}
            <code className="text-white/80">102</code> in docs), <code className="text-white/80">WALLET_NAME</code>,{' '}
            <code className="text-white/80">HOTKEY_NAME</code>.
          </li>
          <li>
            <strong className="text-white/90">Chutes:</strong>{' '}
            <code className="text-white/80">CHUTES_API_KEY</code> (or <code className="text-white/80">CHUTES_AUTH_KEY</code>) — team-granted.
          </li>
          <li>
            <strong className="text-white/90">OpenAI:</strong>{' '}
            <code className="text-white/80">OPENAI_AUTH_KEY</code> — used in the evaluation pipeline (audio / scoring stack per repo).
          </li>
          <li>
            <strong className="text-white/90">Owner API:</strong> <code className="text-white/80">API_URL</code>.
          </li>
          <li>
            <strong className="text-white/90">Hippius corpus:</strong>{' '}
            <code className="text-white/80">HIPPIUS_CORPUS_ACCESS_KEY</code>,{' '}
            <code className="text-white/80">HIPPIUS_CORPUS_SECRET_KEY</code>.
          </li>
          <li>
            <strong className="text-white/90">Your validator bucket:</strong>{' '}
            <code className="text-white/80">HIPPIUS_VALIDATOR_ACCESS_KEY</code>,{' '}
            <code className="text-white/80">HIPPIUS_VALIDATOR_SECRET_KEY</code>.
          </li>
          <li>
            <strong className="text-white/90">Global scoring:</strong>{' '}
            <code className="text-white/80">VALIDATOR_BUCKETS_JSON</code> — JSON array of{' '}
            <code className="text-white/80">hotkey</code>, <code className="text-white/80">bucket_name</code>,{' '}
            <code className="text-white/80">access_key</code>, <code className="text-white/80">secret_key</code> for{' '}
            <em>readonly</em> access to each active validator&apos;s sample bucket you aggregate against.
          </li>
          <li>
            <strong className="text-white/90">Tuning:</strong>{' '}
            <code className="text-white/80">CYCLE_LENGTH</code>, <code className="text-white/80">MIN_EVALS_TO_COMPETE</code>,{' '}
            <code className="text-white/80">THRESHOLD_MARGIN</code>, active-validator windows, etc.—see{' '}
            <RepoFileLink path="env.example" label="env.example" /> and{' '}
            <RepoFileLink path="docs/scoring.md" label="docs/scoring.md" />.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Recommended: Docker + Watchtower</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          The team publishes a validator image; Watchtower pulls new tags so your node stays current without manual restarts.
          Full walkthrough (Docker install, wallet mounts, <code className="text-white/80">logs/</code> permissions, compose
          commands, troubleshooting):
        </p>
        <p>
          <RepoFileLink path="docs/validator-setup.md" label="docs/validator-setup.md" /> ·{' '}
          <RepoFileLink path="docker-compose.yml" label="docker-compose.yml" /> ·{' '}
          <RepoFileLink path="docs/cicd-pipeline.md" label="docs/cicd-pipeline.md" /> (how images are built and published).
        </p>
        <div className="mt-6 rounded-xl border border-white/10 bg-[#0a0a0a] p-4 font-mono text-sm text-[#C6CDD4] overflow-x-auto">
          <pre className="whitespace-pre-wrap">{`git clone ${GH}.git
cd vocence
cp env.example .env
# Edit .env: wallet, CHUTES_*, OPENAI_*, API_URL, Hippius keys, VALIDATOR_BUCKETS_JSON, etc.
mkdir -p logs && sudo chown 1000:1000 logs
docker compose up -d`}</pre>
        </div>
        <p className="text-[#A7B0B7] leading-7 mt-4 text-sm">
          Mount <code className="text-white/90">~/.bittensor/wallets</code> per the compose file; if wallets live under root,
          fix ownership so UID 1000 can read them (documented in validator-setup).
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Alternative: run from source</h2>
        <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4 font-mono text-sm text-[#C6CDD4] overflow-x-auto mb-4">
          <pre className="whitespace-pre-wrap">{`uv sync
uv run vocence serve`}</pre>
        </div>
        <p className="text-[#A7B0B7] leading-7">
          <code className="text-white/90">vocence serve</code> runs sample generation and weight setting in one process. To split
          generator vs weight-setter for scaling, see{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md — Validator commands" /> (
          <code className="text-white/80">vocence services generator</code>,{' '}
          <code className="text-white/80">vocence services validator</code>).
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">How weight setting works (summary)</h2>
        <p className="text-[#A7B0B7] leading-7 mb-4">
          Each validator still generates its own samples locally. When setting weights, it pulls the valid miner list and
          active validator list from the owner API, intersects with <code className="text-white/80">VALIDATOR_BUCKETS_JSON</code>, reads recent
          evaluation windows from those buckets, and aggregates miner performance with <strong className="text-white/90">stake-weighted</strong>{' '}
          rules (<code className="text-white/80">sqrt(stake)</code>). A miner needs enough evaluations across enough active
          validator buckets to be globally eligible; the winner must beat earlier eligible commitments (including the owner base
          model when configured) by the threshold margin, or the subnet burns weight on UID 0.
        </p>
        <p className="text-[#A7B0B7] leading-7">
          Exact thresholds, tie-breaks, and task generation:{' '}
          <RepoFileLink path="docs/scoring.md" label="docs/scoring.md" /> · base model behavior:{' '}
          <RepoFileLink path="docs/base-model-protocol.md" label="docs/base-model-protocol.md" />.
        </p>
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-4">Owner / API database (operators only)</h2>
        <p className="text-[#A7B0B7] leading-7">
          If you operate the centralized gateway stack (Postgres, API, corpus downloader), see{' '}
          <RepoFileLink path="docs/setup-postgres-vocence.md" label="docs/setup-postgres-vocence.md" /> and owner sections in{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md" />. This is separate from the typical validator quick start.
        </p>
      </section>

      <section className="bg-white/5 border border-white/10 rounded-xl p-6">
        <h2 className="text-xl font-semibold mb-3">Clone the repository</h2>
        <a
          href={GH}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-[#DFFF00] hover:underline font-medium"
        >
          github.com/vocence-bt/vocence
          <ExternalLink size={16} />
        </a>
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
        return renderCloning();
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
              activeSection === 'api' || activeSection === 'miner' || activeSection === 'validator'
                ? 'max-w-4xl'
                : 'max-w-3xl'
            }`}
          >
            {renderContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
