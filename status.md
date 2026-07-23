# Vocence — Project Status & Handoff

**Last updated:** 2026-07-23
**Branch:** `ops` (main branch is `master`)
**Repo:** `/development/vocence_website`

This document is a complete handoff of the current state of work. It is written
for someone who has **not** been part of the recent sessions. Read §1 and §2
before touching anything.

---

## 1. ⚠️ READ FIRST — Critical state warnings

### 1.1 Nothing is committed

**All work described in this document exists only as uncommitted changes in the
working tree.**

| Metric | Count |
|---|---|
| Modified files | 37 |
| New (untracked) files | 14 |
| **Total uncommitted changes** | **51** |
| Unpushed commits on `ops` | **0** |

The last commit on the branch is `1c76db7` (agents config tuning), which predates
*all* of the work below. There is **no remote copy of any of it**. A careless
`git checkout`, `git stash`, `git clean`, or `rm` will destroy weeks of work
permanently.

> **Recommended first action for whoever picks this up: commit the work.**
> Suggested split into logical commits:
> 1. Video dubbing (backend + worker + public API + Studio UI)
> 2. Library / assets UX (History→Library, collections, expiry, player modal)
> 3. Auth session-expiry fix (global 401 handler)
> 4. Pricing + documentation updates
> 5. OKX AI Marketplace surface (`developer-api/app/okx/`)
> 6. Completion webhooks + uploads presign + SSRF hardening
>
> The repo owner previously instructed "no push until I ping you" — **confirm
> with them before pushing**, but committing locally is safe and strongly advised.

### 1.2 Vendor confidentiality (hard requirement)

Video dubbing is powered by two third-party engines:

- **Standard tier (voice-preserving dub)** → ElevenLabs Dubbing API
- **Lip-sync tier** → HeyGen Video Translation v3 API

**These vendor names must NEVER appear in any client-facing output** — not in UI
copy, API responses, error messages, docs, or the OKX marketplace listing. This
is an explicit product requirement from the repo owner.

This is enforced in code and by test:
- `jobs/workers/dispatch.py` uses `e.public_message` for vetted user-facing text,
  because raw upstream error bodies name the engine.
- A test in `dashboard-backend/tests/test_video_dub_routes.py` scans
  `routers/video_dub.py` for vendor-name leakage.

If you add an error path, route it through `public_message` or the friendly-message
mapper. Do not pass upstream response bodies to users.

### 1.3 Secrets hygiene

- A **GitHub personal access token is embedded in the git remote URL**
  (`git remote -v` exposes it). Anyone with shell access or a screenshot of that
  command has push rights to the repo. **Recommend rotating it** and switching to
  SSH or a credential helper.
- Never print, export, or commit the OKX wallet seed/private keys. The repo owner
  holds these.
- `.env` files are gitignored. `developer-api/.env.example` and
  `dashboard-backend/prod.env.additions` document required variables **without values**.

---

## 2. What is / is not verified

Be precise about this distinction — it determines what is safe to ship.

### ✅ Verified

| Check | Result |
|---|---|
| developer-api test suite | **153 passed** |
| dashboard-backend test suite | **174 passed** |
| Frontend type check (`tsc -p tsconfig.app.json --noEmit`) | **clean** |
| OKX x402 integration vs. **real SDK** (isolated py3.12 venv) | all imports correct, middleware builds, dynamic pricing exact |
| Live video dubbing (manual, earlier session) | 6s lip-sync job = $0.20; 4 concurrent = $0.80; per-second billing confirmed |

### ❌ NOT verified (do this before calling anything "live")

- **`/v1/uploads/presign` end-to-end.** Unit tests only assert the route exists and
  is auth-gated. The full presign → real R2 PUT → dub submit chain has never run
  against live infrastructure.
- **Completion webhooks firing for real.** Logic is unit-tested; no delivery to a
  real receiver has been observed.
- **Frontend rendering.** The new homepage dubbing section and Docs API examples
  type-check but have never been viewed in a browser.
- **Anything OKX beyond the SDK harness.** No testnet transaction has ever settled.

---

## 3. Architecture overview

Monorepo with three deployables:

