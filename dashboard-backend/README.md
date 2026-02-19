# Vocence Dashboard Backend (FastAPI)

Single **Python FastAPI** backend for the Vocence website: **dashboard** (owner DB, blog, metrics) and **auth** (login, users, credits, history). Reads from the owner's Vocence PostgreSQL for dashboard data; uses local SQLite for auth and website-only data.

## Requirements

- Python 3.11+
- Access to the Vocence owner database (PostgreSQL) — same `registered_miners`, `performance_metrics`, `validator_evaluations`, `validator_registry` tables used by the Vocence service.

## Setup

1. **Create a virtualenv (recommended)**
   ```bash
   cd dashboard-backend
   python -m venv .venv
   source .venv/bin/activate   # Windows: .venv\Scripts\activate
   ```

2. **Install dependencies**
   ```bash
   pip install -r requirements.txt
   ```

3. **Configure database** (same as Vocence)
   - Either set `DATABASE_URL` (e.g. `postgresql://user:pass@host:5432/vocence`)
   - Or set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

4. **Port (must match frontend in production)**  
   Set `PORT` or `DASHBOARD_PORT` to the same port as in the frontend `VITE_API_URL` (e.g. if the URL is `http://136.59.129.136:34717`, set `PORT=34717` in this backend's `.env` or when running).

5. **Optional**
   - `JWT_SECRET` — for auth (login, verify). Change in production.
   - `CORS_ORIGIN` — comma-separated allowed origins (default allows all)
   - `RELOAD=true` — enable uvicorn auto-reload for development

## Run

```bash
python main.py
# Uses PORT or DASHBOARD_PORT from .env (default 3002). For production, set PORT to match VITE_API_URL.

# Or specify port explicitly:
uvicorn main:app --host 0.0.0.0 --port 34717
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service and DB health (200/503) |
| GET | `/api/dashboard/overview` | Counts: total/valid miners, validators, evaluations, last_activity |
| GET | `/api/dashboard/miners` | Miners list with win_rate, total_evaluations (query: `?valid=false`, `?limit=100`) |
| GET | `/api/dashboard/validators` | Validators from validator_registry |
| GET | `/api/dashboard/activity` | Evaluation counts over time (query: `?range=24h` or `?range=7d`) |

**Auth (same server):** `POST /api/auth/login`, `POST /api/auth/verify`, `GET /api/users/:id`, `PATCH /api/users/:id/credits`, `POST /api/history`, `GET /api/history`.

Interactive API docs: **http://localhost:34717/docs** (or your `PORT`)

## Frontend

In the website app (and on Vercel), set **`VITE_API_URL`** to this backend's public URL (e.g. `http://YOUR_SERVER_IP:34717`). This single URL is used for both dashboard and auth. The port must match the `PORT` or `DASHBOARD_PORT` this backend is run with.
