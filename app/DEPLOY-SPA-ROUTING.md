# SPA routing (fix 404 on refresh)

For routes like `/dashboard`, `/blog`, etc. to work on **refresh** or **direct URL**, the server must serve `index.html` for those paths (so the React app loads and the client-side router can handle the route).

## What’s in this repo

- **`vercel.json`** – Rewrites all non-asset requests to `/index.html` (for Vercel).
- **`public/_redirects`** – Copied to build output; used by **Netlify** and **Cloudflare Pages** for the same behavior (`/* → /index.html` with status 200).

## If you use Cloudflare Pages

1. **Option A:** Rely on `public/_redirects`  
   It’s copied to the build output. If your build output is the repo root (e.g. `app` or `dist`), ensure `_redirects` is at the **root** of what you deploy (e.g. build from `app` so `dist/_redirects` exists).

2. **Option B:** Configure in the dashboard  
   In **Cloudflare Dashboard → Pages → your project → Settings → Builds & deployments** (or **Redirects**): add a rule so all requests are served by `index.html` (e.g. **Redirect rule**: If path matches `*`, then **URL** = `/index.html`, **Status code** = **200** (rewrite), so it’s an SPA fallback, not a 302).

After deploying, test: open `https://www.vocence.ai/dashboard` and refresh; you should see the dashboard, not 404.
