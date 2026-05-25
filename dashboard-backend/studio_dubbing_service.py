"""Studio Dubbing service: proxy enhance requests to a DeepFilterNet pod.

The DeepFilterNet pod accepts POST /enhance with multipart form (audio file)
and returns enhanced WAV bytes.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

_log = logging.getLogger(__name__)

DUBBING_TIMEOUT_SEC = 300


async def enhance_audio(
    *,
    audio_bytes: bytes,
    filename: str = "input.wav",
    base_url: str | None = None,
) -> tuple[bytes | None, str]:
    """Send audio to the dubbing pod for enhancement.

    Returns (enhanced_wav_bytes, error_message). On success error is "".
    """
    # Try ops dispatcher first.
    pod_cm = None
    ops_url: str | None = None
    ops_key: str | None = None
    if base_url is None:
        try:
            from ops import pool as gpu_pool
            if gpu_pool.online_pod_count("dubbing") > 0:
                pod_cm = gpu_pool.pick_pod("dubbing")
                pod = await pod_cm.__aenter__()
                ops_url = pod.url + "/enhance"
                ops_key = pod.api_key or None
        except Exception as e:
            try:
                from ops.pool import NoCapacity
                if isinstance(e, NoCapacity):
                    return None, "dubbing fleet busy (all pods at capacity)"
            except ImportError:
                pass
            pod_cm = None

    url = ops_url or (base_url or "").strip()
    if not url:
        return None, "Dubbing not configured (no ops pods online)"

    headers: dict[str, str] = {}
    if ops_key:
        headers["Authorization"] = f"Bearer {ops_key}"

    try:
        form = aiohttp.FormData()
        form.add_field(
            "audio",
            audio_bytes,
            filename=filename,
            content_type="audio/wav",
        )
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=headers,
                data=form,
                timeout=aiohttp.ClientTimeout(total=DUBBING_TIMEOUT_SEC),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    _log.warning("Dubbing enhance returned %d: %s", resp.status, body[:500])
                    return None, f"Dubbing server returned {resp.status}: {body[:200]}"
                wav = await resp.read()
                if not wav:
                    return None, "Dubbing server returned empty audio"
                return wav, ""
    except asyncio.TimeoutError:
        return None, f"Dubbing timed out ({DUBBING_TIMEOUT_SEC}s)"
    except Exception as e:
        _log.exception("Dubbing enhance failed")
        return None, str(e)
    finally:
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass
