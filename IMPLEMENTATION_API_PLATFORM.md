# Vocence API Platform Implementation (Current Scope)

This document defines the production implementation for:

- Website backend traffic on `backend.vocence.ai`
- Developer API traffic on `api.vocence.ai`
- TTS + STT + voice clone API product (voice design / chat not in this phase)
- Working billing, API keys, usage metering, and docs

This is intentionally focused on **current implementation only**. No future features are included.

---

## 1) Domains, Routing, and Service Split

### 1.1 Public domains

- `https://www.vocence.ai` -> website frontend
- `https://backend.vocence.ai` -> website backend (`dashboard-backend`)
- `https://api.vocence.ai` -> developer API service (new API app)

### 1.2 Why split domains

- Website app keeps existing auth/account/admin/payment UX on `backend.vocence.ai`
- Developer API is isolated on `api.vocence.ai` with API-key auth and versioned endpoints
- Clean separation for rate-limits, docs, keys, and monitoring

### 1.3 Nginx requirements

Configure 2 server blocks:

- `backend.vocence.ai` -> proxy to website backend process (current port)
- `api.vocence.ai` -> proxy to new API service port

TLS required on both.

---

## 2) Services to Run

## 2.1 Website backend (existing)

Codebase: `vocence_website/dashboard-backend`

Responsibilities:

- user auth/login
- account summary and credits
- pricing plans
- Stripe + NOWPayments checkout session creation
- payment webhooks
- admin usage pages
- studio web UI integration

Runs behind: `https://backend.vocence.ai`

## 2.2 Developer API service (new)

Codebase: create inside `vocence_website` (recommended folder: `developer-api/`)

Responsibilities:

- API key auth
- `POST /v1/tts/generate`
- `POST /v1/stt/transcribe`
- `POST /v1/voice/clone` (reference audio + target text; STT on reference then clone synth)
- credits validation and deduction
- request logging/metering
- provider selection (env-configured chutes)
- OpenAPI + docs endpoint

Runs behind: `https://api.vocence.ai`

---

## 3) Data Model (Current Implementation)

Use SQLite (same website DB) for now.

Required tables:

## 3.1 `api_keys`

- `id` TEXT PK
- `user_id` TEXT NOT NULL
- `name` TEXT NOT NULL
- `key_prefix` TEXT NOT NULL
- `key_hash` TEXT NOT NULL
- `last_used_at` TEXT NULL
- `revoked_at` TEXT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

Rules:

- Store hash only (never store full plaintext key)
- Show plaintext key only once at creation

## 3.2 `api_request_logs`

- `id` TEXT PK
- `user_id` TEXT NOT NULL
- `api_key_id` TEXT NOT NULL
- `endpoint` TEXT NOT NULL (e.g. `/v1/tts/generate`)
- `provider` TEXT NULL (selected chute/provider name)
- `status` TEXT NOT NULL (`success`, `error`, `rejected`)
- `http_status` INTEGER NOT NULL
- `credits_used` INTEGER NOT NULL DEFAULT 0
- `latency_ms` INTEGER NULL
- `request_chars` INTEGER NULL
- `error_code` TEXT NULL
- `error_message` TEXT NULL
- `created_at` TEXT NOT NULL

## 3.3 Reuse existing payment/credit tables

Already present in website backend:

- `payment_sessions`
- `payments`
- `credit_transactions`
- `auth_users`

No duplicate ledger table should be introduced.

---

## 4) Authentication and Authorization

## 4.1 Website auth (unchanged)

- JWT bearer for website users on backend routes

## 4.2 Developer API auth (new)

For `api.vocence.ai` endpoints:

- Header: `Authorization: Bearer <voc_live_...>`
- Parse key -> lookup by prefix -> verify hash
- Reject revoked keys
- Attach `user_id` + `api_key_id` to request context

Error responses:

- 401 missing/invalid key
- 403 revoked key

---

## 5) API Key Management Endpoints (backend.vocence.ai)

Expose key management under website backend so logged-in users can manage keys in account UI.

## 5.1 Create key

- `POST /api/developer/keys`
- Auth: JWT user
- Request:
  - `name`
- Response:
  - `id`, `name`, `key_prefix`, `created_at`
  - `plain_key` (returned once)

## 5.2 List keys

- `GET /api/developer/keys`
- Auth: JWT user
- Response list (never includes full key)

## 5.3 Revoke key

- `POST /api/developer/keys/{id}/revoke`
- Auth: JWT user

---

## 6) API Endpoints (api.vocence.ai)

## 6.1 TTS endpoint

- `POST /v1/tts/generate`

Request body:

- `text` (required)
- `style_instruction` (optional)
- `model` (optional alias if needed; for now provider selection is automatic)

Response:

- `request_id`
- `audio_url`
- `provider`
- `credits_remaining`
- `latency_ms`

## 6.2 TTS processing sequence

1. Authenticate API key
2. Validate payload
3. Check user credits (must be >= TTS cost)
4. Select provider from configured list
5. Call chute `/speak`
6. Store audio in Hippius
7. Deduct credits + write credit transaction
8. Write `api_request_logs`
9. Return result

