/**
 * Studio credit costs — keep aligned with `dashboard-backend/routers/studio.py`
 * (STUDIO_* env vars can override server defaults).
 */
export const CREDIT_TTS = 25;
export const CREDIT_STT = 20;
export const CREDIT_VOICE_CLONE = 50;
/** Charged when running A/B preview in Voice Design (saving the voice has no extra fee). */
export const CREDIT_VOICE_DESIGN_PREVIEW = 120;
/** Generating speech from a saved “My voice” in Studio. */
export const CREDIT_MY_VOICE_GENERATE = 25;
export const CREDIT_SIGNUP_BONUS = 300;