| Path | What it is | Host |
|---|---|---|
| `app/` | React 19 + Vite + Tailwind SPA (marketing site + Studio dashboard) | www.vocence.ai (Vercel) |
| `dashboard-backend/` | FastAPI. Owns auth, credits, job queue, storage, all provider calls | backend.vocence.ai |
| `developer-api/` | FastAPI. Thin public API (`voc_live_` key auth), proxies to dashboard | api.vocence.ai |

**Key principle:** `developer-api` never implements generation logic. It authenticates,
rate-limits, meters, and forwards to `dashboard-backend` via `call_dashboard()` with
an internal service token. The dashboard is the single source of truth for pricing,
credit charging, and provider selection.

**Job queue** (`dashboard-backend/jobs/`): async enqueue → per-type worker pool →
terminal state. Credits are charged at enqueue and **refunded automatically** on
failure/timeout. Terminal-state handling is centralized in
`jobs/workers/dispatch.py::_process_one` — this is the chokepoint for anything that
must happen when *any* job finishes.

---

## 4. Workstream: Video Dubbing ✅ complete

Translate a video into other languages in the original speaker's voice, optionally
lip-synced.

### 4.1 Tiers and pricing

| Tier | What it does | Credits | USD | Engine (private) |
|---|---|---|---|---|
| Standard | Translated audio in the speaker's own voice; original video untouched | 200 / min | ~$0.50 | ElevenLabs |
| Lip-sync | The above **plus** the mouth re-rendered to match | 800 / min | ~$2.00 | HeyGen |

- **Billed per second**, rounded up, and **per output language**. One video into 3
  languages costs 3×.
- Lip-sync is an **opt-in checkbox, default OFF**. Unchecked → standard tier.
- Pricing is computed **server-side only**; the client's estimate is never trusted.
- Constants live in `dashboard-backend/video_dub_service.py` (env-overridable:
  `STUDIO_VIDEO_DUB_CREDITS_PER_MIN`, `STUDIO_VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN`).

### 4.2 Limits

| Limit | Value |
|---|---|
| Max duration | 10 minutes |
| Max upload | 200 MB (standard) / 100 MB (lip-sync) |
| Max languages per job | 3 |
| Supported languages | 28 |
| Lip-sync resolution | ≤2048px longest side |
| **Free-plan lip-sync cap** | **10 seconds** (standard dubbing uncapped, credit-gated) |

Free users get standard dubbing without a length cap; only lip-sync is capped.

### 4.3 Flow

```
Client → POST /api/dashboard/uploads/presign  (or /v1/uploads/presign)
       → PUT bytes directly to R2
       → POST /api/dashboard/video-dub/start  (or /v1/video/dub)
          ├─ validates duration/languages/consent
          ├─ checks plan caps + credit balance
          ├─ charges credits via jobs_api.enqueue()
          └─ returns {job_id, credits_charged}
       → worker: probe (ffprobe) → re-validate → dub per language → store → result
       → GET /api/dashboard/jobs/{id}  (or /v1/video/dub/{id})   [poll]
          …or receive a completion webhook (§8)
```

The worker **re-probes the real file with ffprobe** and refuses under-quoted jobs, so
a client lying about `duration_sec` gains nothing.

### 4.4 Consent requirement

`consent_attested: true` is **mandatory** on every dub request. The lip-sync engine
places the likeness-consent obligation on us as the API caller. Requests without it
are rejected with 400 before any charge. The attestation is recorded on the resulting
history rows.

### 4.5 Key files

| File | Role |
|---|---|
| `dashboard-backend/video_dub_service.py` | Pricing, validation, plan caps, tier config |
| `dashboard-backend/routers/video_dub.py` | Dashboard routes: start/quote/languages/history |
| `dashboard-backend/jobs/workers/video_dub.py` | Worker: probe → dub → store |
| `developer-api/app/api/routes/video_dub.py` | Public `/v1/video/dub` proxy |
| `app/src/pages/StudioVideoDub.tsx` | Studio UI |
| `dashboard-backend/tests/test_video_dub_pricing.py` | Pricing math tests |
| `dashboard-backend/tests/test_video_dub_routes.py` | Route + consent + vendor-leak tests |

### 4.6 Gotchas already fixed (do not reintroduce)

- `require_auth` returns a **`str` user id**, not a dict. Use
  `user_id: str = Depends(require_auth)`.