## 6.3 STT endpoint

- `POST /v1/stt/transcribe`

Request body:

- `audio_b64` (required, base64 audio bytes)
- `language` (optional hint language code)

Response:

- `request_id`
- `text`
- `language` (optional)
- `provider`
- `credits_remaining`
- `latency_ms`
- `credits_used`

Atomicity:

- Credit deduction and transaction logging must happen in one DB transaction.

---

## 7) Provider Configuration (Current, Config-Driven)

Use env-driven provider list so adding/removing providers requires no code changes.

Variables (on `developer-api` only; **not** `STUDIO_MODEL_*`, which is Studio/frontend):

- `API_TTS_PROVIDER_1_NAME`
- `API_TTS_PROVIDER_1_CHUTE_SLUG`
- `API_TTS_PROVIDER_1_ENABLED=true|false`
- `API_TTS_PROVIDER_1_WEIGHT=100` (relative weight for load balancing)

Repeat with `_2_`, `_3_`, etc.

If **no** `API_TTS_PROVIDER_*_NAME` keys exist, legacy `TTS_PROVIDER_<N>_*` is read instead.

Load balancing: when multiple enabled rows match the requested model (or no `model` is sent), one chute is chosen per request using **weighted random** (`WEIGHT`). There is no round-robin or health-check failover yet.

Current rollout:

- Configure one or more API chutes; weights control traffic share across chutes that share the same `NAME`.

---

## 8) Billing and Payments (Current)

## 8.1 Pricing plans

Plan rows in `pricing_plans` (SQLite website DB):

- **Stripe (card):** `normal` — `$12` / `4000` credits; `premium` — `$24` / `10000` credits (`price_usd`, `credits_included`).
- **Crypto (NOWPayments):** same codes use **`crypto_price_usd` / `crypto_credits_included`** when set — currently `normal` `$20` / `7000`, `premium` `$40` / `16000`. Checkout uses these for invoice amount and credits; Stripe still uses list `price_usd` / `credits_included`.
- Developer API billing: `$10 per 1M characters` (pay-as-you-go, prepaid balance)

Credits are granted by successful payment events and tracked in `credit_transactions`.

**Studio credit costs** (`routers/studio.py`, overridable via env `STUDIO_*_CREDITS_COST`):

- TTS: **25** (`STUDIO_TTS_CREDITS_COST`)
- STT: **20** (`STUDIO_STT_CREDITS_COST`)
- Voice clone (upload/record): **50** (`STUDIO_CLONE_CREDITS_COST`)
- Voice design preview (creation; A/B samples): **120** (`STUDIO_VOICE_DESIGN_PREVIEW_CREDITS`); saving the voice has no extra charge
- Generate with **My voice** (designed): **25** (`STUDIO_VOICE_DESIGN_SPEAK_CREDITS`)

**Signup bonus:** **300** credits (`SIGNUP_CREDITS` in `routers/auth.py`).

## 8.2 Stripe (existing, keep unchanged)

- Existing checkout + webhook remains active.
- **Checkout mode:** `payment` for Normal/Premium credit packs (one-time `STRIPE_PRICE_ID_*`). Only if `pricing_plans.billing_type` is **`subscription`** does Checkout use **`subscription`** mode (recurring Prices + `invoice.paid` for credits).
- **Webhook 400:** almost always **`STRIPE_WEBHOOK_SECRET`** not matching the webhook endpoint (or test/live mismatch with `STRIPE_SECRET_KEY`). Check server logs for the warning line Stripe verification emits.

## 8.3 NOWPayments crypto (implemented in website backend)

- **Pay currency choice:** `GET /api/payments/nowpayments/pay-currency-options?planCode=…` returns tickers for the pricing UI. Checkout body may include **`payCurrency`** (must be in that list). If unset, the env default (`NOWPAYMENTS_PAY_CURRENCY_*`) is used. **`NOWPAYMENTS_SELECTABLE_PAY_CURRENCIES`** overrides the offered list; when unset, options match the pre-validation set (e.g. TRC + ERC USDT). Invoice **`price_amount`** is resolved for the **chosen** ticker only.
- Checkout session creates NOWPayments invoice URL
- **Pre-flight:** before `POST /invoice`, backend runs **`GET /min-amount`** + **`GET /estimate`** for **`NOWPAYMENTS_VALIDATE_EXTRA_CURRENCIES`** (default: **usdttrc20** and **usdterc20**) so switching coin on the hosted page doesn’t fail after redirect. Checkout **400** if list+buffer USD is still below NP minimums.
- **Invoice USD:** By default **`NOWPAYMENTS_USE_DYNAMIC_INVOICE_USD`** (true) iterates NP **`/min-amount`** + **`/estimate`** so **`price_amount`** is the **smallest USD ≥ crypto list price** (`crypto_price_usd` when set, else `price_usd`) that clears validated pay→payout pairs (often much less than a flat +$6). Optional **`NOWPAYMENTS_INVOICE_BUFFER_USD`** adds extra USD on top; **`NOWPAYMENTS_LEGACY_FLAT_BUFFER_USD`** applies only when dynamic is disabled. **Credits** for crypto use **`crypto_credits_included`** when set, else **`credits_included`**; stored **`amount_usd`** is the charged invoice USD.
- **Fees:** **`NOWPAYMENTS_IS_FEE_PAID_BY_USER`** defaults to **true**.
- **Fixed rate:** **`NOWPAYMENTS_IS_FIXED_RATE`** defaults to **false** (often reduces “currency unavailable, try in 2h” on TRX when NP can’t lock a fixed quote).
- **Payout:** **`NOWPAYMENTS_PAYOUT_CURRENCY`** must match your **main** payout wallet ticker in the NP dashboard.
- Webhook endpoint:
  - `POST /api/payments/nowpayments/webhook`
  - Verify `x-nowpayments-sig` with `NOWPAYMENTS_IPN_SECRET`
  - Match by `order_id` / `payment_id`
  - Apply credits once on success statuses

