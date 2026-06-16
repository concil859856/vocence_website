"""Shared limits for the agent-config and knowledge-ingestion APIs.

Single source of truth so the Pydantic validators in
``routers/agents.py``, the ingest validators in
``routers/agent_knowledge.py``, the SDK (when it adds local
validation), and the frontend char-counters all read the same
numbers. Bumping a limit here propagates to every layer.

Numbers are grounded in the largest real agent on the system as
of writing (Lila — system_prompt 2k, knowledge 2k, purpose 82 chars,
first_message 67 chars) with comfortable headroom and the
``system_prompt > 5000 chars dilutes attention`` lesson from the
recent prompt-trim work baked into the system_prompt cap.
"""

from __future__ import annotations

# --- Agent config text fields (user-edited in the agent builder) ---

# Agent display name. Short — must fit in a card title and not wrap.
AGENT_NAME_MAX_CHARS = 25

# One-line "what this agent does" the architect uses to seed everything
# else. Should be a short paragraph at most.
AGENT_PURPOSE_MAX_CHARS = 300

# What the agent says when the user picks up the call. Multi-sentence
# greeting at most — anything longer feels canned and steals TTFA from
# the first real reply.
AGENT_FIRST_MESSAGE_MAX_CHARS = 150

# System prompt that frames the agent's personality + behaviour. Beyond
# ~5000 chars attention dilutes and the model defaults to safe/generic
# outputs (proven with the recent Lila trim: 4024 → 1993 chars made
# replies noticeably more interesting). 5000 leaves 2.5× headroom over
# Lila's current ~2000 for power users who really need it.
AGENT_SYSTEM_PROMPT_MAX_CHARS = 5000

# Textarea ``knowledge`` field — short, inline-able knowledge for the
# common case (a few hundred FAQ entries). Above 5k chars users should
# use the upload API (PDF / URL / sitemap) which goes through RAG and
# scales much further.
AGENT_KNOWLEDGE_MAX_CHARS = 5000


# --- Knowledge-ingestion API limits (POST /agents/{id}/knowledge/ingest/*) ---

# Per-call text/markdown ingest body. 10k chars (~1500 words) — fits a
# typical FAQ page, a product-info sheet, or a small reference doc.
# Users get ONE text source per agent (see PER_AGENT_*_LIMIT below), so
# this cap is the per-agent text-knowledge ceiling, not just per-call.
# For larger reference docs use the URL or PDF ingest paths.
INGEST_TEXT_MAX_CHARS = 10_000

# Per-agent source-count caps. Each agent gets ONE of each source kind
# to prevent corpus bloat and stop a user from stacking dozens of PDFs
# / URLs to bypass the per-source size limits. Re-uploading the same
# kind REPLACES the prior source rather than stacking. Source kinds the
# knowledge pod tracks: ``text``, ``markdown`` (treated as text for
# count purposes), ``url``, ``sitemap`` (treated as url for count
# purposes), ``pdf``.
PER_AGENT_TEXT_SOURCE_LIMIT = 1
PER_AGENT_URL_SOURCE_LIMIT = 1
PER_AGENT_PDF_SOURCE_LIMIT = 1

# Ingest title (across all ingest endpoints). Already capped at 200 in
# Pydantic; mirrored here so the frontend reads the same number.
INGEST_TITLE_MAX_CHARS = 200

# URL ingest URL length. Already capped at 2048; mirrored here.
INGEST_URL_MAX_CHARS = 2048

# PDF byte ceiling. Already enforced in routers/agent_knowledge.py
# (50 MB); mirrored here as the public reference.
INGEST_PDF_MAX_BYTES = 50 * 1024 * 1024