- `jobs_api.enqueue()` takes **`credits_to_charge=`** (not `credits=`) and returns an
  **`EnqueueResult` dataclass** (`result.job_id`, not `result["job_id"]`).
  `load_warning` is a **bool**.
- Presigned URLs need a **non-zero TTL window** — a zero-second window returns `None`
  (this caused "could not presign source video").
- Language labels for the lip-sync engine must match its catalogue exactly
  (e.g. **"Norwegian Bokmål (Norway)"**, **"Hungarian (Hungary)"**) or the request
  400s *after* credits are charged.

---

## 5. Workstream: Library / Assets ✅ complete

- **History → Library** rename throughout.
- Dub language variants are grouped as **Collections** (one card per source video,
  expandable to per-language results).
- **`ExpiryBadge.tsx`** surfaces retention. Dubbed videos are kept **permanently**.
- **`VideoPlayerModal.tsx`** — large in-browser player with poster thumbnails.
- **`DubLibraryDialog.tsx`** — paginated "View all" dialog.

**UI gotchas already fixed:**
- The player portals outside the Radix dialog, so Radix counted clicks as
  outside-clicks and closed the library. Fixed with `onInteractOutside` /
  `onEscapeKeyDown` guarded by `playerOpen`, plus `pointer-events-auto` on the player.
- Radix's default `sm:max-w-lg` **beats** `max-w-6xl` by specificity — the dialog width
  needs `sm:max-w-[1512px]`.
- Volume slider must be visible by default (`w-20`), not hover-expanded (`w-0 group-hover/vol:w-20`).
- Job-completion polling is driven by `pendingByType.video_dub > 0`, not a fixed timer
  (a 3s timer fired long before a 17–80s job finished).

---

## 6. Workstream: Auth session expiry ✅ complete

**Problem:** JWTs expire after 30 days with no refresh flow. Returning users hit
"token not provided or invalid token" errors with no recovery path.

**Solution (Option A):** a global 401 handler in `app/src/contexts/AuthContext.tsx`
auto-logs-out and surfaces the login prompt when any API call returns 401.

---

## 7. Workstream: Pricing & documentation ✅ complete

Video-dubbing pricing propagated to:
- `app/src/pages/Pricing.tsx`
- `app/src/pages/Docs.tsx` — guide, API reference table, pricing table, **and** a full
  copy-pasteable presign → PUT → submit → poll example in curl **and** Python
- `product.md`
- developer-api OpenAPI descriptions
- `app/src/studio/creditCosts.ts` — Studio cost estimates are **dynamic** (computed from
  duration × languages × tier), not hardcoded

Homepage (`app/src/pages/Overview.tsx`) now has a dedicated "New — Video Dubbing"
section plus an updated feature card.

---

## 8. Workstream: Completion webhooks ✅ complete (unverified live)

Async dubbing previously required polling. Callers can now pass a callback.

**Request fields** (on `/v1/video/dub` and the dashboard start route):
- `callback_url` — public HTTPS URL, POSTed once on terminal state
- `callback_secret` — optional; HMAC-signs the body

**Payload:**
```json
{ "event": "video_dub.completed", "job_id": "...", "status": "completed",
  "result": {...}, "error": null }
```
Events: `video_dub.completed` / `video_dub.failed`.

**Design notes:**
- New module `dashboard-backend/job_callbacks.py`. This is **one-shot per-request**
  delivery — distinct from `webhooks_service.py`, which is *subscription* delivery for
  agents. It deliberately reuses the same `X-Vocence-Signature` HMAC format so the
  SDK's `webhooks.verify()` works unchanged.
- Fired from `jobs/workers/dispatch.py` at the single terminal-state chokepoint, so
  **any future async job type gets callbacks for free**.
- Retries in-process at 0s / 30s / 120s. **Best-effort** — if the server restarts
  mid-retry the callback is lost. The poll endpoint remains the documented source of
  truth. If guaranteed delivery is needed later, the `webhook_deliveries` queue in
  `webhooks_service.py` is the natural upgrade path.
- `callback_url` is SSRF-validated **at submit time (before charging)** and again at
  delivery time (DNS can shift inward in between).
- **`callback_secret` is scrubbed in `jobs/state.py::Job.to_dict()`** — the job-status
  endpoints echo the payload, and the secret must never travel back out. Covered by test.