Webhook URL to set in NOWPayments:

- `https://backend.vocence.ai/api/payments/nowpayments/webhook`

---

## 9) Required Environment Variables

## 9.1 Website backend (`dashboard-backend/.env`)

- Existing auth/db/stripe vars
- NOWPayments vars:
  - `NOWPAYMENTS_API_KEY`
  - `NOWPAYMENTS_IPN_SECRET`
  - `NOWPAYMENTS_IPN_CALLBACK_URL=https://backend.vocence.ai/api/payments/nowpayments/webhook`
  - `NOWPAYMENTS_SUCCESS_URL=https://www.vocence.ai/account?tab=credits&checkout=success`
  - `NOWPAYMENTS_CANCEL_URL=https://www.vocence.ai/pricing?checkout=cancel`
  - `NOWPAYMENTS_PAY_CURRENCY_DEFAULT=usdttrc20`
  - `NOWPAYMENTS_PAY_CURRENCY_NORMAL=usdttrc20`
  - `NOWPAYMENTS_PAY_CURRENCY_PREMIUM=usdttrc20` (match main payout network when possible)
  - `NOWPAYMENTS_SUCCESS_STATUSES=finished,confirmed`
  - Optional: `NOWPAYMENTS_PAYOUT_CURRENCY`, `NOWPAYMENTS_IS_FEE_PAID_BY_USER`, `NOWPAYMENTS_IS_FIXED_RATE`, `NOWPAYMENTS_INVOICE_OMIT_PAY_CURRENCY`, `NOWPAYMENTS_SKIP_MIN_AMOUNT_CHECK` (see `.env.example`)

## 9.2 Developer API service (`developer-api/.env`)

- DB connection or sqlite path
- Hippius credentials
- Chutes key
- TTS provider config (`API_TTS_PROVIDER_<N>_*`, or legacy `TTS_PROVIDER_<N>_*`)
- API key signing/hash config if needed
- API rate limiting:
  - `API_RATE_LIMIT_REQUESTS_PER_MINUTE=4`
  - `API_RATE_LIMIT_ENABLED=true`

---

## 10) Developer Documentation (Current)

Publish on `api.vocence.ai`:

- `/docs` (Swagger UI)
- `/openapi.json`

Also add a website docs page with:

- Quickstart
- API key creation flow
- `POST /v1/tts/generate` examples (curl, JS, Python)
- Error codes
- Pricing/credits explanation

No speculative endpoints in docs. Only implemented endpoints.

---

## 11) Account UI Changes (Current)

In website frontend account/developer section:

- API keys tab:
  - create key
  - list keys
  - revoke key
- Usage tab:
  - request count
  - credits consumed
  - recent request logs

These views must consume real backend endpoints only.

---

## 12) Operational Requirements

## 12.1 Logging

Both services should log:

- request id
- user id / api_key id (when present)
- selected provider
- latency
- result status

## 12.2 Health endpoints

- `GET /health` on both services
- Nginx upstream health-check compatible

## 12.3 Rate limiting

- Enforce per-API-key request limits in the API service.
- Initial default: `4 requests per minute per API key`.
- Value is configurable via `API_RATE_LIMIT_REQUESTS_PER_MINUTE`.

## 12.4 Idempotency

Payment webhooks and credit application must remain idempotent.

---

## 13) Launch Checklist (Current Scope)

1. DNS:
   - `backend.vocence.ai` and `api.vocence.ai` resolve correctly
2. TLS active on both domains
3. Website backend env complete + restarted
4. NOWPayments webhook configured to backend URL
5. Developer API service deployed and reachable
6. API key endpoints working in account UI
7. `POST /v1/tts/generate` works with API key and deducts credits
8. Stripe checkout still works
9. NOWPayments checkout + webhook crediting verified
10. Docs accessible on `api.vocence.ai/docs`

---

## 14) Acceptance Criteria

Project is considered complete for current scope when:

- User can buy credits by card or crypto and receive credits automatically
- User can generate/revoke API keys from account
- Developer can call `api.vocence.ai/v1/tts/generate` with API key and get audio
- Credits and usage logs update correctly
- Docs reflect exactly implemented endpoints and payloads

