"""Music generation provider — proxies requests to ACE-Step API server."""

import asyncio
import logging

import aiohttp

from app.core.config import MUSIC_GEN_API_URL, MUSIC_GEN_TIMEOUT_SEC

_log = logging.getLogger(__name__)


def music_gen_configured() -> bool:
    return bool(MUSIC_GEN_API_URL)


async def generate_text2music(
    *,
    prompt: str,
    lyrics: str = "",
    audio_duration: float = 60.0,
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str]:
    """
    Call ACE-Step /generate/text2music. Returns (audio_bytes, error_msg).
    error_msg is empty on success.
    """
    if not MUSIC_GEN_API_URL:
        return None, "Music generation not configured (MUSIC_GEN_API_URL)"

    url = f"{MUSIC_GEN_API_URL.rstrip('/')}/generate/text2music"

    fd = aiohttp.FormData()
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("audio_duration", str(audio_duration))
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                data=fd,
                timeout=aiohttp.ClientTimeout(total=MUSIC_GEN_TIMEOUT_SEC),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    return None, f"Music server returned {resp.status}: {body[:200]}"

                result = await resp.json()
                audio_path = result.get("audio_path", "")
                if not audio_path:
                    return None, "Music server returned no audio_path"

                filename = audio_path.split("/")[-1]
                audio_fetch_url = f"{MUSIC_GEN_API_URL.rstrip('/')}/audio/{filename}"
                async with session.get(
                    audio_fetch_url,
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as audio_resp:
                    if audio_resp.status != 200:
                        return None, f"Failed to fetch audio: {audio_resp.status}"
                    audio_bytes = await audio_resp.read()
                    if not audio_bytes:
                        return None, "Music server returned empty audio"
                    return audio_bytes, ""

    except asyncio.TimeoutError:
        return None, f"Music generation timed out ({MUSIC_GEN_TIMEOUT_SEC}s)"
    except Exception as e:
        _log.exception("Music gen failed")
        return None, str(e)
