/**
 * Agent-config + ingest length limits, mirrored from the backend's
 * single source of truth (`dashboard-backend/agent_limits.py`). Bump
 * these in lockstep with the Python constants — Pydantic on the
 * server hard-rejects with 422 if the frontend lets through anything
 * larger.
 *
 * Used by `AgentConfigForm` for live char counters and to disable
 * Save when a field is over its limit. The SDK should read the same
 * numbers when it adds local pre-validation.
 */

export const AGENT_NAME_MAX_CHARS = 25;
export const AGENT_PURPOSE_MAX_CHARS = 300;
export const AGENT_FIRST_MESSAGE_MAX_CHARS = 150;
export const AGENT_SYSTEM_PROMPT_MAX_CHARS = 5000;
export const AGENT_KNOWLEDGE_MAX_CHARS = 5000;

export const INGEST_TEXT_MAX_CHARS = 10_000;
export const INGEST_TITLE_MAX_CHARS = 200;
export const INGEST_URL_MAX_CHARS = 2048;
export const INGEST_PDF_MAX_BYTES = 50 * 1024 * 1024;

// Per-agent source-count caps. Each kind of external source is limited
// to ONE per agent — re-uploading replaces the previous source instead
// of stacking. Mirrors agent_limits.py PER_AGENT_*_SOURCE_LIMIT.
export const PER_AGENT_TEXT_SOURCE_LIMIT = 1;
export const PER_AGENT_URL_SOURCE_LIMIT = 1;
export const PER_AGENT_PDF_SOURCE_LIMIT = 1;
