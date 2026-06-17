/**
 * Per-route static HTML emitter.
 *
 * Runs after ``vite build``. For every entry in ``ROUTE_META`` we read
 * the canonical ``dist/index.html``, swap in route-specific <title>,
 * <meta name="description">, og:* and twitter:* tags, and write the
 * result to ``dist/<route>/index.html``.
 *
 * Why: the app is a Vite SPA, so every URL the build emits ships the
 * homepage <title>/<meta>/<og> values. Crawlers that DO run JS
 * (Googlebot) recover via the runtime ``usePageMeta`` hook; crawlers
 * and AI agents that don't (ClaudeBot, GPTBot, PerplexityBot, Bing) see
 * the homepage tags for every URL. This script gives those crawlers a
 * per-route static HTML with the right meta — combined with
 * ``llms-full.txt`` for content, that's enough to be indexable.
 *
 * Vercel/Cloudflare both serve ``<route>/index.html`` for the matching
 * URL when present (the catch-all rewrite rule only triggers when there
 * isn't a static match), so wiring is free — no _redirects edit needed.
 *
 * Real content prerendering (vite-react-ssg) is the proper Phase 2.
 * This is Phase 1: cheap, contained, no app-code refactor.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://www.vocence.ai';
const OG_IMAGE = `${SITE}/og.png`;
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(APP_DIR, 'dist');

/**
 * Each entry produces ``dist/<path>/index.html`` with the matching
 * meta. Titles capped ~60 chars, descriptions ~155 chars (SERP
 * truncation points). Keep this list in sync with sitemap.xml and the
 * SECTION_META map in src/pages/Docs.tsx.
 */
const ROUTE_META = [
  // Marketing
  {
    path: '/pricing',
    title: 'Pricing — Vocence',
    description: 'Plans, credit packs, and per-action costs for Vocence Studio + the Developer API. One-time credit packs from $12. 300 free credits at signup.',
  },
  {
    path: '/blog',
    title: 'Blog — Vocence',
    description: 'Product updates, voice AI research, and engineering notes from the team building Vocence.',
  },
  {
    path: '/whitepaper',
    title: 'Whitepaper — Vocence',
    description: 'Decentralized voice AI on Bittensor SN10: scoring contract, miner / validator economics, model evaluation pipeline.',
  },
  {
    path: '/privacy',
    title: 'Privacy Policy — Vocence',
    description: 'How Vocence collects, stores, and uses your account, audio, and usage data.',
  },
  {
    path: '/terms',
    title: 'Terms of Service — Vocence',
    description: 'Terms of use for the Vocence platform, including acceptable use, billing, intellectual property, and service availability.',
  },

  // Docs — Introduction
  {
    path: '/docs/getting-started',
    title: 'Getting Started — Vocence Docs',
    description: 'Sign up, claim 300 free credits, and make your first speech, transcription, voice clone, or voice agent in five minutes.',
  },
  {
    path: '/docs/core-concepts',
    title: 'Core Concepts — Vocence Docs',
    description: 'Voices, agents, credits, embeddings, and the request lifecycle — the vocabulary every Vocence integration shares.',
  },
  {
    path: '/docs/architecture',
    title: 'Architecture — Vocence Docs',
    description: 'How Vocence routes a request across the Bittensor SN10 network: dashboard, developer API, and the streaming voice pipeline.',
  },

  // Docs — Studio guides
  {
    path: '/docs/guide-agents',
    title: 'Voice Agents Guide — Vocence Studio',
    description: 'Build a voice agent in Studio: pick a voice, write a system prompt, attach knowledge or tools, and deploy via web embed, SDK, or phone.',
  },
  {
    path: '/docs/guide-tts',
    title: 'Text-to-Speech Guide — Vocence Studio',
    description: 'PromptTTS and SpeakerTTS: generate natural speech from text using 16 built-in voices or a one-line prose voice description.',
  },
  {
    path: '/docs/guide-cloning',
    title: 'Voice Cloning Guide — Vocence Studio',
    description: 'Clone any voice from a 5–30s reference clip. Reuse the saved voice across TTS, agents, and live conversations.',
  },
  {
    path: '/docs/guide-stt',
    title: 'Speech-to-Text Guide — Vocence Studio',
    description: 'Transcribe up to 5 minutes of audio with accurate timestamps, language detection, and one-shot REST or streaming WebSocket.',
  },
  {
    path: '/docs/guide-music',
    title: 'Music Generation Guide — Vocence Studio',
    description: 'Generate background music and ambient tracks from a text prompt, ready to drop into agents, podcasts, or videos.',
  },
  {
    path: '/docs/guide-dubbing',
    title: 'Noise Remover Guide — Vocence Studio',
    description: 'Strip background noise from voice recordings while preserving speech fidelity. Up to 5 minutes / 50 MB per request.',
  },

  // Docs — API + SDK + Cookbook
  {
    path: '/docs/api',
    title: 'API Reference — Vocence Developer Docs',
    description: 'Complete REST + WebSocket reference. Live OpenAPI explorer, per-endpoint params, request bodies, error codes, rate limits.',
  },
  {
    path: '/docs/cookbook',
    title: 'API Cookbook — Vocence Docs',
    description: 'Runnable Python recipes for the most-asked integrations: synthesize, clone, transcribe, build a voice agent, fetch call recordings.',
  },
  {
    path: '/docs/sdk-python',
    title: 'Python SDK Reference — Vocence',
    description: 'Official Vocence Python client. Sync and async APIs, typed responses, structured errors, voice-agent helpers, no manual HTTP.',
  },
  {
    path: '/docs/sdk-cli',
    title: 'CLI Reference — Vocence',
    description: 'The vocence command-line tool. Browser-based login, scripted TTS/STT, listing agents and voices, live agent chat in the terminal.',
  },
  {
    path: '/docs/sdk-agents',
    title: 'Voice Agents SDK — Vocence',
    description: 'Drive a voice agent in three layers: raw WebSocket events, Conversation helper, or live mic ↔ speaker. Press-to-talk or continuous streaming.',
  },
  {
    path: '/docs/sdk-webhooks',
    title: 'Webhooks SDK — Vocence',
    description: 'Sign and verify Vocence webhooks. Build a FastAPI receiver with signature checking and replay-tolerance.',
  },

  // Docs — Billing + Support + Subnet
  {
    path: '/docs/pricing',
    title: 'Pricing Details — Vocence Docs',
    description: 'How credits convert to dollars across Studio and the Developer API, plan tiers, per-endpoint cost reference, billing model, worked examples.',
  },
  {
    path: '/docs/faq',
    title: 'FAQ — Vocence Docs',
    description: 'Common questions about credits, voice cloning, custom voices, agents, the Vocence subnet, and how Vocence differs from cloud-only APIs.',
  },
  {
    path: '/docs/troubleshooting',
    title: 'Troubleshooting — Vocence Docs',
    description: 'Diagnose audio dropouts, slow first-byte latency, WebSocket close codes, voice cloning failures, and authentication issues.',
  },
  {
    path: '/docs/miner',
    title: 'Miner Setup — Vocence Subnet (SN10)',
    description: 'Stand up a Vocence miner on Bittensor: prerequisites, model wrappers, Chute deployment, scoring contract, and example commands.',
  },
  {
    path: '/docs/validator',
    title: 'Validator Setup — Vocence Subnet (SN10)',
    description: 'Run a Vocence validator on Bittensor: Docker setup, scoring methodology, weight setting, and credentials.',
  },
];

