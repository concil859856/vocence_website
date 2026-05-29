"""Studio Noise Remover service: proxy enhance requests to a DeepFilterNet pod.

The DeepFilterNet pod accepts POST /enhance with multipart form (audio file)
and returns enhanced WAV bytes.

Renamed from "Studio Dubbing" in Nov 2026 — same pod image, same backing
service, just better naming for what the feature actually does. Ops service
name supports both ``noise_remover`` (canonical) and ``dubbing`` (legacy
alias) so in-flight pod migrations don't break the endpoint.
"""

from __future__ import annotations

import asyncio
import logging

import aiohttp

_log = logging.getLogger(__name__)

NOISE_REMOVER_TIMEOUT_SEC = 300


async def enhance_audio(
    *,
    audio_bytes: bytes,
    filename: str = "input.wav",
    base_url: str | None = None,
) -> tuple[bytes | None, str]:
    """Send audio to the noise-remover pod for enhancement.

    Returns (enhanced_wav_bytes, error_message). On success error is "".
    """
    # Try ops dispatcher first. Check both the new and legacy service
    # names so a half-rolled-out fleet still routes correctly.
    pod_cm = None
    ops_url: str | None = None
    ops_key: str | None = None
    if base_url is None:
        try:
            from ops import pool as gpu_pool
            picked_service: str | None = None
            if gpu_pool.online_pod_count("noise_remover") > 0:
                picked_service = "noise_remover"
            elif gpu_pool.online_pod_count("dubbing") > 0:
                picked_service = "dubbing"
            if picked_service:
                pod_cm = gpu_pool.pick_pod(picked_service)
                pod = await pod_cm.__aenter__()
                ops_url = pod.url + "/enhance"
                ops_key = pod.api_key or None
        except Exception as e:
            try:
                from ops.pool import NoCapacity
                if isinstance(e, NoCapacity):
                    return None, "noise remover fleet busy (all pods at capacity)"
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
                timeout=aiohttp.ClientTimeout(total=NOISE_REMOVER_TIMEOUT_SEC),
            ) as resp:
                if resp.status != 200:
                    body = await resp.text()
                    _log.warning("Noise remover enhance returned %d: %s", resp.status, body[:500])
                    return None, f"Noise remover server returned {resp.status}: {body[:200]}"
                wav = await resp.read()
                if not wav:
                    return None, "Noise remover server returned empty audio"
                return wav, ""
    except asyncio.TimeoutError:
        return None, f"Noise removal timed out ({NOISE_REMOVER_TIMEOUT_SEC}s)"
    except Exception as e:
        _log.exception("Noise remover enhance failed")
        return None, str(e)
    finally:
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass
