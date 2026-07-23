# Deployment & OKX Agent Setup Guide

**Last updated:** 2026-07-23
**Target machine:** `/deployment/vocence_website` (production)
**Source of truth:** branch `ops` on `origin`, currently at `91c1b3f`

Read alongside [`status.md`](status.md), which explains *what* was built and what
is / is not verified. This file is the *how to install and run it* companion.

There are two independent parts:

- **Part A — Deploy the current release.** Video dubbing, Library, auth fix,
  completion webhooks, public uploads presign. **Do this first.**
- **Part B — OKX agent.** The A2MCP marketplace listing. Optional, independent,
  and can wait. Nothing in Part A depends on it.

---

## 0. Current production state (verified 2026-07-23)

| Item | Value |
|---|---|
| Deploy path | `/deployment/vocence_website` |
| Deployed commit | `312c76b` — **behind** `origin/ops` (`91c1b3f`) |
| dashboard-backend | port **8083**, `venv_3.12` (**Python 3.12.13**), screen `backend` |
| developer-api | port **8031**, `venv` (**Python 3.10.12**), screen `api` |
| widget host | port **8087**, `developer-api/venv`, screen `widget` |
| Process manager | GNU `screen` (no systemd units) |
| `ffmpeg` / `ffprobe` | ✅ installed at `/usr/bin` — **required** by the dub worker |
| `python3.12` | ✅ available at `/usr/bin/python3.12` |
| `jsonschema` in developer-api venv | ❌ **missing — must install** |
| Dubbing env vars | ❌ none set |
| OKX env vars | ❌ none set |

> ⚠️ The live developer-api process reports its interpreter as
> `/usr/bin/python3.10 (deleted)` — the binary was replaced underneath the running
> process. It is running on borrowed time; the restart in Part A resolves it.

---

# Part A — Deploy the current release

## A1. Pull the code

```bash
cd /deployment/vocence_website
git fetch origin
git status                      # confirm nothing local would be clobbered
git checkout ops
git pull origin ops             # 312c76b -> 91c1b3f
```

If `git status` shows local modifications on the deploy box, **stop and inspect
them first** — they may be hand-applied hotfixes not present in the repo.

## A2. Install dependencies

**developer-api** — `jsonschema` is newly required (the OKX router validates tool
arguments with it). Without it the OKX routes silently fail to mount; the API
still boots, but `/okx/*` returns 404.

```bash
cd /deployment/vocence_website/developer-api
./venv/bin/pip install -r requirements.txt
./venv/bin/python -c "import jsonschema; print('ok', jsonschema.__version__)"
```

**dashboard-backend** — no new Python packages, but confirm ffprobe is reachable
by the service user (the worker shells out to it):

```bash
which ffprobe && ffprobe -version | head -1
```

## A3. Add the new environment variables

### A3.1 REQUIRED — `dashboard-backend/.env`

Video dubbing will not work without these. Each tier is independently gated:
if a key is missing, that tier reports "temporarily unavailable" (HTTP 503) and
the other tier keeps working.

```bash
# Video dubbing — upstream engines.
# Standard tier: translate + revoice, speaker's voice preserved.
ELEVENLABS_API_KEY=<your key>
# Lip-sync tier: the above, plus the mouth re-rendered to match.
HEYGEN_API_KEY=<your key>
```

> **Confidentiality:** these vendor names must never reach users. Keep them in
> env and logs only — never in UI copy, API responses, or error text. See
> `status.md` §1.2.

### A3.2 OPTIONAL — `dashboard-backend/.env`

All have working defaults; set them only to override. Listed with their defaults
so you know what you are getting if you skip them.

