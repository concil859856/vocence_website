"""
Studio Music Generation service: proxy requests to an external ACE-Step API server.

The ACE-Step API runs on a separate server and exposes endpoints for:
  text2music, audio2audio, retake, repaint, edit, extend

Base URL is configured via MUSIC_GEN_API_URL in .env.
"""

import asyncio
import logging
import os

import aiohttp

_log = logging.getLogger(__name__)

# Base URL of the ACE-Step music generation server (e.g. http://gpu-server:8000)
MUSIC_GEN_API_URL = (os.environ.get("MUSIC_GEN_API_URL") or "").strip()
MUSIC_GEN_TIMEOUT_SEC = int(os.environ.get("MUSIC_GEN_TIMEOUT_SEC", "300"))


def music_gen_configured() -> bool:
    return bool(MUSIC_GEN_API_URL)


async def _post_music_form(
    endpoint: str,
    form_data: aiohttp.FormData,
    base_url: str | None = None,
) -> tuple[bytes | None, str | None, str]:
    """
    POST multipart form to ACE-Step API. Returns (audio_bytes, audio_path, error).
    On success error is empty string. On failure audio_bytes is None.

    `base_url` overrides MUSIC_GEN_API_URL for this call (used by the load
    balancer to target a specific pod).
    """
    base = (base_url or MUSIC_GEN_API_URL or "").rstrip("/")
    if not base:
        return None, None, "Music generation not configured (MUSIC_GEN_API_URL)"

    url = f"{base}{endpoint}"
    _log.info("Music gen POST %s", url)

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                data=form_data,
                timeout=aiohttp.ClientTimeout(total=MUSIC_GEN_TIMEOUT_SEC),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    _log.warning("Music gen %s returned %d: %s", endpoint, resp.status, body[:500])
                    return None, None, f"Music server returned {resp.status}: {body[:200]}"

                result = await resp.json()
                audio_path = result.get("audio_path", "")
                if not audio_path:
                    return None, None, "Music server returned no audio_path"

                filename = audio_path.split("/")[-1]
                audio_url = f"{base}/audio/{filename}"
                async with session.get(
                    audio_url,
                    timeout=aiohttp.ClientTimeout(total=60),
                ) as audio_resp:
                    if audio_resp.status != 200:
                        return None, None, f"Failed to fetch generated audio: {audio_resp.status}"
                    audio_bytes = await audio_resp.read()
                    if not audio_bytes:
                        return None, None, "Music server returned empty audio"
                    return audio_bytes, audio_path, ""

    except asyncio.TimeoutError:
        _log.warning("Music gen %s timed out after %ds", endpoint, MUSIC_GEN_TIMEOUT_SEC)
        return None, None, f"Music generation timed out ({MUSIC_GEN_TIMEOUT_SEC}s)"
    except Exception as e:
        _log.exception("Music gen %s failed", endpoint)
        return None, None, str(e)


