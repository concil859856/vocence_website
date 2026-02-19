# Testing the Vocence Website & Dashboard

## Quick test (frontend only, mock data)

If you only want to see the UI without the Vocence database:

1. **Start the frontend**
   ```bash
   cd vocence_website/app
   npm install
   npm run dev
   ```
2. Open **http://localhost:5173** and go to **Dashboard**.
3. You’ll see the yellow banner: *"Showing sample data. Start the dashboard backend for live network data."*  
   The dashboard still works with mock miners, validators, activity, and validation list.

---

## Full test (real data from Postgres + SQLite)

You need:

- **PostgreSQL** with the Vocence schema (same DB as the Vocence API: `registered_miners`, `performance_metrics`, `validator_evaluations`, `validator_registry`, `blocked_entities`).
- **Dashboard backend** (reads/writes Postgres for dashboard + blocklist/validators, uses SQLite for registered users).

### 1. Configure Postgres

Same as Vocence API. In `vocence_website/dashboard-backend`:

- Set **`DATABASE_URL`** (e.g. `postgresql://user:pass@localhost:5432/vocence`),  
  **or**
- Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`.

### 2. Start the dashboard backend

```bash
cd vocence_website/dashboard-backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
pip install python-multipart   # for blog image upload
python main.py
```

- Backend runs at **http://localhost:3002**.
- Health: **http://localhost:3002/health** (should return `"database": true` if Postgres is OK).
- API docs: **http://localhost:3002/docs**.

SQLite is created automatically at `dashboard-backend/data/website.db` (or `SQLITE_PATH` if set). No extra setup.

### 3. Configure the frontend

In `vocence_website/app` create or edit `.env`:

```env
VITE_DASHBOARD_API_URL=http://localhost:3002
```

(Optional: `VITE_GOOGLE_CLIENT_ID` for Google login; `VITE_API_BASE_URL` for the main Vocence API.)

### 4. Start the frontend

```bash
cd vocence_website/app
npm run dev
```

Open **http://localhost:5173**.

### 5. What to test

| Feature | Where | How |
|--------|--------|-----|
| **Dashboard stats** | Dashboard | Overview cards, activity chart, top 20 miners from real DB. |
| **View whole list** | Dashboard | Click **"View whole list"** → modal with full miners table (up to 500). |
| **Validation status** | Dashboard | Right panel shows recent evaluations from `validator_evaluations`. |
| **Blocklist** | Dashboard | **"Blacklisted hotkeys"** → add/remove (writes Postgres `blocked_entities`). |
| **Admin** | Admin (must be logged in as **medfil777@gmail.com**) | **Validators**: add validator (UID + hotkey). **Registered users**: list of users stored in SQLite. **Blocklist** & **Blog** as before. |
| **Registered users** | Login + Admin | Log in with any Google account → user is stored in SQLite. Then as admin, open Admin → **Registered users** to see the list. |

### 6. Test without Postgres (backend only)

If Postgres is not available, the backend will still start, but:

- `/api/dashboard/overview`, `/miners`, `/validators`, `/activity`, `/evaluations/recent` will fail or return empty when they hit the DB.
- **Registered users** (SQLite) still work: `POST /api/dashboard/users/register`, `GET /api/dashboard/users` (admin).
- Health will show `"database": false` if Postgres is down.

To test only the website DB:

```bash
# Register a user (no auth required)
curl -X POST http://localhost:3002/api/dashboard/users/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","name":"Test User"}'

# List users (admin only)
curl http://localhost:3002/api/dashboard/users \
  -H "X-Admin-Email: medfil777@gmail.com"
```

---

## Summary

- **UI + mock data:** run only `vocence_website/app` (`npm run dev`).
- **Real dashboard data:** run Vocence Postgres + `dashboard-backend` + `app` with `VITE_DASHBOARD_API_URL=http://localhost:3002`.
- **Admin and registered users:** log in (Google) and use Admin as **medfil777@gmail.com**; registered users are stored in SQLite and listed under Admin → Registered users.