/**
 * Swap the homepage meta values for route-specific ones. Operates on
 * known tag selectors; falls back to no-op if a tag isn't found (we
 * own index.html, so misses would indicate a template change worth
 * surfacing rather than swallowing).
 */
function rewriteHead(html, { title, description, url }) {
  const replacements = [
    // <title>
    [/<title>[^<]*<\/title>/, `<title>${title}</title>`],
    // name="..." meta
    [/<meta name="description" content="[^"]*"[^/]*\/>/, `<meta name="description" content="${description}" />`],
    [/<meta name="twitter:title" content="[^"]*"[^/]*\/>/, `<meta name="twitter:title" content="${title}" />`],
    [/<meta name="twitter:description" content="[^"]*"[^/]*\/>/, `<meta name="twitter:description" content="${description}" />`],
    // property="..." meta
    [/<meta property="og:url" content="[^"]*"[^/]*\/>/, `<meta property="og:url" content="${url}" />`],
    [/<meta property="og:title" content="[^"]*"[^/]*\/>/, `<meta property="og:title" content="${title}" />`],
    [/<meta property="og:description" content="[^"]*"[^/]*\/>/, `<meta property="og:description" content="${description}" />`],
    // canonical link
    [/<link rel="canonical" href="[^"]*"[^/]*\/>/, `<link rel="canonical" href="${url}" />`],
  ];

  let out = html;
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

async function emitRoute(template, route) {
  const url = `${SITE}${route.path}`;
  const html = rewriteHead(template, { ...route, url });
  const outDir = resolve(DIST, route.path.replace(/^\//, ''));
  const outFile = resolve(outDir, 'index.html');
  await mkdir(outDir, { recursive: true });
  await writeFile(outFile, html, 'utf8');
}

async function main() {
  let template;
  try {
    template = await readFile(resolve(DIST, 'index.html'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('[route-meta] dist/index.html missing — run `vite build` first');
      process.exit(1);
    }
    throw err;
  }

  let count = 0;
  for (const route of ROUTE_META) {
    await emitRoute(template, route);
    count += 1;
  }
  console.log(`[route-meta] wrote ${count} per-route HTML files under dist/`);
}

main().catch((err) => {
  console.error('[route-meta] failed:', err);
  process.exit(1);
});
