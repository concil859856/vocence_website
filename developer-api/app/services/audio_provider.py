"""
Developer API audio provider helpers (TTS + STT + storage).
"""

from __future__ import annotations

import asyncio
import base64
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath

import aiohttp
from minio import Minio

CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
CHUTES_WHISPER_STT_URL = os.environ.get(
    "CHUTES_WHISPER_STT_URL",
    "https://chutes-whisper-large-v3.chutes.ai/transcribe",
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
    payload = {"text": text or "Hello.", "instruction": instruction or "neutral voice"}
    headers = {"Content-Type": "application/json"}
    if CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                _chute_speak_url(chute_slug),
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


async def transcribe_audio(audio_bytes: bytes, language: str | None = None) -> tuple[dict | None, str]:
    payload: dict[str, str] = {
        "audio_b64": base64.b64encode(audio_bytes).decode("utf-8"),
    }
    if language:
        payload["language"] = language
    headers = {"Content-Type": "application/json"}
    if CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                CHUTES_WHISPER_STT_URL,
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