---

## 9. Workstream: Public uploads presign ✅ complete (unverified live)

`developer-api/app/api/routes/uploads.py` → `POST /v1/uploads/presign`.

This route **did not exist** even though the dubbing endpoint's own docs told
customers to use it — public API dubbing was therefore impossible for external
developers. It proxies the dashboard's presign and exposes only kinds a public `/v1`
endpoint actually consumes (currently `video-dub-source`).

---

## 10. Workstream: OKX AI Marketplace 🚧 BUILT BUT NOT LIVE

Goal: list Vocence as an **A2MCP ASP** on the OKX AI Marketplace. Buyer agents
discover tools, pay **per call in stablecoin via x402 (HTTP 402)** on **X Layer**,
settling to our OKX Agentic Wallet.

### 10.1 What exists

`developer-api/app/okx/` — mounted into the existing developer-api app (no separate
service):

| File | Role |
|---|---|
| `tools.py` | The 6 exposed tools: name, JSON schema, price, `/v1` path |
| `routes.py` | `GET /okx/manifest`, `POST /okx/tools/{name}`, `POST /okx/mcp` (JSON-RPC), free dub status route |
| `payments.py` | x402 gate — **the only file touching the OKX SDK** |
| `proxy.py` | Fulfillment via our own `/v1` API using a system key |
| `config.py` | All env config + `okx_enabled()` / `payments_configured()` |
| `services.json` | Batch registration payload for the CLI |
| `README.md` | Runbook |

**Tools & crypto pricing** (independent of credit pricing, set on-chain):

| Tool | `/v1` endpoint | Price |
|---|---|---|
| `vocence_text_to_speech` | `/v1/tts/speak` | $0.02 / call |
| `vocence_speech_to_text` | `/v1/stt/transcribe` | $0.02 / call |
| `vocence_voice_design` | `/v1/voice/design/preview` | $0.10 / call |
| `vocence_voice_clone` | `/v1/voice/clone` | $0.05 / call |
| `vocence_noise_remover` | `/v1/audio/noise-remover` | $0.02 / call |
| `vocence_video_dub` | `/v1/video/dub` | $0.60/min ($2.40/min lip-sync), **per language** |

Text-to-Music is intentionally **excluded** (owner decision). Voice Agents are
excluded (real-time WS doesn't fit MCP's request/reply model).

### 10.2 Design decisions worth knowing

- **Fails closed.** Without config, `okx_enabled()` is false, the payment middleware
  never attaches, and paid tools return **503** — never free service. The manifest
  stays public so the listing can be reviewed pre-launch.
- **Cannot break boot.** The whole mount in `main.py` is wrapped in try/except.
- **Dynamic pricing.** The dub tool's price depends on the request body. The SDK
  supports `DynamicPrice` callables but **hides the request body from them**
  (`get_body()` returns `None`). Workaround: the middleware wrapper parses the body and
  passes it via a `ContextVar`. Verified correct against the real SDK.
- **Free polling.** Dubbing is async and every `POST /okx/tools/*` is priced, so
  polling would have charged per check. There is a free
  `GET /okx/tools/vocence_video_dub/jobs/{job_id}`.
- **SSRF-guarded downloads.** Buyers supply a `video_url` that our server fetches.
  Only public HTTP(S) hosts on standard ports are allowed; loopback / RFC1918 /
  link-local (cloud metadata) are blocked, DNS is resolved to defeat CNAME tricks, and
  the guard re-runs on **every redirect hop** (max 4).
- **Settlement asset.** The SDK has a default stablecoin for X Layer **mainnet**
  (`eip155:196` → USD₮0) but **none for testnet** (`eip155:1952`), so testnet runs
  **must** set `OKX_ASSET_ADDRESS` or every priced call 500s.

### 10.3 SDK verification results (real SDK, isolated py3.12 venv)

All 10 adapter imports match `okxweb3-app-x402==0.1.1` (module name is `x402`).
Middleware builds and produces exact on-the-wire 402 challenge amounts:

| Scenario | Expected | Actual (atomic, 6 dp) |
|---|---|---|
| 10 min × 2 languages × lip-sync | $48.00 | `48000000` ✅ |
| 30 s × 1 language, standard (min) | $0.60 | `600000` ✅ |
| TTS flat | $0.02 | `20000` ✅ |

