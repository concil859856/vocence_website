"""
Voice clone HTTP client for the Developer API.

Mirrors dashboard-backend/studio_tts_service.voice_clone_synthesize (same env vars).
When changing clone protocol, keep both in sync.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
from urllib.parse import urlparse

import aiohttp

CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
STUDIO_VOICE_CLONE_URL = (os.environ.get("STUDIO_VOICE_CLONE_URL") or "").strip()
STUDIO_VOICE_CLONE_API_KEY = (os.environ.get("STUDIO_VOICE_CLONE_API_KEY") or "").strip()
STUDIO_VOICE_CLONE_TIMEOUT_SEC = int(os.environ.get("STUDIO_VOICE_CLONE_TIMEOUT_SEC", "300"))
STUDIO_VOICE_CLONE_CHUTE_SLUG = (os.environ.get("STUDIO_VOICE_CLONE_CHUTE_SLUG") or "").strip()
STUDIO_VOICE_CLONE_PATH = (os.environ.get("STUDIO_VOICE_CLONE_PATH") or "/clone").strip()
if not STUDIO_VOICE_CLONE_PATH.startswith("/"):
    STUDIO_VOICE_CLONE_PATH = f"/{STUDIO_VOICE_CLONE_PATH}"
STUDIO_VOICE_CLONE_KEY_REF_AUDIO = (os.environ.get("STUDIO_VOICE_CLONE_KEY_REF_AUDIO") or "reference_audio").strip()
STUDIO_VOICE_CLONE_KEY_REF_TEXT = (os.environ.get("STUDIO_VOICE_CLONE_KEY_REF_TEXT") or "ref_text").strip()
STUDIO_VOICE_CLONE_KEY_TARGET = (os.environ.get("STUDIO_VOICE_CLONE_KEY_TARGET") or "target_text").strip()
STUDIO_VOICE_CLONE_REQUEST_MODE = (os.environ.get("STUDIO_VOICE_CLONE_REQUEST_MODE") or "json").strip().lower()
STUDIO_VOICE_CLONE_REF_FILENAME = (os.environ.get("STUDIO_VOICE_CLONE_REF_FILENAME") or "reference.wav").strip()
STUDIO_VOICE_CLONE_REF_CONTENT_TYPE = (os.environ.get("STUDIO_VOICE_CLONE_REF_CONTENT_TYPE") or "audio/wav").strip()


def _chute_voice_clone_url(slug: str) -> str:
    return f"https://{slug}.chutes.ai{STUDIO_VOICE_CLONE_PATH}"


def _is_riff_wav(b: bytes) -> bool:
    return len(b) >= 12 and b[:4] == b"RIFF" and b[8:12] == b"WAVE"


def normalize_reference_audio_for_voice_clone(raw: bytes) -> bytes:
    if not raw or _is_riff_wav(raw):
        return raw
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return raw
    try:
        proc = subprocess.run(
            [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                "pipe:0",
                "-f",
                "wav",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "pipe:1",
            ],
            input=raw,
            capture_output=True,
            timeout=120,
            check=False,
        )
        if proc.returncode != 0 or not proc.stdout:
            return raw
        out = proc.stdout
        if _is_riff_wav(out):
            return out
    except Exception:
        pass
    return raw


def voice_clone_chute_configured() -> bool:
    return bool(STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG)


def voice_clone_endpoint_label() -> str:
    if STUDIO_VOICE_CLONE_URL:
        parsed = urlparse(STUDIO_VOICE_CLONE_URL)
        if parsed.netloc:
            return parsed.netloc
        return STUDIO_VOICE_CLONE_URL[:120]
    return STUDIO_VOICE_CLONE_CHUTE_SLUG or "clone"


async def voice_clone_synthesize(
    *,
    reference_audio_bytes: bytes,
    reference_text: str,
    target_text: str,
    chute_slug: str | None = None,
) -> tuple[bytes | None, str]:
    reference_audio_bytes = normalize_reference_audio_for_voice_clone(reference_audio_bytes)
    b64_audio = base64.b64encode(reference_audio_bytes).decode("utf-8")
    payload = {
        STUDIO_VOICE_CLONE_KEY_REF_AUDIO: b64_audio,
        STUDIO_VOICE_CLONE_KEY_REF_TEXT: reference_text or "",
        STUDIO_VOICE_CLONE_KEY_TARGET: target_text or "",
    }
    headers: dict[str, str] = {}
    if STUDIO_VOICE_CLONE_URL:
        url = STUDIO_VOICE_CLONE_URL
        if STUDIO_VOICE_CLONE_API_KEY:
            headers["Authorization"] = f"Bearer {STUDIO_VOICE_CLONE_API_KEY}"
        req_mode = STUDIO_VOICE_CLONE_REQUEST_MODE
    else:
        slug = (chute_slug or STUDIO_VOICE_CLONE_CHUTE_SLUG).strip()
        if not slug:
            return None, "voice clone not configured (set STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG)"
        url = _chute_voice_clone_url(slug)
        if CHUTES_AUTH_KEY:
            headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
        req_mode = "json"
    try:
        async with aiohttp.ClientSession() as session:
            if STUDIO_VOICE_CLONE_URL and req_mode in ("form", "multipart", "form-data"):
                form = aiohttp.FormData()
                form.add_field(STUDIO_VOICE_CLONE_KEY_REF_AUDIO, b64_audio)
                form.add_field(STUDIO_VOICE_CLONE_KEY_REF_TEXT, reference_text or "")
                form.add_field(STUDIO_VOICE_CLONE_KEY_TARGET, target_text or "")
                post = session.post(
                    url,
                    headers=headers,
                    data=form,
                    timeout=aiohttp.ClientTimeout(total=STUDIO_VOICE_CLONE_TIMEOUT_SEC),
                )
            elif STUDIO_VOICE_CLONE_URL and req_mode in ("form_file", "multipart_file", "file"):
                form = aiohttp.FormData()
                form.add_field(
                    STUDIO_VOICE_CLONE_KEY_REF_AUDIO,
                    reference_audio_bytes,
                    filename=STUDIO_VOICE_CLONE_REF_FILENAME,
                    content_type=STUDIO_VOICE_CLONE_REF_CONTENT_TYPE,
                )
                form.add_field(STUDIO_VOICE_CLONE_KEY_REF_TEXT, reference_text or "")
                form.add_field(STUDIO_VOICE_CLONE_KEY_TARGET, target_text or "")
                post = session.post(
                    url,
                    headers=headers,
                    data=form,
                    timeout=aiohttp.ClientTimeout(total=STUDIO_VOICE_CLONE_TIMEOUT_SEC),
                )
            else:
                post = session.post(
                    url,
                    headers={**headers, "Content-Type": "application/json"},
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=STUDIO_VOICE_CLONE_TIMEOUT_SEC),
                )
            async with post as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:400] if body else ""
                    return None, f"clone service returned {resp.status}" + (f": {err}" if err else "")
                ct = (resp.headers.get("Content-Type") or "").lower()
                if "audio" in ct or "octet-stream" in ct:
                    if body:
                        return body, ""
                    return None, "clone service returned empty audio body"
                if "json" in ct or body.startswith(b"{") or body.startswith(b"["):
                    try:
                        data = json.loads(body.decode("utf-8"))
                    except Exception:
                        return None, "clone service returned invalid JSON"
                    if isinstance(data, list):
                        data = data[0] if data else {}
                    if not isinstance(data, dict):
                        return None, "clone service returned unsupported JSON"
                    for key in (
                        "audio_wav_b64",
                        "audio_b64",
                        "wav_b64",
                        "output_audio_b64",
                        "speech_b64",
                        "output_wav_b64",
                    ):
                        val = data.get(key)
                        if isinstance(val, str) and val.strip():
                            try:
                                return base64.b64decode(val.strip(), validate=False), ""
                            except Exception:
                                continue
                    return None, "clone service JSON had no recognized audio_b64 field"
                if body:
                    return body, ""
                return None, "clone service returned empty body"
    except asyncio.TimeoutError:
        return None, "clone service request timed out"
    except Exception as e:
        return None, str(e)
