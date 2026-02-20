/**
 * App config from environment. Set in .env (see .env.example).
 */
export const ADMIN_EMAIL = (import.meta.env.VITE_ADMIN_EMAIL ?? "").trim();
