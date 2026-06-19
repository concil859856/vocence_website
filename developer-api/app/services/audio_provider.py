"""
Developer API audio provider helpers (TTS + STT + storage).

STT and PromptTTS PROXY to the dashboard-backend rather than
talking to GPU pods directly. The dashboard is the single source
of truth for the ops_pool pod registry (which is hydrated by
background pollers running in the dashboard's lifespan); a separate
process can't reliably reproduce that state. The dashboard's
``/api/dashboard/studio/transcribe`` and ``/voice-design/speak``
routes already do all the pod-dispatch correctly and are what the
production UI uses — proxying to them keeps the two surfaces in
lock-step at the cost of one extra in-process HTTP hop.

The voice-clone REST path stays direct (uses ``voice_clone_client``
which talks to the chute URL configured in env) because that flow
predates pod-pool migration; it can be migrated next.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import uuid
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath

import aiohttp
from minio import Minio

_log = logging.getLogger(__name__)

# URL of the dashboard-backend on the same host. The dev-api proxies
# STT + PromptTTS calls here. Defaults to ``http://127.0.0.1:8083``
# (production loopback); override via DASHBOARD_BASE_URL if the two
# services don't share a host.
DASHBOARD_BASE_URL = (os.environ.get("DASHBOARD_BASE_URL") or "http://127.0.0.1:8083").rstrip("/")
# Same shared secret used for the voice-agent WS proxy. The dashboard
# verifies it via the ``is_internal_proxy`` dependency and accepts the
# user_id forwarded from this layer.
INTERNAL_SERVICE_TOKEN = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()

CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
# STT endpoint. We run our own Qwen3-ASR server (POST /transcribe with
# JSON {audio_b64, language?}). The env var is still named
# CHUTES_WHISPER_STT_URL for back-compat — the underlying service is
# Qwen3-ASR. Falls back to STUDIO_STT_URL so a single var on the
# dashboard-backend powers both services.
CHUTES_WHISPER_STT_URL = (
    os.environ.get("CHUTES_WHISPER_STT_URL")
    or os.environ.get("STUDIO_STT_URL")
    or ""
)
STUDIO_TTS_BUCKET = os.environ.get("STUDIO_TTS_BUCKET", "studio-tts")
STUDIO_TTS_EXPIRY_DAYS = int(os.environ.get("STUDIO_TTS_EXPIRY_DAYS", "7"))
PRESIGNED_EXPIRY_SECONDS = min(7 * 24 * 3600, STUDIO_TTS_EXPIRY_DAYS * 24 * 3600)

# ---------- Bucket provider: "r2" (default) or "hippius" ----------
BUCKET_PROVIDER = (os.environ.get("BUCKET_PROVIDER") or "r2").strip().lower()

# Cloudflare R2 (S3-compatible)
R2_ACCOUNT_ID = (os.environ.get("R2_ACCOUNT_ID") or "").strip()
R2_ACCESS_KEY_ID = (os.environ.get("R2_ACCESS_KEY_ID") or "").strip()
R2_SECRET_ACCESS_KEY = (os.environ.get("R2_SECRET_ACCESS_KEY") or "").strip()
R2_BUCKET_NAME = (os.environ.get("R2_BUCKET_NAME") or STUDIO_TTS_BUCKET).strip()
R2_PUBLIC_DOMAIN = (os.environ.get("R2_PUBLIC_DOMAIN") or "").strip()

# Hippius S3 (legacy)
HIPPIUS_ENDPOINT = os.environ.get("HIPPIUS_ENDPOINT", "s3.hippius.com")
HIPPIUS_OWNER_ACCESS_KEY = os.environ.get("HIPPIUS_OWNER_ACCESS_KEY") or os.environ.get("HIPPIUS_ACCESS_KEY", "")
HIPPIUS_OWNER_SECRET_KEY = os.environ.get("HIPPIUS_OWNER_SECRET_KEY") or os.environ.get("HIPPIUS_SECRET_KEY", "")


def _chute_speak_url(slug: str) -> str:
    return f"https://{slug}.chutes.ai/speak"


def _minio_client() -> Minio:
    """S3-compatible client — points to R2 or Hippius based on BUCKET_PROVIDER."""
    if BUCKET_PROVIDER == "r2":
        endpoint = f"{R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
        return Minio(
            endpoint,
            access_key=R2_ACCESS_KEY_ID or "",
            secret_key=R2_SECRET_ACCESS_KEY or "",
            secure=True,
            region="auto",
        )
    return Minio(
        HIPPIUS_ENDPOINT,
        access_key=HIPPIUS_OWNER_ACCESS_KEY or "",
        secret_key=HIPPIUS_OWNER_SECRET_KEY or "",
        secure=True,
        region="decentralized",
    )


def _active_bucket() -> str:
    if BUCKET_PROVIDER == "r2":
        return R2_BUCKET_NAME
    return STUDIO_TTS_BUCKET


def _dashboard_internal_headers(user_id: str) -> dict[str, str]:
    """Headers the dashboard's ``is_internal_proxy`` dependency expects.
    Without these the dashboard rejects loopback requests as unauthenticated
    even though we're on the same box."""
    return {
        "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
        "X-Internal-User-Id": user_id,
    }


