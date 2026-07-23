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

// ── Video dubbing (billed PER SECOND, PER TARGET LANGUAGE) ────────────────
// Priced at cost parity with the upstream engines, which bill per second with
// no minimum. Dubbing three languages costs three times one language.
// Keep in sync with STUDIO_VIDEO_DUB_*_CREDITS_PER_MIN on the server; the
// server is authoritative and /video-dub/quote returns the real number.
export const CREDIT_VIDEO_DUB_PER_MIN = 200;          // $0.50/min at crypto rate
export const CREDIT_VIDEO_DUB_LIPSYNC_PER_MIN = 800;  // $2.00/min — mouth re-rendered to match

/** Mirrors ``credits_for`` in dashboard-backend/video_dub_service.py. */
export function estimateVideoDubCredits(
  durationSec: number,
  languageCount: number,
  lipsync: boolean,
): number {
  if (durationSec <= 0 || languageCount <= 0) return 0;
  const perMin = lipsync ? CREDIT_VIDEO_DUB_LIPSYNC_PER_MIN : CREDIT_VIDEO_DUB_PER_MIN;
  const seconds = Math.max(1, Math.ceil(durationSec));
  return Math.ceil((seconds * perMin) / 60) * languageCount;
}

// ── Limits (enforced frontend + backend) ──────────────────────────────────
export const TTS_MAX_CHARS = 2000;
export const CLONE_MAX_TEXT_CHARS = 2000;
export const STT_MAX_DURATION_SEC = 5 * 60;      // 5 min hard cap
export const STT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const NOISE_REMOVER_MAX_DURATION_SEC = 5 * 60;
export const NOISE_REMOVER_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const VIDEO_DUB_MAX_DURATION_SEC = 10 * 60;   // 10 min hard cap
export const VIDEO_DUB_MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export const VIDEO_DUB_MAX_LANGUAGES = 3;
// Lip-sync is tighter than standard dubbing on both size and resolution.
// Mirrors STUDIO_VIDEO_DUB_LIPSYNC_MAX_BYTES / _MAX_DIM on the server; these
// are display-only, /start re-checks authoritatively.
export const VIDEO_DUB_LIPSYNC_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const VIDEO_DUB_LIPSYNC_MAX_DIMENSION = 2048;

// ── One-time bonuses ──────────────────────────────────────────────────────
export const CREDIT_SIGNUP_BONUS = 300;
