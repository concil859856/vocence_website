"""
Developer API audio provider helpers (TTS + STT + storage).
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import sys
import uuid
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

import aiohttp
from minio import Minio

_log = logging.getLogger(__name__)

# Allow the dev-api to import the dashboard-backend's ``ops.pool`` and
# ``sample_voice_loader`` modules. In production both checkouts live
# side-by-side under ``/deployment/vocence_website/`` (sibling
# directories); locally they're under ``/workspace/...``. The dashboard
# is the source of truth for the GPU pod registry — sharing the
# same SQLite DB the dashboard writes to. Without this, the dev-api
# keeps hitting its legacy hardcoded CHUTES_* chute URLs (mostly dead
# now that pod deployment moved to the admin/ops form).
_DASHBOARD_BACKEND_PATH = (
    Path(__file__).resolve().parent.parent.parent.parent / "dashboard-backend"
)
if _DASHBOARD_BACKEND_PATH.is_dir() and str(_DASHBOARD_BACKEND_PATH) not in sys.path:
    sys.path.insert(0, str(_DASHBOARD_BACKEND_PATH))


def _ops_pool():
    """Lazy-import — the heavy ``ops.pool`` module is only loaded
    when we actually need it. Returns ``None`` if the dashboard's
    ops module isn't importable (deployments that ship the dev-api
    without a sibling dashboard checkout)."""
    try:
        from ops import pool as gpu_pool  # type: ignore[import-not-found]
        return gpu_pool
    except Exception as exc:  # noqa: BLE001
        _log.debug("ops.pool unavailable from dev-api: %s", exc)
        return None

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


async def synthesize_speak(chute_slug: str, text: str, instruction: str) -> tuple[bytes | None, str]:
    """PromptTTS — "speak" with a text description of the desired voice.

    Same migration story as ``transcribe_audio``: the dashboard now
    dispatches to ``voice_design`` pods via ``ops_pool.pick_pod``, but
    the dev-api kept hitting hardcoded chute slugs from
    ``API_TTS_PROVIDER_<N>_CHUTE_SLUG`` env vars. Most production
    deployments left those env vars empty after moving pod registration
    to the admin/ops form, so this endpoint returned 502 on every call.

    Dispatch order:
      1. ops_pool voice_design pod (matches what /api/dashboard/studio
         uses internally and what works in the production UI)
      2. Fall back to the legacy ``{chute_slug}.chutes.ai/speak`` URL
         when no voice_design pod is registered — covers single-host
         dev environments that ship the chute slug via .env.
    """
    payload = {"text": text or "Hello.", "instruction": instruction or "neutral voice"}

    pod_cm = None
    pod_url: str | None = None
    pod_key: str | None = None

    gp = _ops_pool()
    if gp is not None:
        try:
            if gp.online_pod_count("voice_design") > 0:
                pod_cm = gp.pick_pod("voice_design")
                pod = await pod_cm.__aenter__()
                pod_url = pod.url.rstrip("/") + "/speak"
                pod_key = pod.api_key or None
        except Exception as e:  # noqa: BLE001
            try:
                from ops.pool import NoCapacity  # type: ignore[import-not-found]
                if isinstance(e, NoCapacity):
                    return None, "voice synthesis temporarily unavailable (fleet busy)"
            except ImportError:
                pass
            _log.warning("ops_pool voice_design dispatch failed, falling back: %s", e)

    if pod_url is None and chute_slug:
        pod_url = _chute_speak_url(chute_slug)

    if not pod_url:
        return None, "voice synthesis temporarily unavailable"

    headers = {"Content-Type": "application/json"}
    if pod_key:
        headers["X-API-Key"] = pod_key
    elif CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"

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
    finally:
        if pod_cm is not None:
            with suppress(Exception):
                await pod_cm.__aexit__(None, None, None)


async def transcribe_audio(audio_bytes: bytes, language: str | None = None) -> tuple[dict | None, str]:
    # The dashboard migrated STT dispatch from hardcoded chute URLs to
    # the ops_pool registry — operators deploy STT pods via /admin/ops
    # and the pool tracks them. The dev-api was never updated and kept
    # calling its legacy ``CHUTES_WHISPER_STT_URL`` env var (a chute
    # slug that's mostly decommissioned now — the user-facing symptom
    # is every ``client.stt.transcribe`` returning 502). Mirror the
    # dashboard's dispatch logic here:
    #   1. Prefer ``asr_streaming_rt`` pods (modern, POST /v1/transcribe)
    #   2. Fall back to legacy ``stt`` pods (POST /transcribe)
    #   3. Final fallback: the env-var URL, for deployments that
    #      haven't set up the ops pool at all.
    b64 = base64.b64encode(audio_bytes).decode("utf-8")
    payload: dict[str, str] = {
        "audio_base64": b64,  # Qwen3-ASR / asr_streaming_rt shape
        "audio_b64": b64,     # legacy Whisper shape — both keys for safety
    }
    if language:
        payload["language"] = language

    ops_url: str | None = None
    ops_api_key: str | None = None
    pod_cm = None

    gp = _ops_pool()
    if gp is not None:
        try:
            target = None
            if gp.online_pod_count("asr_streaming_rt") > 0:
                target = ("asr_streaming_rt", "/v1/transcribe")
            elif gp.online_pod_count("stt") > 0:
                target = ("stt", "/transcribe")
            if target is not None:
                svc_name, path = target
                pod_cm = gp.pick_pod(svc_name)
                pod = await pod_cm.__aenter__()
                ops_url = pod.url.rstrip("/") + path
                ops_api_key = pod.api_key or None
        except Exception as e:  # noqa: BLE001
            # Translate NoCapacity to a clear user-facing string; everything
            # else falls through to the legacy CHUTES_WHISPER_STT_URL path.
            try:
                from ops.pool import NoCapacity  # type: ignore[import-not-found]
                if isinstance(e, NoCapacity):
                    return None, "stt fleet busy (all pods at capacity)"
            except ImportError:
                pass
            _log.warning("ops_pool dispatch failed, falling back to legacy URL: %s", e)

    target_url = ops_url or CHUTES_WHISPER_STT_URL
    if not target_url:
        return None, "speech recognition temporarily unavailable"

    headers = {"Content-Type": "application/json"}
    auth_key = ops_api_key or CHUTES_AUTH_KEY
    if auth_key:
        # ops pod uses X-API-Key; legacy chute uses Authorization Bearer.
        # Send both — pods ignore the one they don't recognize.
        if ops_api_key:
            headers["X-API-Key"] = ops_api_key
        else:
            headers["Authorization"] = f"Bearer {auth_key}"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                target_url,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:300] if body else ""
                    return None, f"provider returned {resp.status}" + (f": {err}" if err else "")
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    return None, "provider returned non-JSON transcription response"
                if isinstance(data, list):
                    first = data[0] if data else {}
                    if not isinstance(first, dict):
                        return None, "provider returned unsupported list response"
                    return first, ""
                if not isinstance(data, dict):
                    return None, "provider returned unsupported JSON response"
                return data, ""
    except asyncio.TimeoutError:
        return None, "provider request timed out"
    except Exception as exc:
        return None, str(exc)
    finally:
        # Release the ops_pool slot. The dispatcher's per-pod in_flight
        # counter (the one /admin/ops graphs) leaks if we forget this.
        if pod_cm is not None:
            with suppress(Exception):
                await pod_cm.__aexit__(None, None, None)


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

