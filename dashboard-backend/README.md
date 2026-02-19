# Vocence Dashboard Backend (FastAPI)

Standalone **Python FastAPI** backend that reads from the **owner's Vocence PostgreSQL database** (same DB as the Vocence API) and exposes REST endpoints for the website dashboard. Run this separately from the Vocence subnet API.

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

4. **Optional**
   - `DASHBOARD_PORT` or `PORT` — default `3002`
   - `CORS_ORIGIN` — comma-separated allowed origins (default allows all)
   - `RELOAD=true` — enable uvicorn auto-reload for development

## Run

```bash
python main.py
# or
uvicorn main:app --host 0.0.0.0 --port 3002
# with auto-reload
uvicorn main:app --host 0.0.0.0 --port 3002 --reload
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Service and DB health (200/503) |
| GET | `/api/dashboard/overview` | Counts: total/valid miners, validators, evaluations, last_activity |
| GET | `/api/dashboard/miners` | Miners list with win_rate, total_evaluations (query: `?valid=false`, `?limit=100`) |
| GET | `/api/dashboard/validators` | Validators from validator_registry |
| GET | `/api/dashboard/activity` | Evaluation counts over time (query: `?range=24h` or `?range=7d`) |

Interactive API docs: **http://localhost:3002/docs**

## Frontend

In the website app, set `VITE_DASHBOARD_API_URL=http://localhost:3002` (or your deployed URL) so the dashboard page fetches from this backend.
