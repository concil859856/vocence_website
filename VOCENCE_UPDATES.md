# Recommended Updates for Vocence (Subnet) Repository

This file lists changes that would improve the **vocence** (Bittensor subnet) repository from the perspective of the **vocence_website** dashboard and operator visibility. Implement these in the **vocence** repo as needed; the website dashboard backend is implemented to work **without** these changes (by reading directly from the owner PostgreSQL database).

---

## 1. Optional: Public read-only dashboard API

**Current:** The website dashboard backend in `vocence_website/dashboard-backend` connects **directly to the same PostgreSQL** as the Vocence API and reads `registered_miners`, `performance_metrics`, `validator_evaluations`, `validator_registry`. No change to Vocence is required for the dashboard to work.

**Recommendation:** If you prefer the website **not** to have DB credentials, add a **read-only dashboard API** to the Vocence FastAPI service (e.g. under `/dashboard` or `/public`) that:

- Does **not** require validator signature.
- Returns the same data the website needs: overview counts, miners list with aggregated metrics, validators list, activity buckets. Optionally protect with an API key or IP allowlist.

Then the website dashboard backend can call this HTTP API instead of connecting to Postgres. This keeps DB access inside the Vocence deployment only.

---

## 2. Expose last metagraph sync time in status

**Current:** `vocence/gateway/http/service/endpoints/status.py` has `_last_metagraph_sync` in memory and exposes it in `/health`. The dashboard backend does not call the Vocence API; it derives "last activity" from `last_validated_at` (registered_miners) and `evaluated_at` (validator_evaluations).

**Recommendation:** If you want the dashboard to show "last metagraph sync" explicitly, either:

- Persist `last_metagraph_sync` (e.g. in a small `service_state` table or Redis) so it survives restarts and can be read by a dashboard API, or
- Document that the dashboard’s "last activity" is a proxy for freshness (last validation or last evaluation).

---

## 3. Align API path names (client vs server)

**Current:** In the **vocence** repo, the adapter `vocence/adapters/api.py` calls:

- `GET /miners/valid`
- `GET /miners/all`
- `GET /blacklist/miners`

But the FastAPI app mounts routers as:

- `GET /participants/valid`, `GET /participants/all`
- `GET /blocklist/participants`

So the validator client would get 404s when calling the API unless there are redirects or aliases.

**Recommendation:** Either:

- Add route aliases in the Vocence FastAPI app (e.g. mount the same participants router also at `/miners` and blocklist at `/blacklist/miners`), or
- Change the client in `vocence/adapters/api.py` to use `/participants/valid`, `/participants/all`, and `/blocklist/participants`.

---

## 4. Ranking calculator metadata key

**Current:** In `vocence/ranking/calculator.py`, scores are computed from S3 metadata using `metadata.get("miners", {})`. In `vocence/pipeline/generation.py`, uploaded metadata uses the key `"participants"` (with nested `evaluation.generated_wins`).

**Recommendation:** Update `ranking/calculator.py` to read from `metadata.get("participants", {})` and to use the nested structure (e.g. `participant_data.get("evaluation", {}).get("generated_wins", False)` and optionally `participant_data.get("chute_slug")` for slug). This keeps S3-based score aggregation consistent when the API is unavailable.

---

## 5. Subnet ID and block in dashboard (optional)

**Current:** The website dashboard does not show live **block number** or **metagraph** (stake, emission, incentive) because the dashboard backend only reads from Postgres. Block and metagraph come from the chain.

**Recommendation:** If you want the dashboard to show block height and/or stake/emission:

- **Option A:** In the **vocence** API, add a read-only endpoint (e.g. `GET /dashboard/chain`) that returns current block and, if feasible, a cached or on-demand metagraph summary (e.g. stake, incentive per UID). The Vocence service already has Bittensor/subtensor in process; it could periodically fetch metagraph and expose a summary.
- **Option B:** Run a small **metagraph sync job** (e.g. in the website backend or a cron) that uses the Bittensor SDK to fetch metagraph, then write block and key metrics to a table or cache that the dashboard backend reads. This avoids changing the Vocence codebase but requires running Bittensor (or a RPC client) in the website’s environment.

---

## Summary

| Item | Priority | Purpose |
|------|----------|---------|
| Public dashboard API (optional) | Low | Avoid giving the website DB credentials; call Vocence HTTP instead. |
| Last metagraph sync in status/DB | Low | Clearer “last sync” in dashboard. |
| Align /miners vs /participants paths | High | Validator client can call the API without 404. |
| Ranking calculator use "participants" | High | S3 fallback scoring works with current generation metadata. |
| Block/metagraph in dashboard | Optional | Richer dashboard (block, stake, emission). |

The **vocence_website** dashboard backend and frontend are implemented to work with the **current** Vocence setup (direct DB read). Applying the above in the **vocence** repo will improve consistency and optional features.