```bash
# Pricing (credits per minute, billed per second and per output language)
STUDIO_VIDEO_DUB_CREDITS_PER_MIN=200            # standard  (~$0.50/min)
STUDIO_VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN=800    # lip-sync  (~$2.00/min)

# Limits
STUDIO_VIDEO_DUB_MAX_DURATION_SEC=600           # 10 minutes
STUDIO_VIDEO_DUB_MAX_UPLOAD_BYTES=209715200     # 200 MB
STUDIO_VIDEO_DUB_MAX_LANGUAGES=3
STUDIO_VIDEO_DUB_LIPSYNC_MAX_BYTES=104857600    # 100 MB for lip-sync
STUDIO_VIDEO_DUB_LIPSYNC_MAX_DIM=2048           # longest side
UPLOAD_VIDEO_DUB_SOURCE_MAX_BYTES=209715200     # presign cap

# Free-plan gate: caps lip-sync length only. Standard dubbing is uncapped
# and limited purely by the user's credit balance. Set 0 to disable the cap.
STUDIO_VIDEO_DUB_LIPSYNC_FREE_MAX_SEC=10
```

### A3.3 Completion webhooks — leave UNSET in production

```bash
# WEBHOOKS_ALLOW_HTTP=true    # DEV ONLY. Leaving it unset forces HTTPS for all
                              # outbound callbacks. Do not set this in prod.
```

### A3.4 developer-api/.env

**No new variables are required for Part A.** The public dubbing and presign
routes proxy to the dashboard using the existing internal-service token.

## A4. Restart the services

Both services are launched as `python main.py` inside `screen` sessions.

```bash
# --- dashboard-backend (port 8083) ---
screen -S backend -X quit 2>/dev/null
screen -dmS backend bash -c 'cd /deployment/vocence_website/dashboard-backend && exec ./venv_3.12/bin/python main.py'

# --- developer-api (port 8031) ---
screen -S api -X quit 2>/dev/null
screen -dmS api bash -c 'cd /deployment/vocence_website/developer-api && exec ./venv/bin/python main.py'

screen -ls          # both sessions should be listed as Detached
```

Attach with `screen -r backend` (detach again with `Ctrl-A` then `D`) to watch
startup logs.

> The `api` session was previously started interactively, so the exact original
> command line was not recoverable. The command above matches the observed
> running process (`python main.py`, cwd `developer-api`). **Verify the service
> answers on 8031 after restart** before considering the deploy done.

## A5. Frontend

`app/` deploys via Vercel from the repo. Once `ops` is merged/deployed, confirm:

- Homepage shows the new **"New — Video Dubbing"** section
- **Studio → Video Dubbing** loads, lists languages, and shows a live cost estimate
- **Library** groups dub results into per-source collections
- **Docs → Video Dubbing** shows the curl/Python API example

## A6. Verify the deployment

```bash
# Services alive
curl -s localhost:8083/health  || echo "dashboard DOWN"
curl -s localhost:8031/health  || echo "developer-api DOWN"

# Dubbing configured — both tiers should report available
curl -s localhost:8083/api/dashboard/video-dub/languages | head -c 400

# Public presign route exists (401 = present + auth-gated; 404 = NOT deployed)
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8031/v1/uploads/presign
```

**Then do a real end-to-end dub** — this path has never been exercised against
live infrastructure (`status.md` §2):

1. Studio → Video Dubbing → upload a short clip (10–20 s)
2. Pick one language, leave lip-sync **off**
3. Confirm credits are charged, the job completes, and the result plays in the Library
4. Repeat with lip-sync **on** using a ≤10 s clip

---

# Part B — OKX agent setup

**This is optional and independent of Part A.** Until its env vars are set, the
OKX surface is dark: paid tools return 503 and the payment gate never attaches.

## B1. Good news on the Python requirement

The OKX x402 SDK requires **Python ≥ 3.11**. The OKX code lives in
**developer-api**, which currently runs **3.10.12** — so it cannot be installed
there as-is.

**This is not a blocker.** `/usr/bin/python3.12` is already on the machine, and
`dashboard-backend` already runs from a `venv_3.12`. Follow the same pattern for
developer-api.

## B2. What to install

