import { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, Link, useParams, useNavigate } from 'react-router-dom';
import { ApiExplorer } from '../components/ApiExplorer';
import { useHasVoiceChatAccess } from '../lib/voicechatAccess';
import {
  ChevronRight,
  BookOpen,
  Code,
  Layers,
  Terminal,
  KeyRound,
  ExternalLink,
} from 'lucide-react';
import gsap from 'gsap';
// Syntax highlighting for the docs CodeBlock. The full hljs bundle
// auto-loads every grammar and balloons the docs page; the ``/lib/core``
// entry leaves grammar registration to us. We hand-pick only the
// languages used in this file (python, bash, ts/js, json, http) so the
// bundle stays lean while still giving Cursor-like accurate coloring.
import hljs from 'highlight.js/lib/core';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import httpLang from 'highlight.js/lib/languages/http';
import plaintext from 'highlight.js/lib/languages/plaintext';
// Atom One Dark — closest off-the-shelf hljs theme to the modern
// Cursor / VSCode "One Dark" palette the user pointed at as the
// reference look. Imported once globally via this module.
import 'highlight.js/styles/atom-one-dark.css';

hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('http', httpLang);
hljs.registerLanguage('text', plaintext);
hljs.registerLanguage('plaintext', plaintext);
import { formatCreditsCompact } from '../utils/formatCredits';
import {
  CREDIT_NOISE_REMOVER,
  CREDIT_MUSIC,
  CREDIT_MY_VOICE_GENERATE,
  CREDIT_SIGNUP_BONUS,
  CREDIT_STT,
  CREDIT_TTS,
  CREDIT_VOICE_CLONE,
  CREDIT_VOICE_DESIGN_PREVIEW,
} from '../studio/creditCosts';

type DocSection = 'getting-started' | 'core-concepts' | 'architecture' | 'api' | 'pricing' | 'faq' | 'troubleshooting' | 'guide-tts' | 'guide-cloning' | 'guide-stt' | 'guide-music' | 'guide-dubbing' | 'guide-agents' | 'cookbook' | 'sdk-python' | 'sdk-cli' | 'sdk-agents' | 'sdk-webhooks' | 'miner' | 'validator';

interface DocLink {
  id: DocSection;
  label: string;
  category: string;
  /** When true, only signed-in admin users (matched against VITE_ADMIN_EMAIL
   *  via useHasVoiceChatAccess) see this entry in the sidebar AND can
   *  navigate to the URL. Non-admins hitting the URL get bounced to
   *  /docs/getting-started. Mirrors the launch-gate already applied to
   *  Logos and /studio/agents. */
  adminOnly?: true;
}

const docLinks: DocLink[] = [
  // Introduction, orientation for newcomers.
  { id: 'getting-started', label: 'Getting Started', category: 'Introduction' },
  { id: 'core-concepts', label: 'Core Concepts', category: 'Introduction' },
  { id: 'architecture', label: 'Architecture', category: 'Introduction' },
  // Studio, feature-by-feature how-to for the web app.
  // Agents is admin-only until the feature launches publicly.
  { id: 'guide-agents', label: 'Agents', category: 'Studio', adminOnly: true },
  { id: 'guide-tts', label: 'Text-to-Speech', category: 'Studio' },
  { id: 'guide-cloning', label: 'Voice Cloning', category: 'Studio' },
  { id: 'guide-stt', label: 'Speech-to-Text', category: 'Studio' },
  { id: 'guide-music', label: 'Music', category: 'Studio' },
  { id: 'guide-dubbing', label: 'Noise Remover', category: 'Studio' },
  // API, everything a developer needs to integrate.
  // API + Cookbook are admin-only until public launch; Pricing stays
  // public since it's a marketing concern, not a developer one.
  { id: 'api', label: 'API Reference', category: 'API', adminOnly: true },
  { id: 'cookbook', label: 'Cookbook', category: 'API', adminOnly: true },
  { id: 'pricing', label: 'Pricing', category: 'API' },
  // SDK, official Python client library (PyPI: ``vocence``).
  // Entire SDK category is admin-only until public launch.
  { id: 'sdk-python', label: 'Python SDK', category: 'SDK', adminOnly: true },
  { id: 'sdk-cli', label: 'CLI Reference', category: 'SDK', adminOnly: true },
  { id: 'sdk-agents', label: 'Voice Agents', category: 'SDK', adminOnly: true },
  { id: 'sdk-webhooks', label: 'Webhooks', category: 'SDK', adminOnly: true },
  // Subnet, running infrastructure on Bittensor (SN10).
  { id: 'miner', label: 'Miner Setup', category: 'Subnet' },
  { id: 'validator', label: 'Validator Setup', category: 'Subnet' },
  // Support, last because users hit it after trying everything else.
  { id: 'faq', label: 'FAQ', category: 'Support' },
  { id: 'troubleshooting', label: 'Troubleshooting', category: 'Support' },
];

const ADMIN_ONLY_SECTIONS: Set<DocSection> = new Set(
  docLinks.filter((l) => l.adminOnly).map((l) => l.id),
);

const DOC_SECTIONS: DocSection[] = ['getting-started', 'core-concepts', 'architecture', 'guide-agents', 'guide-tts', 'guide-cloning', 'guide-stt', 'guide-music', 'guide-dubbing', 'cookbook', 'api', 'pricing', 'sdk-python', 'sdk-cli', 'sdk-agents', 'sdk-webhooks', 'miner', 'validator', 'faq', 'troubleshooting'];

/** Stable links to the open-source subnet repo (paths use `master` branch). */
const GH = 'https://github.com/vocence-78/vocence';
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

/**
 * `<pre>` with a copy-to-clipboard button pinned in the top-right.
 * Use anywhere we want a runnable snippet, Cookbook leans on it.
 */
function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  // Run hljs once per (code, language) pair. When the language is
  // explicitly named and registered, use the targeted highlighter for
  // best accuracy; otherwise fall back to autodetect over the registered
  // subset. The atom-one-dark stylesheet (imported at module top)
  // colors the resulting span tree. Wrapped in useMemo so we don't
  // re-tokenize on every parent re-render (the docs page re-renders
  // frequently as the scroll-spy updates the active TOC item).
  const highlighted = useMemo(() => {
    try {
      const lang = (language || '').toLowerCase();
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      }
      // No explicit language → autodetect across the registered set.
      return hljs.highlightAuto(code).value;
    } catch {
      // Defensive: on any tokenizer error, escape and render plain so
      // the page still works instead of a blank code block.
      return code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }
  }, [code, language]);
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-white/[0.08] bg-black/60 px-2 py-1 text-[11px] font-medium text-zinc-300 opacity-0 backdrop-blur transition-opacity hover:bg-black/80 group-hover:opacity-100 focus:opacity-100"
        aria-label="Copy code"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre
        className="overflow-x-auto rounded-lg border border-white/[0.06] bg-black/40 p-4 pr-14 font-mono text-[12px] leading-relaxed"
        data-language={language}
      >
        <code
          className={`hljs language-${language || 'plaintext'}`}
          // atom-one-dark sets a solid ``#282c34`` background on
          // ``.hljs``; inline style overrides it so the translucent
          // ``bg-black/40`` on the outer <pre> shows through, keeping
          // the docs page's visual rhythm intact while still getting
          // proper token coloring from the theme stylesheet.
          style={{ background: 'transparent', padding: 0 }}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

/**
 * Auto-built "On this page" right rail. Scans the passed container for
 * `<h2>` elements, treats them as section anchors (assigning a stable id
 * if the markup didn't), and scroll-spies which one is currently in
 * view. We re-scan whenever the active page changes so each docs page
 * gets its own TOC without any per-page wiring.
 */