With fake credentials the middleware reaches OKX's **live** facilitator and returns
`401 Invalid OK-ACCESS-KEY (50111)` — confirming dev-portal credentials are required
for **settlement** but **not** for registration.

### 10.4 Wallet

| Field | Value |
|---|---|
| Login email | `space@vocence.ai` |
| EVM address | `0x67f9b23fc6dcced1ba70e178bf04266df9307423` |
| Solana address | `3M38cnz5wE5oXcKgK94NqPFqHG7rBxAw8QFQ43GtiNF9` |
| Login type | email (TEE wallet — no browser extension or seed needed) |
| CLI state | `/root/.onchainos/` |

The repo owner holds the wallet. **Never export or print private keys.**

### 10.5 ❌ Agent ID: DOES NOT EXIST YET

OKX has asked for an agent ID. **There isn't one.** Verified authoritatively:

```
$ onchainos agent get-my-agents
{"ok":true,"data":{"list":[],"page":1,"pageSize":5,"total":0}}
```

Zero agents registered. The agent ID is **minted by** `onchainos agent create --role asp`,
which has never been run.

> ⚠️ **Do not send `f10401e9-97f5-4b0d-9584-baf2a0cc0c54` to OKX.** That UUID appears in
> `wallets.json` and looks like an answer, but it is the **wallet accountId**, not an
> agent ID.

Correct order: **deploy → `agent create` → agent ID → send to OKX for human review.**

### 10.6 Blockers — updated 2026-07-23 (our side is DONE; waiting on OKX)

Everything Vocence-side was completed and verified live on 2026-07-23:

| # | Blocker | Status |
|---|---|---|
| 1 | developer-api Python ≥3.11 | ✅ **DONE** — api runs in `developer-api/venv_3.12` (3.12.13); full test suite passes on it |
| 2 | Deploy `/okx` to api.vocence.ai | ✅ **DONE** — SDK installed with extras; manifest live at https://api.vocence.ai/okx/manifest (payments_ready false) |
| 5 | Funded `voc_live_` system key | ✅ **DONE** — system account `okx-system@vocence.ai` (premium, 100k credits, internal $0 grant row satisfies the dev-api premium gate); key in `developer-api/.env` `OKX_SYSTEM_API_KEY`. Fulfillment chain verified end-to-end (OKX route → key auth → gate → dashboard). Keep it topped up. |
| 3 | OKX dev-portal credentials | ❌ waiting on OKX — API key / secret / passphrase; required for settlement |
| 4 | Testnet settlement-token address | ❌ waiting on OKX — needed for `OKX_ASSET_ADDRESS` on `eip155:1952` |
| 6 | WL email to OKX | ❌ waiting — send wallet email `space@vocence.ai`; destination unknown |
| 7 | Testnet end-to-end dry run | pending #3 + #4 |
| 8 | On-chain `agent create --role asp` | pending #7 — produces the agent ID |
| 9 | Flip to mainnet + send agent ID | `OKX_NETWORK=eip155:196` |

Note: commit `21f6c4f` closed a fail-open gap — with fulfillment wired but no
portal creds, paid tools would previously have served for FREE (the x402
middleware only attaches when `payments_configured()`). Execution now requires
both gates; the current live state (503 on paid tools) depends on that fix.

### 10.7 Open questions for OKX (Vincent)

- Fee unit at registration: plain-number **USDT**? (the one-pager showed USDG elsewhere)
- How to express a **per-minute metered** price vs. a flat per-call fee
- Settlement token on X Layer — USDT or USDG?
- **Testnet token contract address** for `eip155:1952`
- Any facilitator rate limits

---

## 11. Environment variables

### Video dubbing (dashboard-backend)
```bash
ELEVENLABS_API_KEY=                 # standard tier
HEYGEN_API_KEY=                     # lip-sync tier
STUDIO_VIDEO_DUB_CREDITS_PER_MIN=200
STUDIO_VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN=800
STUDIO_VIDEO_DUB_MAX_DURATION_SEC=600
STUDIO_VIDEO_DUB_MAX_UPLOAD_BYTES=209715200
STUDIO_VIDEO_DUB_MAX_LANGUAGES=3
STUDIO_VIDEO_DUB_LIPSYNC_FREE_MAX_SEC=10
UPLOAD_VIDEO_DUB_SOURCE_MAX_BYTES=209715200
```

