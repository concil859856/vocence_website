"""
Studio TTS service: call miner Chutes /speak, upload WAV to Hippius, presigned URLs.

This module is part of vocence_website (dashboard-backend) and does not import
from the vocence package. Chutes/Hippius usage is aligned with the Vocence subnet
(api.chutes.ai + {slug}.chutes.ai; Hippius owner S3).

Chutes:
  - Chute metadata: GET https://api.chutes.ai/chutes/{chute_id} -> response has "slug".
  - Miner invoke: POST https://{slug}.chutes.ai/speak (slug = subdomain).
  - Auth: Bearer CHUTES_AUTH_KEY for both API and /speak.

Hippius:
  - Endpoint: s3.hippius.com (secure, region=decentralized).
  - Owner credentials: HIPPIUS_OWNER_* or HIPPIUS_ACCESS_KEY / HIPPIUS_SECRET_KEY.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone

import aiohttp
from minio import Minio

# Chutes: API base for fetching chute details (GET /chutes/{chute_id})
CHUTES_BASE_URL = os.environ.get("CHUTES_BASE_URL", "https://api.chutes.ai")
CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
# Miner endpoint: https://{slug}.chutes.ai/speak (slug from API response)
CHUTE_TTS_PATH = "/speak"


def _chute_speak_url(slug: str) -> str:
    """Build miner TTS URL from chute slug. Rule: https://{slug}.chutes.ai/speak (chutes.ai)."""
    return f"https://{slug}.chutes.ai{CHUTE_TTS_PATH}"


STUDIO_TTS_BUCKET = os.environ.get("STUDIO_TTS_BUCKET", "studio-tts")
# Hippius S3: s3.hippius.com, secure, region decentralized (owner bucket)
HIPPIUS_ENDPOINT = os.environ.get("HIPPIUS_ENDPOINT", "s3.hippius.com")
HIPPIUS_OWNER_ACCESS_KEY = os.environ.get("HIPPIUS_OWNER_ACCESS_KEY") or os.environ.get("HIPPIUS_ACCESS_KEY", "")
HIPPIUS_OWNER_SECRET_KEY = os.environ.get("HIPPIUS_OWNER_SECRET_KEY") or os.environ.get("HIPPIUS_SECRET_KEY", "")
STUDIO_TTS_EXPIRY_DAYS = int(os.environ.get("STUDIO_TTS_EXPIRY_DAYS", "7"))
PRESIGNED_EXPIRY_SECONDS = min(7 * 24 * 3600, STUDIO_TTS_EXPIRY_DAYS * 24 * 3600)


def _minio_client() -> Minio:
    """Minio client for Hippius (owner credentials, s3.hippius.com)."""
    return Minio(
        HIPPIUS_ENDPOINT,
        access_key=HIPPIUS_OWNER_ACCESS_KEY or "",
        secret_key=HIPPIUS_OWNER_SECRET_KEY or "",
        secure=True,
        region="decentralized",
    )


async def fetch_chute_slug(chute_id: str) -> str | None:
    """Get chute slug from Chutes API: GET {CHUTES_BASE_URL}/chutes/{chute_id}, response slug."""
    url = f"{CHUTES_BASE_URL}/chutes/{chute_id}"
    headers = {}
    if CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers or None, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
                return data.get("slug")
    except Exception:
        return None


async def synthesize_speak(chute_slug: str, text: str, instruction: str) -> bytes | None:
    """POST to https://{slug}.chutes.ai/speak with JSON { text, instruction }; returns WAV bytes or None."""
    url = _chute_speak_url(chute_slug)
    payload = {"text": text or "Hello.", "instruction": instruction or "neutral voice"}
    headers = {"Content-Type": "application/json"}
    if CHUTES_AUTH_KEY:
        headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                if resp.status != 200:
                    return None
                return await resp.read()
    except Exception:
        return None


def ensure_bucket(client: Minio, bucket: str) -> None:
    """Create bucket if it does not exist (Hippius/S3)."""
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def upload_wav_to_hippius(user_id: str, wav_bytes: bytes) -> tuple[str, str, datetime]:
    """Upload WAV bytes to Hippius studio bucket. Key: {user_id}/{uuid}.wav. Returns (bucket, key, expires_at)."""
    from io import BytesIO

    client = _minio_client()
    ensure_bucket(client, STUDIO_TTS_BUCKET)
    key = f"{user_id}/{uuid.uuid4().hex}.wav"
    expires_at = datetime.now(timezone.utc) + timedelta(days=STUDIO_TTS_EXPIRY_DAYS)
    client.put_object(
        STUDIO_TTS_BUCKET,
        key,
        BytesIO(wav_bytes),
        length=len(wav_bytes),
        content_type="audio/wav",
    )
    return STUDIO_TTS_BUCKET, key, expires_at


def get_presigned_url(bucket: str, key: str, expires_at: datetime) -> str | None:
    """Generate presigned GET URL; validity capped by expires_at (7 days from creation)."""
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    client = _minio_client()
    now = datetime.now(timezone.utc)
    expiry_sec = min(
        PRESIGNED_EXPIRY_SECONDS,
        max(0, int((expires_at - now).total_seconds())),
    )
    if expiry_sec <= 0:
        return None
    try:
        return client.presigned_get_object(bucket, key, expires=timedelta(seconds=expiry_sec))
    except Exception:
        return None
