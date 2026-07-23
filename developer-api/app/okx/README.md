# Vocence on the OKX AI Marketplace (A2MCP ASP)

This module exposes six Vocence voice tools to the OKX AI Marketplace as an
**A2MCP ASP** (Agentic Service Provider). Buyer agents discover the tools, pay
per call in stablecoin via OKX's **x402** payment protocol on **X Layer**, and
the payment settles to our **Agentic Wallet**. Fulfillment reuses Vocence's own
`/v1` API with a system key — no new generation logic.

It runs **in the existing developer-api FastAPI app** (`api.vocence.ai`); no
separate service.

## Tools

| MCP tool | /v1 endpoint | Pricing (default, env-overridable) |
|---|---|---|
| `vocence_text_to_speech` | `/v1/tts/speak` | `$0.02` / call |
| `vocence_speech_to_text` | `/v1/stt/transcribe` | `$0.02` / call |
| `vocence_voice_design` | `/v1/voice/design/preview` | `$0.10` / call |
| `vocence_voice_clone` | `/v1/voice/clone` | `$0.05` / call |
| `vocence_noise_remover` | `/v1/audio/noise-remover` | `$0.02` / call |
| `vocence_video_dub` | `/v1/video/dub` | `$0.60`/min (`$2.40`/min lip-sync), per language |

Prices are USD strings; the x402 SDK settles them as an X Layer stablecoin.
The dubbing tool is priced **dynamically per request**: the gate reads the
request body and charges rate × ceil(minutes) × languages (verified against
the real SDK: 10 min × 2 languages × lip-sync → a $48.00 challenge). The
downstream worker re-probes the source with ffprobe and refuses under-quoted
jobs, so lying about `duration_sec` buys a rejected job, not a discount.

Dubbing fulfillment bridges the URL-to-object gap: the buyer sends a
`video_url`; we download it (200 MB cap), presign a `video-dub-source` slot
via our own `/v1/uploads/presign`, PUT the bytes, then submit the job. The
paid call returns a `job_id` plus a **free** polling endpoint.

## Endpoints

- `GET  /okx/manifest` — discovery: tools, JSON schemas, prices, payTo. Always live.
- `POST /okx/tools/{name}` — execute a tool (x402-priced per call).
- `GET  /okx/tools/vocence_video_dub/jobs/{job_id}` — poll a paid dub job (free).
- `POST /okx/mcp` — MCP JSON-RPC (`tools/list`, `tools/call`).

## Configuration (env)

Nothing here is set by default — the surface stays dark until wired.

```bash
# Settlement — REQUIRED for paid calls
OKX_PAY_TO_ADDRESS=0x...            # the Agentic Wallet EVM address that receives funds
OKX_API_KEY=...                     # OKX Developer Portal
OKX_SECRET_KEY=...
OKX_PASSPHRASE=...
OKX_NETWORK=eip155:1952             # X Layer TESTNET (default). Prod: eip155:196
OKX_SYNC_SETTLE=1                   # block response until settled

# Settlement token. MAINNET needs nothing: the SDK's default for eip155:196
# is USD₮0 (0x779ded0c9e1022225f8e0630b35a9b54be713736, 6 dp). TESTNET has no
# SDK default — set the test-token contract or every priced call 500s:
OKX_ASSET_ADDRESS=                  # e.g. the X Layer testnet USDT contract
OKX_ASSET_DECIMALS=6
OKX_ASSET_NAME=USDT
OKX_ASSET_VERSION=1

# Fulfillment — REQUIRED
OKX_SYSTEM_API_KEY=voc_live_...     # a funded system account's key; keep it topped up
OKX_SELF_API_BASE=http://127.0.0.1:8031   # our own /v1 API base

# Pricing — OPTIONAL overrides
OKX_PRICE_TTS=$0.02
OKX_PRICE_STT=$0.02
OKX_PRICE_VOICE_DESIGN=$0.10
OKX_PRICE_VOICE_CLONE=$0.05
OKX_PRICE_NOISE_REMOVER=$0.02
OKX_PRICE_VIDEO_DUB_PER_MIN=$0.60
OKX_PRICE_VIDEO_DUB_LIPSYNC_PER_MIN=$2.40
```

And install the SDK on the listed deployment: `pip install "okxweb3-app-x402[fastapi,evm]"`.

## Fail-closed behaviour

- No wallet / system key / x402 package → paid tools return **503** (never free).
- Manifest is always served, so the listing can be reviewed before go-live.
- A payment-layer import/config error is caught and logged; it never blocks API boot.

## Go-live runbook

1. **Wallet** (Koyuki): create the OKX Agentic Wallet, save the seed, note the EVM address.
2. **OKX creds**: get API key/secret/passphrase from the OKX Developer Portal.
3. **System account**: mint a `voc_live_` key for a dedicated account; keep it funded with credits.
4. **Testnet**: set the env above with `OKX_NETWORK=eip155:1952`, `pip install "okxweb3-app-x402[fastapi,evm]"`, restart. Fund a test buyer from the X Layer testnet faucet and exercise a tool end-to-end.
5. **Register**: register as an **A2MCP ASP** on OKX AI; submit the manifest (`GET /okx/manifest`), per-call pricing, and `payTo`. Email OKX the Agentic Wallet's registered email for the WL step.
6. **Go live**: flip `OKX_NETWORK=eip155:196`, restart.

## Open items to confirm with OKX (Vincent)

The `mcp-marketplace` docs page 404'd and the onboarding one-pager is an
un-scrapeable SPA, so these are **unverified** and should be confirmed before
final listing:

- The A2MCP **listing manifest schema** and the whitelist form URL.
- The **testnet** settlement-token contract address for `eip155:1952`
  (→ `OKX_ASSET_ADDRESS`). Mainnet is answered by the SDK itself: the
  default asset for `eip155:196` is **USD₮0**, and the challenge travels in a
  base64 `payment-required` header (both verified against `x402` 2.16.0).
- Any rate limits on the facilitator.
