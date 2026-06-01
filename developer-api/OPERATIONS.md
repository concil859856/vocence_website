# Developer API — Operations

Runbook for the people running the developer-api proxy. Code lives in
this directory; the proxy forwards to `dashboard-backend` over HTTP
using the trust-header model described below.

---

## Architecture (one-paragraph)

The developer-api is a thin FastAPI proxy that authenticates API-key
holders and forwards their requests to `dashboard-backend` over HTTP.
The forwarded request carries two service-to-service trust headers
(`X-Internal-Service-Token` + `X-Internal-User-Id`), which let the
backend's `require_auth` dependency treat the call as if it came from
the key's owner — without the user holding a Google JWT.

The trust-header model is the single most security-critical surface
in this codebase. **The two sides must agree on `INTERNAL_SERVICE_TOKEN`
or every authenticated request fails — and if the token leaks, an
attacker who can reach `dashboard-backend` directly can impersonate any
user.**

---

## Token rotation (`INTERNAL_SERVICE_TOKEN`)

### When to rotate

Rotate on a schedule **AND** on the events below:

* **Every 90 days** — calendar-driven, default rotation cadence.
* **Immediately** when:
  * staff with access to the secret leaves or changes roles,
  * the secret is suspected to have leaked (paste in a chat, accidental
    commit, exposed in a log, compromised host),
  * a security-affecting CVE forces a redeploy of either service.

### How to rotate (zero-downtime)

`dashboard-backend/auth_internal.py` accepts a single token via
`INTERNAL_SERVICE_TOKEN`. To rotate without a downtime window we run a
brief **overlap period** where the backend accepts both old and new:

1. **Pick the new token.** 32+ bytes from a CSPRNG:
   ```bash
   openssl rand -hex 32
   ```
   Store it in your secret manager alongside the current one — do NOT
   replace the current one yet.

2. **Backend accepts both.** Set `INTERNAL_SERVICE_TOKEN_NEXT` to the
   new value on `dashboard-backend`. The auth check needs to accept
   either `INTERNAL_SERVICE_TOKEN` OR `INTERNAL_SERVICE_TOKEN_NEXT`
   during the overlap window. Restart `dashboard-backend`. (If the
   backend doesn't currently support `_NEXT`, that's a one-time
   patch to `auth_internal.py` — wire it before scheduling rotations.)

3. **Developer-api switches to the new token.** Set
   `INTERNAL_SERVICE_TOKEN` to the new value on `developer-api`.
   Restart `developer-api`. Confirm one successful authenticated
   request end-to-end (e.g. `GET /v1/account`).

4. **Backend drops the old token.** Remove `INTERNAL_SERVICE_TOKEN`'s
   old value (promote `_NEXT` to the canonical slot, clear `_NEXT`).
   Restart `dashboard-backend`. Confirm one successful request.

5. **Audit.** Watch the dashboard's `auth_failures_total` metric for
   24 h. Any spike means a service is still trying to use the old
   value — investigate before assuming clean rollover.

### What can go wrong

* **Mismatched single-value rotation.** If you replace the secret on
  one side without the overlap step, every request in flight 502s
  until the other side restarts. Always use the overlap path above.
* **Token in a build artifact.** The secret is environment-only; it
  must NEVER appear in a Docker image layer, a public log, or
  `git log`. CI should grep for the token's prefix on every build.
* **Stale process holding the old value.** Some deploys leave the
  previous container running for a minute on graceful drain — confirm
  with `docker ps -a | grep dashboard-backend` and stop any leftovers.
* **Loadbalancer caching.** If a TLS-terminating proxy in front of
  `dashboard-backend` is configured with the token as a header (it
  shouldn't be — the token is on the request body / header from the
  dev-api, not from any external client), drain it too.

---

## Other secrets that need a rotation schedule

| Secret                           | Where                           | Cadence       | Notes                                                                                  |
| -------------------------------- | ------------------------------- | ------------- | -------------------------------------------------------------------------------------- |
| `INTERNAL_SERVICE_TOKEN`         | dev-api + dashboard-backend     | 90 days       | This document — overlap rollover.                                                       |
| `JWT_SECRET` (`HS256` HMAC)      | dashboard-backend               | 180 days      | Rotating invalidates ALL active website sessions — schedule for a low-traffic window.    |
| Developer API keys (`voc_live_…`) | dashboard-backend.developer_keys | user-initiated | Users self-rotate via `/v1/account/keys`. We do NOT force-rotate without a breach event. |
| Provider keys (OpenAI / Cerebras / Chutes / R2 / Stripe) | dashboard-backend `.env` | 180 days, OR vendor-driven | Tied to the upstream provider's policy. Stripe webhook secret rotates on its own surface. |
| `EMBED_TOKEN_PEPPER`             | dashboard-backend               | NEVER         | Rotating it invalidates every customer's deployed `<vocence-agent>` snippet — only on confirmed leak. |

---

## Trust-header invariants (do not violate)

* `X-Internal-Service-Token` and `X-Internal-User-Id` are minted ONLY
  by `developer-api/app/services/dashboard_proxy.py` after a successful
  API-key validation. No other code path generates them.
* Any public ingress in front of `dashboard-backend` MUST strip both
  headers on the public path. The trust check is "the network path
  required passing through dev-api" — if a public client can reach
  the backend directly with these headers, the model collapses.
* IP allowlist on the backend is the second layer: by default it
  accepts the trust headers only from loopback. Production overrides
  this with the dev-api host's private IP. Keep that list narrow.
* The token check uses `hmac.compare_digest` (constant-time). Do not
  swap it for a `==` comparison in a refactor.

---

## Incident response — suspected token leak

1. Treat as an active impersonation incident. Don't wait for the next
   scheduled rotation.
2. Generate a fresh value (`openssl rand -hex 32`).
3. Run the rotation steps above with **no overlap window** — set the
   new value on the backend first (drop the old immediately, accept
   only the new), then on dev-api. Yes, this drops in-flight requests
   for 30–60 s; that's correct.
4. Open the dashboard's audit log and filter to requests that hit
   sensitive endpoints (`/agents/*/runs`, `/agents/*/knowledge/*`,
   payment routes) in the last 30 days. Anything that doesn't match
   a known dev-api source IP is suspect.
5. File a postmortem covering: how the secret got out, what changed
   in the supply chain since the last rotation, and whether logging /
   build-artifact scanning would have caught it earlier.
