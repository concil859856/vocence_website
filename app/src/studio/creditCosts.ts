/**
 * Studio credit costs, keep aligned with `dashboard-backend/routers/studio.py`
 * (STUDIO_* env vars can override server defaults).
 *
 * Pricing model (Nov 2026 redesign):
 *   - Card:   $12 = 4,000 cr · $24 = 8,000 cr   (333 cr/$)
 *   - Crypto: $20 = 8,000 cr · $40 = 16,000 cr  (400 cr/$, 20% bonus)
 *
 * All API $-equivalents below are derived from the crypto rate (400 cr/$).
 */

// ── Per-generation flat costs ──────────────────────────────────────────────
export const CREDIT_TTS = 30;                    // up to 2,000 chars
export const CREDIT_STT = 15;                    // up to 5 min audio
export const CREDIT_VOICE_CLONE = 40;            // studio clone+TTS one-shot, up to 2,000 chars (uses STT+LLM upstream → priced higher than plain TTS)
export const CREDIT_VOICE_DESIGN_PREVIEW = 70;   // generate sample voice from prompt
export const CREDIT_MY_VOICE_GENERATE = 30;      // TTS using a saved designed/cloned voice, up to 2,000 chars
export const CREDIT_MUSIC = 30;                  // ACE-Step text2music + all derived modes
export const CREDIT_NOISE_REMOVER = 5;           // DeepFilterNet enhancement, up to 5 min audio (was "dubbing")
/** Per-minute rate for voice agents, billed in 6-second increments while a session is active. */
export const CREDIT_VOICE_AGENT_PER_MIN = 40;    // ~$0.10/min at crypto rate

// ── Limits (enforced frontend + backend) ──────────────────────────────────
export const TTS_MAX_CHARS = 2000;
export const CLONE_MAX_TEXT_CHARS = 2000;
export const STT_MAX_DURATION_SEC = 5 * 60;      // 5 min hard cap
export const STT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const NOISE_REMOVER_MAX_DURATION_SEC = 5 * 60;
export const NOISE_REMOVER_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

// ── One-time bonuses ──────────────────────────────────────────────────────
export const CREDIT_SIGNUP_BONUS = 300;

/**
 * Back-compat alias. Kept so any lingering imports don't break during the
 * dubbing → noise_remover rename. New code should import CREDIT_NOISE_REMOVER.
 * TODO: drop once all import sites migrate.
 */
export const CREDIT_DUBBING = CREDIT_NOISE_REMOVER;