async def generate_text2music(
    *,
    base_url: str | None = None,
    prompt: str,
    lyrics: str = "",
    audio_duration: float = 60.0,
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
    scheduler_type: str = "euler",
    cfg_type: str = "apg",
    omega_scale: float = 10.0,
    manual_seeds: str = "",
    guidance_interval: float = 0.5,
    guidance_interval_decay: float = 0.0,
    min_guidance_scale: float = 3.0,
    use_erg_tag: bool = True,
    use_erg_lyric: bool = False,
    use_erg_diffusion: bool = True,
    oss_steps: str = "",
    guidance_scale_text: float = 0.0,
    guidance_scale_lyric: float = 0.0,
    lora_name_or_path: str = "none",
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("audio_duration", str(audio_duration))
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    fd.add_field("scheduler_type", scheduler_type)
    fd.add_field("cfg_type", cfg_type)
    fd.add_field("omega_scale", str(omega_scale))
    fd.add_field("manual_seeds", manual_seeds)
    fd.add_field("guidance_interval", str(guidance_interval))
    fd.add_field("guidance_interval_decay", str(guidance_interval_decay))
    fd.add_field("min_guidance_scale", str(min_guidance_scale))
    fd.add_field("use_erg_tag", str(use_erg_tag).lower())
    fd.add_field("use_erg_lyric", str(use_erg_lyric).lower())
    fd.add_field("use_erg_diffusion", str(use_erg_diffusion).lower())
    fd.add_field("oss_steps", oss_steps)
    fd.add_field("guidance_scale_text", str(guidance_scale_text))
    fd.add_field("guidance_scale_lyric", str(guidance_scale_lyric))
    fd.add_field("lora_name_or_path", lora_name_or_path)
    return await _post_music_form("/generate/text2music", fd, base_url=base_url)


async def generate_audio2audio(
    *,
    ref_audio_bytes: bytes,
    ref_audio_filename: str = "reference.wav",
    prompt: str,
    lyrics: str = "",
    audio_duration: float = 60.0,
    ref_audio_strength: float = 0.5,
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("ref_audio", ref_audio_bytes, filename=ref_audio_filename, content_type="audio/wav")
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("audio_duration", str(audio_duration))
    fd.add_field("ref_audio_strength", str(ref_audio_strength))
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    return await _post_music_form("/generate/audio2audio", fd)


async def generate_retake(
    *,
    src_audio_bytes: bytes,
    src_audio_filename: str = "source.wav",
    prompt: str,
    lyrics: str = "",
    retake_variance: float = 0.2,
    retake_seeds: str = "",
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("src_audio", src_audio_bytes, filename=src_audio_filename, content_type="audio/wav")
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("retake_variance", str(retake_variance))
    fd.add_field("retake_seeds", retake_seeds)
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    return await _post_music_form("/generate/retake", fd)


async def generate_repaint(
    *,
    src_audio_bytes: bytes,
    src_audio_filename: str = "source.wav",
    prompt: str,
    lyrics: str = "",
    repaint_start: float = 0.0,
    repaint_end: float = 30.0,
    retake_variance: float = 0.2,
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("src_audio", src_audio_bytes, filename=src_audio_filename, content_type="audio/wav")
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("repaint_start", str(repaint_start))
    fd.add_field("repaint_end", str(repaint_end))
    fd.add_field("retake_variance", str(retake_variance))
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    return await _post_music_form("/generate/repaint", fd)


async def generate_edit(
    *,
    src_audio_bytes: bytes,
    src_audio_filename: str = "source.wav",
    prompt: str,
    lyrics: str = "",
    edit_target_prompt: str,
    edit_target_lyrics: str = "",
    edit_n_min: float = 0.6,
    edit_n_max: float = 1.0,
    retake_seeds: str = "",
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("src_audio", src_audio_bytes, filename=src_audio_filename, content_type="audio/wav")
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("edit_target_prompt", edit_target_prompt)
    fd.add_field("edit_target_lyrics", edit_target_lyrics)
    fd.add_field("edit_n_min", str(edit_n_min))
    fd.add_field("edit_n_max", str(edit_n_max))
    fd.add_field("retake_seeds", retake_seeds)
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    return await _post_music_form("/generate/edit", fd)


async def generate_extend(
    *,
    src_audio_bytes: bytes,
    src_audio_filename: str = "source.wav",
    prompt: str,
    lyrics: str = "",
    left_extend_length: float = 0.0,
    right_extend_length: float = 30.0,
    extend_seeds: str = "",
    format: str = "wav",
    infer_step: int = 60,
    guidance_scale: float = 15.0,
) -> tuple[bytes | None, str | None, str]:
    fd = aiohttp.FormData()
    fd.add_field("src_audio", src_audio_bytes, filename=src_audio_filename, content_type="audio/wav")
    fd.add_field("prompt", prompt)
    fd.add_field("lyrics", lyrics)
    fd.add_field("left_extend_length", str(left_extend_length))
    fd.add_field("right_extend_length", str(right_extend_length))
    fd.add_field("extend_seeds", extend_seeds)
    fd.add_field("format", format)
    fd.add_field("infer_step", str(infer_step))
    fd.add_field("guidance_scale", str(guidance_scale))
    return await _post_music_form("/generate/extend", fd)
