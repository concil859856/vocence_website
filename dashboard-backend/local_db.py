"""
Local SQLite database for website-only data.

Owner / subnet state stays in PostgreSQL. Product and website data such as
users, plans, credits, blog posts, studio history, and payments live here.
"""

import json
import logging
import os
import uuid
import hashlib
import secrets
from pathlib import Path
from typing import Any

import aiosqlite
import asyncpg


_log = logging.getLogger(__name__)

# Default: data/website.db next to dashboard-backend
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = os.environ.get("SQLITE_PATH", str(DATA_DIR / "website.db"))


async def get_connection() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    # WAL lets readers and a single writer proceed concurrently without
    # blocking each other — essential because this DB is shared by two
    # processes (dashboard-backend + developer-api) plus this backend's own
    # concurrent async connections. busy_timeout makes a writer wait for a
    # lock instead of failing instantly with "database is locked" (default
    # busy_timeout is 0). journal_mode is a persistent DB-level setting;
    # busy_timeout is per-connection so must be set on every connection.
    await conn.execute("PRAGMA journal_mode = WAL")
    await conn.execute("PRAGMA busy_timeout = 5000")
    return conn


SCHEMA_SQL = [
    """
    CREATE TABLE IF NOT EXISTS registered_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        picture TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        picture TEXT,
        credits INTEGER NOT NULL DEFAULT 300,
        plan_code TEXT NOT NULL DEFAULT 'normal',
        plan_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auth_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        style_prompt TEXT,
        model TEXT,
        meta TEXT,
        duration TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pricing_plans (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price_usd REAL,
        billing_type TEXT NOT NULL,
        credits_included INTEGER NOT NULL DEFAULT 0,
        credits_per_pack INTEGER,
        price_subtitle TEXT,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_highlighted INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        features_json TEXT NOT NULL DEFAULT '[]',
        cta_label TEXT NOT NULL DEFAULT 'Select plan',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS credit_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        description TEXT,
        reference_type TEXT,
        reference_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS blog_posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Updates',
        date TEXT NOT NULL,
        read_time TEXT NOT NULL DEFAULT '5 min read',
        image TEXT NOT NULL,
        content TEXT NOT NULL,
        featured INTEGER NOT NULL DEFAULT 0,
        is_published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_tts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        miner_hotkey TEXT NOT NULL,
        model_name TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        style_instruction TEXT NOT NULL DEFAULT 'neutral voice',
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 10,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_stt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        source_audio_filename TEXT NOT NULL,
        source_language TEXT,
        duration_seconds REAL,
        transcribed_text TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 2,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_clone_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        reference_text TEXT NOT NULL,
        target_text TEXT NOT NULL,
        source_mode TEXT NOT NULL,
        source_audio_filename TEXT NOT NULL,
        source_language TEXT,
        chute_slug TEXT NOT NULL,
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 15,
        stt_latency_ms INTEGER,
        clone_latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS payment_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan_code TEXT,
        mode TEXT,
        credits_requested INTEGER NOT NULL DEFAULT 0,
        amount_usd REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_url TEXT,
        reference TEXT,
        stripe_checkout_session_id TEXT,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT,
        completed_at TEXT,
        canceled_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan_code TEXT,
        amount_usd REAL NOT NULL DEFAULT 0,
        credits_granted INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        provider_payment_id TEXT,
        stripe_checkout_session_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_invoice_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT,
        stripe_event_id TEXT,
        mode TEXT,
        wallet_address TEXT,
        billing_period_start TEXT,
        billing_period_end TEXT,
        credits_applied_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES payment_sessions(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        object_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS daily_usage_stats (
        day TEXT PRIMARY KEY,
        tts_generation_count INTEGER NOT NULL DEFAULT 0,
        unique_users INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        revenue_usd REAL NOT NULL DEFAULT 0,
        credits_purchased INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admin_audit_log (
        id TEXT PRIMARY KEY,
        admin_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'normal',
        rate_limit_rpm INTEGER,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS api_request_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        provider TEXT,
        status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 0,
        request_chars INTEGER,
        latency_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_music_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task TEXT NOT NULL DEFAULT 'text2music',
        prompt_text TEXT NOT NULL,
        lyrics TEXT NOT NULL DEFAULT '',
        audio_duration REAL NOT NULL DEFAULT 60,
        audio_format TEXT NOT NULL DEFAULT 'wav',
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 50,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_video_dub_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        source_filename TEXT NOT NULL DEFAULT '',
        source_language TEXT NOT NULL DEFAULT 'auto',
        target_language TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'standard',
        -- Groups the language variants produced by one dub job into a
        -- "collection": one source video in, N sibling rows out. Indexed
        -- because the Library groups on it. Nullable so a row is never
        -- orphaned if the job row is later pruned — the asset outlives its job.
        job_id TEXT,
        duration_sec REAL NOT NULL DEFAULT 0,
        video_s3_bucket TEXT NOT NULL,
        video_s3_key TEXT NOT NULL,
        -- One extracted frame, so the library renders as cards rather than
        -- a list of filenames. Nullable: ffmpeg may be unavailable, and a
        -- missing poster degrades the card without failing the dub.
        poster_s3_bucket TEXT,
        poster_s3_key TEXT,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        -- Rights attestation captured at upload. The upstream lip-sync engine
        -- puts the likeness-consent obligation on us as the API caller, so we
        -- record who attested and when for every dubbed clip.
        consent_attested INTEGER NOT NULL DEFAULT 0,
        consent_attested_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_noise_remover_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        source_audio_filename TEXT NOT NULL DEFAULT '',
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 5,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_voice_design_previews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        preview_token TEXT NOT NULL UNIQUE,
        voice_description TEXT NOT NULL,
        revised_instruction TEXT NOT NULL,
        sample_script TEXT NOT NULL,
        miner_hotkey TEXT NOT NULL,
        model_name TEXT NOT NULL,
        chute_slug TEXT NOT NULL,
        audio_a_bucket TEXT NOT NULL,
        audio_a_key TEXT NOT NULL,
        audio_b_bucket TEXT NOT NULL,
        audio_b_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_user_designed_voices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        voice_description TEXT NOT NULL,
        revised_instruction TEXT NOT NULL,
        chosen_variant TEXT NOT NULL,
        ref_script TEXT NOT NULL,
        miner_hotkey TEXT NOT NULL,
        model_name TEXT NOT NULL,
        chute_slug TEXT NOT NULL,
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS playbooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT 'Untitled Playbook',
        description TEXT NOT NULL DEFAULT '',
        cover_image_url TEXT,
        visibility TEXT NOT NULL DEFAULT 'private',
        play_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS playbook_votes (
        playbook_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (playbook_id, user_id),
        FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Per-(user, voice) like for the Community Voices catalog. ``voice_id``
    # is the catalog id string (e.g. ``voc-atlas``, ``design-aria``).
    # Aggregate counts power the popularity sort on /studio/community-voices.
    """
    CREATE TABLE IF NOT EXISTS voice_likes (
        voice_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (voice_id, user_id),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS playbook_tracks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playbook_id INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        audio_url TEXT NOT NULL,
        image_url TEXT,
        source_type TEXT NOT NULL DEFAULT 'generated',
        duration_seconds REAL,
        audio_s3_bucket TEXT,
        audio_s3_key TEXT,
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (playbook_id) REFERENCES playbooks(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS generation_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,                 -- 'tts'|'stt'|'clone'|'voice_design'|'music'
        status TEXT NOT NULL,               -- pending|processing|completed|failed|timeout|cancelled
        phase TEXT,                         -- e.g. 'transcribing reference', 'cloning voice'
        payload_json TEXT NOT NULL,         -- input
        result_json TEXT,                   -- output (audio_url, history_id, ...)
        error_message TEXT,
        pod_url TEXT,                       -- last pod that handled it
        credits_charged INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,                -- 'knowledge' | 'goal'
        status TEXT NOT NULL DEFAULT 'draft',  -- draft|active|paused|archived
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,         -- AgentConfig as JSON
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_run_at TEXT,
        run_count INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agent_custom_tools (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,                -- function name the LLM calls (snake_case)
        description TEXT NOT NULL,         -- LLM uses this to decide when to invoke
        parameters_json TEXT NOT NULL,     -- JSON Schema for the function's args
        endpoint_url TEXT NOT NULL,        -- where we POST when the LLM calls it
        method TEXT NOT NULL DEFAULT 'POST',
        auth_type TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'bearer' | 'header'
        auth_header_name TEXT,             -- for 'header' auth (e.g. 'X-API-Key')
        auth_secret TEXT,                  -- bearer token or header value (plaintext, internal-only)
        timeout_ms INTEGER NOT NULL DEFAULT 5000,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agent_custom_tool_bindings (
        agent_id TEXT NOT NULL,
        tool_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (agent_id, tool_id),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (tool_id) REFERENCES agent_custom_tools(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL,              -- pending|running|completed|failed|cancelled
        goal TEXT NOT NULL,
        success_metric TEXT NOT NULL,
        iterations_json TEXT NOT NULL DEFAULT '[]',
        best_output TEXT,
        best_score REAL,
        error TEXT,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_voicechat_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        mode TEXT NOT NULL,                 -- 'voice' | 'text'
        user_text TEXT,
        bot_text TEXT,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        ttft_ms INTEGER NOT NULL DEFAULT 0, -- time to first LLM token
        ttfa_ms INTEGER,                    -- time to first audio frame (null if turn errored before audio)
        error TEXT,
        status TEXT NOT NULL DEFAULT 'completed',
        -- One WS open = one session_id, every turn on that WS shares it.
        -- COUNT(DISTINCT session_id) is the true "calls handled" metric.
        -- Old rows (pre-migration) have NULL and are excluded from counts.
        session_id TEXT,
        -- Which agent the call was against. NULL = Logos / Vocence
        -- Assistant (no user-built agent attached).
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Session-level call log. ONE row per voice-agent session (= one
    # WebSocket open). Written in the session_close finally block.
    # Per-turn metrics still live in studio_voicechat_history; this
    # table captures facts that only make sense at the session level:
    # how the session ENDED, how long it actually was end-to-end (not
    # sum-of-turn-latencies), whether it was recorded, the turn count
    # for drop-rate analysis ("user opened mic, never said anything"
    # vs "had a real conversation"), and a path to the audio file if
    # recording was on. Drives the per-agent Analytics + Calls
    # dashboard.
    """
    CREATE TABLE IF NOT EXISTS voice_call_logs (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT,                          -- NULL = Logos
        agent_name TEXT,                        -- snapshot; survives agent rename/delete
        started_at TEXT NOT NULL,               -- UTC ISO8601
        ended_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        -- normalized: user_hangup | max_duration | idle_timeout |
        -- free_time_up | billing_exhausted | error | unknown
        end_reason TEXT NOT NULL DEFAULT 'unknown',
        turn_count INTEGER NOT NULL DEFAULT 0,  -- number of completed user turns
        user_chars INTEGER NOT NULL DEFAULT 0,  -- sum across the call
        agent_chars INTEGER NOT NULL DEFAULT 0,
        -- Path to the stereo WAV (left=user, right=agent) under
        -- data/recordings/. NULL when recording was disabled or
        -- failed mid-call. Frontend serves this via a streaming
        -- download endpoint, not directly.
        recording_path TEXT,
        recording_bytes INTEGER,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Per-call transcript snapshot. Lives in its own table (not on
    # voice_call_logs above) so the call-list query stays narrow and
    # fast — we only join in the transcript when the user opens the
    # detail panel for a single call.
    """
    CREATE TABLE IF NOT EXISTS voice_call_transcripts (
        session_id TEXT PRIMARY KEY,
        -- JSON: [{"role":"user"|"assistant","text":"...","at_ms":int}, ...]
        -- ``at_ms`` is monotonic from session start so playback can sync.
        transcript_json TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES voice_call_logs(session_id) ON DELETE CASCADE
    )
    """,
    # Webhook destinations for one agent. The owner registers a URL
    # + (optional) custom secret; we sign every delivery with
    # HMAC-SHA256 in the format the vocence-sdk's
    # ``webhooks.verify()`` helper expects:
    #   X-Vocence-Timestamp: <unix-ts>
    #   X-Vocence-Signature: v1=base64(HMAC-SHA256(secret, "v1.{ts}." + body))
    # ``events_json`` is a JSON array of subscribed event names
    # (e.g. ``["call.ended"]``); ``["*"]`` subscribes to everything.
    """
    CREATE TABLE IF NOT EXISTS agent_webhooks (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        user_id TEXT NOT NULL,                   -- denormalized for fast owner check
        url TEXT NOT NULL,
        secret TEXT NOT NULL,                    -- 32+ hex chars
        events_json TEXT NOT NULL DEFAULT '["*"]',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Outbound webhook delivery queue + history. Enqueued at event
    # time, drained by ops.webhook_delivery_loop. Retries with
    # exponential backoff capped at MAX_ATTEMPTS; status drives the
    # "recent deliveries" UI on the Webhooks tab.
    """
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        webhook_id TEXT NOT NULL,
        event_type TEXT NOT NULL,                -- e.g. "call.ended"
        payload_json TEXT NOT NULL,              -- the body we'll POST
        -- "pending" → not yet attempted
        -- "delivering" → in flight (set just before POST to prevent
        --   another worker double-dispatching the same row)
        -- "delivered" → 2xx received
        -- "failed" → ran out of attempts
        status TEXT NOT NULL DEFAULT 'pending',
        attempt INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_status_code INTEGER,
        last_error TEXT,
        last_attempted_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (webhook_id) REFERENCES agent_webhooks(id) ON DELETE CASCADE
    )
    """,
    # CLI device-code login flow (RFC 8628-ish). The CLI obtains a
    # device_code + user_code, opens the user_code page in the browser,
    # and polls the device_code endpoint until the user approves. On
    # approval we mint a fresh API key and stash it here so the next
    # poll returns the plaintext exactly once.
    """
    CREATE TABLE IF NOT EXISTS cli_auth_codes (
        device_code TEXT PRIMARY KEY,
        user_code TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | denied | expired | consumed
        user_id TEXT,
        api_key_id TEXT,
        api_key_plain TEXT,
        approved_at TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Per-call LLM telemetry. Every chat/stream call from llm_client.py
    # writes one row (or one row per attempt when fallback fires).
    #
    # ``mode`` is 'chat' (non-streaming) or 'stream'. ``fallback_from``
    # is the provider of the prior attempt when this call is a fallback
    # ladder rung — e.g. when Cerebras 429s and Grok takes over,
    # the Grok row has fallback_from='cerebras'. ``rate_limited`` and
    # ``timed_out`` are derived booleans for fast filtering — the
    # canonical truth is in ``http_status``/``error_message``.
    #
    # ``cost_usd`` is computed at insert time from llm_pricing — if no
    # price row exists for (provider, model) it stays NULL and the row
    # is still useful for failure/latency analysis. ``user_id`` /
    # ``agent_id`` may be NULL for system calls (voice design, summaries).
    """
    CREATE TABLE IF NOT EXISTS llm_calls (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,              -- 'cerebras'|'xai'|'groq'|'openai'|'chutes'|'local'
        model TEXT NOT NULL,
        mode TEXT NOT NULL,                  -- 'chat' | 'stream'
        status TEXT NOT NULL,                -- 'ok'|'error'|'empty'
        http_status INTEGER,                 -- transport-level status, NULL if connect failed
        rate_limited INTEGER NOT NULL DEFAULT 0,  -- 1 when http_status=429
        timed_out INTEGER NOT NULL DEFAULT 0,     -- 1 when underlying request timed out
        latency_ms INTEGER,                  -- wall time from request start to call end
        ttft_ms INTEGER,                     -- streaming only: time to first delta
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        cost_usd REAL,                       -- NULL when no llm_pricing row matches
        fallback_from TEXT,                  -- previous provider if this is a fallback rung
        fallback_reason TEXT,                -- short label, e.g. 'cerebras_429', 'cerebras_timeout'
        user_id TEXT,                        -- nullable: NULL for system/background calls
        agent_id TEXT,                       -- nullable: agent that triggered this call
        error_message TEXT,                  -- truncated to 500 chars at insert
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    # Per-provider/model pricing. ``input_per_1m`` and ``output_per_1m``
    # are USD per million tokens for prompt / completion respectively
    # (matches every major provider's published pricing format). The
    # admin UI edits this table directly; llm_logging.record_call reads
    # it on every write to compute cost_usd.
    """
    CREATE TABLE IF NOT EXISTS llm_pricing (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_per_1m REAL NOT NULL,          -- USD per 1M prompt tokens
        output_per_1m REAL NOT NULL,         -- USD per 1M completion tokens
        notes TEXT,                          -- e.g. 'public price 2026-05-29; private discount: 30%'
        active INTEGER NOT NULL DEFAULT 1,   -- 0 = retired entry, kept for historical cost lookup
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (provider, model)
    )
    """,
    # User-facing thumbs-up/down on a single generation output. One row
    # per (user, entry_type, entry_id) — a user can change their vote
    # by replacing the row (UPSERT). entry_type matches the StudioHistory
    # categories: 'tts'|'stt'|'clone'|'voice_design'|'music'|
    # 'noise_remover'|'agent_call'|'agent_message'. entry_id is the
    # primary key of the corresponding history table for that type
    # (integer id) — or, for agent_message, the message id from the
    # voicechat session log.
    """
    CREATE TABLE IF NOT EXISTS generation_feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        entry_type TEXT NOT NULL,
        entry_id TEXT NOT NULL,              -- TEXT so it works for both INT and UUID keyspaces
        rating INTEGER NOT NULL,             -- 1 = thumbs up, -1 = thumbs down
        comment TEXT,                        -- optional short reason ('robotic', 'wrong language', etc.)
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, entry_type, entry_id),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Auth event log — distinct from auth_history (which is the user's
    # action history, mis-named). Captures login/logout/failed-attempts
    # with IP / user-agent / country so admins can spot brute force,
    # geographic anomalies, and account-takeover signals.
    #
    # user_id is NULL for failed attempts when the email didn't match
    # an account (so we don't expose existence via failed-login analytics).
    """
    CREATE TABLE IF NOT EXISTS auth_login_events (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,                  -- 'login_ok'|'login_fail'|'logout'|'token_refresh'
        user_id TEXT,
        email_attempted TEXT,                -- present for failed attempts (lowercased)
        ip TEXT,
        country TEXT,                        -- ISO-3166 alpha-2, derived from IP at write time if avail
        user_agent TEXT,
        reason TEXT,                         -- 'bad_password'|'unknown_email'|'oauth'|'manual_logout'|...
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE SET NULL
    )
    """,
    # Embed tokens — agent owners generate these from Studio to let
    # anonymous visitors on their own websites use the agent via the
    # embeddable widget. Each token:
    #   • binds to one specific agent_id
    #   • is owned by the user who created it (they get billed)
    #   • optionally restricts which Origin headers can present it
    #   • carries per-IP rate limits
    #   • is revocable (set ``revoked_at``); revoked tokens are kept
    #     for audit purposes, NOT deleted, so the Studio UI can still
    #     show last_used_at history after revocation
    #
    # ``token_hash`` is SHA-256 of the plaintext token. The plaintext
    # itself is shown ONCE on creation and never stored — same pattern
    # as the api_keys table. ``token_prefix`` (first 6 chars of the
    # plaintext) is stored separately so the Studio UI can show
    # "vet_abc123…" in the issuance list without revealing the secret.
    """
    CREATE TABLE IF NOT EXISTS agent_embed_tokens (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        owner_user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,                  -- 'vet_abc123' style preview
        label TEXT NOT NULL DEFAULT '',              -- human-friendly name
        allowed_origins_json TEXT NOT NULL DEFAULT '[]',  -- JSON array of host patterns; empty = any origin
        rate_limit_per_ip_per_hour INTEGER NOT NULL DEFAULT 30,
        max_session_minutes INTEGER NOT NULL DEFAULT 5,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
        FOREIGN KEY (owner_user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # Per-token rate-limit ledger. One row per session start so we can
    # enforce "≤ N per IP per rolling hour" without an external store.
    # Rows are pruned by a scheduled job (or naturally evicted by a
    # trailing window query — both work).
    """
    CREATE TABLE IF NOT EXISTS agent_embed_token_uses (
        token_id TEXT NOT NULL,
        ip TEXT NOT NULL,
        at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (token_id) REFERENCES agent_embed_tokens(id) ON DELETE CASCADE
    )
    """,
    # User-submitted voices for the Community Voices catalog. Reviewed
    # by admin; on approval the voice is published, the submitter gets
    # a credit bonus, and a notification fires. Files (audio + avatar)
    # live in object storage (MinIO/R2); we keep only the URLs here.
    """
    CREATE TABLE IF NOT EXISTS voice_submissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,             -- ≤30 chars, user-facing tagline
        ref_text TEXT NOT NULL,                -- the exact words spoken in audio_url
        language TEXT NOT NULL,                -- one of the qwen3-clone supported langs
        audio_url TEXT NOT NULL,               -- 8-15s WAV/MP3, object-storage URL
        audio_duration_ms INTEGER NOT NULL,
        avatar_url TEXT NOT NULL,              -- square 512x512 WebP after server-side normalize
        status TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected
        reject_reason TEXT,
        reviewed_at TEXT,
        reviewed_by TEXT,                      -- admin email
        approved_voice_id TEXT,                -- catalog id once published (e.g. ``community-<id>``)
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    # In-product notifications. Created by the system (approval/rejection
    # of a voice submission, credit bonuses, etc.) OR by an admin
    # broadcasting to recipients via the admin composer. Read state is
    # tracked per row (one row per recipient, even for broadcasts) so
    # the unread count is a cheap COUNT(*).
    """
    CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,                 -- recipient
        kind TEXT NOT NULL,                    -- submission_approved | submission_rejected | credit_bonus | admin_announcement | ...
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        link TEXT,                             -- optional in-app destination (e.g. /studio/community-voices)
        image_url TEXT,                        -- optional banner image; rendered atop the detail modal when set
        sender TEXT,                           -- 'system' or admin email
        read_at TEXT,                          -- NULL = unread
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
]


INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users (email)",
    "CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_auth_history_user_id ON auth_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at ON blog_posts (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_tts_history_user_id ON studio_tts_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_stt_history_user_id ON studio_stt_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_clone_history_user_id ON studio_clone_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_user_id ON payment_sessions (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_cli_auth_user_code ON cli_auth_codes (user_code)",
    "CREATE INDEX IF NOT EXISTS idx_cli_auth_expires_at ON cli_auth_codes (expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_stripe_checkout ON payment_sessions (stripe_checkout_session_id)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_stripe_subscription ON payment_sessions (stripe_subscription_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoice ON payments (stripe_invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_stripe_subscription ON payments (stripe_subscription_id)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix)",
    "CREATE INDEX IF NOT EXISTS idx_api_request_logs_key_time ON api_request_logs (api_key_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_api_request_logs_user_time ON api_request_logs (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_music_history_user_id ON studio_music_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_noise_remover_history_user_id ON studio_noise_remover_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_voice_design_previews_user ON studio_voice_design_previews (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_voice_submissions_status ON voice_submissions (status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_voice_submissions_user ON voice_submissions (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications (user_id, read_at, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_user_designed_voices_user ON studio_user_designed_voices (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_playbooks_user_id ON playbooks (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_playbook_tracks_playbook_id ON playbook_tracks (playbook_id, position ASC)",
    "CREATE INDEX IF NOT EXISTS idx_playbook_votes_playbook ON playbook_votes (playbook_id)",
    "CREATE INDEX IF NOT EXISTS idx_playbook_votes_user ON playbook_votes (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_voice_likes_voice ON voice_likes (voice_id)",
    "CREATE INDEX IF NOT EXISTS idx_voice_likes_user ON voice_likes (user_id)",
    "CREATE INDEX IF NOT EXISTS idx_studio_video_dub_history_user ON studio_video_dub_history (user_id, created_at DESC)",
    # Collection lookup: fetch every language variant of one dub job.
    "CREATE INDEX IF NOT EXISTS idx_studio_video_dub_history_job ON studio_video_dub_history (job_id)",
    "CREATE INDEX IF NOT EXISTS idx_generation_jobs_user_created ON generation_jobs (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_generation_jobs_status ON generation_jobs (status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_generation_jobs_type_status ON generation_jobs (type, status, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_studio_voicechat_history_user ON studio_voicechat_history (user_id, created_at DESC)",
    # Used by the public /stats/voice endpoint for COUNT(DISTINCT session_id).
    "CREATE INDEX IF NOT EXISTS idx_studio_voicechat_history_session ON studio_voicechat_history (session_id) WHERE session_id IS NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_agents_user ON agents (user_id, updated_at DESC)",
    # FTS5 virtual table for agent knowledge chunks (RAG retrieval).
    # Created with porter+unicode61 tokenizer so English stems work
    # (e.g. "running" matches "run"). agent_id and chunk_idx are stored
    # but NOT searched (UNINDEXED). Filter by agent_id in the WHERE clause
    # of MATCH queries.
    """
    CREATE VIRTUAL TABLE IF NOT EXISTS agent_knowledge_chunks
    USING fts5(
        agent_id UNINDEXED,
        chunk_idx UNINDEXED,
        content,
        tokenize = 'porter unicode61'
    )
    """,
    # NOTE: the studio_voicechat_history_fts virtual table + its
    # triggers used to live here. We moved the whole thing into
    # ensure_tables() because CREATE VIRTUAL TABLE IF NOT EXISTS
    # was silently failing when it ran in the same transaction as
    # a prior DROP TABLE on the same name (some sqlite builds keep
    # the dropped table's shadow tables visible until commit, then
    # CREATE … IF NOT EXISTS sees the stale name and no-ops, then
    # the next SELECT can't find the table). Explicit commits
    # between DROP and CREATE in ensure_tables() avoid the trap.
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs (agent_id, started_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs (user_id, started_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_agent_custom_tools_user ON agent_custom_tools (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_agent_custom_tool_bindings_agent ON agent_custom_tool_bindings (agent_id)",
    "CREATE INDEX IF NOT EXISTS idx_agent_custom_tool_bindings_tool ON agent_custom_tool_bindings (tool_id)",
    # LLM telemetry — index the four common admin query shapes.
    "CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_llm_calls_provider_time ON llm_calls (provider, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_llm_calls_status_time ON llm_calls (status, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_llm_calls_agent_time ON llm_calls (agent_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_llm_calls_user_time ON llm_calls (user_id, created_at DESC)",
    # generation_feedback: per-entry lookups (already enforced UNIQUE) +
    # per-user history (for "voices you've rated" type views).
    "CREATE INDEX IF NOT EXISTS idx_generation_feedback_entry ON generation_feedback (entry_type, entry_id)",
    "CREATE INDEX IF NOT EXISTS idx_generation_feedback_user_time ON generation_feedback (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_generation_feedback_type_rating ON generation_feedback (entry_type, rating, created_at DESC)",
    # Auth login events: by time (for the global feed) and by user (for
    # per-user security drill-down).
    "CREATE INDEX IF NOT EXISTS idx_auth_login_events_time ON auth_login_events (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_auth_login_events_user_time ON auth_login_events (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_auth_login_events_kind_time ON auth_login_events (kind, created_at DESC)",
    # Embed tokens: look up by hash on every embed-WS handshake (hot path)
    # and by agent_id when the Studio UI lists tokens for an agent.
    "CREATE INDEX IF NOT EXISTS idx_agent_embed_tokens_hash ON agent_embed_tokens (token_hash)",
    "CREATE INDEX IF NOT EXISTS idx_agent_embed_tokens_agent ON agent_embed_tokens (agent_id, revoked_at)",
    "CREATE INDEX IF NOT EXISTS idx_agent_embed_tokens_owner ON agent_embed_tokens (owner_user_id, created_at DESC)",
    # Token-uses: count rows per (token_id, ip) in a rolling hour window.
    "CREATE INDEX IF NOT EXISTS idx_agent_embed_token_uses_token_at ON agent_embed_token_uses (token_id, at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_agent_embed_token_uses_ip_at ON agent_embed_token_uses (token_id, ip, at DESC)",
]


PLAN_SEEDS = [
    {
        "code": "normal",
        "name": "Normal",
        "price_usd": 12.0,
        "billing_type": "credits",
        "credits_included": 4000,
        "credits_per_pack": 4000,
        "price_subtitle": "one-time pack",
        "description": "Flexible starter credits for personal use.",
        "sort_order": 1,
        "is_highlighted": 0,
        "features_json": json.dumps(
            [
                "300 free credits when you register",
                "TTS, STT, Voice Cloning, Music, Noise Remover",
                "Voice Agents — pay-per-minute",
                "Up to 5 custom voices (Voice Design)",
                "Generation history saved for 7 days",
            ]
        ),
        "cta_label": "Buy credits",
        # Crypto: 20% more credits per dollar (400 cr/$ vs 333 cr/$ card).
        "crypto_price_usd": 20.0,
        "crypto_credits_included": 8000,
    },
    {
        "code": "premium",
        "name": "Premium",
        "price_usd": 24.0,
        "billing_type": "credits",
        # Same cr/$ rate as Normal — predictable pricing, no volume
        # discount on top of the existing crypto bonus. (Was 10K, now 8K
        # so the per-dollar rate matches Normal exactly.)
        "credits_included": 8000,
        "credits_per_pack": 8000,
        "price_subtitle": "one-time pack",
        "description": "High-volume credit pack for active creators.",
        "sort_order": 2,
        "is_highlighted": 1,
        "features_json": json.dumps(
            [
                "Everything in Normal, plus:",
                "Generation history never expires",
                "Unlimited custom voices (Voice Design)",
                "Developer API access (TTS, STT, Clone, Music, Voice Agents)",
                "Ideal for teams, creators, and production workflows",
            ]
        ),
        "cta_label": "Buy Premium Pack",
        "crypto_price_usd": 40.0,
        "crypto_credits_included": 16000,
    },
    {
        "code": "enterprise",
        "name": "Enterprise",
        "price_usd": None,
        "billing_type": "custom",
        "credits_included": 0,
        "credits_per_pack": None,
        "price_subtitle": "volume pricing",
        "description": "Custom commercial support and API access.",
        "sort_order": 3,
        "is_highlighted": 0,
        "features_json": json.dumps(
            [
                "Full API support for product and platform integration",
                "Dedicated onboarding and commercial support",
                "Private quotas and operational flexibility",
                "Built for teams, apps, and larger-scale deployment",
            ]
        ),
        "cta_label": "Talk to Sales",
    },
]


async def _ensure_column(conn: aiosqlite.Connection, table: str, column: str, ddl: str) -> None:
    cursor = await conn.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    existing = {row["name"] for row in rows}
    if column not in existing:
        await conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def seed_pricing_plans(conn: aiosqlite.Connection) -> None:
    for plan in PLAN_SEEDS:
        await conn.execute(
            """
            INSERT INTO pricing_plans
            (code, name, price_usd, billing_type, credits_included, credits_per_pack, price_subtitle,
             description, sort_order, is_highlighted, is_active, features_json, cta_label,
             crypto_price_usd, crypto_credits_included, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(code) DO UPDATE SET
                name = excluded.name,
                price_usd = excluded.price_usd,
                billing_type = excluded.billing_type,
                credits_included = excluded.credits_included,
                credits_per_pack = excluded.credits_per_pack,
                price_subtitle = excluded.price_subtitle,
                description = excluded.description,
                sort_order = excluded.sort_order,
                is_highlighted = excluded.is_highlighted,
                features_json = excluded.features_json,
                cta_label = excluded.cta_label,
                crypto_price_usd = excluded.crypto_price_usd,
                crypto_credits_included = excluded.crypto_credits_included,
                updated_at = datetime('now')
            """,
            (
                plan["code"],
                plan["name"],
                plan["price_usd"],
                plan["billing_type"],
                plan["credits_included"],
                plan["credits_per_pack"],
                plan["price_subtitle"],
                plan["description"],
                plan["sort_order"],
                plan["is_highlighted"],
                plan["features_json"],
                plan["cta_label"],
                plan.get("crypto_price_usd"),
                plan.get("crypto_credits_included"),
            ),
        )


_FTS_CREATE_SQL = """
CREATE VIRTUAL TABLE studio_voicechat_history_fts
USING fts5(
    user_text,
    bot_text,
    agent_id UNINDEXED,
    session_id UNINDEXED,
    tokenize='porter unicode61'
)
"""

_FTS_TRIGGER_AI = """
CREATE TRIGGER studio_voicechat_history_fts_ai
AFTER INSERT ON studio_voicechat_history BEGIN
    INSERT INTO studio_voicechat_history_fts
        (rowid, user_text, bot_text, agent_id, session_id)
    VALUES (new.id,
            COALESCE(new.user_text, ''),
            COALESCE(new.bot_text, ''),
            new.agent_id,
            new.session_id);
END
"""

_FTS_TRIGGER_AD = """
CREATE TRIGGER studio_voicechat_history_fts_ad
AFTER DELETE ON studio_voicechat_history BEGIN
    DELETE FROM studio_voicechat_history_fts WHERE rowid = old.id;
END
"""

_FTS_TRIGGER_AU = """
CREATE TRIGGER studio_voicechat_history_fts_au
AFTER UPDATE ON studio_voicechat_history BEGIN
    DELETE FROM studio_voicechat_history_fts WHERE rowid = old.id;
    INSERT INTO studio_voicechat_history_fts
        (rowid, user_text, bot_text, agent_id, session_id)
    VALUES (new.id,
            COALESCE(new.user_text, ''),
            COALESCE(new.bot_text, ''),
            new.agent_id,
            new.session_id);
END
"""


async def _ensure_transcript_fts(conn: aiosqlite.Connection) -> None:
    """Bring studio_voicechat_history_fts into a known-good state:
    drop + recreate + backfill if it's missing, stale, or has the
    old external-content shape.

    Splits the work into three transactions to dodge a SQLite quirk
    where CREATE VIRTUAL TABLE inside the same transaction as a
    prior DROP of the same name silently no-ops (shadow tables
    linger). Each conn.commit() ends the current implicit
    transaction so the next statement starts fresh.

    All branches log exactly one INFO line so the migration is
    traceable from the startup log.
    """
    # ── Step 1: decide if we need to rebuild ───────────────────────
    src_count = 0
    try:
        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history")
        src_count = int((await cur.fetchone())[0] or 0)
    except Exception:
        # Source table doesn't exist yet — nothing to index.
        return

    needs_rebuild = False
    rebuild_reason = ""

    cur = await conn.execute(
        "SELECT sql FROM sqlite_master "
        "WHERE type='table' AND name='studio_voicechat_history_fts'"
    )
    row = await cur.fetchone()
    if row is None:
        needs_rebuild = True
        rebuild_reason = "missing"
    else:
        try:
            existing_sql = row["sql"] or ""
        except (KeyError, IndexError, TypeError):
            existing_sql = row[0] or ""
        if "content=" in existing_sql.lower():
            needs_rebuild = True
            rebuild_reason = "external-content layout"

    if not needs_rebuild:
        try:
            cur = await conn.execute(
                "SELECT COUNT(*) FROM studio_voicechat_history_fts"
            )
            fts_count = int((await cur.fetchone())[0] or 0)
        except Exception:
            fts_count = 0
            needs_rebuild = True
            rebuild_reason = "unreadable"
        else:
            if src_count > 5 and fts_count < src_count // 2:
                needs_rebuild = True
                rebuild_reason = f"stale (fts={fts_count} src={src_count})"

    if not needs_rebuild:
        _log.info(
            "ensure_tables: transcript FTS up-to-date (src=%d)", src_count,
        )
        return

    # ── Step 2: drop + commit ──────────────────────────────────────
    # FTS5 virtual tables come with 4-5 shadow tables (suffixes
    # _data, _idx, _docsize, _config, plus _content for non-external
    # mode). DROP TABLE on the virtual table SHOULD cascade — but if
    # the prior session crashed mid-drop or hit the shadow-table
    # lingering bug we've already seen, those shadows can survive
    # and trip a "table already exists" on the next CREATE.
    #
    # Belt + suspenders: after dropping the virtual table itself,
    # we also try DROP TABLE IF EXISTS on every known shadow
    # suffix. No-op when the shadows are already gone; cleans up
    # the rare case when they aren't.
    _log.info(
        "ensure_tables: rebuilding studio_voicechat_history_fts (%s, src=%d)",
        rebuild_reason, src_count,
    )
    try:
        for stmt in (
            "DROP TRIGGER IF EXISTS studio_voicechat_history_fts_ai",
            "DROP TRIGGER IF EXISTS studio_voicechat_history_fts_ad",
            "DROP TRIGGER IF EXISTS studio_voicechat_history_fts_au",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts_data",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts_idx",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts_docsize",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts_content",
            "DROP TABLE IF EXISTS studio_voicechat_history_fts_config",
        ):
            try:
                await conn.execute(stmt)
            except Exception:
                # Per-statement guard so one stuck shadow doesn't
                # abort the rest of the cleanup.
                pass
        await conn.commit()
    except Exception:
        _log.exception("ensure_tables: FTS drop step failed")
        return

    # ── Step 3: create + commit ────────────────────────────────────
    # No IF NOT EXISTS on the CREATE — if step 2 didn't fully clean
    # up and the table still appears in sqlite_master, we want a
    # LOUD error here instead of a silent no-op that bites at
    # search time. The exception handler below logs the traceback.
    try:
        await conn.execute(_FTS_CREATE_SQL)
        await conn.commit()
        for trigger in (_FTS_TRIGGER_AI, _FTS_TRIGGER_AD, _FTS_TRIGGER_AU):
            await conn.execute(trigger)
        await conn.commit()
    except Exception:
        _log.exception("ensure_tables: FTS create step failed")
        return

    # ── Step 4: backfill from source ───────────────────────────────
    if src_count == 0:
        _log.info("ensure_tables: transcript FTS empty (no source rows yet)")
        return
    try:
        await conn.execute(
            """
            INSERT INTO studio_voicechat_history_fts
                (rowid, user_text, bot_text, agent_id, session_id)
            SELECT id,
                   COALESCE(user_text, ''),
                   COALESCE(bot_text, ''),
                   agent_id,
                   session_id
            FROM studio_voicechat_history
            """
        )
        await conn.commit()
        cur = await conn.execute(
            "SELECT COUNT(*) FROM studio_voicechat_history_fts"
        )
        final = int((await cur.fetchone())[0] or 0)
        _log.info(
            "ensure_tables: transcript FTS backfilled (%d rows)", final,
        )
    except Exception:
        _log.exception("ensure_tables: FTS backfill step failed")


async def ensure_tables() -> None:
    conn = await get_connection()
    try:
        # Rename the dubbing table to noise_remover BEFORE CREATE TABLE
        # IF NOT EXISTS runs — otherwise CREATE makes a fresh empty
        # noise_remover table next to the old populated dubbing table.
        # Only renames if dubbing exists and noise_remover doesn't.
        try:
            cur = await conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('studio_dubbing_history','studio_noise_remover_history')"
            )
            existing_names = {row["name"] for row in await cur.fetchall()}
            if "studio_dubbing_history" in existing_names and "studio_noise_remover_history" not in existing_names:
                await conn.execute("ALTER TABLE studio_dubbing_history RENAME TO studio_noise_remover_history")
        except Exception:
            # Best-effort migration; if it fails the CREATE below just
            # makes the new table empty and old data is orphaned. Logged
            # by the connection driver if it happened.
            pass

        for statement in SCHEMA_SQL:
            await conn.execute(statement)

        # ── Transcript FTS5 setup (drop-recreate-backfill) ───────────
        # Done OUTSIDE the SCHEMA_SQL loop because CREATE VIRTUAL
        # TABLE IF NOT EXISTS silently no-ops after a DROP in the
        # same transaction on some sqlite builds — the shadow
        # tables linger and the CREATE thinks it's done. Explicit
        # commit between the DROP and CREATE breaks the trap.
        #
        # Drop criteria:
        #   1. Old external-content layout (``content='studio_voicechat_history'``).
        #   2. Significantly fewer rows than the source table.
        # Either triggers a full rebuild. Both paths converge on
        # the same end state, so the recovery is the same.
        await _ensure_transcript_fts(conn)

        # Added after the table shipped — existing rows carry the job id in
        # metadata_json, so backfill from there rather than leaving them
        # ungroupable.
        await _ensure_column(conn, "studio_video_dub_history", "job_id", "job_id TEXT")
        await _ensure_column(conn, "studio_video_dub_history", "poster_s3_bucket", "poster_s3_bucket TEXT")
        await _ensure_column(conn, "studio_video_dub_history", "poster_s3_key", "poster_s3_key TEXT")
        try:
            await conn.execute(
                """
                UPDATE studio_video_dub_history
                SET job_id = json_extract(metadata_json, '$.job_id')
                WHERE job_id IS NULL
                  AND json_valid(metadata_json)
                  AND json_extract(metadata_json, '$.job_id') IS NOT NULL
                """
            )
        except Exception:
            # json1 unavailable on this SQLite build — new rows still populate
            # the column directly, only pre-existing ones stay ungrouped.
            pass

        await _ensure_column(conn, "auth_users", "plan_code", "plan_code TEXT")
        await _ensure_column(conn, "auth_users", "plan_status", "plan_status TEXT")
        await _ensure_column(conn, "auth_users", "updated_at", "updated_at TEXT")
        await _ensure_column(conn, "auth_users", "last_login_at", "last_login_at TEXT")
        # Per-user voicechat rate-limit overrides. NULL = inherit the
        # platform defaults (VOICECHAT_RATE_LIMIT_TURNS /
        # VOICECHAT_RATE_LIMIT_WINDOW_SEC env vars). Set by admins via
        # the website-usage page when enterprise / sales users need a
        # higher cap. Use 0 in either column to disable the cap
        # entirely for that user.
        await _ensure_column(
            conn, "auth_users",
            "voicechat_rate_limit_turns",
            "voicechat_rate_limit_turns INTEGER",
        )
        await _ensure_column(
            conn, "auth_users",
            "voicechat_rate_limit_window_sec",
            "voicechat_rate_limit_window_sec INTEGER",
        )
        # Per-user Developer API rate-limit override (rpm). When set,
        # takes precedence over per-key rate_limit_rpm AND the
        # API_RATE_LIMIT_REQUESTS_PER_MINUTE env default. NULL = no
        # override; the existing per-key resolution path runs. 0 =
        # uncapped (skips bucket bookkeeping entirely).
        await _ensure_column(
            conn, "auth_users",
            "api_rate_limit_rpm",
            "api_rate_limit_rpm INTEGER",
        )
        # Per-user Developer-API WebSocket-session caps. Cover the
        # voice agent (/v1/agents/{id}/session), TTS streaming
        # (/v1/voices/{id}/stream), and STT streaming (/v1/stt/stream).
        # Both NULL = use platform defaults (MAX_SESSION_OPENS_PER_MINUTE
        # _PER_ACCOUNT=10, MAX_CONCURRENT_SESSIONS_PER_ACCOUNT=5). 0 =
        # uncapped (skip the per-account checks entirely).
        await _ensure_column(
            conn, "auth_users",
            "api_ws_opens_per_minute",
            "api_ws_opens_per_minute INTEGER",
        )
        await _ensure_column(
            conn, "auth_users",
            "api_ws_concurrent",
            "api_ws_concurrent INTEGER",
        )
        # voice_call_logs.recording_bucket — added after the table
        # first shipped because we initially stored a local filesystem
        # path and migrated to object storage (R2 / Hippius). Old rows
        # (filesystem-era) will have NULL here; the audio endpoint
        # treats those as "no longer accessible" since the disk path
        # has been wiped, which is correct.
        await _ensure_column(
            conn, "voice_call_logs",
            "recording_bucket",
            "recording_bucket TEXT",
        )
        await conn.execute("UPDATE auth_users SET plan_code = COALESCE(plan_code, 'normal')")
        await conn.execute("UPDATE auth_users SET plan_status = COALESCE(plan_status, 'active')")
        await conn.execute("UPDATE auth_users SET updated_at = COALESCE(updated_at, created_at, datetime('now'))")
        await _ensure_column(conn, "pricing_plans", "crypto_price_usd", "crypto_price_usd REAL")
        await _ensure_column(conn, "pricing_plans", "crypto_credits_included", "crypto_credits_included INTEGER")
        await _ensure_column(conn, "payment_sessions", "mode", "mode TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_checkout_session_id", "stripe_checkout_session_id TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_customer_id", "stripe_customer_id TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_subscription_id", "stripe_subscription_id TEXT")
        await _ensure_column(conn, "payment_sessions", "completed_at", "completed_at TEXT")
        await _ensure_column(conn, "payment_sessions", "canceled_at", "canceled_at TEXT")
        await _ensure_column(conn, "payments", "stripe_checkout_session_id", "stripe_checkout_session_id TEXT")
        await _ensure_column(conn, "payments", "stripe_payment_intent_id", "stripe_payment_intent_id TEXT")
        await _ensure_column(conn, "payments", "stripe_invoice_id", "stripe_invoice_id TEXT")
        await _ensure_column(conn, "payments", "stripe_subscription_id", "stripe_subscription_id TEXT")
        await _ensure_column(conn, "payments", "stripe_customer_id", "stripe_customer_id TEXT")
        await _ensure_column(conn, "payments", "stripe_event_id", "stripe_event_id TEXT")
        await _ensure_column(conn, "payments", "mode", "mode TEXT")
        await _ensure_column(conn, "payments", "billing_period_start", "billing_period_start TEXT")
        await _ensure_column(conn, "payments", "billing_period_end", "billing_period_end TEXT")
        await _ensure_column(conn, "payments", "credits_applied_at", "credits_applied_at TEXT")
        await _ensure_column(conn, "api_keys", "tier", "tier TEXT")
        await _ensure_column(conn, "api_keys", "rate_limit_rpm", "rate_limit_rpm INTEGER")
        # Notifications got an optional banner-image field after the
        # initial ship. Backfill nullable so historical rows remain
        # valid; new rows default to NULL (= no image).
        await _ensure_column(conn, "notifications", "image_url", "image_url TEXT")
        # session_id is required to distinguish a single voice "call"
        # (one WS open → multiple turns) from raw turn counts. Old rows
        # have NULL here — the stats endpoint ignores them when
        # counting distinct calls. agent_id captures which agent the
        # call was against (NULL = Logos / Vocence Assistant).
        await _ensure_column(
            conn, "studio_voicechat_history", "session_id", "session_id TEXT"
        )
        await _ensure_column(
            conn, "studio_voicechat_history", "agent_id", "agent_id TEXT"
        )
        # Public-playbook play counter. Added after the table shipped, so
        # existing rows need backfilling to 0 (NOT NULL needs a default).
        await _ensure_column(conn, "playbooks", "play_count", "play_count INTEGER NOT NULL DEFAULT 0")
        # ``source`` distinguishes how the saved voice was created:
        #   'designed' — generated via Voice Design (LLM prompt → TTS preview)
        #   'cloned'   — uploaded by the user as a real-voice reference clip
        # Both reuse the same row shape (ref_script + audio_s3_*); the
        # designed-only fields (voice_description, revised_instruction,
        # chute_slug, etc.) are blank for cloned rows. Frontend uses the
        # column to render a badge so users can tell the two apart.
        await _ensure_column(
            conn,
            "studio_user_designed_voices",
            "source",
            "source TEXT NOT NULL DEFAULT 'designed'",
        )
        await _ensure_column(
            conn,
            "studio_user_designed_voices",
            "source_language",
            "source_language TEXT",
        )

        # Email + password auth columns on auth_users. Google-signup users
        # have password_hash=NULL and email_verified=1 (Google asserts the
        # email is verified). Email-signup users have password_hash set
        # and email_verified=0 until they click the verification link.
        # All timestamps are ISO-8601 strings to match existing columns;
        # the lockout / token-expiry helpers in auth_security.py compare
        # them via datetime.fromisoformat for monotonic correctness.
        await _ensure_column(conn, "auth_users", "password_hash", "password_hash TEXT")
        await _ensure_column(conn, "auth_users", "email_verified", "email_verified INTEGER NOT NULL DEFAULT 1")
        await _ensure_column(conn, "auth_users", "verification_token_hash", "verification_token_hash TEXT")
        await _ensure_column(conn, "auth_users", "verification_token_expires_at", "verification_token_expires_at TEXT")
        await _ensure_column(conn, "auth_users", "failed_login_attempts", "failed_login_attempts INTEGER NOT NULL DEFAULT 0")
        await _ensure_column(conn, "auth_users", "locked_until", "locked_until TEXT")
        await _ensure_column(conn, "auth_users", "password_reset_token_hash", "password_reset_token_hash TEXT")
        await _ensure_column(conn, "auth_users", "password_reset_expires_at", "password_reset_expires_at TEXT")
        await _ensure_column(conn, "auth_users", "password_changed_at", "password_changed_at TEXT")
        # Stashed at signup so the verify endpoint can pass it into
        # validate_referral. Without this, every email-signup referral
        # was silently dropped (the device-fingerprint gate refused
        # None). Audit finding H1.
        await _ensure_column(conn, "auth_users", "signup_device_fingerprint", "signup_device_fingerprint TEXT")
        # Per-account cooldown on verification-email resends. Without
        # this an attacker can rotate IPs to bomb a victim's inbox
        # with verification emails. Audit finding M40 — checked on
        # /resend-verify and on the login auto-resend path. Updated
        # every time we successfully issue a new verification token.
        await _ensure_column(conn, "auth_users", "last_verification_resend_at", "last_verification_resend_at TEXT")
        # Lookups by reset / verification token hash MUST be O(1) — the
        # token is the only thing the request bears, and a table scan
        # leaks timing information about user count under load.
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_auth_users_verification_token "
            "ON auth_users(verification_token_hash) WHERE verification_token_hash IS NOT NULL"
        )
        await conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_auth_users_reset_token "
            "ON auth_users(password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL"
        )

        # Referral system columns on auth_users.
        await _ensure_column(conn, "auth_users", "referral_code", "referral_code TEXT")
        await conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_users_referral_code "
            "ON auth_users(referral_code) WHERE referral_code IS NOT NULL"
        )
        await _ensure_column(conn, "auth_users", "referred_by", "referred_by TEXT")
        await _ensure_column(conn, "auth_users", "referral_activated", "referral_activated INTEGER NOT NULL DEFAULT 0")

        # Referral device tracking (anti-abuse: one referral per device).
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS referral_devices (
                device_fingerprint TEXT PRIMARY KEY,
                referral_code TEXT NOT NULL,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)

        for statement in INDEX_SQL:
            await conn.execute(statement)

        await seed_pricing_plans(conn)
        await conn.commit()
    finally:
        await conn.close()


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def generate_api_key() -> tuple[str, str]:
    """
    Generate API key in format voc_live_<token>.
    Returns (plain_key, prefix).
    """
    token = secrets.token_urlsafe(32).replace("-", "").replace("_", "")
    plain = f"voc_live_{token}"
    return plain, plain[:16]


async def atomic_deduct_credits(
    conn: aiosqlite.Connection,
    *,
    user_id: str,
    cost: int,
) -> int | None:
    """Atomically deduct credits. Returns new balance, or None if insufficient.

    Uses UPDATE ... WHERE credits >= cost to prevent races where concurrent
    requests all pass a separate credit check then all deduct."""
    cursor = await conn.execute(
        "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
        "WHERE id = ? AND credits >= ?",
        (cost, user_id, cost),
    )
    if cursor.rowcount == 0:
        return None
    row = await (await conn.execute(
        "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
    )).fetchone()
    return int(row["credits"]) if row else 0


async def record_credit_transaction(
    conn: aiosqlite.Connection,
    *,
    user_id: str,
    transaction_type: str,
    amount: int,
    balance_after: int,
    description: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    transaction_id = uuid.uuid4().hex
    await conn.execute(
        """
        INSERT INTO credit_transactions
        (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            transaction_id,
            user_id,
            transaction_type,
            amount,
            balance_after,
            description,
            reference_type,
            reference_id,
            json.dumps(metadata or {}),
        ),
    )
    return transaction_id


async def refresh_daily_usage_for_day(conn: aiosqlite.Connection, day: str) -> None:
    gen_row = await (await conn.execute(
        """
        SELECT COUNT(*) AS generation_count,
               COUNT(DISTINCT user_id) AS unique_users
        FROM studio_tts_history
        WHERE date(created_at) = date(?)
          AND status = 'completed'
        """,
        (day,),
    )).fetchone()
    pay_row = await (await conn.execute(
        """
        SELECT COALESCE(SUM(amount_usd), 0) AS revenue_usd,
               COALESCE(SUM(credits_granted), 0) AS credits_purchased
        FROM payments
        WHERE date(created_at) = date(?)
          AND status IN ('paid', 'completed')
        """,
        (day,),
    )).fetchone()
    credit_row = await (await conn.execute(
        """
        SELECT COALESCE(SUM(-amount), 0) AS credits_used
        FROM credit_transactions
        WHERE date(created_at) = date(?)
          AND amount < 0
        """,
        (day,),
    )).fetchone()
    await conn.execute(
        """
        INSERT INTO daily_usage_stats
        (day, tts_generation_count, unique_users, credits_used, revenue_usd, credits_purchased, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(day) DO UPDATE SET
            tts_generation_count = excluded.tts_generation_count,
            unique_users = excluded.unique_users,
            credits_used = excluded.credits_used,
            revenue_usd = excluded.revenue_usd,
            credits_purchased = excluded.credits_purchased,
            updated_at = datetime('now')
        """,
        (
            day,
            int(gen_row["generation_count"] or 0),
            int(gen_row["unique_users"] or 0),
            int(credit_row["credits_used"] or 0),
            float(pay_row["revenue_usd"] or 0),
            int(pay_row["credits_purchased"] or 0),
        ),
    )


async def log_admin_action(
    conn: aiosqlite.Connection,
    *,
    admin_email: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO admin_audit_log (id, admin_email, action, target_type, target_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            uuid.uuid4().hex,
            admin_email,
            action,
            target_type,
            target_id,
            json.dumps(metadata or {}),
        ),
    )


async def migrate_legacy_website_data(pg_conn: asyncpg.Connection) -> None:
    """
    Best-effort migration of website-owned legacy tables from PostgreSQL into
    website.db. Safe to run repeatedly.
    """
    conn = await get_connection()
    try:
        blog_count = await (await conn.execute("SELECT COUNT(*) AS n FROM blog_posts")).fetchone()
        if int(blog_count["n"] or 0) == 0:
            try:
                blog_rows = await pg_conn.fetch(
                    """
                    SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
                    FROM blog_posts
                    ORDER BY created_at ASC
                    """
                )
            except Exception:
                blog_rows = []
            for row in blog_rows:
                await conn.execute(
                    """
                    INSERT OR IGNORE INTO blog_posts
                    (id, title, excerpt, category, date, read_time, image, content, featured, is_published, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        str(row["id"]),
                        row["title"],
                        row["excerpt"],
                        row["category"],
                        row["date"],
                        row["read_time"] or "5 min read",
                        row["image"],
                        row["content"],
                        int(bool(row["featured"])),
                        row["created_at"].isoformat() if row["created_at"] else None,
                        row["created_at"].isoformat() if row["created_at"] else None,
                    ),
                )

        studio_count = await (await conn.execute("SELECT COUNT(*) AS n FROM studio_tts_history")).fetchone()
        if int(studio_count["n"] or 0) == 0:
            try:
                studio_rows = await pg_conn.fetch(
                    """
                    SELECT id, user_id, miner_hotkey, model_name, prompt_text, style_instruction,
                           audio_s3_bucket, audio_s3_key, expires_at, created_at
                    FROM studio_tts_history
                    ORDER BY created_at ASC
                    """
                )
            except Exception:
                studio_rows = []
            for row in studio_rows:
                await conn.execute(
                    """
                    INSERT OR IGNORE INTO studio_tts_history
                    (id, user_id, miner_hotkey, model_name, prompt_text, style_instruction,
                     audio_s3_bucket, audio_s3_key, expires_at, credits_used, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 'completed', ?)
                    """,
                    (
                        int(row["id"]),
                        row["user_id"],
                        row["miner_hotkey"],
                        row["model_name"],
                        row["prompt_text"],
                        row["style_instruction"] or "neutral voice",
                        row["audio_s3_bucket"],
                        row["audio_s3_key"],
                        row["expires_at"].isoformat() if row["expires_at"] else None,
                        row["created_at"].isoformat() if row["created_at"] else None,
                    ),
                )
        await conn.commit()
    finally:
        await conn.close()
