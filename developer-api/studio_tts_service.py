"""
Developer API TTS helpers (shared behavior with dashboard backend).
"""

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import PurePosixPath

import aiohttp
from minio import Minio

CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
STUDIO_TTS_BUCKET = os.environ.get("STUDIO_TTS_BUCKET", "studio-tts")
HIPPIUS_ENDPOINT = os.environ.get("HIPPIUS_ENDPOINT", "s3.hippius.com")
HIPPIUS_OWNER_ACCESS_KEY = os.environ.get("HIPPIUS_OWNER_ACCESS_KEY") or os.environ.get("HIPPIUS_ACCESS_KEY", "")
HIPPIUS_OWNER_SECRET_KEY = os.environ.get("HIPPIUS_OWNER_SECRET_KEY") or os.environ.get("HIPPIUS_SECRET_KEY", "")
STUDIO_TTS_EXPIRY_DAYS = int(os.environ.get("STUDIO_TTS_EXPIRY_DAYS", "7"))
PRESIGNED_EXPIRY_SECONDS = min(7 * 24 * 3600, STUDIO_TTS_EXPIRY_DAYS * 24 * 3600)


def _chute_speak_url(slug: str) -> str:
    return f"https://{slug}.chutes.ai/speak"


def _minio_client() -> Minio:
    return Minio(
        HIPPIUS_ENDPOINT,
        access_key=HIPPIUS_OWNER_ACCESS_KEY or "",
        secret_key=HIPPIUS_OWNER_SECRET_KEY or "",
        secure=True,
        region="decentralized",
    )


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


def _ensure_bucket(client: Minio, bucket: str) -> None:
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def upload_wav_to_hippius(user_id: str, wav_bytes: bytes) -> tuple[str, str, datetime]:
    from io import BytesIO

    client = _minio_client()
    _ensure_bucket(client, STUDIO_TTS_BUCKET)
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