### B2.1 A Python 3.12 venv for developer-api

```bash
cd /deployment/vocence_website/developer-api

# Build alongside the existing venv so you can roll back instantly
/usr/bin/python3.12 -m venv venv_3.12
./venv_3.12/bin/pip install --upgrade pip
./venv_3.12/bin/pip install -r requirements.txt
./venv_3.12/bin/python --version        # expect Python 3.12.x
```

### B2.2 The OKX x402 seller SDK

**The `[fastapi,evm]` extras are required** — without them the middleware cannot
build. Note the install name differs from the import name (`x402`).

```bash
./venv_3.12/bin/pip install "okxweb3-app-x402[fastapi,evm]"

# Verify — all of these must import cleanly
./venv_3.12/bin/python - <<'PY'
from x402 import x402ResourceServer
from x402.http.middleware.fastapi import payment_middleware
from x402.http.types import PaymentOption, RouteConfig
from x402.mechanisms.evm.exact.server import ExactEvmScheme
from x402.http import OKXFacilitatorClient, OKXAuthConfig, OKXFacilitatorConfig
print("x402 SDK OK")
PY
```

Then uncomment the SDK line in `requirements.txt` on this deployment only:
```
okxweb3-app-x402[fastapi,evm]>=0.1.1
```

### B2.3 The Onchain OS CLI

Already installed: **`onchainos 4.3.0`** at `/root/.local/bin/onchainos`, and the
Agentic Wallet is already logged in (`space@vocence.ai`). Verify:

```bash
onchainos --version
onchainos agent get-my-agents      # currently {"list":[],"total":0}
```

Nothing to install here unless the CLI is missing on the target machine.

### B2.4 System dependency check

`ffmpeg`/`ffprobe` are already installed and are required for the dub tool —
which the OKX marketplace also exposes. No extra system packages are needed.

## B3. Environment variables — `developer-api/.env`

```bash
# --- Settlement ---
OKX_PAY_TO_ADDRESS=0x67f9b23fc6dcced1ba70e178bf04266df9307423
OKX_API_KEY=<from OKX developer portal>
OKX_SECRET_KEY=<from OKX developer portal>
OKX_PASSPHRASE=<from OKX developer portal>
OKX_NETWORK=eip155:1952          # X Layer TESTNET. Production: eip155:196
OKX_SYNC_SETTLE=1                # block the response until settlement confirms

# --- Settlement token ---
# The SDK knows X Layer MAINNET's default (USD₮0) so you may omit these there.
# TESTNET has NO default — omit these on testnet and every priced call 500s.
OKX_ASSET_ADDRESS=<testnet token contract — ASK OKX>
OKX_ASSET_DECIMALS=6
OKX_ASSET_NAME=USDT
OKX_ASSET_VERSION=1

# --- Fulfillment ---
# A voc_live_ key for a dedicated system account. Tool calls are fulfilled by
# calling our own /v1 API with this key, so KEEP IT FUNDED WITH CREDITS or the
# generations it fronts will fail after the buyer has already paid on-chain.
OKX_SYSTEM_API_KEY=voc_live_...
OKX_SELF_API_BASE=http://127.0.0.1:8031

# --- Optional price overrides (defaults shown) ---
# OKX_PRICE_TTS=$0.02
# OKX_PRICE_STT=$0.02
# OKX_PRICE_VOICE_DESIGN=$0.10
# OKX_PRICE_VOICE_CLONE=$0.05
# OKX_PRICE_NOISE_REMOVER=$0.02
# OKX_PRICE_VIDEO_DUB_PER_MIN=$0.60
# OKX_PRICE_VIDEO_DUB_LIPSYNC_PER_MIN=$2.40
```

## B4. Switch developer-api to the 3.12 venv

```bash
screen -S api -X quit
screen -dmS api bash -c 'cd /deployment/vocence_website/developer-api && exec ./venv_3.12/bin/python main.py'
screen -r api        # watch for: "[okx] x402 payment gate active on eip155:1952 → 0x67f9b23f… (6 tools)"
```