async def synthesize_speak(
    chute_slug: str,
    text: str,
    instruction: str,
    *,
    user_id: str | None = None,  # noqa: ARG001 — kept for call-site symmetry with transcribe_audio
) -> tuple[bytes | None, str]:
    """PromptTTS — "speak this text in a voice with these characteristics".

    There is NO dashboard endpoint for this exact shape. The
    dashboard's voice-design routes are different concepts:
      • /voice-design/preview — DESIGNS a voice from a description and
        returns sample audio (LLM-proposed sample line, not the caller's
        text). Charges 70 credits per call.
      • /voice-design/speak   — clones a saved designed voice with
        caller's text. Needs an INTEGER voice_id of a saved design.

    So PromptTTS still uses its direct chute slug (the legacy path).
    When ``API_TTS_PROVIDER_<N>_CHUTE_SLUG`` env vars aren't set,
    return a clean 503-style error rather than leaking env-var names
    (the user is an API customer, not the operator).
    """
    if not chute_slug:
        return None, "voice synthesis temporarily unavailable"
    pod_url = _chute_speak_url(chute_slug)
    headers = {"Content-Type": "application/json"}
    if CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
    payload = {"text": text or "Hello.", "instruction": instruction or "neutral voice"}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                pod_url,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:200] if body else ""
                    return None, f"provider returned {resp.status}" + (f": {err}" if err else "")
                if not body:
                    return None, "provider returned no audio"
                return body, ""
    except asyncio.TimeoutError:
        return None, "provider request timed out"
    except Exception as exc:
        return None, str(exc)


async def transcribe_audio(
    audio_bytes: bytes,
    language: str | None = None,
    *,
    user_id: str | None = None,
) -> tuple[dict | None, str]:
    """STT — proxy to the dashboard's transcribe endpoint.

    Replaces the previous direct-chute call (and the short-lived
    in-process ops_pool import attempt that broke for the same
    reason as synthesize_speak: pool state is hydrated by the
    dashboard's lifespan pollers and not reachable from here).

    The dashboard's ``/api/dashboard/studio/transcribe`` already does
    the pod dispatch (asr_streaming_rt → stt fallback), credit
    deduction, duration capping, and provider name selection. We just
    forward.
    """
    if not user_id:
        return None, "transcribe_audio requires a user_id when proxying"
    if not INTERNAL_SERVICE_TOKEN:
        return None, "internal service token not configured on developer-api"
    url = f"{DASHBOARD_BASE_URL}/api/dashboard/studio/transcribe"
    form = aiohttp.FormData()
    form.add_field("user_id", user_id)
    if language:
        form.add_field("language", language)
    form.add_field(
        "audio_file", audio_bytes,
        filename="audio.wav", content_type="audio/wav",
    )
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=_dashboard_internal_headers(user_id),
                data=form,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:300] if body else ""
                    return None, f"dashboard returned {resp.status}" + (f": {err}" if err else "")
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    return None, "dashboard returned non-JSON transcription response"
                if not isinstance(data, dict):
                    return None, "dashboard returned unsupported transcription response"
                return data, ""
    except asyncio.TimeoutError:
        return None, "dashboard request timed out"
    except Exception as exc:
        return None, str(exc)


def _ensure_bucket(client: Minio, bucket: str) -> None:
    if BUCKET_PROVIDER == "r2":
        return  # R2 buckets are created in Cloudflare dashboard
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def upload_wav_to_hippius(user_id: str, wav_bytes: bytes, subdir: str = "") -> tuple[str, str, datetime]:
    """Upload WAV bytes to the active bucket (R2 or Hippius). Returns (bucket, key, expires_at).

    Args:
        subdir: Optional subdirectory under user_id, e.g. "tts", "music", "clone".
    """
    from io import BytesIO

    bucket = _active_bucket()
    client = _minio_client()
    _ensure_bucket(client, bucket)
    if subdir:
        key = f"{user_id}/{subdir}/{uuid.uuid4().hex}.wav"
    else:
        key = f"{user_id}/{uuid.uuid4().hex}.wav"
    expires_at = datetime.now(timezone.utc) + timedelta(days=STUDIO_TTS_EXPIRY_DAYS)
    client.put_object(
        bucket,
        key,
        BytesIO(wav_bytes),
        length=len(wav_bytes),
        content_type="audio/wav",
    )
    return bucket, key, expires_at


def get_presigned_url(bucket: str, key: str, expires_at: datetime) -> str | None:
    """Return a presigned URL for the audio object.

    Developer API always uses presigned URLs (7-day expiry) — even for premium
    users. Public domain URLs are reserved for Studio premium users only.
    """
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    client = _minio_client()
    now = datetime.now(timezone.utc)
    expiry_sec = min(PRESIGNED_EXPIRY_SECONDS, max(0, int((expires_at - now).total_seconds())))
    if expiry_sec <= 0:
        return None
    try:
        filename = PurePosixPath(key).name or "vocence-tts.wav"
        return client.presigned_get_object(
            bucket,
            key,
            expires=timedelta(seconds=expiry_sec),
            response_headers={"response-content-disposition": f'attachment; filename="{filename}"'},
        )
    except Exception:
        return None