function DocsRightToc({
  contentRef,
  activeSection,
}: {
  contentRef: React.RefObject<HTMLDivElement | null>;
  activeSection: string;
}) {
  const [items, setItems] = useState<Array<{ id: string; label: string }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    if (!contentRef.current) return;
    // Defer to next tick so the new page's DOM has rendered.
    const handle = requestAnimationFrame(() => {
      if (!contentRef.current) return;
      const found = Array.from(contentRef.current.querySelectorAll('h2'));
      const collected = found
        .map((el, i) => {
          if (!el.id) {
            const slug = (el.textContent || '')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-+|-+$/g, '');
            el.id = slug ? `${slug}-${i}` : `h2-${i}`;
            el.classList.add('scroll-mt-24');
          }
          return { id: el.id, label: el.textContent?.trim() || '' };
        })
        .filter((x) => x.label);
      setItems(collected);
    });
    return () => cancelAnimationFrame(handle);
  }, [activeSection, contentRef]);

  useEffect(() => {
    if (!items.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-80px 0px -60% 0px', threshold: 0 },
    );
    for (const it of items) {
      const el = document.getElementById(it.id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <aside className="hidden w-[220px] shrink-0 xl:block">
      <div className="sticky top-[5.5rem] max-h-[calc(100vh-6rem)] overflow-y-auto pl-1 pr-2">
        <div className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          On this page
        </div>
        <ul className="space-y-0.5 border-l border-white/[0.06]">
          {items.map((item) => (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={`block -ml-px border-l-2 py-1 pl-3 text-[12px] leading-snug transition-colors ${
                  item.id === activeId
                    ? 'border-[#DFFF00] text-white'
                    : 'border-transparent text-zinc-500 hover:text-zinc-200'
                }`}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

export function Docs() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams<{ section?: string }>();
  const sectionParamRaw = (params.section || '').toLowerCase();
  const isAdmin = useHasVoiceChatAccess();

  // Filter the sidebar, admin-only sections (Agents docs, API
  // Reference, Cookbook, all SDK pages) only show for users who pass
  // the launch-gate check. Categories that end up empty after filtering
  // also drop out (e.g. SDK disappears entirely for non-admins).
  const visibleDocLinks = useMemo(
    () => (isAdmin ? docLinks : docLinks.filter((l) => !l.adminOnly)),
    [isAdmin],
  );

  const [activeSection, setActiveSection] = useState<DocSection>('getting-started');
  // Collapsed sidebar categories. We start with EVERY category
  // collapsed; a follow-up effect opens just the one containing the
  // active section. The user can then collapse that one too, there's
  // no force-open, you're always in control.
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(() => {
    return new Set(visibleDocLinks.map((l) => l.category));
  });

  // Direct URL access to an admin-only section by a non-admin: bounce
  // to Getting Started. Done in an effect (not during render) so
  // useNavigate doesn't fire mid-commit.
  useEffect(() => {
    if (isAdmin) return;
    if (sectionParamRaw && ADMIN_ONLY_SECTIONS.has(sectionParamRaw as DocSection)) {
      navigate('/docs/getting-started', { replace: true });
    }
  }, [isAdmin, sectionParamRaw, navigate]);
  const docsRef = useRef<HTMLDivElement>(null);
  // Ref the main column so the right-rail TOC can scan its <h2>s.
  const contentRef = useRef<HTMLDivElement>(null);

  // Open section from route param (e.g. /docs/api)
  useEffect(() => {
    if (!sectionParamRaw) return;
    if (DOC_SECTIONS.includes(sectionParamRaw as DocSection)) {
      setActiveSection(sectionParamRaw as DocSection);
    }
  }, [sectionParamRaw]);

  // Whenever the active section changes (initial mount or sidebar
  // navigation), un-collapse the category that contains it. This
  // matters on first paint: the page lands with all categories closed,
  // and this effect opens just the one holding the current page —
  // /docs/getting-started → Introduction only, /docs/api → API only,
  // and so on.
  useEffect(() => {
    const cat = visibleDocLinks.find((l) => l.id === activeSection)?.category;
    if (!cat) return;
    setCollapsedCats((prev) => {
      if (!prev.has(cat)) return prev;
      const next = new Set(prev);
      next.delete(cat);
      return next;
    });
  }, [activeSection]);

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
    <div className="space-y-8">
      {/* Header */}
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Introduction</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Getting Started</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Getting Started with Vocence</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          Introduction to the Vocence Voice Intelligence Layer—a decentralized protocol for PromptTTS, STT, STS, voice cloning, TTM, and voice agents—and its place in the Bittensor ecosystem.
        </p>
      </div>

      {/* What is Vocence */}
      <section>
        <h2 className="text-lg font-semibold mb-3">What is Vocence?</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Vocence is a Bittensor subnet focused on the development, training, evaluation, and improvement of a wide range of voice intelligence models: PromptTTS (text-to-speech), STT (speech-to-text), STS (speech-to-speech), voice cloning, TTM (text-to-music), and voice agents. This decentralized network goes beyond traditional voice synthesis by integrating multiple layers of multimodal voice intelligence, enabling dynamic voice agents with advanced control and adaptability.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Miners train and serve models that respond to detailed prompts—voice characteristics (gender, age, emotion, tone), speaking style, accent, and environmental factors. Validators assess performance using public evaluation pipelines, ensuring prompt adherence, content accuracy, and environmental consistency across use cases from natural speech to interactive voice agents and music generation.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed">
          By leveraging a decentralized incentive structure, Vocence fosters an open, permissionless ecosystem where voice models evolve into intelligent, context-aware agents adaptable to a wide array of tasks.
        </p>
      </section>

      {/* Whitepaper CTA */}
      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-base font-semibold mb-2">Full technical overview</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
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
      <section className="pt-6 border-t border-white/[0.06]">
        <h2 className="text-lg font-semibold mb-4">Next Steps</h2>
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

        </div>
      </section>
    </div>
  );

  const renderCoreConcepts = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Core Concepts</h1>
        <p className="text-sm text-zinc-400">
          Understand the fundamental concepts behind the Vocence Voice Intelligence Layer.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Voice Intelligence Domains</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
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
        <h2 className="text-lg font-semibold mb-3">Decentralized Training & Evaluation</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
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
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Architecture</h1>
        <p className="text-sm text-zinc-400">
          High-level overview of the Vocence Voice Intelligence Layer and how miners, validators, and Chutes interact.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">System Overview</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-6">
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
        <h2 className="text-lg font-semibold mb-3">Evaluation Pipeline</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
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
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">API Reference</span>
      </nav>

      <header className="space-y-6 border-b border-white/[0.06] pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            API Reference
          </h1>
          <Link
            to="/account/developer"
            className="inline-flex items-center gap-2 rounded-lg bg-[#DFFF00] px-3 py-1.5 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90"
          >
            <KeyRound size={14} strokeWidth={2} />
            Create API key
          </Link>
        </div>

      </header>

      <section className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          Voice Agent WebSocket — wire protocol
        </h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          The endpoint <code className="rounded bg-white/[0.06] px-1 text-zinc-300">wss://api.vocence.ai/v1/agents/&#123;agent_id&#125;/session</code> {' '}
          drives every voice agent — used by the Studio UI, the embed snippet, the SDK, and your own clients. It's a single
          bidirectional WebSocket carrying JSON control messages and binary PCM audio in both directions. The full
          message reference is auto-generated below; this section explains the wire-level pieces that don't
          fit cleanly in the schema browser.
        </p>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Authentication</h3>
        <p className="text-sm leading-relaxed text-zinc-400">
          Browsers can't set custom headers on a WS upgrade, so two auth shapes are supported:
        </p>
        <ul className="ml-4 list-disc space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li>
            <code className="rounded bg-white/[0.06] px-1 text-zinc-300">Authorization: Bearer voc_live_…</code> — server-side
            clients (Python, Go, Node) using your account-scoped API key. Caller must own the agent.
          </li>
          <li>
            <code className="rounded bg-white/[0.06] px-1 text-zinc-300">?token=&lt;embed-token&gt;</code> query param —
            browsers using a per-agent embed token minted in Studio → Embed. Origin-locked when configured;
            revocable at any time. See the{' '}
            <Link to="/docs/guide-agents#deploy" className="text-[#DFFF00] hover:underline">Agents guide §12</Link>{' '}
            for the embed flow.
          </li>
        </ul>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Three turn modes</h3>
        <p className="text-sm leading-relaxed text-zinc-400 mb-2">
          One turn = one user input → one agent reply. Pick the mode that matches your client:
        </p>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.03]">
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-2.5 font-medium text-zinc-300">Mode</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">Client → server</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">Use when</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">text</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>&#123;"type":"text","text":"…"&#125;</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">Chat-style. No audio input. Fastest TTFA.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">voice</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>&#123;"type":"voice","audio_b64":"…","mime":"audio/wav"&#125;</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">Press-to-talk. Whole clip in one shot. Easy to integrate.</td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">stream_start</td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  <code>&#123;"type":"stream_start","language":"en"&#125;</code><br />
                  then 20 ms PCM16LE @ 16 kHz binary frames<br />
                  then <code>&#123;"type":"stream_commit"&#125;</code> (optional VAD hint)
                </td>
                <td className="px-4 py-3 text-zinc-400 align-top">Continuous live conversation. Server runs STT + turn detection. Lowest latency. Requires{' '}
                  <code>capabilities.voice_stream=true</code> in the <code>ready</code> event.
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Server → client events</h3>
        <p className="text-sm leading-relaxed text-zinc-400">
          A typical turn yields, in order: <code>transcript</code> (final user text), optional <code>tool_call_started</code> →{' '}
          <code>tool_call_completed</code>, a sequence of <code>token</code> deltas, then per-sentence{' '}
          <code>audio_meta</code> → binary frames → <code>audio_end</code>, finally <code>turn_end</code>. Errors fire as{' '}
          <code>error</code>; the server may also send <code>session_timeout</code> (idle / max-duration) and{' '}
          <code>billing_exhausted</code> as terminal events.
        </p>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Barge-in protocol</h3>
        <p className="text-sm leading-relaxed text-zinc-400">
          Send <code>&#123;"type":"cancel"&#125;</code> to interrupt the agent. The server flushes the in-flight TTS, drops
          straggling audio chunks (so they don't queue ahead of your next reply), trims the recording's right channel to
          the moment of barge-in, and acks with <code>&#123;"type":"cancelled"&#125;</code>. Your audio player should flush
          its own queue locally — don't wait for the server confirmation before silencing the speakers.
        </p>
        <p className="text-sm leading-relaxed text-zinc-400 mt-2">
          When you instead start a new turn (<code>stream_start</code> / <code>voice</code> / <code>text</code>) while the
          agent's previous reply is still playing in your local audio queue, the server cancels the previous LLM/TTS
          server-side AND sends <code>&#123;"type":"flush_player"&#125;</code> so your client can flush whatever bytes were
          already on the wire or sitting in its prebuffer. Handle <code>flush_player</code> exactly like the audio-queue
          flush part of <code>cancelled</code> — but DO NOT close the active streaming session (the new turn just opened
          it). Flushing the player only is the difference between the two messages.
        </p>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Audio formats</h3>
        <ul className="ml-4 list-disc space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li>Client → server (stream_start mode): <strong>PCM16LE, 16 kHz, mono, 20 ms frames</strong> (640 bytes / frame).</li>
          <li>Server → client (every mode): <strong>PCM16LE, 24 kHz, mono, 40 ms frames</strong> (1920 bytes / frame), preceded by an{' '}
            <code>audio_meta</code> JSON envelope so the format is self-describing.
          </li>
          <li>Frames are NOT base64-encoded over the WS — raw binary. The base64-encoded path is only the one-shot{' '}
            <code>voice</code> upload.
          </li>
        </ul>

        <h3 className="text-sm font-semibold text-zinc-200 mt-4">Close codes</h3>
        <ul className="ml-4 list-disc space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li><code>4401</code> — authentication failed (missing / wrong / revoked token).</li>
          <li><code>4404</code> — agent id not found or not owned by the calling key.</li>
          <li><code>4502</code> — voice pipeline upstream unavailable (STT / TTS / LLM pod offline).</li>
          <li><code>4503</code> — service misconfigured (env vars / missing pods at deploy time).</li>
        </ul>
      </section>

      {/* All endpoints (REST + WebSocket + key management) are rendered
          inside the explorer. The right-rail TOC mirrors the same set
          and scrolls independently of the page. */}
      <ApiExplorer />

    </div>
  );

  const renderPricing = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Pricing</h1>
        <p className="text-sm text-zinc-400">
          Detailed pricing and billing rules for Studio and Developer API.
        </p>
      </div>

      <section className="border-t border-white/[0.06] pt-8 max-w-4xl">
        <h2 className="text-lg font-semibold tracking-tight text-white mb-3">
          Call History — recordings &amp; transcripts
        </h2>
        <p className="text-sm leading-relaxed text-zinc-400 mb-4">
          Every voice-agent call is logged. When the agent's{' '}
          <code>config.record_enabled</code> is <code>true</code>, the session also produces a stereo WAV
          (left channel = user mic post-denoise, right channel = agent TTS, both 16 kHz s16le, one shared
          timeline) uploaded to Cloudflare R2. Three endpoints expose the history:
        </p>
        <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02] mb-4">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.03] text-zinc-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">Route</th>
                <th className="px-4 py-2.5 font-medium">What it returns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr>
                <td className="px-4 py-3 align-top"><code className="text-white/90">GET /v1/agents/&#123;agent_id&#125;/calls?range=30d&amp;limit=100</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Recent calls, newest first. Each row carries <code>session_id</code>,{' '}
                  <code>started_at</code>, <code>ended_at</code>, <code>duration_ms</code>,{' '}
                  <code>end_reason</code>, <code>turn_count</code>, <code>user_chars</code>,{' '}
                  <code>agent_chars</code>, and a <code>has_recording</code> boolean. <code>range</code>{' '}
                  accepts <code>7d</code>/<code>30d</code>/<code>90d</code> (max <code>365d</code>);{' '}
                  <code>limit</code> caps at 500.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top"><code className="text-white/90">GET /v1/agents/&#123;agent_id&#125;/calls/&#123;session_id&#125;/transcript</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Per-turn transcript:{' '}
                  <code>&#123;turns: [&#123;role: "user"|"assistant", text, at_ms&#125;…]&#125;</code>. The{' '}
                  <code>at_ms</code> offset is relative to the call's <code>started_at</code> so a player
                  UI can seek to the exact moment of a turn.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top"><code className="text-white/90">GET /v1/agents/&#123;agent_id&#125;/calls/&#123;session_id&#125;/recording?download=false</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Returns <code>&#123;url, expires_in: 3600&#125;</code> — a 1-hour presigned R2 URL. Stream
                  the WAV directly from R2 (no auth needed on the GET). Pass <code>download=true</code> to
                  receive a URL with a <code>Content-Disposition: attachment</code> header so browsers
                  offer a save dialog. <strong>404</strong> when the recording is missing (agent didn't
                  have <code>record_enabled</code>, or the 30-day retention sweep already removed it).
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 align-top"><code className="text-white/90">DELETE /v1/agents/&#123;agent_id&#125;/calls/&#123;session_id&#125;/recording</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Purge a single recording from object storage. Returns{' '}
                  <code>&#123;deleted: true|false&#125;</code>; <code>false</code> means it was already
                  gone. The <code>voice_call_logs</code> row stays so analytics totals don't shift.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeBlock language="python" code={`from vocence import Vocence

client = Vocence()

# 1. List the agent's calls from the last 30 days.
calls = client.agents.calls("agent-id").list(range="30d", limit=50)
for c in calls:
    print(c["session_id"], c["duration_ms"], "recording:", c["has_recording"])

# 2. Fetch one call's per-turn transcript.
turns = client.agents.calls("agent-id").transcript(calls[0]["session_id"])
for t in turns:
    print(f"[{t['at_ms']:>6} ms] {t['role']}: {t['text']}")

# 3. Get a presigned URL for the stereo WAV.
rec = client.agents.calls("agent-id").recording(calls[0]["session_id"])
print(rec["url"])  # download or stream directly from R2
`} />
        <p className="text-xs leading-relaxed text-zinc-500 mt-3">
          Recordings require the agent's <code>config.record_enabled = true</code> (off by default for
          privacy). Default retention is 30 days; after that the WAV is purged but the call row stays.
          To delete a recording on demand, call the DELETE endpoint or{' '}
          <code>client.agents.calls(id).delete_recording(session_id)</code> from the Python SDK.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Current Plans</h2>
        <p className="text-zinc-400 mb-4 max-w-3xl leading-7">
          One-time credit packs are sold through two separate checkouts:{' '}
          <span className="text-white font-medium">Stripe</span> (card) and{' '}
          <span className="text-white font-medium">NOWPayments</span> (crypto). They use{' '}
          <span className="text-white font-medium">different USD prices and different numbers of credits</span> for the
          same plan name (Normal vs Premium). What you pay and what you receive match the button you complete on the
          pricing page. After purchase, credits behave the same for Studio and API usage.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl mb-6">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7] text-left">
              <tr>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Card (Stripe)</th>
                <th className="px-4 py-3 font-medium">Crypto (NOWPayments)</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3 text-white font-medium">Normal</td>
                <td className="px-4 py-3">$12 → {formatCreditsCompact(4000)} credits</td>
                <td className="px-4 py-3">$20 → {formatCreditsCompact(8000)} credits</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3 text-white font-medium">Premium</td>
                <td className="px-4 py-3">$24 → {formatCreditsCompact(8000)} credits</td>
                <td className="px-4 py-3">$40 → {formatCreditsCompact(16000)} credits</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-6">
            <h3 className="text-base font-semibold mb-2">Normal</h3>
            <p className="text-zinc-400 text-sm mb-3">Best for standard Studio usage.</p>
            <ul className="space-y-1.5 text-sm text-[#A7B0B7]">
              <li>Generation history saved for <span className="text-white font-medium">7 days</span></li>
              <li>Up to <span className="text-white font-medium">5 custom voices</span> (Voice Design)</li>
              <li>All Studio features (TTS, STT, Clone, Music)</li>
            </ul>
          </div>
          <div className="card-vocence p-6 border-[#DFFF00]/30">
            <h3 className="text-base font-semibold mb-2">Premium</h3>
            <p className="text-zinc-400 text-sm mb-3">Required to unlock Developer API access.</p>
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
        <h2 className="text-lg font-semibold mb-3">How Credits Are Used</h2>
        <div className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <p>
            <span className="text-white font-medium">New accounts:</span> {CREDIT_SIGNUP_BONUS} free credits at signup.
          </p>
          <div className="overflow-x-auto border border-white/[0.06] rounded-xl my-4">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-[#A7B0B7] text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Studio action</th>
                  <th className="px-4 py-3 font-medium">Credits</th>
                </tr>
              </thead>
              <tbody className="text-zinc-300">
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">Text-to-Speech</td>
                  <td className="px-4 py-3">{CREDIT_TTS} per generation</td>
                </tr>
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">Speech-to-Text</td>
                  <td className="px-4 py-3">{CREDIT_STT} per transcription</td>
                </tr>
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">Voice cloning</td>
                  <td className="px-4 py-3">{CREDIT_VOICE_CLONE} per generation</td>
                </tr>
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">Voice design (A/B preview → save)</td>
                  <td className="px-4 py-3">{CREDIT_VOICE_DESIGN_PREVIEW} for preview; saving the voice has no extra charge</td>
                </tr>
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">My voice (designed), generate speech</td>
                  <td className="px-4 py-3">{CREDIT_MY_VOICE_GENERATE} per generation</td>
                </tr>
                <tr className="border-t border-white/[0.06]">
                  <td className="px-4 py-3 text-white font-medium">Music generation (Text-to-Music)</td>
                  <td className="px-4 py-3">{CREDIT_MUSIC} per generation</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-zinc-400 text-sm">
            <span className="text-white font-medium">Studio</span> and the <span className="text-white font-medium">Developer API</span>
            use different billing units for the same features, Studio bills per generation,
            the API bills per character / per minute. See the Developer API table below for
            the exact rates.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Developer API cost reference</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          All $ prices below are quoted at the baseline rate{' '}
          <span className="text-white">1 credit ≈ $0.0025</span> (the crypto pack rate of
          8,000 credits per $20). Crypto purchases get this rate exactly; card purchases
          fund credits at a slightly higher per-credit cost but the credit cost per
          operation is the same.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Endpoint</th>
                <th className="text-left px-4 py-3">Rate (default)</th>
                <th className="text-left px-4 py-3">$ equivalent</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/tts/generate</code></td>
                <td className="px-4 py-3">4,000 credits per 1M chars</td>
                <td className="px-4 py-3">$10 / 1M chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/tts/speak</code></td>
                <td className="px-4 py-3">4,000 credits per 1M chars</td>
                <td className="px-4 py-3">$10 / 1M chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voices/{`{id}`}/speak</code></td>
                <td className="px-4 py-3">4,000 credits per 1M chars</td>
                <td className="px-4 py-3">$10 / 1M chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/clone</code></td>
                <td className="px-4 py-3">4,000 credits per 1M chars</td>
                <td className="px-4 py-3">$10 / 1M chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/stt/transcribe</code></td>
                <td className="px-4 py-3">3 credits / min · 5 min max</td>
                <td className="px-4 py-3">$0.0075 / min</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/audio/noise-remover</code></td>
                <td className="px-4 py-3">1 credit / min · 5 min / 50 MB max</td>
                <td className="px-4 py-3">$0.0025 / min</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/design/preview</code></td>
                <td className="px-4 py-3">70 credits / voice</td>
                <td className="px-4 py-3">$0.175 / voice</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/design/save</code> · <code className="text-white/90">POST /v1/voice/clone/save</code></td>
                <td className="px-4 py-3">20 credits / save</td>
                <td className="px-4 py-3">$0.05 / save</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS /v1/agents/{`{id}`}/session</code></td>
                <td className="px-4 py-3">40 credits / min · 6-sec billing, 30-sec min</td>
                <td className="px-4 py-3">$0.10 / min</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS /v1/voices/{`{id}`}/stream</code></td>
                <td className="px-4 py-3">4,000 credits per 1M chars (per speak turn)</td>
                <td className="px-4 py-3">$10 / 1M chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS /v1/stt/stream</code></td>
                <td className="px-4 py-3">20 credits / min · per-second billing</td>
                <td className="px-4 py-3">$0.05 / min</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ─────────────────── FULL ENDPOINT REFERENCE ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">All API endpoints</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          Complete list of every dev-API route. The Python SDK (<code className="text-white/90">pip install vocence</code>)
          wraps every one of these — most user code never needs raw HTTP.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3 w-1/2">Endpoint</th>
                <th className="text-left px-4 py-3">Description</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              {[
                ['GET /health', 'Uptime probe. Always 200.'],
                ['GET /v1/account', 'Account snapshot: credits, plan, key count.'],
                ['GET /v1/account/keys', 'List your developer API keys (metadata only).'],
                ['POST /v1/account/keys', 'Create a new API key (plaintext returned ONCE).'],
                ['POST /v1/account/keys/{id}/revoke', 'Revoke an API key immediately.'],
                ['GET /v1/account/usage', 'Recent API requests with credits + latency.'],
                ['POST /v1/tts/generate', 'PromptTTS: speak text in a voice described in prose.'],
                ['POST /v1/tts/speak', 'Speak text using a pre-defined speaker id.'],
                ['POST /v1/stt/transcribe', 'Transcribe a clip (up to 5 min, 50 MB).'],
                ['POST /v1/voice/clone', 'One-shot clone: reference clip → target text.'],
                ['POST /v1/voice/clone/save', 'Save a clone reference for reuse via id.'],
                ['POST /v1/voice/design/preview', 'Generate a voice from a text description.'],
                ['POST /v1/voice/design/save', 'Save a designed voice as reusable.'],
                ['POST /v1/audio/noise-remover', 'Remove background noise from an audio clip.'],
                ['GET /v1/voices/builtin', 'List built-in sample voices.'],
                ['GET /v1/voices', 'List your saved voices (designed + cloned).'],
                ['GET /v1/voices/{id}', 'Get a saved voice by id.'],
                ['DELETE /v1/voices/{id}', 'Delete a saved voice.'],
                ['POST /v1/voices/{id}/speak', 'Synthesize with a saved voice id.'],
                ['GET /v1/agents', 'List your agents (compact: id + name).'],
                ['GET /v1/agents/{id}', 'Full agent spec including bound tools.'],
                ['POST /v1/agents', 'Create a new agent (knowledge or goal type).'],
                ['PATCH /v1/agents/{id}', 'Update agent fields (name, status, voice, tools, etc.).'],
                ['DELETE /v1/agents/{id}', 'Delete an agent (cascades to bound tools).'],
                ['GET /v1/agents/templates', 'List starter agent templates.'],
                ['GET /v1/agents/templates/{id}', 'Get a template body (system prompt + knowledge starter).'],
                ['GET /v1/agents/models', 'List LLM models available for voice agents.'],
                ['GET /v1/agents/tools/builtin', 'List built-in tools (web search, weather, etc.).'],
                ['POST /v1/agents/draft', 'One-shot: generate a complete agent spec from a description.'],
                ['POST /v1/agents/architect/chat', 'Conversational agent architect — one turn at a time.'],
                ['GET /v1/agents/{id}/runs', 'List recent goal-agent runs (most recent first).'],
                ['POST /v1/agents/{id}/runs', 'Start a new goal-agent run.'],
                ['GET /v1/agents/{id}/runs/{run_id}', 'Get a run\'s status + transcript.'],
                ['POST /v1/agents/{id}/runs/{run_id}/cancel', 'Cancel a pending or running run.'],
                ['GET /v1/agents/{id}/tools', 'List custom tools bound to an agent.'],
                ['POST /v1/agents/{id}/tools/{tool_id}', 'Bind a custom tool to an agent (idempotent).'],
                ['DELETE /v1/agents/{id}/tools/{tool_id}', 'Unbind a custom tool from an agent.'],
                ['GET /v1/agent-tools', 'List your custom webhook tools.'],
                ['GET /v1/agent-tools/{id}', 'Get a custom tool by id.'],
                ['POST /v1/agent-tools', 'Register a custom webhook tool.'],
                ['PATCH /v1/agent-tools/{id}', 'Update a custom tool (URL, schema, auth).'],
                ['DELETE /v1/agent-tools/{id}', 'Delete a custom tool.'],
                ['GET /v1/agents/{id}/knowledge/sources', 'List ingested knowledge sources for an agent.'],
                ['GET /v1/agents/{id}/knowledge/jobs/{job_id}', 'Check an ingest job\'s status.'],
                ['DELETE /v1/agents/{id}/knowledge/sources/{source_id}', 'Remove an ingested source.'],
                ['POST /v1/agents/{id}/knowledge/ingest/text', 'Ingest a raw text document.'],
                ['POST /v1/agents/{id}/knowledge/ingest/markdown', 'Ingest a markdown document.'],
                ['POST /v1/agents/{id}/knowledge/ingest/url', 'Ingest a single web page by URL.'],
                ['POST /v1/agents/{id}/knowledge/ingest/sitemap', 'Crawl an entire site via its sitemap.'],
                ['POST /v1/agents/{id}/knowledge/ingest/pdf', 'Upload + parse a PDF.'],
                ['GET /v1/agents/{id}/embed-tokens', 'List embed tokens for a public-website widget.'],
                ['POST /v1/agents/{id}/embed-tokens', 'Create an embed token (allowed origins + rate limits).'],
                ['DELETE /v1/agents/{id}/embed-tokens/{id}', 'Revoke an embed token.'],
                ['GET /v1/agents/{id}/calls', 'List recent voice calls (range 7d/30d/90d, newest first).'],
                ['GET /v1/agents/{id}/calls/{session_id}/transcript', 'Per-turn transcript with at_ms timestamps.'],
                ['GET /v1/agents/{id}/calls/{session_id}/recording', 'Presigned URL for the stereo WAV (1 h TTL).'],
                ['DELETE /v1/agents/{id}/calls/{session_id}/recording', 'Purge the recording from object storage.'],
                ['POST /v1/feedback', 'Submit or update thumbs feedback on a generation.'],
                ['GET /v1/feedback', 'Fetch your current rating for a single generation.'],
                ['WS /v1/agents/{id}/session', 'Bidirectional voice-agent WebSocket (PCM in, PCM out).'],
                ['WS /v1/voices/{id}/stream', 'Streaming TTS WebSocket with a pre-registered voice.'],
                ['WS /v1/stt/stream', 'Streaming STT WebSocket — PCM in, transcripts out.'],
              ].map(([path, desc]) => (
                <tr key={path} className="border-t border-white/[0.06]">
                  <td className="px-4 py-3"><code className="text-white/90 text-[12.5px]">{path}</code></td>
                  <td className="px-4 py-3 text-zinc-400">{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Access Rules</h2>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>Developer API access requires at least one successful Premium purchase.</li>
          <li>User creates API keys in Account → Developer tab after the Premium purchase.</li>
          <li>Each request consumes credits from the same balance shown in the Studio sidebar.</li>
          <li>When credits are insufficient the API returns <code className="text-white/90">402</code> and no work is performed.</li>
        </ul>
      </section>

      {/* ─────────────────── PER-ENDPOINT HARD CAPS ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Per-endpoint limits</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          Every endpoint has a hard input cap. Requests over the cap are rejected with{' '}
          <code className="text-white/90">HTTP 413</code> <span className="text-zinc-500">(Payload Too Large)</span>{' '}
          before any credits are spent. The caps match what the Studio UI accepts —
          for longer workloads, chunk on the client side and make multiple calls.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Endpoint</th>
                <th className="text-left px-4 py-3">Input cap</th>
                <th className="text-left px-4 py-3">Other</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/tts/generate</code></td>
                <td className="px-4 py-3">2,000 chars text</td>
                <td className="px-4 py-3">style_instruction: 500 chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/tts/speak</code></td>
                <td className="px-4 py-3">2,000 chars text</td>
                <td className="px-4 py-3">voice id: 64 chars</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voices/{`{id}`}/speak</code></td>
                <td className="px-4 py-3">2,000 chars text</td>
                <td className="px-4 py-3">—</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/clone</code></td>
                <td className="px-4 py-3">2,000 chars target_text · 50 MB reference audio</td>
                <td className="px-4 py-3">reference clip best at 5–30 s</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/stt/transcribe</code></td>
                <td className="px-4 py-3">5 min · 50 MB audio</td>
                <td className="px-4 py-3">language hint must be a canonical name</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/audio/noise-remover</code></td>
                <td className="px-4 py-3">5 min · 50 MB audio</td>
                <td className="px-4 py-3">WAV / MP3 / M4A / OGG / FLAC / WebM / AAC</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/design/save</code></td>
                <td className="px-4 py-3">display_name: 20 chars</td>
                <td className="px-4 py-3">requires preview_token from previous call</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">POST /v1/voice/clone/save</code></td>
                <td className="px-4 py-3">display_name: 40 chars · 50 MB audio</td>
                <td className="px-4 py-3">5–30 s reference clip recommended</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS /v1/agents/{`{id}`}/session</code></td>
                <td className="px-4 py-3">30 min max · 60 sec idle timeout</td>
                <td className="px-4 py-3">Auto-close on balance=0 (4402), max length (4408), or idle (4410)</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ─────────────────── RATE LIMITS ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Rate limits</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          Three separate limit mechanisms apply, each with its own counter and error response.
          All three are <span className="text-white">per-account</span>, every API key you
          create draws from the same shared bucket, so spinning up additional keys does not
          multiply your quota.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Scope</th>
                <th className="text-left px-4 py-3">Limit</th>
                <th className="text-left px-4 py-3">Error</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">All HTTP endpoints (shared)</td>
                <td className="px-4 py-3">4 req/min per account (sliding 60-sec window)</td>
                <td className="px-4 py-3"><code className="text-white/90">HTTP 429</code></td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent session opens</td>
                <td className="px-4 py-3">10 opens/min per account</td>
                <td className="px-4 py-3">WS close <code className="text-white/90">4429</code></td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent concurrent sessions</td>
                <td className="px-4 py-3">5 in-flight per account</td>
                <td className="px-4 py-3">WS close <code className="text-white/90">4429</code></td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent max session length</td>
                <td className="px-4 py-3">30 min per session</td>
                <td className="px-4 py-3">WS close <code className="text-white/90">4408</code></td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent idle timeout</td>
                <td className="px-4 py-3">60 sec without a user turn → auto-close</td>
                <td className="px-4 py-3">WS close <code className="text-white/90">4410</code></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-400 mt-4 leading-relaxed">
          Higher per-account limits are available on request, contact us with your
          projected peak QPS and we'll bump the cap for your account. Voice agent session
          limits are operationally enforced and not yet self-service configurable; ping
          us if you need more concurrent voice sessions.
        </p>
      </section>

      {/* ─────────────────── WORKED BILLING EXAMPLES ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Billing examples</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          The API is pay-as-you-go within each endpoint's hard cap, you pay for what you
          actually send, not for the cap. Credits are deducted only after the work succeeds
          (no charge on <code className="text-white/90">5xx</code> or <code className="text-white/90">413</code>).
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Scenario</th>
                <th className="text-left px-4 py-3">Math</th>
                <th className="text-left px-4 py-3">Charge</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">TTS, "Hello world" (11 chars)</td>
                <td className="px-4 py-3 text-zinc-400">11 × 4,000 / 1,000,000 = 0.044, round up</td>
                <td className="px-4 py-3">1 cr · $0.0025</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">TTS, full 2,000-char article</td>
                <td className="px-4 py-3 text-zinc-400">2,000 × 4,000 / 1,000,000 = 8</td>
                <td className="px-4 py-3">8 cr · $0.02</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice clone, 500-char target text</td>
                <td className="px-4 py-3 text-zinc-400">500 × 4,000 / 1,000,000 = 2</td>
                <td className="px-4 py-3">2 cr · $0.005</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">STT, 12-second voicemail</td>
                <td className="px-4 py-3 text-zinc-400">ceil(12 / 60) = 1 min × 3 cr</td>
                <td className="px-4 py-3">3 cr · $0.0075</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">STT, 3 min 30 sec recording</td>
                <td className="px-4 py-3 text-zinc-400">ceil(210 / 60) = 4 min × 3 cr</td>
                <td className="px-4 py-3">12 cr · $0.03</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Noise remover, 45-sec clip</td>
                <td className="px-4 py-3 text-zinc-400">ceil(45 / 60) = 1 min × 1 cr</td>
                <td className="px-4 py-3">1 cr · $0.0025</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice design, preview + save 1 voice</td>
                <td className="px-4 py-3 text-zinc-400">70 cr preview + 20 cr save</td>
                <td className="px-4 py-3">90 cr · $0.225</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent, 3-sec accidental hang-up</td>
                <td className="px-4 py-3 text-zinc-400">30-sec floor: 5 increments × 4 cr</td>
                <td className="px-4 py-3">20 cr · $0.05</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent, 35-sec call</td>
                <td className="px-4 py-3 text-zinc-400">ceil(35 / 6) = 6 increments × 4 cr</td>
                <td className="px-4 py-3">24 cr · $0.06</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">Voice agent, 7-min support call</td>
                <td className="px-4 py-3 text-zinc-400">7 × 40 cr/min</td>
                <td className="px-4 py-3">280 cr · $0.70</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ─────────────────── VOICE AGENT BILLING (DEEP DIVE) ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Voice agent billing model</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          Voice agent sessions are the only continuous-flow billing path. Charges accrue
          while the WebSocket is open, not at the end. Three numbers govern the model:
        </p>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed list-disc list-inside ml-2">
          <li>
            <span className="text-white">40 cr/min</span>, the headline rate ($0.10/min
            at the baseline credit rate).
          </li>
          <li>
            <span className="text-white">6-second increments</span>, the billing loop
            deducts 4 cr every 6 seconds during the session. A 35-second call rounds up
            to 6 increments (24 cr), not 5.83. Same granularity as Vapi and Retell.
          </li>
          <li>
            <span className="text-white">30-second minimum charge</span>, a session that
            hangs up before 30 seconds is still billed 20 cr. Prevents flap-attacks where
            a leaked key opens and closes hundreds of sessions per second for ~$0.
          </li>
        </ul>
        <p className="text-sm text-zinc-400 mt-4 leading-relaxed">
          Pre-flight check: at connect time we verify the user has at least 20 credits
          (the 30-sec floor). Sessions below that balance are rejected with WS close{' '}
          <code className="text-white/90">4402</code>. While the session is live, when
          the balance can no longer cover the next 6-sec increment we send a{' '}
          <code className="text-white/90">billing_exhausted</code> JSON event and close
          with the same 4402 code. Build your SDK to surface this as a "top up credits"
          banner rather than an unexpected disconnect.
        </p>

        <p className="text-sm text-zinc-400 mt-4 leading-relaxed">
          Two additional auto-close conditions protect users and our pipeline:
        </p>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed list-disc list-inside ml-2 mt-2">
          <li>
            <span className="text-white">Max session length: 30 minutes.</span> Hard ceiling
            per WebSocket. When reached we send{' '}
            <code className="text-white/90">{`{"type":"session_timeout","code":"max_duration"}`}</code>{' '}
            and close with WS code <code className="text-white/90">4408</code>. To continue,
            open a new session, it counts as a new conversation for billing.
          </li>
          <li>
            <span className="text-white">Idle timeout: 60 seconds.</span> If no user turn
            (<code className="text-white/90">voice</code> or <code className="text-white/90">text</code>{' '}
            message) arrives for 60 seconds, the session auto-closes with{' '}
            <code className="text-white/90">{`{"type":"session_timeout","code":"idle_timeout"}`}</code>{' '}
            and WS code <code className="text-white/90">4410</code>. A <code className="text-white/90">cancel</code>{' '}
            does not count as activity. The credits already accrued are still billed.
          </li>
        </ul>
      </section>

      {/* ─────────────────── ERROR CODES ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">Error codes</h2>
        <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
          HTTP endpoints use standard status codes. WebSocket endpoints use 4xxx close
          codes (the 4000 series is reserved for application-level errors per RFC 6455).
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">Code</th>
                <th className="text-left px-4 py-3">Meaning</th>
                <th className="text-left px-4 py-3">What to do</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 400</code></td>
                <td className="px-4 py-3">Bad request (missing field, malformed base64)</td>
                <td className="px-4 py-3">Fix the request, don't retry as-is</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 401</code></td>
                <td className="px-4 py-3">Missing or invalid API key</td>
                <td className="px-4 py-3">Check the Authorization header format</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 402</code></td>
                <td className="px-4 py-3">Insufficient credits</td>
                <td className="px-4 py-3">Top up credits; no work was performed</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 403</code></td>
                <td className="px-4 py-3">Resource not owned by this API key's user, or Premium gate failed</td>
                <td className="px-4 py-3">Check ownership; purchase Premium if first-time</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 404</code></td>
                <td className="px-4 py-3">Agent / voice / resource not found</td>
                <td className="px-4 py-3">Verify the id; check spelling</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 413</code></td>
                <td className="px-4 py-3">Payload too large (cap exceeded)</td>
                <td className="px-4 py-3">Chunk the input, see per-endpoint limits above</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 429</code></td>
                <td className="px-4 py-3">Rate limit exceeded (4 req/min per account, default)</td>
                <td className="px-4 py-3">Back off; respect <code className="text-white/90">Retry-After</code> if present</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 502</code></td>
                <td className="px-4 py-3">Upstream provider error (no credits charged)</td>
                <td className="px-4 py-3">Safe to retry with exponential backoff</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">HTTP 503</code></td>
                <td className="px-4 py-3">Feature temporarily unavailable (no pods online)</td>
                <td className="px-4 py-3">Retry after 30–60 seconds</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4401</code></td>
                <td className="px-4 py-3">WebSocket auth failed (missing/invalid Bearer key)</td>
                <td className="px-4 py-3">Check the Authorization header sent during the WS handshake</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4402</code></td>
                <td className="px-4 py-3">Insufficient credits, pre-flight or mid-session exhaustion</td>
                <td className="px-4 py-3">Top up credits; the session is not recoverable</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4404</code></td>
                <td className="px-4 py-3">Agent not found / not owned by this key</td>
                <td className="px-4 py-3">Verify the agent_id and ownership</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4423</code></td>
                <td className="px-4 py-3">Agent is paused or archived</td>
                <td className="px-4 py-3">Re-activate the agent from the Studio UI</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4408</code></td>
                <td className="px-4 py-3">Session reached max duration (30 min)</td>
                <td className="px-4 py-3">Open a new session if the conversation needs to continue</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4410</code></td>
                <td className="px-4 py-3">Idle timeout, no user turn for 60 seconds</td>
                <td className="px-4 py-3">Send any user turn within 60s of the previous one to keep the session alive</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4429</code></td>
                <td className="px-4 py-3">Session-rate limit (10/min open OR 5 concurrent)</td>
                <td className="px-4 py-3">Back off; close idle sessions before opening new ones</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3"><code className="text-white/90">WS 4502/4503</code></td>
                <td className="px-4 py-3">Upstream voice pipeline error</td>
                <td className="px-4 py-3">Retry; ping us if it persists</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ─────────────────── BILLING FLOW ─────────────────── */}
      <section>
        <h2 className="text-lg font-semibold mb-3">End-to-end billing flow</h2>
        <ol className="space-y-2 text-sm text-zinc-400 leading-relaxed list-decimal list-inside">
          <li>Sign in and purchase credits from the Pricing page (Stripe or Crypto).</li>
          <li>Purchase the Premium pack at least once to unlock the Developer API.</li>
          <li>Create an API key in Account → Developer tab. Copy the <code className="text-white/90">voc_live_…</code> token once, it isn't shown again.</li>
          <li>
            Call any endpoint with <code className="text-white/90">Authorization: Bearer voc_live_…</code>.
            The server applies rate-limit and balance checks before doing any work.
          </li>
          <li>
            Credits are deducted after the work succeeds. The response includes{' '}
            <code className="text-white/90">credits_used</code> and{' '}
            <code className="text-white/90">credits_remaining</code> so you can drive
            in-app usage UI without an extra balance lookup.
          </li>
          <li>View per-call logs and spend in Account → Developer tab.</li>
        </ol>
      </section>
    </div>
  );

  const renderMinerSetup = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-2 text-sm text-[#666] mb-4">
          <span>Docs</span>
          <ChevronRight size={14} />
          <span>Guides</span>
          <ChevronRight size={14} />
          <span className="text-[#DFFF00]">Miner Setup</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Miner setup</h1>
        <p className="text-sm text-zinc-400 leading-relaxed">
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
        <h2 className="text-lg font-semibold mb-3">What miners do</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Miners train and deploy voice models that expose a single{' '}
          <code className="text-white/90 bg-white/10 px-1.5 py-0.5 rounded text-sm">POST /speak</code> API: natural-language{' '}
          <strong className="text-white/90">instruction</strong> plus <strong className="text-white/90">text</strong> → WAV
          audio. In the current quarter the subnet focuses on <strong className="text-white/90">PromptTTS</strong>; the same
          interface will extend to other voice tasks over time.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Validators call your Chute, score outputs (content, quality, prompt adherence), and incentives follow subnet
          rules. The owner verifies wrapper integrity and participant metadata via the gateway API described in the repo.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Prerequisites</h2>
        <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400 leading-relaxed">
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
        <h2 className="text-lg font-semibold mb-3">Repository layout on Hugging Face</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Your HF repo must include the files below. See{' '}
          <RepoFileLink path="miner_sample/example_repo/README.md" label="miner_sample/example_repo/README.md" /> and{' '}
          <RepoFileLink path="miner_sample/example_repo/miner.py" label="miner_sample/example_repo/miner.py" /> for a mock
          layout you replace with a real engine.
        </p>
        <div className="overflow-x-auto border border-white/[0.06] rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-white/5 text-[#A7B0B7]">
              <tr>
                <th className="text-left px-4 py-3">File</th>
                <th className="text-left px-4 py-3">Required</th>
                <th className="text-left px-4 py-3">Role</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300">
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">miner.py</code>
                </td>
                <td className="px-4 py-3">Yes</td>
                <td className="px-4 py-3">
                  Engine: class <code className="text-white/80">Miner</code>, <code className="text-white/80">warmup()</code>,{' '}
                  <code className="text-white/80">generate_wav(instruction, text)</code> → mono float32 PCM + sample rate.
                </td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">chute_config.yml</code>
                </td>
                <td className="px-4 py-3">Yes</td>
                <td className="px-4 py-3">Image, GPU node selector, Chute metadata for build.</td>
              </tr>
              <tr className="border-t border-white/[0.06]">
                <td className="px-4 py-3">
                  <code className="text-[#DFFF00]">vocence_config.yaml</code>
                </td>
                <td className="px-4 py-3">Optional</td>
                <td className="px-4 py-3">PromptTTS options (e.g. sample rate limits) if your engine reads it.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4">
          All engine logic must stay in <code className="text-white/90">miner.py</code>; only the Python stdlib and
          installed packages may be imported—no importing other files from the repo in the engine.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Canonical Chute wrapper &amp; approved variables</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Deployment uses the Jinja2 template in{' '}
          <RepoFileLink
            path="miner_sample/chute_template/vocence_chute.py.jinja2"
            label="miner_sample/chute_template/vocence_chute.py.jinja2"
          />
          . You may change <strong className="text-white/90">only</strong> these four values when rendering the script:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400 leading-relaxed mb-4">
          <li>
            <code className="text-white/90">VOCENCE_REPO</code>, Hugging Face repo ID (e.g. <code className="text-white/80">user/model</code>).
          </li>
          <li>
            <code className="text-white/90">VOCENCE_REVISION</code>, revision; a <strong className="text-white/90">commit hash</strong>{' '}
            is strongly recommended.
          </li>
          <li>
            <code className="text-white/90">VOCENCE_CHUTES_USER</code>, your Chutes username.
          </li>
          <li>
            <code className="text-white/90">VOCENCE_CHUTE_ID</code>, the <strong className="text-white/90">Chute deployment name</strong>{' '}
            you choose; it <strong className="text-white/90">must contain &quot;vocence&quot;</strong> (any position, case-insensitive).
            The on-chain Chute UUID is separate and is <em>not</em> checked for that substring.
          </li>
        </ul>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Full step-by-step: <RepoFileLink path="miner_sample/MINER_GUIDE.md" label="miner_sample/MINER_GUIDE.md" />.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Build, deploy, and register</h2>
        <ol className="list-decimal list-inside space-y-3 text-sm text-zinc-400 leading-relaxed">
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
        <h2 className="text-lg font-semibold mb-3">Vocence CLI (optional automation)</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          From a clone of the repo, install dependencies (e.g. <code className="text-white/90">uv sync</code>) and use:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>
            <code className="text-white/90">vocence miner push</code>, deploy HF model to Chutes (
            <code className="text-white/80">--model-name</code>, <code className="text-white/80">--model-revision</code>).
          </li>
          <li>
            <code className="text-white/90">vocence miner commit</code>, commit model name, revision, and Chute ID to the chain.
          </li>
        </ul>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4">
          Complete flags and env:{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md" /> (section &quot;Miner commands&quot;). Example env keys for local
          tooling: <RepoFileLink path="env.example" label="env.example" />.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">HTTP API your Chute must expose</h2>
        <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>
            <code className="text-white/90">GET /health</code>, status, HF repo/revision, load state, sample rate, adapter.
          </li>
          <li>
            <code className="text-white/90">POST /speak</code>, JSON <code className="text-white/80">{`{ "instruction", "text" }`}</code>
            ; response <code className="text-white/80">audio/wav</code> bytes.
          </li>
        </ul>
      </section>

      <section className="bg-white/5 border border-white/[0.06] rounded-xl p-6">
        <h2 className="text-base font-semibold mb-3">Wrapper integrity (owner check)</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          The <strong className="text-white/90">owner</strong> (not validators) fetches your deploy script from the Chutes
          API, masks the four approved variables, normalizes the AST, and compares a hash to the canonical template. Mismatch
          or fetch failure marks the participant invalid. Validators only call <code className="text-white/90">/health</code> and{' '}
          <code className="text-white/90">/speak</code> for scoring—keep the wrapper unchanged except for those variables.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Details: <RepoFileLink path="miner_sample/MINER_GUIDE.md" label="MINER_GUIDE.md § Wrapper integrity" /> ·{' '}
          <RepoFileLink path="docs/base-model-protocol.md" label="Base model &amp; burn protocol" /> (how reference models and
          burn behave in scoring).
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Scoring context</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          To understand what validators optimize for (task generation from corpus audio, global aggregation, eligibility
          thresholds), read{' '}
          <RepoFileLink path="docs/scoring.md" label="docs/scoring.md" />.
        </p>
      </section>
    </div>
  );

  const renderValidatorSetup = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-2 text-sm text-[#666] mb-4">
          <span>Docs</span>
          <ChevronRight size={14} />
          <span>Guides</span>
          <ChevronRight size={14} />
          <span className="text-[#DFFF00]">Validator Setup</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Validator setup</h1>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Validators run the subnet evaluation loop: sample generation from the shared corpus, miner queries via Chutes,
          uploads to your Hippius bucket, metadata to the owner API, and on-chain weights using{' '}
          <strong className="text-white/90">global consensus scoring</strong>. This mirrors{' '}
          <RepoFileLink path="README.md" label="README.md" /> and{' '}
          <RepoFileLink path="docs/validator-setup.md" label="docs/validator-setup.md" />.
        </p>
      </div>

      <section className="bg-amber-500/10 border border-amber-500/25 rounded-xl p-6">
        <h2 className="text-base font-semibold mb-3 text-amber-100">Contact the Vocence team first</h2>
        <p className="text-[#E8DDD0] leading-7">
          You need team-provided access before a validator can run in production:{' '}
          <strong className="text-white">Chutes permission</strong> (validators call miners&apos; chutes),{' '}
          <strong className="text-white">owner API URL</strong> (<code className="text-white/90">API_URL</code>, participants,
          blocklist, evaluations, active validators), and <strong className="text-white">Hippius keys</strong> (corpus
          read-only + your validator bucket, plus readonly credentials for other validators&apos; sample buckets for global
          scoring). Without these, setup cannot be completed.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Credentials at a glance</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Align your <code className="text-white/90">.env</code> with{' '}
          <RepoFileLink path="env.example" label="env.example" />. Typical validator variables include:
        </p>
        <ul className="list-disc pl-5 space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>
            <strong className="text-white/90">Bittensor:</strong>{' '}
            <code className="text-white/80">NETWORK</code>, <code className="text-white/80">NETUID</code> (mainnet subnet{' '}
            <code className="text-white/80">78</code> in docs), <code className="text-white/80">WALLET_NAME</code>,{' '}
            <code className="text-white/80">HOTKEY_NAME</code>.
          </li>
          <li>
            <strong className="text-white/90">Chutes:</strong>{' '}
            <code className="text-white/80">CHUTES_API_KEY</code> (or <code className="text-white/80">CHUTES_AUTH_KEY</code>), team-granted.
          </li>
          <li>
            <strong className="text-white/90">OpenAI:</strong>{' '}
            <code className="text-white/80">OPENAI_AUTH_KEY</code>, used in the evaluation pipeline (audio / scoring stack per repo).
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
            <code className="text-white/80">VALIDATOR_BUCKETS_JSON</code>, JSON array of{' '}
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
        <h2 className="text-lg font-semibold mb-3">Recommended: Docker + Watchtower</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          The team publishes a validator image; Watchtower pulls new tags so your node stays current without manual restarts.
          Full walkthrough (Docker install, wallet mounts, <code className="text-white/80">logs/</code> permissions, compose
          commands, troubleshooting):
        </p>
        <p>
          <RepoFileLink path="docs/validator-setup.md" label="docs/validator-setup.md" /> ·{' '}
          <RepoFileLink path="docker-compose.yml" label="docker-compose.yml" /> ·{' '}
          <RepoFileLink path="docs/cicd-pipeline.md" label="docs/cicd-pipeline.md" /> (how images are built and published).
        </p>
        <div className="mt-6 rounded-xl border border-white/10 bg-[#0a0a0a] p-4 font-mono text-sm text-zinc-300 overflow-x-auto">
          <pre className="whitespace-pre-wrap">{`git clone ${GH}.git
cd vocence
cp env.example .env
# Edit .env: wallet, CHUTES_*, OPENAI_*, API_URL, Hippius keys, VALIDATOR_BUCKETS_JSON, etc.
mkdir -p logs && sudo chown 1000:1000 logs
docker compose up -d`}</pre>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4 text-sm">
          Mount <code className="text-white/90">~/.bittensor/wallets</code> per the compose file; if wallets live under root,
          fix ownership so UID 1000 can read them (documented in validator-setup).
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Alternative: run from source</h2>
        <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4 font-mono text-sm text-zinc-300 overflow-x-auto mb-4">
          <pre className="whitespace-pre-wrap">{`uv sync
uv run vocence serve`}</pre>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed">
          <code className="text-white/90">vocence serve</code> runs sample generation and weight setting in one process. To split
          generator vs weight-setter for scaling, see{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md, Validator commands" /> (
          <code className="text-white/80">vocence services generator</code>,{' '}
          <code className="text-white/80">vocence services validator</code>).
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">How weight setting works (summary)</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Each validator still generates its own samples locally. When setting weights, it pulls the valid miner list and
          active validator list from the owner API, intersects with <code className="text-white/80">VALIDATOR_BUCKETS_JSON</code>, reads recent
          evaluation windows from those buckets, and aggregates miner performance with <strong className="text-white/90">stake-weighted</strong>{' '}
          rules (<code className="text-white/80">sqrt(stake)</code>). A miner needs enough evaluations across enough active
          validator buckets to be globally eligible; the winner must beat earlier eligible commitments (including the owner base
          model when configured) by the threshold margin, or the subnet burns weight on UID 0.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Exact thresholds, tie-breaks, and task generation:{' '}
          <RepoFileLink path="docs/scoring.md" label="docs/scoring.md" /> · base model behavior:{' '}
          <RepoFileLink path="docs/base-model-protocol.md" label="docs/base-model-protocol.md" />.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Owner / API database (operators only)</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          If you operate the centralized gateway stack (Postgres, API, corpus downloader), see{' '}
          <RepoFileLink path="docs/setup-postgres-vocence.md" label="docs/setup-postgres-vocence.md" /> and owner sections in{' '}
          <RepoFileLink path="docs/CLI.md" label="docs/CLI.md" />. This is separate from the typical validator quick start.
        </p>
      </section>

      <section className="bg-white/5 border border-white/[0.06] rounded-xl p-6">
        <h2 className="text-base font-semibold mb-3">Clone the repository</h2>
        <a
          href={GH}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-[#DFFF00] hover:underline font-medium"
        >
          github.com/vocence-78/vocence
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
      <div className="space-y-8">
        <div className="border-b border-white/[0.06] pb-6">
          <h1 className="text-2xl font-semibold mb-2 tracking-tight">FAQ</h1>
          <p className="text-sm text-zinc-400">
            Frequently asked questions about Vocence.
          </p>
        </div>

        <section className="space-y-6">
          {faqs.map((item, index) => (
            <div
              key={index}
              className="border border-white/[0.06] rounded-xl p-6 bg-white/[0.02] hover:border-white/20 transition-colors"
            >
              <h3 className="text-lg font-semibold text-white mb-3">Q: {item.q}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">A: {item.a}</p>
            </div>
          ))}
        </section>
      </div>
    );
  };

  const renderDefault = (title: string, description: string) => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">{title}</h1>
        <p className="text-sm text-zinc-400">{description}</p>
      </div>

      <div className="card-vocence p-12 text-center">
        <div className="w-16 h-16 rounded-full bg-[#DFFF00]/10 flex items-center justify-center mx-auto mb-4">
          <Terminal size={28} className="text-[#DFFF00]" />
        </div>
        <h2 className="text-base font-semibold mb-2">Coming Soon</h2>
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

  const renderGuideAgents = () => (
    <div className="space-y-10">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Studio Guides</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Agents</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Agents, Build &amp; Deploy Voice Agents</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          A Vocence Agent is a voice-first AI you configure once and call again and again, for support, study,
          brainstorming, autonomous work, and anything in between. This guide covers everything from your first agent to
          tool-calling, custom webhooks, voice tuning, persistence, costs, and troubleshooting.
        </p>
      </div>

      {/* In-page TOC. */}
      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-sm font-semibold mb-3 uppercase tracking-wider text-zinc-500">On this page</h2>
        <ul className="grid sm:grid-cols-2 gap-2 text-sm">
          <li><a href="#two-flavors" className="text-zinc-300 hover:text-[#DFFF00]">1. Two flavors</a></li>
          <li><a href="#quick-start" className="text-zinc-300 hover:text-[#DFFF00]">2. Quick start</a></li>
          <li><a href="#anatomy" className="text-zinc-300 hover:text-[#DFFF00]">3. Anatomy of an agent</a></li>
          <li><a href="#tools" className="text-zinc-300 hover:text-[#DFFF00]">4. Tools (built-in)</a></li>
          <li><a href="#custom-tools" className="text-zinc-300 hover:text-[#DFFF00]">5. Custom webhook tools</a></li>
          <li><a href="#voice" className="text-zinc-300 hover:text-[#DFFF00]">6. Voice tuning</a></li>
          <li><a href="#chatting" className="text-zinc-300 hover:text-[#DFFF00]">7. Chatting &amp; memory</a></li>
          <li><a href="#latency" className="text-zinc-300 hover:text-[#DFFF00]">8. Latency &amp; what to expect</a></li>
          <li><a href="#goal" className="text-zinc-300 hover:text-[#DFFF00]">9. Goal agents</a></li>
          <li><a href="#cost" className="text-zinc-300 hover:text-[#DFFF00]">10. Cost &amp; credits</a></li>
          <li><a href="#calls" className="text-zinc-300 hover:text-[#DFFF00]">11. Calls, recordings &amp; replay</a></li>
          <li><a href="#deploy" className="text-zinc-300 hover:text-[#DFFF00]">12. Deploying — embed &amp; webhooks</a></li>
          <li><a href="#privacy" className="text-zinc-300 hover:text-[#DFFF00]">13. Privacy &amp; data</a></li>
          <li><a href="#troubleshooting" className="text-zinc-300 hover:text-[#DFFF00]">14. Troubleshooting</a></li>
        </ul>
      </section>

      <section id="two-flavors">
        <h2 className="text-lg font-semibold mb-3">1. Two flavors</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-[#DFFF00]/15 text-[#DFFF00] border border-[#DFFF00]/30">Knowledge</span>
            </div>
            <h3 className="font-medium mb-2 text-sm">Conversational</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Answers questions using injected knowledge plus its tools. You talk to it via voice or text in real time.
              Examples: customer support, study coach, internal docs assistant, a research helper that searches the web
              when it doesn't know.
            </p>
          </div>
          <div className="card-vocence p-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-md bg-purple-500/15 text-purple-200 border border-purple-400/30">Goal</span>
            </div>
            <h3 className="font-medium mb-2 text-sm">Self-improving</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              You give it a goal and a success metric; it iterates toward the target, scoring itself each round and
              refining. Examples: cold-email refiner, daily summarizer, draft brainstormer. No live chat, runs are
              triggered and you watch the iterations.
            </p>
          </div>
        </div>
      </section>

      <section id="quick-start">
        <h2 className="text-lg font-semibold mb-3">2. Quick start</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>
            Open <Link to="/studio/agents" className="text-[#DFFF00] hover:underline">Studio → Agents</Link> and click{' '}
            <span className="text-zinc-200">New Agent</span> (or pick a template).
          </li>
          <li>
            Describe your agent in plain English on the left pane. The{' '}
            <span className="text-zinc-200">Agent Architect</span> drafts the full config (name, purpose, system prompt,
            voice, model, knowledge) on the right.
          </li>
          <li>
            Refine by chatting ("make it more technical", "shorten the answers") or by editing any field directly.
            Each field has a ✨ button to regenerate just that one.
          </li>
          <li>
            For Goal agents, fill in <span className="text-zinc-200">Goal</span>,{' '}
            <span className="text-zinc-200">Success metric</span>, and{' '}
            <span className="text-zinc-200">Max iterations</span>.
          </li>
          <li>
            Click <span className="text-zinc-200">Deploy</span>. Your agent is now active. Knowledge agents open a chat
            tab; Goal agents show a Runs tab where you start runs and watch iterations.
          </li>
        </ol>
      </section>

      <section id="anatomy">
        <h2 className="text-lg font-semibold mb-3">3. Anatomy of an agent</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Every Knowledge agent has four levers. Knowing which lever to pull is most of the skill of building good
          agents.
        </p>
        <div className="space-y-4">
          <div className="card-vocence p-5">
            <h3 className="font-medium text-sm mb-2 text-zinc-100">Purpose</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              One or two sentences describing what the agent is for. This seeds the system prompt and is the single
              biggest determinant of agent quality. <span className="text-zinc-300">Bad:</span> "a helpful assistant".{' '}
              <span className="text-zinc-300">Good:</span> "answer factual questions about the Bittensor network and its
              subnets; refuse to advise on prices or speculation".
            </p>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium text-sm mb-2 text-zinc-100">System prompt</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Tone, personality, behavioural rules. <span className="text-zinc-300">What it should refuse, how it
              should phrase things, how long replies should be, whether it can be playful or must be formal.</span> Don't
              put facts here, those go in Knowledge.
            </p>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium text-sm mb-2 text-zinc-100">Knowledge</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Static facts the agent should treat as authoritative. Pricing, FAQs, product specs, internal policies.
              Short knowledge (≤ a few KB) is dumped into the system prompt verbatim. Larger bodies switch to retrieval
              automatically, relevant chunks are injected per turn so the agent only "sees" what matters for that
              question. You don't have to do anything for retrieval to kick in; the system picks the right strategy.
            </p>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium text-sm mb-2 text-zinc-100">Tools</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Live actions the agent can take mid-conversation: search the web, look up weather, hit your own API. The
              agent decides when to use them based on what the user asks. Toggle tools on/off in the agent settings;
              the agent only sees the ones you enabled.
            </p>
          </div>
        </div>
      </section>

      <section id="tools">
        <h2 className="text-lg font-semibold mb-3">4. Tools, built-in</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Vocence ships five tools every agent can use out of the box. Enable them per-agent in the settings tab. The
          agent decides when to call them, you don't have to script the trigger; the LLM matches the user's question
          to the tool description.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
                <th className="py-2 pr-3 font-medium">Tool</th>
                <th className="py-2 pr-3 font-medium">What it does</th>
                <th className="py-2 font-medium">Fires when the user asks…</th>
              </tr>
            </thead>
            <tbody className="text-zinc-400">
              <tr className="border-b border-white/[0.04]">
                <td className="py-3 pr-3"><code className="text-[#DFFF00]">get_time</code></td>
                <td className="py-3 pr-3">Current time in any timezone</td>
                <td className="py-3">"what time is it in Tokyo?"</td>
              </tr>
              <tr className="border-b border-white/[0.04]">
                <td className="py-3 pr-3"><code className="text-[#DFFF00]">get_weather</code></td>
                <td className="py-3 pr-3">Live weather via Open-Meteo (no key)</td>
                <td className="py-3">"what's the weather in Paris?"</td>
              </tr>
              <tr className="border-b border-white/[0.04]">
                <td className="py-3 pr-3"><code className="text-[#DFFF00]">web_search</code></td>
                <td className="py-3 pr-3">Web search via Tavily</td>
                <td className="py-3">News, recent events, anything time-sensitive</td>
              </tr>
              <tr className="border-b border-white/[0.04]">
                <td className="py-3 pr-3"><code className="text-[#DFFF00]">fetch_url</code></td>
                <td className="py-3 pr-3">Fetch a specific URL the user mentions</td>
                <td className="py-3">"summarize this page: https://…"</td>
              </tr>
              <tr>
                <td className="py-3 pr-3"><code className="text-[#DFFF00]">wikipedia_lookup</code></td>
                <td className="py-3 pr-3">Wikipedia article extract</td>
                <td className="py-3">Encyclopedic / historical lookups</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4">
          When the agent calls a tool, a chip ("Searching the web…", "Checking weather…") appears in the chat bubble
          while it runs, then turns green when the result comes back. The agent then incorporates the result into its
          reply without reading the raw JSON aloud.
        </p>
      </section>

      <section id="custom-tools">
        <h2 className="text-lg font-semibold mb-3">5. Custom webhook tools</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          You can register your own HTTP endpoints as tools the agent can call. Useful when your data lives elsewhere
          (your DB, an internal API, a third-party service the built-ins don't cover).
        </p>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">How a call reaches your endpoint</h3>
        <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-[12px] text-zinc-300 overflow-x-auto font-mono leading-relaxed mb-4">
{`# POST tool (default)
POST <your endpoint>
Content-Type: application/json
Authorization: Bearer <your auth secret>   ← only if you set one

{ "arguments": { "limit": 10, "category": "active" } }

# GET tool, args go as query params, no body
GET <your endpoint>?limit=10&category=active
Authorization: Bearer <your auth secret>`}
        </pre>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">The parameters JSON Schema</h3>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          This is the schema describing what arguments the LLM is allowed to send. The simplest case, your endpoint
          takes no inputs:
        </p>
        <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-[12px] text-zinc-300 overflow-x-auto font-mono leading-relaxed mb-4">
{`{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}`}
        </pre>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          With filters the LLM can pass:
        </p>
        <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-[12px] text-zinc-300 overflow-x-auto font-mono leading-relaxed mb-4">
{`{
  "type": "object",
  "properties": {
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "description": "Max results. Default 20 if user doesn't specify."
    },
    "category": {
      "type": "string",
      "enum": ["active", "pending", "archived"],
      "description": "Filter by category."
    }
  },
  "required": ["limit"],
  "additionalProperties": false
}`}
        </pre>
        <h3 className="text-sm font-medium text-zinc-100 mb-2">The description field is what makes it work</h3>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          The tool's description (separate from the parameters schema) is what tells the LLM <em>when</em> to call it.
          Don't write <code className="text-zinc-300">"my API"</code>. Write something the LLM can pattern-match against
          user phrasing:
        </p>
        <div className="card-vocence p-4 text-sm leading-relaxed">
          <span className="text-emerald-300 text-[11px] uppercase tracking-wider">Good</span>
          <p className="text-zinc-300 mt-1.5">
            "Returns the current list of registered validators on subnet 36. Call this whenever the user asks who's
            validating, asks for validator membership, asks about specific hotkeys, or wants to know the size of the
            active set. The list may change between calls, always fetch fresh, don't reuse a previous result."
          </p>
        </div>
        <div className="card-vocence p-4 text-sm leading-relaxed mt-2">
          <span className="text-red-300 text-[11px] uppercase tracking-wider">Bad</span>
          <p className="text-zinc-400 mt-1.5">"Get validator list"</p>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4">
          Each property's <code className="text-zinc-300">"description"</code> matters too, that's how the LLM decides
          what value to fill in. <code className="text-zinc-300">"the limit"</code> is useless. <code className="text-zinc-300">"Maximum
          number of results to return. Default 20 if the user didn't specify a count."</code> is what gives the LLM a
          sensible default.
        </p>
      </section>

      <section id="voice">
        <h2 className="text-lg font-semibold mb-3">6. Voice tuning</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          Every agent has a voice. Three sources:
        </p>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>
            <span className="text-zinc-200 font-medium">Sample voices</span>, curated bank (Ryan, Olivia, Ethan, Cherry,
            Dylan, Abigail and more). Lowest latency. Pick one when starting out.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Designed voices</span>, generated via Voice Design from a text
            description ("warm female voice with a slight Australian accent"). Saved to your account; selectable per
            agent.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Cloned voices</span>, upload a 5–15 second sample of any voice
            and clone it. Comes with the usual ethical caveats; we require consent confirmation for cloning.
          </li>
        </ul>
        <div className="card-vocence p-4 text-sm text-zinc-400 leading-relaxed mt-4">
          <span className="text-zinc-200 font-medium">Match voice to role.</span> Ryan/Ethan are neutral and fast,
          good for general assistants. Olivia/Abigail land warmer, good for support. Cherry/Dylan are tuned for Mandarin.
          The system prompt has more influence on perceived personality than the voice itself, same voice, different
          prompt, completely different feel.
        </div>
      </section>

      <section id="chatting">
        <h2 className="text-lg font-semibold mb-3">7. Chatting &amp; memory</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          A few things worth knowing about how a chat session behaves:
        </p>
        <ul className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <li>
            <span className="text-zinc-200 font-medium">Memory is per-session.</span> The agent remembers everything
            you've said in the current connection. Switching tabs within the same agent detail page (Chat ↔ Settings)
            keeps the connection alive, the agent still remembers. Closing the tab or refreshing wipes the conversation
            (this is by design; the conversation isn't logged anywhere by default).
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Settings edits don't take effect mid-chat.</span> The system
            prompt is built when the WebSocket session opens. If you edit the system prompt or knowledge mid-conversation,
            the current session still uses the OLD config until you start a fresh one (refresh the page).
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Always-on listening.</span> When the chat tab is active, the
            mic stays armed. A voice activity detector (VAD) decides when you're speaking and when you stop. You can
            barge-in mid-reply, the agent stops talking and listens.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Audio and text appear in lockstep.</span> The text in the chat
            bubble reveals at roughly reading pace as the audio plays. If you see text without audio (or vice versa),
            something's off, see the troubleshooting section below.
          </li>
        </ul>
      </section>

      <section id="latency">
        <h2 className="text-lg font-semibold mb-3">8. Latency &amp; what to expect</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Expect <span className="text-zinc-200">first audio in roughly 600ms–1s</span> from the moment you stop
          speaking. Most conversational turns land near the lower end; turns that fire a tool (web search, fetch URL,
          custom webhook) add another 200–500ms while the tool runs.
        </p>
      </section>

      <section id="goal" className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">9. Goal agents, how iteration works</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          Each run loops up to <span className="text-zinc-200">Max iterations</span> times (or stops early when the
          self-score crosses 0.9). On every iteration the agent:
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>Reads the goal, success metric, knowledge, and the last few prior outputs.</li>
          <li>Produces a new attempt, this is the deliverable.</li>
          <li>Self-scores against the success metric and explains the score.</li>
          <li>
            Stores the iteration in the timeline; if it's the highest score so far, becomes the
            "best output".
          </li>
        </ol>
        <p className="text-sm text-zinc-400 leading-relaxed mt-3">
          You can cancel a run any time. You always see the full timeline (thought, output, score, rationale) for
          every iteration.
        </p>
        <div className="mt-4 p-3 rounded-lg border border-amber-400/20 bg-amber-500/[0.05] text-sm text-amber-100/90">
          <span className="font-medium">Tip:</span> the success metric is the entire game. "Sounds professional" is
          bad, the agent will score itself 0.9 on the first try and stop. "Under 90 words, exactly one call-to-action,
          no buzzwords" is good, the agent has measurable criteria to fail against and improve.
        </div>
      </section>

      <section id="cost">
        <h2 className="text-lg font-semibold mb-3">10. Cost &amp; credits</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          Voice conversation runs on credits. Approximate per-turn cost depends on the components fired:
        </p>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>• STT for the user's audio: <span className="text-zinc-200">~2 credits</span></li>
          <li>• LLM (per turn, including any tool calls): <span className="text-zinc-200">~3–8 credits</span></li>
          <li>• TTS for the reply: <span className="text-zinc-200">~5 credits per sentence</span></li>
        </ul>
        <p className="text-sm text-zinc-400 leading-relaxed mt-4">
          A typical 4-turn back-and-forth conversation is around <span className="text-zinc-200">30–80 credits</span>.
          Tool-using turns cost the same as regular turns, the tool dispatch is free; you pay for the LLM round that
          interprets the result. Goal agent runs charge per iteration. Your balance is shown in the top-right;{' '}
          <Link to="/account?tab=credits" className="text-[#DFFF00] hover:underline">top up here</Link>.
        </p>
      </section>

      <section id="calls">
        <h2 className="text-lg font-semibold mb-3">11. Calls, recordings &amp; replay</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Every conversation an agent has — yours, your team's, or a public visitor's — is captured for review.
          Open any agent and click the <span className="text-zinc-200">Calls</span> tab to scroll the call history,
          listen back, copy transcripts, or hand them to your CRM.
        </p>
        <div className="space-y-4">
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Session replay page</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Clicking a call row opens a per-call replay: a stereo waveform (left&nbsp;=&nbsp;user, right&nbsp;=&nbsp;agent),
              the full transcript with per-turn timestamps, and click-to-seek rows. Hitting the play button on any
              row jumps the audio to that exact moment. The bottom <span className="text-zinc-200">music-style
              player</span> follows you across pages so a recording keeps playing while you navigate.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Downloads — WAV, transcript, CSV</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Three buttons per call: download the stereo WAV (16&nbsp;kHz), download the transcript as plain text, or
              export the whole call list to CSV from the Calls tab header. CSVs include
              <code className="rounded bg-white/[0.06] px-1 mx-1 text-zinc-300">session_id</code>,
              <code className="rounded bg-white/[0.06] px-1 mx-1 text-zinc-300">started_at</code>,
              <code className="rounded bg-white/[0.06] px-1 mx-1 text-zinc-300">duration_ms</code>, and the full
              redacted transcript per row.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Search across history</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              The search bar on the Calls tab runs a full-text query over every call this agent has ever had —
              powered by an SQLite FTS5 index. Type a word or phrase, hit enter, and you get matching sessions
              with the hit highlighted in the transcript snippet. Useful for "did anyone ever ask about pricing?"
              after a few hundred calls have accumulated.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Turning recording off</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Recording is on by default but per-agent. Settings → Recording → uncheck "Record calls" to disable
              for new sessions. Pre-existing recordings keep playing; only future calls won't be captured.
              Retention is 30 days; older WAVs are swept automatically. See section 13 for manual purges.
            </p>
          </div>
        </div>
      </section>

      <section id="deploy">
        <h2 className="text-lg font-semibold mb-3">12. Deploying — embed &amp; webhooks</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Once an agent works in Studio, you'll want it on your own site, in your own app, or wired into your own
          tooling. Three integration shapes, pick the one that fits.
        </p>
        <div className="space-y-4">
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Embed snippet — paste it on your site</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Settings → <span className="text-zinc-200">Embed</span> → mint a token, copy the one-line
              <code className="rounded bg-white/[0.06] px-1 mx-1 text-zinc-300">&lt;script&gt;</code>
              snippet, paste it into your HTML. Visitors get a floating mic button that opens a full-screen call UI
              with your agent. Pin the snippet to specific origins (your domain) for security; you can leave it open
              for embedding anywhere too. Revoke any token from the Embed tab — every site using it stops working
              immediately.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Outbound webhooks — react to call.ended</h3>
            <p className="text-sm text-zinc-400 leading-relaxed mb-3">
              Settings → <span className="text-zinc-200">Webhooks</span> → register a URL + secret. Every time a call
              completes, we POST a signed JSON envelope to your URL so you can pipe transcripts into your CRM, alert
              on escalations, or kick off follow-up workflows. Signature uses the same HMAC-SHA256
              scheme as custom-tool webhooks (see the{' '}
              <Link to="/docs/sdk-webhooks" className="text-[#DFFF00] hover:underline">SDK Webhooks page</Link>
              {' '}for verification helpers). Retries on 5xx / timeout with backoff at 30s, 2m, 10m, 30m.
            </p>
            <pre className="bg-black/40 border border-white/[0.06] rounded-lg p-4 text-[12px] text-zinc-300 overflow-x-auto font-mono leading-relaxed">
{`POST https://your-app.example.com/vocence/events
Content-Type: application/json
X-Vocence-Timestamp: 1735689600
X-Vocence-Signature: v1=BASE64(HMAC-SHA256(secret, "v1.{ts}.{body}"))

{
  "event": "call.ended",
  "session_id": "abc123",
  "agent_id": 42,
  "started_at": "2026-06-13T18:42:11Z",
  "duration_ms": 187000,
  "transcript": "User: Hi, can you help …",
  "recording_url": "https://audio.vocence.ai/…/abc123.wav"
}`}</pre>
            <p className="text-sm text-zinc-400 leading-relaxed mt-3">
              The <span className="text-zinc-200">Test</span> button on the Webhooks tab fires a synthetic
              event you can use to wire up your receiver before any real call lands.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">API — full programmatic control</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              For mobile apps or custom voice UIs, drive the agent over the API directly: open a WebSocket to{' '}
              <code className="rounded bg-white/[0.06] px-1 text-zinc-300">/voicechat/agent/&lt;id&gt;</code>,
              stream PCM up, get token + audio back. The{' '}
              <Link to="/docs/api" className="text-[#DFFF00] hover:underline">API Reference</Link> has the wire
              protocol; the{' '}
              <Link to="/docs/sdk-python" className="text-[#DFFF00] hover:underline">Python SDK</Link> wraps it.
            </p>
          </div>
        </div>
      </section>

      <section id="privacy">
        <h2 className="text-lg font-semibold mb-3">13. Privacy &amp; data</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          What we keep, where it lives, how to delete it.
        </p>
        <div className="space-y-4">
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">PII redaction on stored transcripts</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Email addresses, phone numbers, and credit-card-shaped digit runs are auto-redacted at the
              storage boundary. The LLM still sees the raw text in-call (so it can actually help the user —
              "your card ending in 4242" works), but anything written to the per-call transcript, search index,
              CSV export, or webhook payload is masked. No agent-side configuration needed.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Where audio lives</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Call WAVs go to Cloudflare R2 under a per-user prefix. Transcripts live in your dashboard's local
              SQLite. Audio in transit is TLS; audio at rest is R2-managed encryption. Server logs are operational
              only (timings, error codes) — no transcript bodies are written to logs.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Deletion</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Two paths: per-call (a delete button next to each row in the Calls tab — purges the WAV immediately
              and NULLs the transcript pointer), or wait for the 30-day retention sweep that runs in the existing
              background cleanup loop. Delete is irreversible. Disabling recording per-agent (section&nbsp;11) stops
              new captures but doesn't touch existing ones.
            </p>
          </div>
        </div>
      </section>

      <section id="troubleshooting">
        <h2 className="text-lg font-semibold mb-3">14. Troubleshooting</h2>
        <div className="space-y-4">
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">The agent doesn't talk at all</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Check the agent status (top of settings), paused or archived agents block chat. Also check that your
              mic permission is granted in the browser and that the connecting state passes within ~5 seconds. If the
              state stays on "connecting", you've lost the WebSocket; reload the page.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Agent answers but doesn't use the tool I enabled</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              The trigger isn't the tool being enabled, it's the LLM matching the user's phrasing to the tool's
              description. Make the description more specific and use the keywords a user might naturally say. For
              custom tools, "Returns…" / "Use when the user asks about X, Y, Z" works better than "API for…".
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Audio plays but no text in the chat bubble (or vice versa)</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Hard-refresh the page (Ctrl/Cmd-Shift-R). A stale frontend bundle is the usual culprit, Vite HMR
              occasionally misses a streaming-related change.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Replies are too short / too long</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Both are system-prompt tuning. Add to the prompt: "Keep replies short, 1–2 sentences unless the user
              explicitly asks for detail" (terse), or "After research-tool calls give 4–7 sentences with specifics"
              (verbose). Existing chat sessions use the OLD prompt, refresh to apply.
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Latency feels high</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Three knobs help. (1) Switch the agent's LLM model to a faster provider in settings. (2) Trim the
              knowledge field, large blobs are retrieved per-turn and that adds latency. (3) The filler audio kicks
              in after 350ms by default; if you still feel silence, the slow stage is upstream of where the filler
              fires (typically STT).
            </p>
          </div>
          <div className="card-vocence p-4">
            <h3 className="font-medium text-sm text-zinc-100 mb-1.5">Custom tool returns the wrong shape and the agent gets confused</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Your endpoint can return any JSON or text, the agent hands the response to the LLM as-is. If results are
              wrapped (e.g. <code className="text-zinc-300">{`{"data": [...]}`}</code>) make sure the description
              mentions the shape: "Returns an object with a <code className="text-zinc-300">data</code> array of
              hotkeys." Otherwise the LLM may guess at the structure and answer wrong.
            </p>
          </div>
        </div>
      </section>

      <section className="pt-6 border-t border-white/[0.06]">
        <Link
          to="/studio/agents"
          className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2.5 text-sm font-semibold hover:brightness-110"
        >
          Open Studio → Agents
          <ChevronRight size={16} />
        </Link>
      </section>
    </div>
  );

  const renderGuideTts = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Studio Guides</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Text-to-Speech</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Text-to-Speech, Practice Guide</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          How to get the best results from Vocence Studio TTS. Tips for writing style prompts, picking lengths and
          languages, and avoiding common errors.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">What it does</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Voice Design TTS invents a persona on the fly from your style prompt, no reference audio required. It reads
          the text, listens to your style instruction, and renders speech in one of 10 supported languages. Every
          generation is non-deterministic: the same prompt twice will sound similar but not identical.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tips for great results</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>
            <span className="text-zinc-200 font-medium">Write style prompts like a director's note, not a tag list.</span>{' '}
            <code className="text-zinc-300">"A calm, friendly female voice speaking at a natural pace"</code> beats{' '}
            <code className="text-zinc-300">"calm, female, friendly, neutral, soft, professional"</code>. The model was
            trained on natural sentences.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Anchor with one dominant trait.</span> Pick a single tone, calm,
            energetic, menacing, authoritative, and add at most two modifiers (gender, pace, energy). Stacking too many
            traits muddies the output.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Keep instructions under ~15 words.</span> Long prompts wash out;
            the model focuses on the strongest cues at the start.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Start from a preset.</span> The 13 built-in style presets are
            tested templates, pick the closest one and tweak the description rather than starting from scratch.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Match input language to output.</span> Write the script in the
            target language. The model auto-detects and synthesizes, you don't need to mention the language in the
            prompt.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">For consistent characters across multiple lines, save the voice
            first.</span> Voice Design is non-deterministic, so the same prompt won't produce the same timbre twice. Use{' '}
            <Link to="/studio/voice-design" className="text-[#DFFF00] hover:underline">Voice Design</Link>{' '}→ Save to{' '}
            <Link to="/studio/my-voices" className="text-[#DFFF00] hover:underline">My Voices</Link>, then generate from
            the saved voice.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Keep the script under 2,000 characters.</span> Very long text may
            hit the model's max output duration ceiling.
          </li>
        </ol>
      </section>

      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">Common errors</h2>
        <ul className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <li>
            <code className="text-zinc-300">"This text would produce audio longer than the model supports..."</code> —
            your text + style estimate exceeds ~30 seconds of speech. Shorten the text, or pick a faster style
            ("speaking quickly", "energetic delivery").
          </li>
          <li>
            <code className="text-zinc-300">"miner returned 503"</code>, capacity is full right now. Wait a minute and
            retry; your credits aren't deducted on capacity rejection.
          </li>
          <li>
            Output sounds flat or generic → your style prompt has too many adjectives competing. Trim to 1 dominant tone
            + pace.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Limits & languages</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Limits</h3>
            <ul className="space-y-1 text-sm text-zinc-400">
              <li>• Up to <span className="text-zinc-200">2,000 characters</span> per generation</li>
              <li>• Up to <span className="text-zinc-200">~30 seconds</span> of audio</li>
              <li>• <span className="text-zinc-200">25 credits</span> per generation</li>
            </ul>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Languages (10)</h3>
            <p className="text-sm text-zinc-400">
              Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian.
            </p>
          </div>
        </div>
      </section>
    </div>
  );

  const renderGuideCloning = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Studio Guides</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Voice Cloning</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Voice Cloning, Practice Guide</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          How to clone any voice with high fidelity. What makes a great reference clip, when cross-lingual cloning works,
          and how to handle long scripts.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">What it does</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Cloning takes a short reference clip (someone speaking) plus optional reference text, and synthesizes new
          sentences in that exact voice. It can speak in a different language from the reference, clone an English
          speaker reading Spanish, etc., with strong speaker similarity across all supported languages.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tips for great results</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>
            <span className="text-zinc-200 font-medium">Reference clip 5–20 seconds, sweet spot 5–10s.</span> Studio
            enforces this range. Clips under 5s have unstable timbre; clips over 20s add no extra benefit and slow down
            generation.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Clean reference audio is everything.</span> Single speaker, no
            music, no reverb, no overlapping voices. Spoken-word podcast snippets and audiobook excerpts work best. Phone
            calls, echo-y rooms, and YouTube clips with background music produce muddy clones.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Provide a verbatim reference script if you can.</span> We
            auto-transcribe when you don't, but a hand-written transcript that exactly matches the audio is the #1 lever
            for fidelity. Punctuation and capitalization help.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Match sample rate and channels.</span> 16 kHz mono is the sweet
            spot. Stereo and high sample rates work (we resample), but lower-quality recordings degrade more in
            preprocessing.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Cross-lingual cloning works.</span> A 7-second English reference
            can speak Spanish, German, Japanese. Best directions: Chinese ↔ English. Japanese cross-lingual is the
            weakest direction, proofread pronunciations.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">For repeated cloning of the same voice, save it.</span> Run{' '}
            <Link to="/studio/voice-design" className="text-[#DFFF00] hover:underline">Voice Design</Link>, save the
            preview to <Link to="/studio/my-voices" className="text-[#DFFF00] hover:underline">My Voices</Link>, then
            generate from there. This gives you a stable persona across many lines without re-uploading the reference
            each time.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Always get explicit consent.</span> Cloning a real person's voice
            without permission is a legal and ethical line; Vocence requires you to confirm consent on first use.
          </li>
        </ol>
      </section>

      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">Common failure modes</h2>
        <ul className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <li>
            <span className="text-zinc-200 font-medium">Slurred or hallucinated output</span> → reference script doesn't
            match the audio. Edit the script to match exactly what's spoken in the clip.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Voice doesn't sound like the reference</span> → reference is too
            short, has multiple speakers, or has heavy background noise. Try a longer (~10s) clean clip from the same
            speaker.
          </li>
          <li>
            <code className="text-zinc-300">"Reference audio must be between 5 and 20 seconds…"</code>, re-upload or
            re-record within range.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Limits & languages</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Limits</h3>
            <ul className="space-y-1 text-sm text-zinc-400">
              <li>• Reference audio: <span className="text-zinc-200">5–20 seconds</span></li>
              <li>• Target text: up to <span className="text-zinc-200">2,000 characters</span></li>
              <li>• <span className="text-zinc-200">50 credits</span> per generation</li>
            </ul>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Languages (10, cross-lingual)</h3>
            <p className="text-sm text-zinc-400">
              Chinese, English, Japanese, Korean, German, French, Russian, Portuguese, Spanish, Italian.
            </p>
          </div>
        </div>
      </section>
    </div>
  );

  const renderGuideStt = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Studio Guides</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Speech-to-Text</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Speech-to-Text, Practice Guide</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          How to get accurate transcriptions. Tips for picking the right language, recording quality, and handling long
          or noisy audio.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">What it does</h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Vocence Studio transcribes speech to text across 30 languages and 22 Chinese dialects. It's accurate on noisy
          audio, singing voices, and music-with-vocals mixtures, domains where most ASR systems struggle.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tips for great results</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>
            <span className="text-zinc-200 font-medium">Pick the language explicitly when you know it.</span> Auto-detect
            works but is slightly slower and adds a small accuracy hit. Forcing the right language locks the decoder and
            improves edge-case words.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">16 kHz mono is the sweet spot.</span> Higher rates work (we
            downsample), but they don't add quality. Stereo recordings get mixed to mono before transcription.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Recordings up to 3 minutes per file.</span> For longer sources,
            split into chunks at natural pauses, pasting clips back together is trivial; mid-sentence splits are not.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Avoid clipping.</span> Audio recorded too loud (where waveforms
            hit the ceiling and flatten) is the single biggest source of transcription errors. Aim for peaks at -6 to
            -3 dB.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Single-speaker audio gives the cleanest transcripts.</span> The
            model handles speech-over-music well, but two people talking simultaneously will produce a mixed transcript.
            For interviews, channel-separate first.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Songs work.</span> Studio's transcription is trained on singing
            voice, you can transcribe lyrics directly from a song mix.
          </li>
        </ol>
      </section>

      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">Common failure modes</h2>
        <ul className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <li>
            <span className="text-zinc-200 font-medium">Garbled transcript</span> → audio is clipping (too loud), has
            heavy background noise, or has overlapping speakers. Try a cleaner source.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Wrong language detected</span> → switch from Auto-detect to the
            specific language. Auto-detect can stumble on short clips or accents.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Mid-sentence cutoff</span> → recording exceeded the 3-minute
            ceiling. Split into shorter chunks.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Limits & languages</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Limits</h3>
            <ul className="space-y-1 text-sm text-zinc-400">
              <li>• Up to <span className="text-zinc-200">3 minutes</span> per recording</li>
              <li>• Any audio format (we resample to 16 kHz mono)</li>
              <li>• <span className="text-zinc-200">20 credits</span> per generation</li>
            </ul>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Languages</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              30 languages including Chinese, English, Cantonese, Arabic, German, French, Spanish, Portuguese, Italian,
              Korean, Russian, Thai, Vietnamese, Japanese, Turkish, Hindi, Dutch, Polish, plus Filipino, Persian, Greek,
              Hungarian, Romanian, and more. <span className="text-zinc-300">22 Chinese dialects</span> (Sichuan,
              Shanghai/Wu, Minnan, etc.) and multi-region English accents are also supported.
            </p>
          </div>
        </div>
      </section>
    </div>
  );

  const renderGuideMusic = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <ChevronRight size={12} className="opacity-60" />
          <span>Studio Guides</span>
          <ChevronRight size={12} className="opacity-60" />
          <span className="text-zinc-300">Music</span>
        </div>
        <h1 className="text-2xl font-semibold mb-2 tracking-tight">Music, Practice Guide</h1>
        <p className="text-sm text-zinc-400 leading-relaxed max-w-2xl">
          Studio gives you six music modes: <span className="text-zinc-200">Text to Music</span>,{' '}
          <span className="text-zinc-200">Style Transfer</span>, <span className="text-zinc-200">Retake</span>,{' '}
          <span className="text-zinc-200">Repaint</span>, <span className="text-zinc-200">Edit</span>, and{' '}
          <span className="text-zinc-200">Extend</span>. This guide walks each one, when to use it, which
          fields matter, and the knobs that move the result. Start with Text-to-Music below; the other
          five modes are in <a href="#modes" className="text-[#DFFF00] hover:underline">All six modes</a>.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">Mental model</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          Music generation has two distinct text inputs that do completely different jobs. The most common
          mistake is putting the wrong content in either box, Studio shows a soft warning when this
          happens, but it's worth understanding why:
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <p className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Prompt / Tags</p>
            <p className="text-sm text-zinc-200 font-medium mb-1">Describes what the music sounds like.</p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Genre, instruments, BPM, key, mood, vocal style. Comma-separated tags work best.
              Aim for 8–15 tags, fewer is too vague, more dilutes the signal.
            </p>
          </div>
          <div className="card-vocence p-5">
            <p className="text-xs uppercase tracking-wider text-zinc-500 mb-2">Lyrics</p>
            <p className="text-sm text-zinc-200 font-medium mb-1">What gets sung.</p>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Plain text plus structure tags (<code className="text-zinc-300">[verse]</code>,{' '}
              <code className="text-zinc-300">[chorus]</code>, etc.). For an instrumental track, set
              the field to <code className="text-zinc-300">[inst]</code>, never empty.
            </p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">The fastest path: pick a genre</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          The 8 genre tiles at the top of the page are the fastest way to get a good first track.
          Clicking one fills <span className="text-zinc-200">both</span> the prompt and the lyrics with
          a curated template that matches the genre. If a genre is instrumental (Club EDM, Smooth Jazz,
          Orchestral, Chill Lo-fi), the "Instrumental only" toggle flips on automatically.
        </p>
        <p className="text-sm text-zinc-400 leading-relaxed">
          If you've already typed your own lyrics, picking a different genre will ask before
          overwriting them. Your prompt always updates immediately, the two fields are independent.
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Structure tags inside lyrics</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          The model recognizes a fixed set of structure tokens. Anything else inside square brackets
          (<code className="text-zinc-300">[guitar]</code>,{' '}
          <code className="text-zinc-300">[Verse 1]</code>) is treated as plain text and may be sung
          out loud.
        </p>
        <div className="card-vocence p-5">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-3">Valid tags</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-sm font-mono text-zinc-300">
            <span>[verse]</span>
            <span>[chorus]</span>
            <span>[bridge]</span>
            <span>[intro]</span>
            <span>[outro]</span>
            <span>[end]</span>
            <span>[inst]</span>
            <span>[solo]</span>
            <span>[hook]</span>
            <span>[pre-chorus]</span>
            <span>[break]</span>
          </div>
        </div>
        <ul className="mt-4 space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>• One tag per section, on its own line, with a blank line between sections.</li>
          <li>• Lower-case and exact form matters, <code className="text-zinc-300">[Verse]</code> and{' '}
            <code className="text-zinc-300">[verse 1]</code> are <em>not</em> the special tokens.
          </li>
          <li>• The structure-tag bar above the lyric textarea inserts these at your cursor with
            proper blank-line padding, use it instead of typing them by hand.</li>
          <li>• Match lyric length to the song duration: roughly one section per 30 seconds.
            Too few lines for a long duration → instrumental gaps; too many for a short
            duration → rushed delivery.
          </li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Generate lyrics with AI</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          The <span className="text-[#DFFF00]">Generate lyrics</span> button next to the structure-tag
          bar opens a small panel that asks <em>"What's the song about?"</em> Type a topic and the AI
          writes a full song in the right format, verse, chorus, verse, bridge, chorus, outro, and
          drops it straight into the lyrics box.
        </p>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>• It uses your current <span className="text-zinc-200">prompt</span> as a style hint, so
            picking a genre first means the lyrics will match that vibe.</li>
          <li>• Free, no credits charged for AI lyric generation.</li>
          <li>• Disabled when "Instrumental only" is on (there's nothing to write).</li>
          <li>• You can edit the generated lyrics freely afterward, they're a starting point, not
            a final answer.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Quality modes</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-3">
          The <span className="text-zinc-200">Quality</span> tile in the right-side panel sets two
          parameters: how many denoising steps the model runs, and how strictly it follows the prompt.
          Higher means longer compute and cleaner audio.
        </p>
        <div className="card-vocence p-5">
          <table className="w-full text-sm">
            <thead className="text-xs text-zinc-500 uppercase tracking-wider">
              <tr>
                <th className="text-left pb-2 font-medium">Mode</th>
                <th className="text-left pb-2 font-medium">Steps</th>
                <th className="text-left pb-2 font-medium">Adherence</th>
                <th className="text-left pb-2 font-medium">Wall time (60s song)</th>
                <th className="text-left pb-2 font-medium">Max song length</th>
              </tr>
            </thead>
            <tbody className="text-zinc-300 divide-y divide-white/5">
              <tr>
                <td className="py-2 text-zinc-200 font-medium">Fast</td>
                <td className="py-2">27</td>
                <td className="py-2 text-zinc-400">looser</td>
                <td className="py-2 text-zinc-400">~1 minute</td>
                <td className="py-2 text-zinc-400">400 s</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-200 font-medium">Balanced</td>
                <td className="py-2">60</td>
                <td className="py-2 text-zinc-400">default</td>
                <td className="py-2 text-zinc-400">1–2 minutes</td>
                <td className="py-2 text-zinc-400">300 s</td>
              </tr>
              <tr>
                <td className="py-2 text-zinc-200 font-medium">Max</td>
                <td className="py-2">120</td>
                <td className="py-2 text-zinc-400">strictest</td>
                <td className="py-2 text-zinc-400">2–4 minutes</td>
                <td className="py-2 text-zinc-400">200 s</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed mt-3">
          Use <span className="text-zinc-200">Fast</span> for sketching ideas, then re-roll the
          winners on <span className="text-zinc-200">Balanced</span> or <span className="text-zinc-200">Max</span>.
          The Advanced panel still lets power users tune <code className="text-zinc-300">infer_step</code> and{' '}
          <code className="text-zinc-300">guidance_scale</code> directly, touching them flips the
          mode label to "Custom".
        </p>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tag-writing tips</h2>
        <ol className="list-decimal space-y-3 pl-5 text-sm leading-relaxed text-zinc-400 marker:text-zinc-600">
          <li>
            <span className="text-zinc-200 font-medium">Order matters mildly.</span> Put the dominant
            genre first, then sub-genre, then instruments, then BPM/key, then mood, then vocal qualities,
            then era/scene. Example:{' '}
            <code className="text-zinc-300">pop, synth, drums, guitar, 120 bpm, upbeat, catchy, female vocals, polished vocals, 80s</code>.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Tag count: 8–15 is the sweet spot.</span> Fewer
            and outputs go generic; more and the signal dilutes. The genre presets are tuned to this range.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">BPM: numeric.</span> "120 bpm" or "120 BPM" both
            work. Keep it realistic for the genre, drum-and-bass at 80 BPM won't sound right.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">"instrumental" as a literal tag.</span> Including
            the word <code className="text-zinc-300">instrumental</code> in the tag list (in addition to{' '}
            <code className="text-zinc-300">[inst]</code> in the lyrics box) reinforces the no-vocals signal.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Multilingual works.</span> Spanish, Chinese, Japanese
            and several others are supported in tag form too, useful for non-English genre conventions.
          </li>
        </ol>
      </section>

      <section className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-5">
        <h2 className="text-lg font-semibold mb-3">Common pitfalls</h2>
        <ul className="space-y-3 text-sm text-zinc-400 leading-relaxed">
          <li>
            <span className="text-zinc-200 font-medium">Genre tags pasted into the lyrics box</span>, the
            model will literally try to sing "120 bpm electric guitar". Studio's linter flags this; if you
            see the warning, move the tags up to the prompt field.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Structure tags in the prompt</span>, same issue
            in reverse. <code className="text-zinc-300">[verse]</code> in the prompt field doesn't do anything
            useful and may confuse the tag parser.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Bracketed words that aren't structure tokens</span> —{' '}
            <code className="text-zinc-300">[guitar]</code>,{' '}
            <code className="text-zinc-300">[Verse 1]</code>, <code className="text-zinc-300">[1st verse]</code>{' '}
            all become sung text. Use the tag bar buttons to insert valid ones.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Empty lyrics</span>, the engine errors out. Use{' '}
            <code className="text-zinc-300">[inst]</code> for an instrumental, or just toggle "Instrumental only".
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Generic output</span>, usually means the prompt is
            too vague ("song", "good music"). Add at least one genre word and one mood word.
          </li>
          <li>
            <span className="text-zinc-200 font-medium">Garbled vocals</span>, lyrics too dense for the
            duration, or missing structure tags. Add{' '}
            <code className="text-zinc-300">[verse]</code> /{' '}
            <code className="text-zinc-300">[chorus]</code> or shorten the lyrics.
          </li>
        </ul>
      </section>

      <section id="modes">
        <h2 className="text-lg font-semibold mb-3">All six modes</h2>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">
          Pick the mode that matches your task. <span className="text-zinc-200">Text-to-Music</span> creates
          from scratch; the other five operate on an audio file you upload. Same engine, different
          conditioning.
        </p>

        <div className="overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-zinc-500 border-b border-white/[0.06]">
                <th className="py-2 pr-3 font-medium">Goal</th>
                <th className="py-2 font-medium">Mode</th>
              </tr>
            </thead>
            <tbody className="text-zinc-400">
              <tr className="border-b border-white/[0.04]"><td className="py-2 pr-3">Make a track from scratch</td><td className="py-2"><a href="#mode-text2music" className="text-[#DFFF00]">Text to Music</a></td></tr>
              <tr className="border-b border-white/[0.04]"><td className="py-2 pr-3">Generate something with the vibe of a reference you have</td><td className="py-2"><a href="#mode-style" className="text-[#DFFF00]">Style Transfer</a></td></tr>
              <tr className="border-b border-white/[0.04]"><td className="py-2 pr-3">Get a different version of the same prompt</td><td className="py-2"><a href="#mode-retake" className="text-[#DFFF00]">Retake</a></td></tr>
              <tr className="border-b border-white/[0.04]"><td className="py-2 pr-3">Replace a bad section (bridge, chorus, intro)</td><td className="py-2"><a href="#mode-repaint" className="text-[#DFFF00]">Repaint</a></td></tr>
              <tr className="border-b border-white/[0.04]"><td className="py-2 pr-3">Change the genre or lyrics of an existing track, keep the structure</td><td className="py-2"><a href="#mode-edit" className="text-[#DFFF00]">Edit</a></td></tr>
              <tr><td className="py-2 pr-3">Make a track longer (intro, outro, both)</td><td className="py-2"><a href="#mode-extend" className="text-[#DFFF00]">Extend</a></td></tr>
            </tbody>
          </table>
        </div>

        <div id="mode-text2music" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">New track</p>
          <h3 className="text-base font-semibold text-white mb-2">Text to Music</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-3">
            The default mode. Describe what you want in the prompt, write or paste lyrics, hit
            Generate. No file uploads needed. Everything earlier in this guide (Mental Model,
            Prompt Recipes, Lyric Format) applies here.
          </p>
          <p className="text-sm text-zinc-300"><span className="text-zinc-400">Required:</span> Prompt + Lyrics (use <code className="text-zinc-300">[inst]</code> for instrumentals). <span className="text-zinc-400">Knobs:</span> Duration, Quality (Fast/Balanced/Max), Format.</p>
        </div>

        <div id="mode-style" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Style transfer</p>
          <h3 className="text-base font-semibold text-white mb-2">Style Transfer (audio2audio)</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            Generate a fresh track that has the <em>vibe</em> of a reference audio you upload —
            but follows your prompt for genre, instruments, and tempo. The reference doesn't share
            notes or melody with the output; it conditions energy, key, and groove.
          </p>
          <p className="text-sm text-zinc-300 mb-2"><span className="text-zinc-400">Required:</span> Reference audio + Prompt + Lyrics (<code className="text-zinc-300">[inst]</code> ok). <span className="text-zinc-400">Knobs:</span> Reference Strength, Duration.</p>
          <p className="text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Reference Strength</span> is the main control:
          </p>
          <ul className="text-sm text-zinc-400 leading-relaxed list-disc pl-5 mt-1 space-y-0.5">
            <li><code className="text-zinc-300">0.0</code>, ignores reference, behaves like Text-to-Music</li>
            <li><code className="text-zinc-300">0.5</code> (default), balanced</li>
            <li><code className="text-zinc-300">0.8+</code>, reference dominates the output's feel</li>
            <li><code className="text-zinc-300">1.0</code>, reference dictates; prompt is a hint</li>
          </ul>
          <p className="text-sm text-zinc-400 leading-relaxed mt-2">
            <span className="text-zinc-200">When to use:</span> you hummed a melody on your phone and
            want a real arrangement of that feel · you love a track's energy but need it legally
            distinct · your text2music results sound flat and you want to anchor them to a polished reference.
          </p>
        </div>

        <div id="mode-retake" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Variation</p>
          <h3 className="text-base font-semibold text-white mb-2">Retake</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            Reroll the same prompt + lyrics with new random seeds. You get a different take of the
            same idea. <span className="text-zinc-200">The source audio is used ONLY to copy the
            duration</span>, its actual content does NOT influence the new generation.
          </p>
          <p className="text-sm text-zinc-300 mb-2"><span className="text-zinc-400">Required:</span> Source audio (for duration) + Prompt + Lyrics. <span className="text-zinc-400">Knobs:</span> Variance, Seeds.</p>
          <p className="text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Variance</span>: <code className="text-zinc-300">0.0</code> = same seeds (deterministic), <code className="text-zinc-300">0.2</code> (default) = small variations, <code className="text-zinc-300">0.5</code> = noticeable different feel, <code className="text-zinc-300">1.0</code> = essentially a fresh text2music run.
          </p>
          <p className="text-sm text-zinc-400 leading-relaxed mt-2">
            <span className="text-zinc-200">When to use:</span> text2music gave you something
            <em> almost</em> right and you want another roll of the dice · you want 2–3 alternates
            to A/B-test before committing.
          </p>
        </div>

        <div id="mode-repaint" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Inpaint</p>
          <h3 className="text-base font-semibold text-white mb-2">Repaint</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            Regenerate <em>only</em> a specific time window of an existing track. Audio outside the
            window stays byte-identical. This is the surgical "fix a bad bridge" / "swap the drop" mode.
          </p>
          <p className="text-sm text-zinc-300 mb-2"><span className="text-zinc-400">Required:</span> Source audio + Prompt + Lyrics (description of the NEW content) + Start/End. <span className="text-zinc-400">Knobs:</span> Variance.</p>
          <p className="text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Start / End</span> are seconds defining the window to
            regenerate. <span className="text-zinc-200">Variance</span> controls how different the new
            window can be from the original, <code className="text-zinc-300">0.2</code> keeps the
            replacement close in feel, <code className="text-zinc-300">0.8+</code> makes a dramatic change.
            Transitions at the window boundaries blend naturally because the model conditions on the
            surrounding audio.
          </p>
          <p className="text-sm text-zinc-400 leading-relaxed mt-2">
            <span className="text-zinc-200">When to use:</span> chorus is great but bridge is bad ·
            track starts awkwardly · you want a different drop section without redoing the whole song.
          </p>
        </div>

        <div id="mode-edit" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Restyle</p>
          <h3 className="text-base font-semibold text-white mb-2">Edit</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            Change the style and/or lyrics of an existing track <em>while preserving its structural
            shape</em>. The drums hit at the same times, the verses fall in the same places, but the
            instruments and singing change.
          </p>
          <p className="text-sm text-zinc-300 mb-2"><span className="text-zinc-400">Required:</span> Source audio + Prompt (original) + Lyrics (original) + Target Prompt (desired). <span className="text-zinc-400">Knobs:</span> Target Lyrics, Type (Lyrics-only vs Remix), n_min/n_max.</p>
          <p className="text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Prompt + Lyrics</span> describe the original (anchoring the
            structure). <span className="text-zinc-200">Target Prompt + Target Lyrics</span> describe
            what you want. <span className="text-zinc-200">Type</span> picks how aggressive the edit
            is, <code className="text-zinc-300">Lyrics only</code> preserves more of the original sound;
            <code className="text-zinc-300">Remix</code> allows a bigger style shift. n_min/n_max are
            the underlying noise schedule controls; the Type dropdown picks sensible defaults.
          </p>
          <p className="text-sm text-zinc-400 leading-relaxed mt-2">
            <span className="text-zinc-200">When to use:</span> turn an EDM track into a country cover
            keeping the same melody · change the lyrics of an existing song without re-recording the
            instrumental · take a hip-hop track and remix it as jazz.
          </p>
        </div>

        <div id="mode-extend" className="card-vocence p-5 mb-4">
          <p className="text-xs uppercase tracking-wider text-zinc-500 mb-1">Lengthen</p>
          <h3 className="text-base font-semibold text-white mb-2">Extend</h3>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            Add new content before and/or after an existing track. The original audio is preserved
            byte-for-byte; the new sections segue naturally because the model conditions on the
            existing audio at the seam.
          </p>
          <p className="text-sm text-zinc-300 mb-2"><span className="text-zinc-400">Required:</span> Source audio + Prompt + Lyrics (describing the FULL track including the new sections) + Left and/or Right length. <span className="text-zinc-400">Knobs:</span> Seeds.</p>
          <p className="text-sm text-zinc-400 leading-relaxed">
            <span className="text-zinc-200">Left (sec)</span> = seconds to add BEFORE the original.
            <span className="text-zinc-200"> Right (sec)</span> = seconds to add AFTER. Use at least one.
          </p>
          <p className="text-sm text-zinc-400 leading-relaxed mt-2">
            <span className="text-zinc-200">When to use:</span> 60-second clip needs to be 2 minutes ·
            track starts abruptly and needs an intro build-up · you want a proper outro/fade-out.
          </p>
        </div>

        <div className="mt-6 p-4 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] text-sm text-amber-100/90">
          <span className="font-medium">Tip for modes that operate on existing tracks:</span> the
          model uses your prompt as a "what should this be?" guide. For Retake/Repaint/Extend,
          supply the SAME prompt + lyrics that the source was made with (or a close match). For
          Edit, the <code>prompt</code> describes the original and <code>edit_target_prompt</code>
          describes what you want it to become. Mismatched prompts give unpredictable results.
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Limits & licensing</h2>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Limits</h3>
            <ul className="space-y-1 text-sm text-zinc-400">
              <li>• Duration cap depends on quality: <span className="text-zinc-200">Fast 400 s</span>, <span className="text-zinc-200">Balanced 300 s</span>, <span className="text-zinc-200">Max 200 s</span>, or <code className="text-zinc-300">-1</code> for random</li>
              <li>• Formats: WAV (default), MP3, OGG, FLAC</li>
              <li>• <span className="text-zinc-200">50 credits</span> per generation (all six modes)</li>
              <li>• Vocals are strongest in EN, ZH, RU, ES, JA, DE, FR, PT, IT, KO</li>
              <li>• For modes that take a source/reference audio: any container ffmpeg can read (WAV, MP3, FLAC, M4A, WebM, OGG)</li>
            </ul>
          </div>
          <div className="card-vocence p-5">
            <h3 className="font-medium mb-2 text-sm">Licensing</h3>
            <p className="text-sm text-zinc-400 leading-relaxed">
              Music generated in Studio is trained on licensed / royalty-free / synthetic data and is
              safe for commercial use. Verify originality before publishing and disclose AI involvement
              when your platform requires it.
            </p>
          </div>
        </div>
      </section>
    </div>
  );

  const renderGuideDubbing = () => (
    <div className="space-y-8">
      <div className="border-b border-white/[0.06] pb-6">
        <div className="flex items-center gap-1.5 text-xs text-zinc-500 mb-3">
          <span>Docs</span>
          <span>/</span>
          <span>Studio</span>
          <span>/</span>
          <span className="text-zinc-300">Noise Remover</span>
        </div>
        <h1 className="text-3xl font-bold mb-2">Noise Remover</h1>
        <p className="text-zinc-400 leading-relaxed">
          Remove background noise and enhance audio clarity. Upload or record noisy audio and get a clean version back.
        </p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">How it works</h2>
        <ol className="space-y-3 text-sm text-zinc-400 leading-relaxed list-decimal list-inside">
          <li>Open <Link to="/studio/noise-remover" className="text-[#DFFF00] hover:underline">Studio → Noise Remover</Link>.</li>
          <li>Upload an audio file (drag & drop supported) or record directly in the browser.</li>
          <li>Click <span className="text-zinc-200 font-medium">Enhance Audio</span>. The processed audio plays automatically.</li>
          <li>Compare original vs enhanced side by side, then download the clean version.</li>
        </ol>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Tips for best results</h2>
        <ul className="space-y-2 text-sm text-zinc-400 leading-relaxed">
          <li>• Use audio where speech is clearly audible above the noise, the enhancer preserves voice and removes background.</li>
          <li>• Shorter clips (under 1 minute) process fastest.</li>
          <li>• Works best on recordings with consistent background noise (fans, traffic, hum) rather than sudden loud interruptions.</li>
          <li>• Supported formats: WAV, MP3, M4A, WebM, OGG, FLAC, AAC.</li>
        </ul>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Limits</h2>
        <div className="card-vocence p-5">
          <ul className="space-y-1 text-sm text-zinc-400">
            <li>• Max duration: <span className="text-zinc-200">5 minutes</span></li>
            <li>• Max file size: <span className="text-zinc-200">50 MB</span></li>
            <li>• Cost: <span className="text-zinc-200">{CREDIT_NOISE_REMOVER} credits</span> per enhancement</li>
          </ul>
        </div>
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">Keyboard shortcuts</h2>
        <ul className="space-y-1 text-sm text-zinc-400">
          <li>• <kbd className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-zinc-300 font-mono text-xs">Space</kbd>, play / pause audio</li>
          <li>• <kbd className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-zinc-300 font-mono text-xs">R</kbd>, re-enhance with the same file</li>
          <li>• Drag any audio file onto the page to load it</li>
        </ul>
      </section>
    </div>
  );

  const renderSdkPython = () => (
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span>SDK</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">Python SDK</span>
      </nav>

      <header className="space-y-3 border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Python SDK</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Official Python client for the Vocence Developer API. Covers every
          REST endpoint plus the real-time voice-agent WebSocket, with sync
          and async flavors, typed responses, automatic retries, and a
          companion CLI.
        </p>
        <p className="text-[12px] text-zinc-500">
          Source:{' '}
          <a
            href="https://github.com/concil859856/vocence-sdk"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#DFFF00] hover:underline"
          >
            github.com/concil859856/vocence-sdk
          </a>{' '}
          · License: Apache 2.0
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Installation</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Requires Python ≥ 3.10. The core install is small (httpx, pydantic,
          typer, websockets). Two optional extras unlock platform-specific
          features.
        </p>
        <CodeBlock language="bash" code={`pip install vocence                # core: REST + WebSocket + CLI
pip install "vocence[audio]"       # adds mic capture + speaker playback
pip install "vocence[keyring]"     # store API key in OS keychain`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Quickstart</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Authenticate once with the CLI, then your Python scripts pick up
          the key automatically.
        </p>
        <CodeBlock language="bash" code={`$ vocence login          # opens browser → click Authorize → key saved`} />
        <CodeBlock language="python" code={`from vocence import Vocence

client = Vocence()                              # uses key saved by \`vocence login\`

# 1. Inspect your account
acct = client.account.get()
print(f"plan: {acct.plan_code}, credits: {acct.credits:,}")

# 2. Synthesize speech in a built-in voice
audio = client.tts.speak(
    text="Hello from the Vocence Python SDK!",
    voice="design-aria",
)
audio.write_wav("hello.wav")

# 3. Transcribe an audio clip
text = client.stt.transcribe(audio_path="hello.wav", language="English").text
print(text)

# 4. Remove background noise from audio
enhanced = client.audio.noise_remover(audio_path="noisy_recording.wav")
enhanced.write_wav("clean.wav")`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Authentication</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          The SDK resolves your API key from this chain, in order:
        </p>
        <ol className="ml-4 list-decimal space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li>Explicit <code className="rounded bg-white/[0.06] px-1 text-zinc-300">api_key=</code> argument to <code className="rounded bg-white/[0.06] px-1 text-zinc-300">Vocence(...)</code>.</li>
          <li><code className="rounded bg-white/[0.06] px-1 text-zinc-300">VOCENCE_API_KEY</code> environment variable.</li>
          <li><code className="rounded bg-white/[0.06] px-1 text-zinc-300">~/.vocence/config.json</code>, where <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence login</code> persists the key (mode 0600). Optional OS-keyring storage via <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence config set-keyring on</code>.</li>
        </ol>
        <p className="text-sm leading-relaxed text-zinc-400">
          For servers / CI, set <code className="rounded bg-white/[0.06] px-1 text-zinc-300">VOCENCE_API_KEY</code> via your secrets manager. For local development, <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence login</code> is the friction-free path.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Sync vs Async</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Every resource ships in two flavors with identical method names:
        </p>
        <CodeBlock language="python" code={`# Synchronous (scripts, REPLs, simple servers)
from vocence import Vocence
with Vocence() as client:
    audio = client.tts.speak(text="hi", voice="design-aria")

# Asynchronous (FastAPI, asyncio pipelines, real-time apps)
import asyncio
from vocence import AsyncVocence

async def main():
    async with AsyncVocence() as client:
        audio = await client.tts.speak(text="hi", voice="design-aria")

asyncio.run(main())`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Working with audio</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Audio-producing responses (TTS, voice clone, saved-voice speak)
          carry an <code className="rounded bg-white/[0.06] px-1 text-zinc-300">audio_url</code>{' '}
          plus convenience helpers so you don't have to manage the
          download yourself.
        </p>
        <CodeBlock language="python" code={`r = client.tts.speak(text="Hello", voice="design-aria")

# Three ways to get the audio:
r.audio_url              # presigned URL, short TTL
r.download()             # → bytes (uses the SDK's User-Agent so CDN doesn't reject)
r.write_wav("out.wav")   # → Path (downloaded + saved)

# Cost estimate before firing, pure local arithmetic, no HTTP call
client.tts.estimate(text="hello", voice="design-aria")
# → Estimate(credits=1, chars=5, endpoint='/v1/tts/speak')`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Voice cloning + design</h2>
        <CodeBlock language="python" code={`# One-shot clone, clip → text in that voice
clone = client.voice_clone.create(
    audio_path="my_voice.wav",
    target_text="Hello in my voice.",
)
clone.write_wav("cloned.wav")

# Or from a URL, SDK fetches client-side, then sends as base64
clone = client.voice_clone.create(
    audio_url="https://s3.example.com/me.wav",
    target_text="Same flow, different source.",
)

# Save the reference clip as a reusable voice
saved = client.voice_clone.save(audio_path="my_voice.wav", display_name="Me")
voice_id = saved["voice_id"]

# Reuse it forever
client.voices.speak(voice_id, text="Same voice, new text.")

# Design a voice from a prompt
preview = client.voice_design.preview(
    voice_description="warm middle-aged female narrator with British accent",
)
saved = client.voice_design.save(
    preview_token=preview.preview_token,
    chosen_variant="revised",
    display_name="Narrator",
)`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Batch processing</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          For audiobook-scale workloads. Caps concurrency so you don't trip
          rate limits, returns ordered results, wraps per-item failures so
          one bad row doesn't kill the run.
        </p>
        <CodeBlock language="python" code={`import asyncio
from vocence import AsyncVocence, batch

async def render_chapters(chapters: list[str]):
    async with AsyncVocence() as client:
        items = [{"text": c, "voice": "design-aria"} for c in chapters]
        results = await batch.tts_speak(client, items, max_concurrency=4)
        for i, r in enumerate(results):
            if isinstance(r, batch.BatchError):
                print(f"chapter {i} failed: {r.exception}")
            else:
                r.write_wav(f"chapter_{i:03d}.wav")

asyncio.run(render_chapters(chapters))`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Errors</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Every exception subclasses <code className="rounded bg-white/[0.06] px-1 text-zinc-300">VocenceError</code>{' '}
          and maps to a specific HTTP failure mode:
        </p>
        <CodeBlock language="python" code={`from vocence import Vocence, errors

client = Vocence()
try:
    client.tts.speak(text="x", voice="missing")
except errors.AuthenticationError:        # 401, bad / revoked key
    ...
except errors.InsufficientCreditsError:   # 402, out of credits, Premium required
    ...
except errors.RateLimitError as e:        # 429, slow down
    time.sleep(e.retry_after or 1)
except errors.NotFoundError:              # 404, voice / agent id missing
    ...
except errors.BadRequestError:            # 400 / 422, malformed body
    ...
except errors.UpstreamError:              # 502 / 503 / 504, provider hiccup
    ...
except errors.APIConnectionError:         # DNS / TLS / connection refused
    ...`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          Retries are on by default: GET requests + any 429 retry up to 2
          times with exponential backoff. POST/PATCH/DELETE retry only on
          429 (never 5xx, avoids double-charge / double-create). Disable
          with <code className="rounded bg-white/[0.06] px-1 text-zinc-300">Vocence(max_retries=0)</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Debugging</h2>
        <CodeBlock language="python" code={`# The last response's request_id, paste in support tickets
client.last_request_id

# Quick readiness check before a long batch, round-trips GET /v1/account
client.health()           # → True / False, no credit charge

# repr() never reveals the key (masked as voc_live_XXX…XXXX)
print(client)`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Where to next</h2>
        <ul className="ml-4 list-disc space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li>
            <Link to="/docs/sdk-cli" className="text-[#DFFF00] hover:underline">CLI Reference</Link>, every <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence</code> sub-command.
          </li>
          <li>
            <Link to="/docs/sdk-agents" className="text-[#DFFF00] hover:underline">Voice Agents</Link>, WebSocket sessions, conversation helper, live mic chat.
          </li>
          <li>
            <Link to="/docs/sdk-webhooks" className="text-[#DFFF00] hover:underline">Webhooks</Link>, verifying custom-tool callbacks from Vocence.
          </li>
          <li>
            <Link to="/docs/api" className="text-[#DFFF00] hover:underline">API Reference</Link>, the underlying REST surface the SDK wraps.
          </li>
          <li>
            <Link to="/docs/cookbook" className="text-[#DFFF00] hover:underline">Cookbook</Link>, end-to-end recipes combining endpoints.
          </li>
        </ul>
      </section>
    </div>
  );

  const renderSdkCli = () => (
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span>SDK</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">CLI Reference</span>
      </nav>

      <header className="space-y-3 border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">CLI Reference</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          The <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence</code>{' '}
          command-line tool ships with the Python SDK. Use it to log in
          once and then drive every endpoint from the shell, no Python
          script required for one-off jobs.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Authentication</h2>
        <CodeBlock language="bash" code={`vocence login                          # browser device-code flow (recommended)
vocence login --paste                  # prompt for an existing key value
vocence login --api-key voc_live_xxx   # one-shot (discouraged, visible in shell history)
vocence config show                    # print where the key is stored (masked)
vocence config set-keyring on          # move key to OS keychain (needs vocence[keyring])
vocence config set-base-url URL        # pin to a non-default API host
vocence config set-base-url default    # reset`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          The browser flow opens{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">backend.vocence.ai/cli/authorize</code>{' '}
          with a short verification code. You sign in if needed, click
          <span className="text-zinc-200"> Authorize</span>, the CLI polls
          until a fresh key is minted and saved to{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">~/.vocence/config.json</code>{' '}
          (mode 0600).
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Account &amp; keys</h2>
        <CodeBlock language="bash" code={`vocence account                # plan, credits, key count
vocence account balance        # just the integer balance (machine-friendly)
vocence usage --limit 20       # recent API calls (latency, credits, errors)
vocence keys list              # your existing keys (secrets never shown)
vocence keys create -n "ci"    # mint a new key (plaintext printed ONCE)
vocence keys revoke <id>       # immediate, irreversible`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Voices &amp; TTS / STT</h2>
        <CodeBlock language="bash" code={`vocence voices                                       # list 16 built-in speakers
vocence speak "Hello" -v design-aria -o out.wav      # save as WAV
vocence speak "Hello" -v design-aria -o -            # just print the audio URL
vocence transcribe clip.wav --language English       # STT
vocence clone path/to/clip.wav -n "My Voice"         # upload + save reusable
vocence design "warm female British narrator"        # preview + interactive pick + save
vocence enhance noisy.wav -o clean.wav               # remove background noise`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Agents</h2>
        <CodeBlock language="bash" code={`vocence agents list                       # id + name only (small)
vocence agents show <agent-id>            # full spec including bound tools
vocence agents create -n "Bot" -t knowledge --voice design-aria
vocence agents delete <agent-id>`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Interactive REPLs</h2>
        <CodeBlock language="bash" code={`vocence chat <agent-id>         # text REPL: type → see reply text + hear audio
vocence voice <agent-id>        # push-to-talk mic REPL  (requires vocence[audio])`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          In <code className="rounded bg-white/[0.06] px-1 text-zinc-300">voice</code> mode
          each turn is: <strong>Enter</strong> → speak → <strong>Enter</strong> → the agent
          transcribes, replies, and you hear the audio play through your
          default output device.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Environment variables</h2>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.03]">
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-2.5 font-medium text-zinc-300">Variable</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">Purpose</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr><td className="px-4 py-3 font-mono text-cyan-300">VOCENCE_API_KEY</td><td className="px-4 py-3 text-zinc-400">Bearer token; overrides config file</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">VOCENCE_BASE_URL</td><td className="px-4 py-3 text-zinc-400">Override the API host (e.g. for staging)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">VOCENCE_CONFIG_DIR</td><td className="px-4 py-3 text-zinc-400">Where the CLI writes config (default <code>~/.vocence</code>)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">VOCENCE_BACKEND_URL</td><td className="px-4 py-3 text-zinc-400">Where <code>vocence login</code> hits for device-code auth (default <code>backend.vocence.ai</code>)</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );

  const renderSdkAgents = () => (
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span>SDK</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">Voice Agents</span>
      </nav>

      <header className="space-y-3 border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Voice Agents</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Three layers of abstraction over the agent WebSocket, depending on
          how much control you want.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Layer 1, raw event stream</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Lowest-level: drive the WS manually, iterate every event as it
          arrives. Use when you need token-by-token streaming or
          fine-grained barge-in.
        </p>
        <CodeBlock language="python" code={`import asyncio
from vocence import AsyncVocence, AgentEvent, AudioFrame

async def main():
    async with AsyncVocence() as client:
        async with client.agents.session("agent-id") as sess:
            await sess.send_text("What's the weather in Tokyo?")
            async for event in sess:
                if isinstance(event, AudioFrame):
                    # PCM16LE bytes, write to a player / file / WebRTC track
                    print(f"audio: {len(event.data)} bytes")
                elif event.type == "token":
                    print(event.text, end="", flush=True)
                elif event.type == "audio_meta":
                    # {sample_rate: 24000, frame_ms: 40, encoding: 'pcm16le', channels: 1}
                    print("\\naudio incoming:", event.data)
                elif event.type == "turn_end":
                    break

asyncio.run(main())`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Layer 2, Conversation helper</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Hides the event loop. Each <code className="rounded bg-white/[0.06] px-1 text-zinc-300">.say(...)</code>{' '}
          returns a <code className="rounded bg-white/[0.06] px-1 text-zinc-300">Turn</code>{' '}
          object with the assistant's full text, all audio bytes
          concatenated, audio metadata, transcript, and any tool calls the
          LLM made.
        </p>
        <CodeBlock language="python" code={`async with client.agents.conversation("agent-id") as conv:
    turn = await conv.say("What is the capital of Japan?")

    print(turn.text)            # "The capital of Japan is Tokyo."
    print(turn.audio_meta)      # {'sample_rate': 24000, ...}
    turn.write_wav("reply.wav") # save the synthesized audio
    turn.play()                 # play through speakers  (needs vocence[audio])

    # Multi-turn, same conversation, second turn
    turn2 = await conv.say("And of France?")

    # Tool calls the LLM made for this turn
    for name, args in turn.tool_calls:
        print(f"  → {name}({args})")`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Layer 3, Live mic ↔ agent</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Push-to-talk microphone capture + real-time speaker playback.
          Requires <code className="rounded bg-white/[0.06] px-1 text-zinc-300">pip install "vocence[audio]"</code>{' '}
          which pulls <code className="rounded bg-white/[0.06] px-1 text-zinc-300">sounddevice</code>{' '}
          and <code className="rounded bg-white/[0.06] px-1 text-zinc-300">numpy</code>.
        </p>
        <CodeBlock language="python" code={`async with client.agents.live_chat("agent-id") as live:
    while True:
        input("press Enter to start speaking…")
        live.record()
        input("recording, press Enter to stop…")
        turn = await live.stop_and_send()
        print(f"you   > {turn['transcript']}")
        print(f"agent > {turn['text']}")
        # The audio reply is already playing through your speakers.`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          The CLI wraps this as{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">vocence voice &lt;agent-id&gt;</code>{' '}
         , zero-line setup.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Sync wrapper</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          For scripts that don't want asyncio. The sync client opens the
          WS on a background thread and bridges events into a blocking
          iterator.
        </p>
        <CodeBlock language="python" code={`from vocence import Vocence

with Vocence().agents.session("agent-id") as sess:
    sess.send_text("Hi")
    for event in sess:
        print(event)
        if event.type == "turn_end":
            break`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Event types</h2>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.03]">
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-2.5 font-medium text-zinc-300">Event</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">Meaning</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr><td className="px-4 py-3 font-mono text-cyan-300">ready</td><td className="px-4 py-3 text-zinc-400">WS open + session metadata</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">transcript</td><td className="px-4 py-3 text-zinc-400">User-side STT echo (voice turns only)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">token</td><td className="px-4 py-3 text-zinc-400">LLM text chunk (stream as it arrives)</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">tool_call_started / completed</td><td className="px-4 py-3 text-zinc-400">Custom-tool / built-in tool invocation</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">audio_meta</td><td className="px-4 py-3 text-zinc-400">Format header (pcm16le, 24000 Hz, 40 ms, mono), arrives BEFORE binary frames</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">&lt;binary&gt;</td><td className="px-4 py-3 text-zinc-400">PCM16 audio frame; <code>AudioFrame</code> in Python</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">audio_end</td><td className="px-4 py-3 text-zinc-400">All frames for this sentence delivered</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">turn_end</td><td className="px-4 py-3 text-zinc-400">Turn complete, safe to send the next user input</td></tr>
              <tr><td className="px-4 py-3 font-mono text-cyan-300">error</td><td className="px-4 py-3 text-zinc-400">Upstream failure; the SDK raises <code>UpstreamError</code></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Building browser apps</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Browser JavaScript can't safely carry your API key, keys would
          be visible in source. Use the Python SDK on{' '}
          <em>your own backend</em> and proxy the WebSocket through:
        </p>
        <CodeBlock language="python" code={`# FastAPI proxy: browser ↔ your server ↔ Vocence
from fastapi import FastAPI, WebSocket
from vocence import AsyncVocence, AudioFrame
import asyncio, json

app = FastAPI()
vocence = AsyncVocence()  # uses VOCENCE_API_KEY

@app.websocket("/ws/agent/{agent_id}")
async def proxy(ws: WebSocket, agent_id: str):
    await ws.accept()
    async with vocence.agents.session(agent_id) as session:
        async def fan_out():
            async for ev in session:
                if isinstance(ev, AudioFrame):
                    await ws.send_bytes(ev.data)
                else:
                    await ws.send_json(ev.data)
        asyncio.create_task(fan_out())
        async for msg in ws.iter_json():
            if msg["type"] == "text":
                await session.send_text(msg["text"])
            elif msg["type"] == "voice":
                await session.send_voice(msg["audio_b64"])`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          Browser side: capture mic with{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">getUserMedia</code>
          , send base64 audio over your own WS, queue inbound PCM16 frames
          into a Web Audio <code className="rounded bg-white/[0.06] px-1 text-zinc-300">AudioContext</code>
          . The format is fixed at 24 kHz mono, easy to decode without a
          codec library.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">
          Configuring the voice pipeline
        </h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Three per-agent knobs let you trade latency for robustness against noisy mics and ragged turn-taking.
          Set them when creating or updating an agent — they live under{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">config</code>:
        </p>
        <div className="overflow-hidden rounded-xl border border-white/[0.06]">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-white/[0.03]">
              <tr className="border-b border-white/[0.06]">
                <th className="px-4 py-2.5 font-medium text-zinc-300">Field</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">Type · default</th>
                <th className="px-4 py-2.5 font-medium text-zinc-300">What it does</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">denoise_enabled</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>bool</code> · <code>false</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Inserts DeepFilterNet 3 upstream of STT + UltraVAD. Adds ~200 ms passthrough latency. Turn on for
                  call-center, mobile-in-public, or any agent that expects background noise.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">turn_decider</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>"ultravad" | "fusion"</code> · <code>"ultravad"</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Primary end-of-turn detector. UltraVAD is the snappier, model-based path; fusion ensembles Smart Turn
                  with the LiveKit turn detector. Either path falls back to the other if its pod is unhealthy.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">ultravad_threshold</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>float [0, 1]</code> · <code>0.50</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  UltraVAD's commit threshold. Higher = more conservative (lets mid-sentence pauses through, adds ~200 ms
                  of end-of-turn latency); lower = snappier but more likely to cut the user off mid-sentence. The server
                  also auto-extends silence for short or mid-thought transcripts ("Hm. Yeah." gets 1500 ms before a commit
                  is allowed) — see the Agents guide for the adaptive curve.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">min_delay_ms</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>int? [200, 2000]</code> · <code>null</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  Minimum silence (ms) before commit is even allowed to fire, regardless of model confidence. Omit
                  (server-default 500 ms) for normal use; bump to 800–1000 ms for agents whose users pause mid-thought
                  a lot. The adaptive curve above this still kicks in for very short transcripts.
                </td>
              </tr>
              <tr>
                <td className="px-4 py-3 font-mono text-cyan-300 align-top">record_enabled</td>
                <td className="px-4 py-3 text-zinc-400 align-top"><code>bool</code> · <code>false</code></td>
                <td className="px-4 py-3 text-zinc-400 align-top">
                  When true, the session tees both legs (user + agent PCM) to a stereo WAV uploaded to R2.
                  Downloadable + searchable via the Calls tab in Studio AND through <code>GET /v1/agents/&#123;id&#125;/calls</code>
                  in the public API. Retention 30 days.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <CodeBlock language="python" code={`from vocence import Vocence

agent = Vocence().agents.update(
    "agent-id",
    config={
        "denoise_enabled": True,         # noisy call-center mic
        "turn_decider": "ultravad",
        "ultravad_threshold": 0.55,      # slightly more patient than the 0.50 default
        "min_delay_ms": 800,             # require 800 ms silence before commit
        "record_enabled": True,          # capture WAVs for review
    },
)`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          See <Link to="/docs/guide-agents" className="text-[#DFFF00] hover:underline">Agents §6 Voice tuning</Link> for the
          mental model behind these knobs, and the <Link to="/docs/api" className="text-[#DFFF00] hover:underline">API Reference</Link>
          {' '}for the <code>PATCH /v1/agents/&#123;id&#125;</code> shape.
        </p>
      </section>
    </div>
  );

  const renderSdkWebhooks = () => (
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span>SDK</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">Webhooks</span>
      </nav>

      <header className="space-y-3 border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Webhook signature verification</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          When you register a <strong>custom tool</strong> for one of your
          agents, Vocence calls your webhook URL whenever the LLM decides
          to invoke that tool. The SDK ships helpers so your receiver can
          confirm the call really came from Vocence, not a random attacker
          who scanned your public endpoint.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Wire format</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Two headers travel on every signed request:
        </p>
        <CodeBlock language="http" code={`X-Vocence-Timestamp: 1731478800
X-Vocence-Signature: v1=BASE64(HMAC-SHA256(secret, f"v1.{ts}.{raw_body}"))`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          The shared secret is the <code className="rounded bg-white/[0.06] px-1 text-zinc-300">auth_secret</code>{' '}
          you supplied when registering the tool. The{' '}
          <code className="rounded bg-white/[0.06] px-1 text-zinc-300">v1=</code>{' '}
          prefix lets us bump the scheme later. The timestamp is a Unix
          epoch, receivers reject anything older than 5 minutes (default,
          configurable) to block replay attacks.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Quick start (FastAPI)</h2>
        <CodeBlock language="python" code={`from fastapi import FastAPI, Depends, HTTPException
from vocence.webhooks import fastapi_verifier

app = FastAPI()
verify = fastapi_verifier(secret="your-shared-secret-from-tool-registration")

@app.post("/api/stock", dependencies=[Depends(verify)])
async def get_stock_price(payload: dict):
    # If we got here, the request had a valid X-Vocence-Signature.
    return {"price": fetch_price(payload["ticker"])}`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Quick start (any framework)</h2>
        <CodeBlock language="python" code={`from vocence import webhooks

# In your request handler:
def handle(headers: dict, body: bytes, *, secret: str) -> dict:
    if not webhooks.verify(headers, body, secret):
        return {"status": 401, "body": "bad signature"}
    # Body is a JSON object with the tool's argument dict.
    import json
    args = json.loads(body)
    return {"status": 200, "body": do_work(args)}`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Configuration</h2>
        <CodeBlock language="python" code={`# Tolerance is the freshness window (default 300 seconds).
# Tighten in low-latency networks, loosen if your clock drifts.
webhooks.verify(headers, body, secret, tolerance_seconds=120)

# For unit tests where you control time, pass an explicit 'now' clock.
webhooks.verify(headers, body, secret, now=fake_clock())`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Testing your receiver</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          The SDK exposes <code className="rounded bg-white/[0.06] px-1 text-zinc-300">webhooks.sign(body, secret)</code>{' '}
          so you can fake-sign requests as Vocence would, handy for
          unit tests and curl-based smoke tests.
        </p>
        <CodeBlock language="python" code={`import requests
from vocence import webhooks

body = b'{"ticker": "TSLA"}'
headers = webhooks.sign(body, secret="your-shared-secret")
headers["content-type"] = "application/json"

# Should return 200
resp = requests.post("http://localhost:8000/api/stock", headers=headers, data=body)
print(resp.status_code, resp.json())

# Tamper with the body: should return 401
resp = requests.post("http://localhost:8000/api/stock", headers=headers, data=b'{"ticker":"AAPL"}')
print(resp.status_code)`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">What's protected, what isn't</h2>
        <ul className="ml-4 list-disc space-y-1 text-sm text-zinc-400 marker:text-zinc-600">
          <li><strong>Authenticity</strong>, only someone with the shared secret can sign a request.</li>
          <li><strong>Integrity</strong>, flipping a single byte of the body breaks the signature.</li>
          <li><strong>Replay protection</strong>, captured requests stop working 5 minutes after they were signed.</li>
          <li>The wire is still HTTPS-only in prod, TLS handles confidentiality.</li>
        </ul>
        <p className="text-sm leading-relaxed text-zinc-400">
          What it does <em>not</em> cover: webhook URLs themselves are a
          public surface. Use a unique, hard-to-guess path per tool and
          never log full request bodies if they may contain user PII.
        </p>
      </section>

      <section className="space-y-3 border-t border-white/[0.06] pt-6">
        <h2 className="text-lg font-semibold tracking-tight text-white">Outbound events — verifying <code className="text-zinc-300">call.ended</code></h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Outbound webhooks (Settings → Webhooks in Studio) fire when an agent call completes.
          Same wire format as custom-tool calls, same verifier — the only thing that changes is the direction.
          Both the headers (<code>X-Vocence-Timestamp</code>, <code>X-Vocence-Signature: v1=…</code>) and the
          <code>v1.&#123;ts&#125;.&#123;body&#125;</code> HMAC base string are identical, so the existing helpers work
          unchanged.
        </p>
        <CodeBlock language="python" code={`from fastapi import FastAPI, Depends
from vocence.webhooks import fastapi_verifier

app = FastAPI()
verify = fastapi_verifier(secret="your-webhook-secret-from-Studio")

@app.post("/vocence/events", dependencies=[Depends(verify)])
async def on_event(envelope: dict):
    if envelope["event"] == "call.ended":
        session = envelope["session_id"]
        duration = envelope["duration_ms"] / 1000
        recording = envelope.get("recording_url")  # None when recording is off
        await save_call_to_crm(session, duration, recording, envelope["transcript"])
    return {"ok": True}`} />
        <p className="text-sm leading-relaxed text-zinc-400">
          Delivery is at-least-once: on a 5xx response or timeout we retry with backoff at
          <strong> 30 s, 2 min, 10 min, 30 min</strong> before giving up. Idempotency-key your handler — the same
          <code>session_id</code> may arrive more than once during retry storms or after a transient outage.
        </p>
        <p className="text-sm leading-relaxed text-zinc-400">
          See <Link to="/docs/guide-agents#deploy" className="text-[#DFFF00] hover:underline">Agents §12 Deploying</Link> for the
          full envelope shape and the Test-button flow you can use to wire up your receiver before any real call lands.
        </p>
      </section>
    </div>
  );

  const renderCookbook = () => (
    <div className="space-y-8">
      <nav className="flex items-center gap-1.5 text-xs text-zinc-500">
        <span>Documentation</span>
        <ChevronRight size={12} className="opacity-60" aria-hidden />
        <span className="font-medium text-zinc-400">Cookbook</span>
      </nav>

      <header className="space-y-3 border-b border-white/[0.06] pb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Cookbook</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          End-to-end recipes that combine Vocence API endpoints into the shapes most
          integrations actually need. Python on this page (it's the most common
          integration target); each call has a one-liner curl in the{' '}
          <Link to="/docs/api" className="text-[#DFFF00] hover:underline">API Reference</Link>{' '}
          for translation to any language.
        </p>
        <p className="max-w-2xl text-[12px] leading-relaxed text-zinc-500">
          All snippets assume <code className="rounded bg-white/[0.06] px-1.5 py-0.5">API_KEY</code> is
          set to a Premium <code className="rounded bg-white/[0.06] px-1.5 py-0.5">voc_live_…</code> key
          and <code className="rounded bg-white/[0.06] px-1.5 py-0.5">BASE = "https://api.vocence.ai"</code>.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Speak with a built-in voice</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          List the catalog of pre-defined speakers, pick one, then synthesize.
          Useful when you don't want to clone or design a voice, just pick a
          good-sounding one off the shelf.
        </p>
        <CodeBlock language="python" code={`import requests

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}"}

# 1. Browse the catalog (id, name, description)
voices = requests.get(f"{BASE}/v1/voices/builtin", headers=H).json()
for v in voices["voices"][:5]:
    print(v["id"], "—", v["name"], "—", v["description"])

# 2. Synthesize text in the picked voice
audio = requests.post(
    f"{BASE}/v1/tts/speak",
    headers={**H, "Content-Type": "application/json"},
    json={"text": "Hello from Vocence!", "voice": "design-aria"},
).json()

print("Audio URL:", audio["audio_url"])  # presigned, ~10 min TTL`} />
        <p className="text-[12px] leading-relaxed text-zinc-500">
          Endpoints used: <code className="text-zinc-300">GET /v1/voices/builtin</code>,{' '}
          <code className="text-zinc-300">POST /v1/tts/speak</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Clone a voice from your own audio clip</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Upload a 5–30s reference clip, the API transcribes it server-side and
          saves it as a reusable voice. Reuse the same voice id any number of
          times, no re-upload, no re-transcription.
        </p>
        <CodeBlock language="python" code={`import requests

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}"}

# 1. Upload + save the clip as a reusable voice
with open("my_voice_sample.wav", "rb") as f:
    saved = requests.post(
        f"{BASE}/v1/voice/clone/save",
        headers=H,
        files={"audio_file": ("sample.wav", f, "audio/wav")},
        data={"display_name": "My Voice"},
    ).json()

voice_id = saved["voice_id"]
print("Saved voice:", voice_id, "·", saved["display_name"])

# 2. Synthesize new text in that voice, any time, any number of times
audio = requests.post(
    f"{BASE}/v1/voices/{voice_id}/speak",
    headers={**H, "Content-Type": "application/json"},
    json={"text": "This is my cloned voice speaking."},
).json()

print(audio["audio_url"])`} />
        <p className="text-[12px] leading-relaxed text-zinc-500">
          Endpoints used: <code className="text-zinc-300">POST /v1/voice/clone/save</code>,{' '}
          <code className="text-zinc-300">POST /v1/voices/{`{voice_id}`}/speak</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Transcribe a message and reply in voice</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Classic STT → LLM → TTS pipeline. The LLM step is yours (OpenAI,
          Anthropic, local, anything). Vocence handles both ends of the audio.
        </p>
        <CodeBlock language="python" code={`import base64, requests

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# 1. Transcribe the inbound clip
audio_b64 = base64.b64encode(open("user_message.wav", "rb").read()).decode()
stt = requests.post(
    f"{BASE}/v1/stt/transcribe",
    headers=H,
    json={"audio_b64": audio_b64, "language": "English"},
).json()
heard = stt["text"]

# 2. Build a reply (call your own LLM here)
reply = f"You said: {heard}. Here is my response..."

# 3. Speak the reply in a chosen voice
audio = requests.post(
    f"{BASE}/v1/tts/speak",
    headers=H,
    json={"text": reply, "voice": "design-aria"},
).json()

print(audio["audio_url"])`} />
        <p className="text-[12px] leading-relaxed text-zinc-500">
          Endpoints used: <code className="text-zinc-300">POST /v1/stt/transcribe</code>,{' '}
          <code className="text-zinc-300">POST /v1/tts/speak</code>. For a fully-managed
          real-time agent loop (no LLM glue needed) see the next recipe.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Build a voice agent with a custom webhook tool</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Register your own webhook as a tool, create an agent, bind the tool,
          then connect the WebSocket session and stream text or audio. Vocence
          handles tool calling, transcription, the LLM, and TTS streaming.
        </p>
        <CodeBlock language="python" code={`import requests, asyncio, json, aiohttp

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# 1. Register a webhook tool, Vocence will call this URL whenever the
#    LLM decides to use the tool mid-conversation.
tool = requests.post(f"{BASE}/v1/agent-tools", headers=H, json={
    "name": "get_stock_price",
    "description": "Look up a stock's current price by ticker.",
    "parameters": {
        "type": "object",
        "properties": {"ticker": {"type": "string"}},
        "required": ["ticker"],
    },
    "endpoint_url": "https://yourdomain.com/api/stock",
    "method": "POST",
    "auth_type": "bearer",
    "auth_secret": "your-webhook-shared-secret",
}).json()
tool_id = tool["tool"]["id"]

# 2. Create the agent
agent = requests.post(f"{BASE}/v1/agents", headers=H, json={
    "name": "Finance Bot",
    "type": "knowledge",
    "purpose": "Answer stock-market questions concisely.",
    "system_prompt": "Use the get_stock_price tool whenever asked for a price.",
    "voice": "design-marcus",
    "language": "English",
    "enabled_tools": ["web_search"],   # built-ins; in addition to the custom tool
}).json()
agent_id = agent["agent"]["id"]

# 3. Bind the custom tool to this agent
requests.post(f"{BASE}/v1/agents/{agent_id}/tools/{tool_id}", headers=H)

# 4. Talk to the agent over WebSocket
async def chat():
    url = f"wss://api.vocence.ai/v1/agents/{agent_id}/session"
    headers = {"Authorization": f"Bearer {API_KEY}"}
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect(url, headers=headers) as ws:
            await ws.send_str(json.dumps({"type": "text", "text": "What's TSLA at?"}))
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    print("event:", msg.data[:160])
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    print(f"audio frame: {len(msg.data)} bytes")

asyncio.run(chat())`} />
        <p className="text-[12px] leading-relaxed text-zinc-500">
          Endpoints used: <code className="text-zinc-300">POST /v1/agent-tools</code>,{' '}
          <code className="text-zinc-300">POST /v1/agents</code>,{' '}
          <code className="text-zinc-300">POST /v1/agents/{`{agent_id}`}/tools/{`{tool_id}`}</code>,{' '}
          <code className="text-zinc-300">WS /v1/agents/{`{agent_id}`}/session</code>.
          Server events include <code>token</code> (LLM text chunks),
          <code>tool_call_started</code>, <code>audio_meta</code> + binary PCM16 frames,
          <code>turn_end</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Design a voice from a description, then reuse it</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Voice Design takes a written prompt and generates two preview variants.
          Save the better one and you've got a brand-new reusable voice without
          ever recording a clip.
        </p>
        <CodeBlock language="python" code={`import requests

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}", "Content-Type": "application/json"}

# 1. Generate two preview variants from a description. The server runs
#    an LLM to invent a short sample script for you and synthesizes
#    two variants ("original" uses your description verbatim, "revised"
#    uses the LLM's polished version).
previews = requests.post(f"{BASE}/v1/voice/design/preview", headers=H, json={
    "voice_description": "warm middle-aged female narrator with a slight British accent",
}).json()

print("variant A:", previews["audio_a_url"])  # original (your description)
print("variant B:", previews["audio_b_url"])  # revised  (LLM-polished)
print("sample_script:", previews["sample_script"])

# 2. Save the preferred variant as a reusable voice
saved = requests.post(f"{BASE}/v1/voice/design/save", headers=H, json={
    "preview_token": previews["preview_token"],
    "chosen_variant": "revised",       # or "original"
    "display_name": "Narrator",
}).json()
voice_id = saved["voice_id"]

# 3. Synthesize new text in your designed voice
audio = requests.post(
    f"{BASE}/v1/voices/{voice_id}/speak",
    headers=H,
    json={"text": "This narrator was designed in seconds."},
).json()

print(audio["audio_url"])`} />
        <p className="text-[12px] leading-relaxed text-zinc-500">
          Endpoints used: <code className="text-zinc-300">POST /v1/voice/design/preview</code>,{' '}
          <code className="text-zinc-300">POST /v1/voice/design/save</code>,{' '}
          <code className="text-zinc-300">POST /v1/voices/{`{voice_id}`}/speak</code>.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Remove background noise from audio</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Upload a noisy recording and get a clean version back. Useful for
          pre-processing audio before cloning or transcription.
        </p>
        <CodeBlock language="python" code={`import requests, base64
from pathlib import Path

API_KEY = "voc_live_..."
BASE = "https://api.vocence.ai"
H = {"Authorization": f"Bearer {API_KEY}"}

audio_b64 = base64.b64encode(Path("noisy.wav").read_bytes()).decode()
r = requests.post(f"{BASE}/v1/audio/noise-remover", headers=H, json={
    "audio_b64": audio_b64,
})
data = r.json()
print("enhanced:", data["audio_url"])
print(f"credits used: {data['credits_used']}, remaining: {data['credits_remaining']}")`} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold tracking-tight text-white">Where to go next</h2>
        <p className="text-sm leading-relaxed text-zinc-400">
          Every endpoint in these recipes has its full parameter table, code
          snippets in five languages, and a Try-It-Out button on the{' '}
          <Link to="/docs/api" className="text-[#DFFF00] hover:underline">API Reference</Link>{' '}
          page. If you hit a missing case here, ping us on{' '}
          <a href="https://discord.gg/b2DTT73Usq" className="text-[#DFFF00] hover:underline" target="_blank" rel="noopener noreferrer">
            Discord
          </a>{' '}
          and we'll add the recipe.
        </p>
      </section>
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
      case 'guide-agents':
        return renderGuideAgents();
      case 'guide-tts':
        return renderGuideTts();
      case 'guide-cloning':
        return renderGuideCloning();
      case 'guide-stt':
        return renderGuideStt();
      case 'guide-music':
        return renderGuideMusic();
      case 'guide-dubbing':
        return renderGuideDubbing();
      case 'cookbook':
        return renderCookbook();
      case 'api':
        return renderAPI();
      case 'pricing':
        return renderPricing();
      case 'sdk-python':
        return renderSdkPython();
      case 'sdk-cli':
        return renderSdkCli();
      case 'sdk-agents':
        return renderSdkAgents();
      case 'sdk-webhooks':
        return renderSdkWebhooks();
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

  // Group links by category, uses visibleDocLinks so admin-only
  // sections (and their now-empty categories) drop out for non-admins.
  const groupedLinks = visibleDocLinks.reduce((acc, link) => {
    if (!acc[link.category]) acc[link.category] = [];
    acc[link.category].push(link);
    return acc;
  }, {} as Record<string, DocLink[]>);

  return (
    <div ref={docsRef} className="min-h-screen bg-[#07080A] pt-[4.5rem]">
      <div className="flex">
        <aside className="docs-sidebar sticky top-[4.5rem] hidden h-[calc(100vh-4.5rem)] w-[260px] shrink-0 overflow-y-auto border-r border-white/[0.06] bg-[#07080A] px-4 py-8 lg:block">
          <div className="space-y-3 pr-2">
            {Object.entries(groupedLinks).map(([category, links]) => {
              const shouldShow = !collapsedCats.has(category);
              return (
                <div key={category}>
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsedCats((prev) => {
                        const next = new Set(prev);
                        if (next.has(category)) next.delete(category);
                        else next.add(category);
                        return next;
                      })
                    }
                    className={`group mb-1.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[15px] font-semibold tracking-tight transition-colors ${
                      shouldShow
                        ? 'bg-white/[0.04] text-white'
                        : 'text-zinc-300 hover:bg-white/[0.03] hover:text-white'
                    }`}
                  >
                    <span>{category}</span>
                    <ChevronRight
                      size={14}
                      strokeWidth={2.25}
                      className={`shrink-0 text-zinc-400 transition-transform group-hover:text-zinc-200 ${
                        shouldShow ? 'rotate-90 text-[#DFFF00]' : ''
                      }`}
                      aria-hidden
                    />
                  </button>
                  {shouldShow && (
                    <ul className="ml-2 space-y-0.5 border-l border-white/[0.06] pl-2">
                      {links.map((link) => (
                        <li key={link.id}>
                          <Link
                            to={`/docs/${link.id}`}
                            className={`block w-full rounded-md px-3 py-1.5 text-left text-[12px] leading-snug transition-colors ${
                              activeSection === link.id
                                ? 'bg-white/[0.07] font-medium text-white shadow-[inset_2px_0_0_0_#DFFF00]'
                                : 'text-zinc-500 hover:bg-white/[0.04] hover:text-zinc-200'
                            }`}
                          >
                            {link.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        <main className="docs-content min-h-[calc(100vh-4.5rem)] flex-1 border-l border-transparent lg:border-l-0">
          {activeSection === 'api' ? (
            // The API page has its own internal layout (cards + a
            // specialized method-colored right-rail TOC inside
            // ApiExplorer), so we let it span the full width.
            <div className="mx-auto max-w-[1400px] px-5 py-6 sm:px-8 sm:py-8 lg:px-12 lg:py-10">
              {renderContent()}
            </div>
          ) : (
            <div className="mx-auto flex max-w-[1180px] gap-10 px-5 py-6 sm:px-8 sm:py-8 lg:px-12 lg:py-10">
              <div ref={contentRef} className="min-w-0 max-w-3xl flex-1">
                {renderContent()}
              </div>
              <DocsRightToc contentRef={contentRef} activeSection={activeSection} />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
