# Vocence — Product Guide

A complete walkthrough of what you can do on [vocence.ai](https://vocence.ai), how each Studio feature works, what credits cost, how billing works, and what's allowed on the platform.

This document is written for users — sign up, log in, generate audio, share content, buy credits, and use the API. For deep technical and protocol documentation, see [vocence.ai/docs](https://vocence.ai/docs) and [vocence.ai/whitepaper](https://vocence.ai/whitepaper).

---

## Table of Contents

1. [What Is Vocence?](#what-is-vocence)
2. [Quick Start](#quick-start)
3. [Account & Sign-In](#account--sign-in)
4. [Studio Overview](#studio-overview)
5. [Studio Features](#studio-features)
   - [Voice Design](#1-voice-design)
   - [Text-to-Speech](#2-text-to-speech-tts)
   - [Speech-to-Text](#3-speech-to-text-stt)
   - [Voice Cloning](#4-voice-cloning)
   - [Text-to-Music](#5-text-to-music)
   - [My Voices](#6-my-voices)
   - [Playbooks](#7-playbooks)
   - [History](#8-history)
   - [Voice Chat](#9-voice-chat-coming-soon)
6. [Credits & Pricing](#credits--pricing)
7. [Plans](#plans)
8. [Payment Methods](#payment-methods)
9. [Developer API](#developer-api)
10. [Public Dashboard](#public-dashboard)
11. [Blog & Documentation](#blog--documentation)
12. [Acceptable Use & Community Guidelines](#acceptable-use--community-guidelines)
13. [Privacy & Data](#privacy--data)
14. [Audio Storage & Expiry](#audio-storage--expiry)
15. [Support & Contact](#support--contact)
16. [Reference Links](#reference-links)

---

## What Is Vocence?

Vocence is a decentralized voice AI platform that lets you generate speech, transcribe audio, clone voices, design custom voices from text descriptions, and create music — all from a single Studio interface in your browser.

It is powered by an open network on [Bittensor](https://bittensor.com), a decentralized AI ecosystem. As a user you don't have to think about that — you just open Studio, type, and generate.

**Site:** [https://vocence.ai](https://vocence.ai)

---

## Quick Start

1. Open [vocence.ai](https://vocence.ai).
2. Click **Sign In** and continue with Google.
3. Receive **300 free credits** automatically.
4. Open [Studio](https://vocence.ai/studio) and pick a feature from the left sidebar.
5. Generate. Audio appears in a player you can listen, download, or save.

That's the whole flow. No credit card required to start.

---

## Account & Sign-In

- **Authentication:** Sign in with your Google account. Vocence uses Google as the sole identity provider.
- **Welcome bonus:** New accounts receive **300 credits**, granted automatically on first sign-in.
- **Account page:** [vocence.ai/account](https://vocence.ai/account)
  - View your profile, plan, credit balance, and recent transactions.
  - See payment history and invoices.
  - Manage Developer API keys (Premium plan only).
- **History page:** [vocence.ai/history](https://vocence.ai/history) — every generation you've made (TTS, STT, clone, music, voice design).

You can sign out at any time from the navigation menu.

---

## Studio Overview

Studio is the single workspace where all generation happens.

**Open Studio:** [vocence.ai/studio](https://vocence.ai/studio)

The left sidebar lists every feature:

| Sidebar Item | What It Does |
|---|---|
| **Voice Design** | Create a custom voice from a text description. |
| **Text-to-Speech** | Turn text into speech using a chosen style. |
| **Speech-to-Text** | Transcribe an audio file or recording. |
| **Voice Cloning** | Reproduce a reference voice saying new text. |
| **Text-to-Music** | Generate music from a prompt. |
| **My Voices** | Your saved custom voices. |
| **Playbooks** | Personal or public collections of audio tracks. |
| **History** | Every generation you've made. |
| **Voice Chat** | (coming soon) |

Each generation costs **credits**, deducted from your balance. See [Credits & Pricing](#credits--pricing).

---

## Studio Features

### 1. Voice Design

Design a brand-new voice by describing it in plain English (e.g., *"warm female narrator, calm, slightly raspy, 30s, professional"*).

**How it works:**

1. Open [Studio → Voice Design](https://vocence.ai/studio/voice-design).
2. Describe the voice you want.
3. Studio generates an **A/B preview** — two short audio samples in that style.
4. Pick the variant you prefer and **save** it to your library.
5. Saved voices appear in **My Voices** and can be used to generate new speech anytime.

**Cost:** 120 credits per A/B preview. Saving the chosen voice has no extra fee. Generating speech from a saved "My voice" later: 25 credits.

**Limits:**
- **Normal plan:** up to 5 saved custom voices.
- **Premium plan:** unlimited custom voices.

### 2. Text-to-Speech (TTS)

Convert any text up to **500 characters** into spoken audio.

**How it works:**

1. Open [Studio → Text-to-Speech](https://vocence.ai/studio/tts).
2. Pick a **style preset** (e.g., Neutral Male, Anime Hero, Dark Villain, Narrator/Trailer, Cyberpunk AI, Military Commander, and more) or write your own style description.
3. Type your text.
4. Click generate. Audio plays in the result panel and is saved to History.

**Cost:** 25 credits per generation.

**Limits:** Maximum 500 characters of input text per request.

### 3. Speech-to-Text (STT)

Transcribe a spoken audio clip into written text.

**How it works:**

1. Open [Studio → Speech-to-Text](https://vocence.ai/studio/stt).
2. Upload an audio file or record directly in the browser (recordings are capped at **3 minutes**).
3. Optionally choose the source language.
4. Click transcribe. The text appears in the result panel.

**Cost:** 20 credits per generation.

### 4. Voice Cloning

Reproduce the voice from a reference clip saying new text.

**How it works:**

1. Open [Studio → Voice Cloning](https://vocence.ai/studio/cloning).
2. Upload (or record) a short reference clip of the voice you want to clone.
3. Optionally type the reference text. If you don't, Studio transcribes the clip for you automatically.
4. Type the **target text** — what you want the cloned voice to say.
5. Click generate. The result is a WAV file in the new voice.

**Cost:** 50 credits per generation.

**Important:** You may only clone voices for which you have permission — your own voice, voices you have explicit consent from, or voices clearly licensed for synthesis. See [Acceptable Use](#acceptable-use--community-guidelines).

### 5. Text-to-Music

Generate original music from a prompt.

**How it works:**

1. Open [Studio → Text-to-Music](https://vocence.ai/studio/music).
2. Write a prompt describing the genre, mood, instruments, BPM, and vocals (e.g., *"lo-fi, piano, soft drums, vinyl crackle, 75 bpm, chill, mellow, warm, instrumental"*).
3. Optionally provide lyrics.
4. Choose duration and format.
5. Generate. The track plays in the result panel and is saved to History and **Playbooks**.

**Modes available:**
- **Text-to-Music** — full track from prompt.
- **Audio-to-Audio** — transform an existing audio clip with a new prompt.
- **Retake** — generate a fresh take from the same prompt.
- **Repaint** — regenerate part of an existing track.
- **Edit** — modify a section.
- **Extend** — extend an existing track.

**Cost:** 50 credits per generation, regardless of mode.

### 6. My Voices

Your library of saved custom voices designed in **Voice Design**.

**Open:** [vocence.ai/studio/my-voices](https://vocence.ai/studio/my-voices)

From here you can:
- Preview each voice.
- Generate new speech from a saved voice (25 credits per generation).
- Delete voices you no longer want.

**Limits:**
- Normal plan: 5 voices max.
- Premium plan: unlimited.

### 7. Playbooks

Personal or public collections of audio tracks. Think of it as playlists that you can share.

**Open:** [vocence.ai/studio/playbooks](https://vocence.ai/studio/playbooks)

**What you can do:**
- **Create a Playbook** with a title, description, and cover image.
- **Add tracks** from your Music history or upload your own audio.
- **Reorder** tracks via drag and drop.
- **Choose visibility:** `private` (only you) or `public` (anyone on Vocence can play it).
- **Browse community Playbooks** that other users have made public.

When you make a Playbook **public**, it becomes visible to all users of the platform. You are responsible for ensuring all content complies with our [Terms of Service](https://vocence.ai/terms). See [Acceptable Use](#acceptable-use--community-guidelines).

### 8. History

A full log of every generation you've made — TTS, STT, clones, music, and voice design previews.

**Open:** [vocence.ai/history](https://vocence.ai/history) (or [Studio → History](https://vocence.ai/studio/history))

For each entry you can:
- Replay the audio.
- Download the file.
- See timestamps, credit cost, and source text/prompt.

**History retention:**
- **Normal plan:** items expire after **7 days**.
- **Premium plan:** history **never expires**.

### 9. Voice Chat (coming soon)

A real-time voice conversation feature is in development. Until launch, the entry will show a "Coming soon" notice.

---

## Credits & Pricing

Every generation in Studio consumes **credits**. Credits are a single, simple unit — no separate metering for different features.

| Action | Credits |
|---|---|
| Sign-up bonus (one-time) | **+300** |
| Text-to-Speech | 25 |
| Speech-to-Text | 20 |
| Voice Cloning | 50 |
| Voice Design (A/B preview) | 120 |
| Generate from saved "My Voice" | 25 |
| Text-to-Music (any mode) | 50 |

**Refunds:** If a generation fails on our side (e.g., temporary network capacity), the credits are automatically returned to your balance — you only pay for successful generations.

**See full pricing:** [vocence.ai/pricing](https://vocence.ai/pricing) · [Pricing in Docs](https://vocence.ai/docs/pricing)

---

## Plans

Vocence offers three plans, all visible on the [Pricing page](https://vocence.ai/pricing).

### Normal

- **Card price:** $12 → 4,000 credits (one-time pack)
- **Crypto price:** $20 → 7,000 credits (one-time pack — bonus credits)
- 300 free credits when you register
- Access to TTS, STT, Voice Cloning, Music Generation
- Up to **5** custom voices (Voice Design)
- Generation history saved for **7 days**
- Best for light usage and personal projects

### Premium

- **Card price:** $24 → 10,000 credits (one-time pack)
- **Crypto price:** $40 → 16,000 credits (one-time pack — bonus credits)
- Everything in Normal, plus:
- Generation history **never expires**
- **Unlimited** custom voices (Voice Design)
- Access to **Developer API** (TTS, STT, Clone, Music)
- Ideal for teams, creators, and production workflows

### Enterprise

- Custom pricing — contact us via [vocence.ai/sales](https://vocence.ai/sales)
- Full API support for product and platform integration
- Dedicated onboarding and commercial support
- Private quotas and operational flexibility
- Built for teams, apps, and larger-scale deployment

---

## Payment Methods

Buy credits at [vocence.ai/pricing](https://vocence.ai/pricing).

- **Credit / debit card** (Stripe) — *coming soon*. Currently shows a "coming soon" notice.
- **Crypto** (NOWPayments) — live now. Multiple coins and networks supported (BTC, ETH, USDT, USDC, and more). After choosing the asset and network, you're redirected to a NOWPayments invoice. The invoice stays denominated in USD; NOWPayments shows the exact crypto amount due.

Crypto packs include **bonus credits** versus the card-equivalent price.

After payment confirms, credits are added to your account automatically and a transaction row appears under [Account](https://vocence.ai/account).

---

## Developer API

The Developer API gives you programmatic access to the same generation backends used by Studio.

- **Eligibility:** Requires a successful **Premium** purchase. The API tab on [Account](https://vocence.ai/account) is locked until then.
- **Endpoints:** Text-to-Speech, Speech-to-Text, Voice Cloning, Music Generation.
- **Billing:** Pay-as-you-go from your existing credit balance.
  - **Rate:** **2,000 credits per 1,000,000 characters** (for text-based endpoints; characters = text + style/instruction prompt). If no instruction is provided, the default `"neutral voice"` is used.
- **Default rate limit:** 4 requests / minute / API key. Higher limits available on request for established usage patterns.
- **Key management:** Create, name, and revoke API keys from your [Account](https://vocence.ai/account) page. Each key shows a prefix and the last-used timestamp.

Full API reference: [vocence.ai/docs/api](https://vocence.ai/docs/api)
SDKs and libraries: [vocence.ai/docs/sdk](https://vocence.ai/docs/sdk)
Integration guide: [vocence.ai/docs/integration](https://vocence.ai/docs/integration)

---

## Public Dashboard

Vocence runs an open subnet on Bittensor. The public dashboard shows live network state — totals, validator activity, miner ranking, and the most recent global scoring snapshot.

**Open:** [vocence.ai/dashboard](https://vocence.ai/dashboard)
**Detailed evaluations view:** [vocence.ai/dashboard/evaluations](https://vocence.ai/dashboard/evaluations)

This page is **read-only** — you don't need an account to view it. It's where you can see what's happening on the network behind Studio.

---

## Blog & Documentation

- **Blog:** [vocence.ai/blog](https://vocence.ai/blog) — release notes, technical posts, community updates.
- **Docs:** [vocence.ai/docs](https://vocence.ai/docs)
  - [Getting Started](https://vocence.ai/docs/getting-started)
  - [Core Concepts](https://vocence.ai/docs/core-concepts)
  - [Architecture](https://vocence.ai/docs/architecture)
  - [API Reference](https://vocence.ai/docs/api)
  - [Pricing](https://vocence.ai/docs/pricing)
  - [SDKs & Libraries](https://vocence.ai/docs/sdk)
  - [Models](https://vocence.ai/docs/models)
  - [Voice Cloning Guide](https://vocence.ai/docs/cloning)
  - [Integration Guide](https://vocence.ai/docs/integration)
  - [Miner Setup](https://vocence.ai/docs/miner)
  - [Validator Setup](https://vocence.ai/docs/validator)
  - [FAQ](https://vocence.ai/docs/faq)
  - [Troubleshooting](https://vocence.ai/docs/troubleshooting)
- **Whitepaper:** [vocence.ai/whitepaper](https://vocence.ai/whitepaper)

---

## Acceptable Use & Community Guidelines

By using Vocence you agree to the [Terms of Service](https://vocence.ai/terms). The full list of restrictions and the moderation rules for **public Playbooks** are spelled out there. The most important rules in plain language:

- **Don't break the law.** No content that violates copyright, privacy, export controls, or any other law.
- **No harmful content.** No hateful, violent, sexually explicit, threatening, harassing, discriminatory, self-harm, terrorism, or content involving minors.
- **No impersonation.** Don't clone or imitate a real person without their explicit, documented consent. Public figures are not exempt.
- **No copyrighted material.** Don't upload audio you don't have rights to use, including music recordings, samples, or compositions.
- **No spam.** Public Playbooks must not be used purely for advertising or misleading content.
- **Respect other users.** Don't harass, stalk, or target anyone using public features.

**Moderation:** Vocence may review, restrict, or remove public content at any time without prior notice. Repeat or severe violations can lead to account suspension or termination.

**Reporting:** If you see public content that breaks these rules, email **[space@vocence.ai](mailto:space@vocence.ai)**.

By making a Playbook public you confirm you have all the necessary rights and that the content complies with the Terms.

---

## Privacy & Data

The full text is at [vocence.ai/privacy](https://vocence.ai/privacy). Highlights:

- **Account info we store:** email, name, profile picture (from Google), credits, plan, transaction history.
- **Audio you submit** is processed to fulfill your request and stored in your account so you can play it back from History or Playbooks.
- **We do not sell your personal information.**
- **Service providers** (e.g., hosting, payments, analytics) may process limited data on our behalf.
- **Cookies** are used for sign-in sessions and basic analytics.
- **Your rights:** Depending on your region, you may have rights to access, correct, delete, or port your data. Contact **[space@vocence.ai](mailto:space@vocence.ai)** to exercise them.

---

## Audio Storage & Expiry

Generated audio is hosted on a fast CDN and accessed via short-lived signed URLs.

- **Normal plan:** generated audio in History/Playbooks expires after **7 days**.
- **Premium plan:** audio is retained indefinitely (no expiry).

You can always **download** any generation to your local machine while it is still available.

---

## Support & Contact

- **General contact:** [space@vocence.ai](mailto:space@vocence.ai)
- **Sales / Enterprise:** [vocence.ai/sales](https://vocence.ai/sales) → form on the page submits to our team.
- **Bug reports & feedback:** email [space@vocence.ai](mailto:space@vocence.ai) with reproduction steps if possible.
- **Community:** look for the social links in the site footer.

---

## Reference Links

### Product surfaces

- Home — [https://vocence.ai](https://vocence.ai)
- Studio — [https://vocence.ai/studio](https://vocence.ai/studio)
  - Voice Design — [/studio/voice-design](https://vocence.ai/studio/voice-design)
  - Text-to-Speech — [/studio/tts](https://vocence.ai/studio/tts)
  - Speech-to-Text — [/studio/stt](https://vocence.ai/studio/stt)
  - Voice Cloning — [/studio/cloning](https://vocence.ai/studio/cloning)
  - Text-to-Music — [/studio/music](https://vocence.ai/studio/music)
  - My Voices — [/studio/my-voices](https://vocence.ai/studio/my-voices)
  - Playbooks — [/studio/playbooks](https://vocence.ai/studio/playbooks)
  - History — [/studio/history](https://vocence.ai/studio/history)
- Account — [https://vocence.ai/account](https://vocence.ai/account)
- History — [https://vocence.ai/history](https://vocence.ai/history)
- Pricing — [https://vocence.ai/pricing](https://vocence.ai/pricing)
- Sales — [https://vocence.ai/sales](https://vocence.ai/sales)

### Network & docs

- Public Dashboard — [https://vocence.ai/dashboard](https://vocence.ai/dashboard)
- Detailed Evaluations — [https://vocence.ai/dashboard/evaluations](https://vocence.ai/dashboard/evaluations)
- Documentation — [https://vocence.ai/docs](https://vocence.ai/docs)
- Whitepaper — [https://vocence.ai/whitepaper](https://vocence.ai/whitepaper)
- Blog — [https://vocence.ai/blog](https://vocence.ai/blog)

### Policies

- Terms of Service — [https://vocence.ai/terms](https://vocence.ai/terms)
- Privacy Policy — [https://vocence.ai/privacy](https://vocence.ai/privacy)

### External

- Bittensor — [https://bittensor.com](https://bittensor.com)
- Open-source repository — [https://github.com/vocence-78/vocence](https://github.com/vocence-78/vocence)

---

*Last updated: April 2026. This guide reflects the public product as of this date. Pricing, limits, and feature availability may change — always cross-check on [vocence.ai/pricing](https://vocence.ai/pricing) and [vocence.ai/docs](https://vocence.ai/docs).*