Rollback is instant — relaunch with `./venv/bin/python` instead.

## B5. Verify

```bash
# Manifest is public and always available
curl -s localhost:8031/okx/manifest | head -c 600
# Expect "payments_ready": true once fully configured

# MCP tools/list
curl -s -X POST localhost:8031/okx/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400

# A paid tool with no payment must return 402 (a challenge), never 200
curl -s -o /dev/null -w "%{http_code}\n" -X POST localhost:8031/okx/tools/vocence_text_to_speech \
  -H 'Content-Type: application/json' -d '{"text":"hi"}'
```

**Expected codes:** `402` = working (payment demanded). `503` = not configured
(fails closed — safe). `200` = **BUG, stop** — a tool served for free.

## B6. Register the agent (produces the agent ID)

**Only after B5 passes on testnet, and after the endpoint is publicly reachable
at `https://api.vocence.ai/okx/...`** — OKX runs QA against the live URL.

```bash
onchainos agent pre-check --role asp        # consent + uniqueness
onchainos agent create --role asp           # returns newAgentId
onchainos agent get-my-agents               # confirm it is listed
```

`developer-api/app/okx/services.json` holds the prepared registration payload for
all 6 tools.

> ⚠️ **There is no agent ID today** — `get-my-agents` returns an empty list. The ID
> is minted by `agent create`. Do **not** send OKX the UUID from `wallets.json`
> (`f10401e9-…`); that is the **wallet accountId**, not an agent ID. See
> `status.md` §10.5.

## B7. Go live on mainnet

```bash
OKX_NETWORK=eip155:196      # X Layer mainnet
# OKX_ASSET_ADDRESS may be omitted — the SDK defaults to USD₮0 here
```
Restart, re-run B5, then send OKX the agent ID for their human review.

## B8. Outstanding questions for OKX

1. Testnet settlement-token contract address for `eip155:1952` (→ `OKX_ASSET_ADDRESS`)
2. Fee unit at registration — plain-number USDT?
3. How to express a per-minute **metered** price vs. a flat per-call fee
4. Settlement token on X Layer mainnet — USDT or USDG?
5. Where to send the WL email (wallet email is `space@vocence.ai`)

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Dubbing 503 "temporarily unavailable" | Tier's API key missing | Set `ELEVENLABS_API_KEY` / `HEYGEN_API_KEY` (A3.1) |
| `/okx/*` returns 404 | `jsonschema` missing → router failed to mount | `pip install -r requirements.txt` (A2) |
| `/v1/uploads/presign` 404 | Old code still running | Pull + restart (A1, A4) |
| Job fails right after charging | `ffprobe` not on PATH for the service | Install ffmpeg; credits auto-refund on failure |
| OKX paid tool returns 503 | Not fully configured (fails closed — safe) | Complete B3 |
| OKX paid tool returns 200 with no payment | **Payment gate not attached** | Stop. Check startup logs for the `[okx]` line |
| Startup: "no default settlement asset" warning | Testnet without `OKX_ASSET_ADDRESS` | Set it (B3) |
| `pip install okxweb3-app-x402` fails | Python < 3.11 | Use the 3.12 venv (B2.1) |
| Callback never arrives | Non-public or non-HTTPS URL | Must be public HTTPS; poll endpoint is the fallback |

## Rollback

```bash
cd /deployment/vocence_website
git checkout 312c76b            # previous deployed commit
screen -S backend -X quit; screen -dmS backend bash -c 'cd /deployment/vocence_website/dashboard-backend && exec ./venv_3.12/bin/python main.py'
screen -S api -X quit;     screen -dmS api     bash -c 'cd /deployment/vocence_website/developer-api && exec ./venv/bin/python main.py'
```

Dubbing env vars are additive and harmless to leave in place during a rollback —
older code simply ignores them.