### OKX (developer-api) — all unset today; surface stays dark
```bash
OKX_PAY_TO_ADDRESS=0x67f9b23fc6dcced1ba70e178bf04266df9307423
OKX_API_KEY=                        # dev portal
OKX_SECRET_KEY=
OKX_PASSPHRASE=
OKX_NETWORK=eip155:1952             # testnet default; prod = eip155:196
OKX_SYNC_SETTLE=1
OKX_ASSET_ADDRESS=                  # REQUIRED on testnet, omit on mainnet
OKX_ASSET_DECIMALS=6
OKX_ASSET_NAME=USDT
OKX_ASSET_VERSION=1
OKX_SYSTEM_API_KEY=voc_live_...     # funded system account
OKX_SELF_API_BASE=http://127.0.0.1:8031
# optional price overrides: OKX_PRICE_TTS, OKX_PRICE_STT, OKX_PRICE_VOICE_DESIGN,
# OKX_PRICE_VOICE_CLONE, OKX_PRICE_NOISE_REMOVER,
# OKX_PRICE_VIDEO_DUB_PER_MIN, OKX_PRICE_VIDEO_DUB_LIPSYNC_PER_MIN
```

### Webhooks
```bash
WEBHOOKS_ALLOW_HTTP=                # dev only; leave unset in prod (forces HTTPS)
```

---

## 12. How to run tests

```bash
cd developer-api    && python3 -m pytest tests/ -q     # expect 153 passed
cd dashboard-backend && python3 -m pytest tests/ -q    # expect 174 passed
cd app && npx tsc -p tsconfig.app.json --noEmit        # expect no output
```

Both Python suites run with **no OKX SDK and no OKX env vars** — that is the
production-today state, and the tests assert the surface fails closed in it.

---

## 13. Recommended next steps, in order

1. **Commit everything.** Highest priority — there is no remote copy. (§1.1)
2. **Rotate the GitHub token** in the git remote URL. (§1.3)
3. **Deploy + smoke-test** the product work: presign → PUT → dub → poll through the
   real public API, plus one live webhook delivery. Verify the homepage and Docs
   render.
4. **Decide `ops` → `master`** merge strategy.
5. **OKX, separately:** stand up a **Python 3.11+** environment, get dev-portal creds
   and the testnet token address from OKX, run a testnet dry run, then register and
   report the agent ID.

The product work (§4–§9) and the OKX work (§10) are **independent**. Shipping the
product does not require OKX, and the OKX surface stays dormant and harmless until
its env vars are set.

---

## 14. Quick reference — file map of new work

```
NEW:
  dashboard-backend/video_dub_service.py          pricing/validation/tiers
  dashboard-backend/routers/video_dub.py          dashboard dub routes
  dashboard-backend/jobs/workers/video_dub.py     dub worker
  dashboard-backend/job_callbacks.py              one-shot completion callbacks
  dashboard-backend/tests/test_video_dub_*.py     dub tests
  developer-api/app/api/routes/video_dub.py       public /v1/video/dub
  developer-api/app/api/routes/uploads.py         public /v1/uploads/presign
  developer-api/app/okx/                          OKX marketplace surface (7 files)
  developer-api/tests/test_okx_mcp.py             OKX tests
  app/src/pages/StudioVideoDub.tsx                Studio dubbing UI
  app/src/components/agents/DubVideoCard.tsx      library card
  app/src/components/agents/DubLibraryDialog.tsx  paginated library dialog
  app/src/components/ExpiryBadge.tsx              retention badge

NOTABLY MODIFIED:
  dashboard-backend/jobs/workers/dispatch.py      terminal-state callback hook
  dashboard-backend/jobs/state.py                 callback_secret scrubbing
  dashboard-backend/routers/uploads.py            video-dub-source upload kind
  developer-api/app/main.py                       OKX mount + OpenAPI tags
  app/src/contexts/AuthContext.tsx                global 401 → logout
  app/src/pages/Docs.tsx                          dub guide + API examples
  app/src/pages/Overview.tsx                      homepage dubbing section
  app/src/pages/Pricing.tsx                       dub pricing
  app/src/pages/History.tsx                       Library + collections
```
