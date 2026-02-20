# Run frontend locally (npm run dev)

## 1. Install dependencies

```bash
cd vocence_website/app
npm install
```

## 2. (Optional) Configure .env

Copy `.env.example` to `.env` and set at least:

```env
# Backend URL – required for Dashboard, Blog, Admin, Auth. Use the URL where you run dashboard-backend (see step 3).
VITE_API_URL=http://localhost:3002

# Admin email – required to see Admin link and use /admin (must match backend ADMIN_EMAIL).
VITE_ADMIN_EMAIL=your-admin@example.com
```

If you skip `.env`, the app still runs but Dashboard/API calls will fail or use defaults (e.g. `http://localhost:34717` if no `VITE_API_URL`).

## 3. Start the frontend

```bash
npm run dev
```

Open **http://localhost:5173** (Vite default).

---

## With real data (Dashboard, Blog, Admin)

Run the **dashboard backend** so the app can load data and use Admin:

```bash
# In another terminal
cd vocence_website/dashboard-backend
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
# Optional: pip install python-multipart  (for blog image upload)
# Set DATABASE_URL or POSTGRES_* in .env if you use Postgres
python main.py
```

Backend default port is **3002**. Set `VITE_API_URL=http://localhost:3002` in `app/.env` so the frontend talks to it.

---

## Frontend only (no backend)

You can still run `npm run dev` and browse the site. Dashboard and API-backed pages will show errors or empty/mock data until the backend is running and `VITE_API_URL` points to it.
