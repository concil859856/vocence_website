"""
Studio audio service: call Chutes TTS/STT, upload WAV to Hippius, presigned URLs.

This module is part of vocence_website (dashboard-backend) and does not import
from the vocence package. Chutes/Hippius usage is aligned with the Vocence subnet
(api.chutes.ai + {slug}.chutes.ai; Hippius owner S3).

Chutes:
  - Chute metadata: GET https://api.chutes.ai/chutes/{chute_id} -> response has "slug".
  - PromptTTS (Studio TTS): POST https://{slug}.chutes.ai/speak — same slugs as STUDIO_MODEL_* env (no separate URL).
  - STT (Chutes): POST to STUDIO_STT_CHUTES_URL (defaults to CHUTES_WHISPER_STT_URL / public Whisper URL)
    with JSON: {"audio_b64": "<base64-audio>", "language": "<optional-iso-code>"}.
  - Voice clone: POST STUDIO_VOICE_CLONE_URL (full http(s) URL from .env) OR legacy https://{slug}.chutes.ai/path
    with JSON keys from STUDIO_VOICE_CLONE_KEY_* (default reference_audio, ref_text, target_text; values ref audio as base64).
  - Voice Design LLM: OpenAI-compatible POST {VOICE_DESIGN_LLM_BASE_URL}/chat/completions (default https://llm.chutes.ai/v1)
    with Bearer CHUTES_API_KEY; set VOICE_DESIGN_LLM_MODEL (list models: GET https://llm.chutes.ai/v1/models).
    Multi-model failover: use a comma-separated list of model ids in VOICE_DESIGN_LLM_MODEL; the router tries
    alternatives when a pool is at capacity. Optional routing suffix on the last segment, e.g.
    ``...,moonshotai/Kimi-K2.5-TEE:throughput`` (Chutes: throughput-oriented selection). Other suffixes we
    strip for catalog checks: :latency, :cost. See https://chutes.ai/llms.txt (Model discovery / Inference).
  - Auth: Bearer CHUTES_AUTH_KEY for Chutes TTS/STT and hosted LLM; clone URL may use STUDIO_VOICE_CLONE_API_KEY only.

Hippius:
  - Endpoint: s3.hippius.com (secure, region=decentralized).
  - Owner credentials: HIPPIUS_OWNER_* or HIPPIUS_ACCESS_KEY / HIPPIUS_SECRET_KEY.
"""

import asyncio
import base64
import json
import logging
import os
import shutil
import subprocess
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from pathlib import PurePosixPath
from urllib.parse import urlparse

import aiohttp
from minio import Minio

_log = logging.getLogger(__name__)

# Chutes: API base for fetching chute details (GET /chutes/{chute_id})
CHUTES_BASE_URL = os.environ.get("CHUTES_BASE_URL", "https://api.chutes.ai")
CHUTES_AUTH_KEY = os.environ.get("CHUTES_AUTH_KEY") or os.environ.get("CHUTES_API_KEY", "")
# Miner endpoint: https://{slug}.chutes.ai/speak (slug from API response)
CHUTE_TTS_PATH = "/speak"

# Local voice-design server (replaces Chutes for the /speak endpoint).
# When VOICE_DESIGN_BASE_URL is set, synthesize_speak routes here instead of
# building a per-slug Chutes URL — keeps PromptTTS + VoiceDesign-preview
# entirely on-prem. See /workspace/development/qwen3-voice-design/README.md.
VOICE_DESIGN_BASE_URL = (os.environ.get("VOICE_DESIGN_BASE_URL") or "").strip()
VOICE_DESIGN_API_KEY = (os.environ.get("VOICE_DESIGN_API_KEY") or "").strip()
CHUTE_STT_PATH = "/transcribe"
CHUTES_WHISPER_STT_URL = os.environ.get(
    "CHUTES_WHISPER_STT_URL",
    "https://chutes-whisper-large-v3.chutes.ai/transcribe",
)
# Studio STT URL. Provider-agnostic JSON POST endpoint. Works with Chutes Whisper
# (key: audio_b64) and self-hosted Qwen3-ASR (key: audio_base64) — payload sends both.
# Precedence: STUDIO_STT_URL > STUDIO_STT_CHUTES_URL (legacy) > CHUTES_WHISPER_STT_URL.
STUDIO_STT_URL = (
    os.environ.get("STUDIO_STT_URL")
    or os.environ.get("STUDIO_STT_CHUTES_URL")
    or CHUTES_WHISPER_STT_URL
    or ""
).strip() or "https://chutes-whisper-large-v3.chutes.ai/transcribe"
# Back-compat alias.
STUDIO_STT_CHUTES_URL = STUDIO_STT_URL

STUDIO_VOICE_CLONE_URL = (os.environ.get("STUDIO_VOICE_CLONE_URL") or "").strip()
STUDIO_VOICE_CLONE_API_KEY = (os.environ.get("STUDIO_VOICE_CLONE_API_KEY") or "").strip()
STUDIO_VOICE_CLONE_TIMEOUT_SEC = int(os.environ.get("STUDIO_VOICE_CLONE_TIMEOUT_SEC", "300"))
STUDIO_VOICE_CLONE_CHUTE_SLUG = (os.environ.get("STUDIO_VOICE_CLONE_CHUTE_SLUG") or "").strip()
STUDIO_VOICE_CLONE_PATH = (os.environ.get("STUDIO_VOICE_CLONE_PATH") or "/clone").strip()
if not STUDIO_VOICE_CLONE_PATH.startswith("/"):
    STUDIO_VOICE_CLONE_PATH = f"/{STUDIO_VOICE_CLONE_PATH}"
# JSON body keys for clone HTTP API (values: base64 WAV/PCM in ref-audio field, plain strings for texts).
# Defaults match common FastAPI bodies: reference_audio, ref_text, target_text.
# Legacy Chutes miners often use reference_audio_b64 + reference_text — set STUDIO_VOICE_CLONE_KEY_* to override.
STUDIO_VOICE_CLONE_KEY_REF_AUDIO = (os.environ.get("STUDIO_VOICE_CLONE_KEY_REF_AUDIO") or "reference_audio").strip()
STUDIO_VOICE_CLONE_KEY_REF_TEXT = (os.environ.get("STUDIO_VOICE_CLONE_KEY_REF_TEXT") or "ref_text").strip()
STUDIO_VOICE_CLONE_KEY_TARGET = (os.environ.get("STUDIO_VOICE_CLONE_KEY_TARGET") or "target_text").strip()
# json = application/json (Chutes / many APIs). form = multipart/form-data with base64 string in ref-audio field.
# form_file = multipart with raw WAV bytes as file part (FastAPI File() + Form()).
STUDIO_VOICE_CLONE_REQUEST_MODE = (os.environ.get("STUDIO_VOICE_CLONE_REQUEST_MODE") or "json").strip().lower()
STUDIO_VOICE_CLONE_REF_FILENAME = (os.environ.get("STUDIO_VOICE_CLONE_REF_FILENAME") or "reference.wav").strip()
STUDIO_VOICE_CLONE_REF_CONTENT_TYPE = (os.environ.get("STUDIO_VOICE_CLONE_REF_CONTENT_TYPE") or "audio/wav").strip()

# Voice Design: Chutes hosted LLM (OpenAI-compatible). See https://chutes.ai/llms.txt — inference at https://llm.chutes.ai/v1
VOICE_DESIGN_LLM_BASE_URL = (os.environ.get("VOICE_DESIGN_LLM_BASE_URL") or "https://llm.chutes.ai/v1").strip().rstrip("/")
# Single id, or comma-separated failover list; last segment may include :throughput / :latency / :cost for routing.
VOICE_DESIGN_LLM_MODEL = (os.environ.get("VOICE_DESIGN_LLM_MODEL") or "").strip()
CHUTES_LLM_ROUTING_SUFFIXES = frozenset({"throughput", "latency", "cost"})
VOICE_DESIGN_LLM_TIMEOUT_SEC = int(os.environ.get("VOICE_DESIGN_LLM_TIMEOUT_SEC", "120"))
# 1024 default: some router-selected models (e.g. Kimi) may need headroom beyond short JSON; override with env.
VOICE_DESIGN_LLM_MAX_TOKENS = int(os.environ.get("VOICE_DESIGN_LLM_MAX_TOKENS", "1024"))
VOICE_DESIGN_LLM_TEMPERATURE = float(os.environ.get("VOICE_DESIGN_LLM_TEMPERATURE", "0.35"))
# Retries when Chutes returns 429 / capacity (exponential backoff)
VOICE_DESIGN_LLM_RETRY_MAX = int(os.environ.get("VOICE_DESIGN_LLM_RETRY_MAX", "5"))
VOICE_DESIGN_LLM_RETRY_BASE_SEC = float(os.environ.get("VOICE_DESIGN_LLM_RETRY_BASE_SEC", "3"))
VOICE_DESIGN_SAMPLE_WORDS_MIN = int(os.environ.get("VOICE_DESIGN_SAMPLE_WORDS_MIN", "18"))
VOICE_DESIGN_SAMPLE_WORDS_MAX = int(os.environ.get("VOICE_DESIGN_SAMPLE_WORDS_MAX", "22"))
VOICE_DESIGN_PREVIEW_EXPIRY_HOURS = int(os.environ.get("VOICE_DESIGN_PREVIEW_EXPIRY_HOURS", "24"))


def _chute_speak_url(slug: str) -> str:
    """Build miner TTS URL from chute slug. Rule: https://{slug}.chutes.ai/speak (chutes.ai)."""
    return f"https://{slug}.chutes.ai{CHUTE_TTS_PATH}"


def _chute_voice_clone_url(slug: str) -> str:
    """Voice clone Chute: https://{slug}.chutes.ai{STUDIO_VOICE_CLONE_PATH}."""
    return f"https://{slug}.chutes.ai{STUDIO_VOICE_CLONE_PATH}"


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
R2_PUBLIC_DOMAIN = (os.environ.get("R2_PUBLIC_DOMAIN") or "").strip()  # e.g. audio.vocence.ai

# Hippius S3 (legacy)
HIPPIUS_ENDPOINT = os.environ.get("HIPPIUS_ENDPOINT", "s3.hippius.com")
HIPPIUS_OWNER_ACCESS_KEY = os.environ.get("HIPPIUS_OWNER_ACCESS_KEY") or os.environ.get("HIPPIUS_ACCESS_KEY", "")
HIPPIUS_OWNER_SECRET_KEY = os.environ.get("HIPPIUS_OWNER_SECRET_KEY") or os.environ.get("HIPPIUS_SECRET_KEY", "")


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
    """Return the active bucket name based on provider."""
    if BUCKET_PROVIDER == "r2":
        return R2_BUCKET_NAME
    return STUDIO_TTS_BUCKET


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


async def synthesize_speak(chute_slug: str, text: str, instruction: str, *, base_url: str | None = None) -> tuple[bytes | None, str]:
    """POST to the voice-design /speak endpoint with JSON {text, instruction}.

    URL precedence:
      1. explicit ``base_url`` argument (test/override path)
      2. ops dispatcher: least-loaded online ``voice_design`` pod from gpu_pool
      3. ``VOICE_DESIGN_BASE_URL`` env (single local server)
      4. ``https://{chute_slug}.chutes.ai/speak`` (legacy Chutes path)

    Auth: ops-pod's own api_key for the dispatcher path, else
    VOICE_DESIGN_API_KEY for local server, else CHUTES_AUTH_KEY.

    Returns (wav_bytes, error_message). On success: (bytes, ""). On failure: (None, "reason")."""
    # Try the dispatcher first when ops pods are registered for this service.
    pod_cm = None
    pod_url: str | None = None
    pod_key: str | None = None
    if base_url is None:
        try:
            from ops import pool as gpu_pool  # optional dep
            if gpu_pool.online_pod_count("voice_design") > 0:
                pod_cm = gpu_pool.pick_pod("voice_design")
                pod = await pod_cm.__aenter__()
                pod_url = pod.url + "/speak"
                pod_key = pod.api_key or None
        except Exception as e:
            try:
                from ops.pool import NoCapacity
                if isinstance(e, NoCapacity):
                    return None, "voice_design fleet busy (all pods at capacity)"
            except ImportError:
                pass
            pod_cm = None

    if pod_url is not None:
        url = pod_url
        auth_key = pod_key or VOICE_DESIGN_API_KEY or CHUTES_AUTH_KEY
    elif base_url:
        url = base_url.strip()
        auth_key = VOICE_DESIGN_API_KEY or CHUTES_AUTH_KEY
    elif VOICE_DESIGN_BASE_URL:
        url = VOICE_DESIGN_BASE_URL
        auth_key = VOICE_DESIGN_API_KEY
    else:
        url = _chute_speak_url(chute_slug).strip()
        auth_key = CHUTES_AUTH_KEY

    payload = {"text": text or "Hello.", "instruction": instruction or "neutral voice"}
    headers = {"Content-Type": "application/json"}
    if auth_key:
        headers["Authorization"] = f"Bearer {auth_key}"
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=120),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:200] if body else ""
                    return None, f"miner returned {resp.status}" + (f": {err}" if err else "")
                if not body:
                    return None, "miner returned no audio"
                return body, ""
    except asyncio.TimeoutError:
        return None, "miner request timed out"
    except Exception as e:
        return None, str(e)
    finally:
        # Release the dispatcher slot. Safe to call when pod_cm is None.
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass


async def transcribe_audio(
    *,
    audio_bytes: bytes,
    language: str | None = None,
    base_url: str | None = None,
) -> tuple[dict | None, str]:
    """POST STT to a transcribe URL. `base_url` overrides STUDIO_STT_URL for
    this call (used by the load balancer).

    Payload sends both `audio_b64` (Chutes Whisper) and `audio_base64` (Qwen3-ASR)
    keys so the same code works against either provider. `language` is optional.
    Returns ({text, ...}, "") on success, else (None, "reason").
    """
    # Try the ops dispatcher first when ops pods are registered.
    # Preference order:
    #   1. asr_streaming_rt — the new Parakeet pod, which hosts BOTH
    #      WS /v1/stream and a batch POST /v1/transcribe. This is the
    #      primary target once a pod is online.
    #   2. stt — the legacy batch-only image, kept as fallback so
    #      operators mid-migration don't lose batch capacity.
    pod_cm = None
    ops_url: str | None = None
    ops_key: str | None = None
    # Variant flag controls auth header + endpoint path. The new pod
    # uses X-API-Key and the versioned /v1/transcribe path; the legacy
    # one uses Bearer and /transcribe.
    pod_variant: str = "legacy"
    if base_url is None:
        try:
            from ops import pool as gpu_pool
            target = None
            if gpu_pool.online_pod_count("asr_streaming_rt") > 0:
                target = ("asr_streaming_rt", "/v1/transcribe", "modern")
            elif gpu_pool.online_pod_count("stt") > 0:
                target = ("stt", "/transcribe", "legacy")
            if target is not None:
                svc_name, path, variant = target
                pod_cm = gpu_pool.pick_pod(svc_name)
                pod = await pod_cm.__aenter__()
                ops_url = pod.url + path
                ops_key = pod.api_key or None
                pod_variant = variant
        except Exception as e:
            try:
                from ops.pool import NoCapacity
                if isinstance(e, NoCapacity):
                    return None, "stt fleet busy (all pods at capacity)"
            except ImportError:
                pass
            pod_cm = None

    url = ops_url or (base_url or STUDIO_STT_URL or "").strip()
    if not url:
        return None, "STT not configured (no ops pods online, STUDIO_STT_URL not set)"

    headers: dict[str, str] = {}
    auth_key = ops_key or CHUTES_AUTH_KEY
    if auth_key:
        if pod_variant == "modern":
            headers["X-API-Key"] = auth_key
        else:
            headers["Authorization"] = f"Bearer {auth_key}"

    # Two on-the-wire shapes:
    #
    # * Modern pod (asr_streaming_rt /v1/transcribe) — multipart form with
    #   ``audio`` file part. This matches the conventional batch-STT API
    #   shape (Whisper / OpenAI / etc.) and is what the new pod's
    #   FastAPI route declares.
    # * Legacy pod (stt /transcribe) + Chutes URL — JSON with both
    #   ``audio_b64`` and ``audio_base64`` for cross-provider compat.
    json_payload: dict | None = None
    form_data: aiohttp.FormData | None = None
    if pod_variant == "modern":
        form_data = aiohttp.FormData()
        form_data.add_field(
            "audio",
            audio_bytes,
            filename="audio.wav",
            content_type="audio/wav",
        )
        if language:
            form_data.add_field("language", language)
    else:
        b64 = base64.b64encode(audio_bytes).decode("utf-8")
        json_payload = {
            "audio_b64": b64,
            "audio_base64": b64,
        }
        if language:
            json_payload["language"] = language
        headers["Content-Type"] = "application/json"

    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(
                url,
                headers=headers,
                json=json_payload,
                data=form_data,
                timeout=aiohttp.ClientTimeout(total=180),
            ) as resp:
                body = await resp.read()
                if resp.status != 200:
                    err = body.decode("utf-8", errors="replace")[:300] if body else ""
                    return None, f"miner returned {resp.status}" + (f": {err}" if err else "")
                try:
                    data = await resp.json(content_type=None)
                except Exception:
                    return None, "miner returned non-JSON transcription response"
                if isinstance(data, list):
                    first = data[0] if data else {}
                    if not isinstance(first, dict):
                        return None, "miner returned unsupported list response"
                    return first, ""
                if not isinstance(data, dict):
                    return None, "miner returned unsupported JSON response"
                return data, ""
    except asyncio.TimeoutError:
        return None, "transcription request timed out"
    except Exception as e:
        return None, str(e)
    finally:
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass


async def transcribe_audio_streaming(
    *,
    audio_bytes: bytes,
    language: str | None = None,
    on_partial=None,
):
    """Stream a WAV blob to ``asr_streaming_rt``'s WS /v1/stream endpoint
    and surface partial transcripts as they arrive.

    Designed for the voicechat flow: the client uploads a single VAD-
    segmented WAV (same protocol as batch), and we replay it into the
    streaming pod so partials can flow back to the user's UI while the
    pod is still processing. Returns ``(data, "")`` on success — same
    shape as ``transcribe_audio`` (``{text, language?, ...}``) — or
    ``(None, "reason")`` on failure (caller can then fall back to batch).

    ``on_partial`` is awaited once per ``partial`` event with the running
    text. Returning falsy from it does not cancel the stream.
    """
    # Lazy import — wave is stdlib, audioop is stdlib (deprecation noise
    # in 3.13 is fine; we'll switch to a pure-python resampler if needed).
    import io
    import wave
    try:
        import audioop  # type: ignore
    except Exception:
        audioop = None  # we'll only need it when sample rate ≠ 16000

    # Pick a streaming pod. If none online we tell the caller to fall
    # back rather than guessing a URL.
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
            return None, "no streaming pod online"
        pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
    except Exception as e:
        try:
            from ops.pool import NoCapacity
            if isinstance(e, NoCapacity):
                return None, "asr fleet busy"
        except ImportError:
            pass
        return None, f"streaming pod unavailable: {e}"

    pod = await pod_cm.__aenter__()
    try:
        # Parse WAV → mono pcm_s16le @ 16 kHz.
        try:
            with wave.open(io.BytesIO(audio_bytes), "rb") as wf:
                src_rate = wf.getframerate()
                src_channels = wf.getnchannels()
                src_sampwidth = wf.getsampwidth()
                src_pcm = wf.readframes(wf.getnframes())
        except wave.Error as e:
            return None, f"non-WAV input not supported for streaming: {e}"

        if src_sampwidth != 2:
            return None, f"unsupported sample width: {src_sampwidth} bytes"
        pcm = src_pcm
        if src_channels == 2 and audioop is not None:
            pcm = audioop.tomono(pcm, 2, 0.5, 0.5)
        elif src_channels != 1:
            return None, f"unsupported channel count: {src_channels}"
        if src_rate != 16000:
            if audioop is None:
                return None, f"need 16 kHz audio, got {src_rate} (no resampler)"
            pcm, _ = audioop.ratecv(pcm, 2, 1, src_rate, 16000, None)

        # Build WS URL. pod.url is something like http://host:8117 → ws.
        base = pod.url.rstrip("/")
        if base.startswith("https://"):
            ws_url = "wss://" + base[len("https://"):] + "/v1/stream"
        else:
            ws_url = "ws://" + base[len("http://"):] + "/v1/stream"

        headers = {}
        if pod.api_key:
            headers["X-API-Key"] = pod.api_key

        final_text: str = ""
        final_lang: str | None = None

        async with aiohttp.ClientSession(headers=headers) as session:
            try:
                ws = await session.ws_connect(
                    ws_url,
                    timeout=aiohttp.ClientWSTimeout(ws_close=15),
                    max_msg_size=2 * 1024 * 1024,
                )
            except Exception as e:
                return None, f"ws connect failed: {e}"

            try:
                # 1. start
                await ws.send_json({
                    "type": "start",
                    "language": (language or "auto"),
                    "sample_rate": 16000,
                    "encoding": "pcm_s16le",
                    "enable_partials": True,
                })

                # 2. wait for ready (one text frame)
                ready_msg = await asyncio.wait_for(ws.receive(), timeout=10.0)
                if ready_msg.type != aiohttp.WSMsgType.TEXT:
                    return None, f"expected ready, got {ready_msg.type.name}"
                ready_data = json.loads(ready_msg.data)
                if ready_data.get("type") != "ready":
                    return None, f"unexpected first message: {ready_data}"

                # 3. send audio in 20 ms (640-byte) frames + commit + close
                async def send_audio():
                    CHUNK = 640  # 20 ms @ 16 kHz mono s16le
                    REAL_TIME_MS = 20
                    # The pod may close the WS the moment it commits a
                    # final transcript — which can happen before we've
                    # finished pushing the tail of the audio (the model
                    # is faster than real-time at the end of a clip).
                    # That's not an error; just stop quietly.
                    try:
                        for i in range(0, len(pcm), CHUNK):
                            if ws.closed:
                                return
                            await ws.send_bytes(pcm[i:i + CHUNK])
                            # Pace gently so the server doesn't drop us
                            # with "client too fast" — also lets partials
                            # interleave.
                            await asyncio.sleep(REAL_TIME_MS / 1000.0 * 0.5)
                        if not ws.closed:
                            await ws.send_json({"type": "commit"})
                        if not ws.closed:
                            await ws.send_json({"type": "close"})
                    except (
                        aiohttp.ClientConnectionResetError,
                        ConnectionResetError,
                        aiohttp.ClientConnectionError,
                    ):
                        # Recv side already saw the close — recv_loop
                        # will return cleanly and the wait() below
                        # picks up the final.
                        return

                async def recv_loop():
                    nonlocal final_text, final_lang
                    while True:
                        try:
                            msg = await asyncio.wait_for(ws.receive(), timeout=30.0)
                        except asyncio.TimeoutError:
                            return "recv timeout"
                        if msg.type == aiohttp.WSMsgType.CLOSED:
                            return ""
                        if msg.type == aiohttp.WSMsgType.CLOSE:
                            return ""
                        if msg.type == aiohttp.WSMsgType.ERROR:
                            return f"ws error: {ws.exception()}"
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            continue
                        try:
                            data = json.loads(msg.data)
                        except Exception:
                            continue
                        mtype = data.get("type")
                        if mtype == "partial":
                            text = (data.get("text") or "").strip()
                            if text and on_partial is not None:
                                try:
                                    await on_partial(text)
                                except Exception:
                                    # Caller-side errors must not poison
                                    # the upstream stream.
                                    pass
                        elif mtype == "final":
                            # New utterance final replaces previous.
                            final_text = (data.get("text") or "").strip()
                            final_lang = data.get("language_detected") or final_lang
                        elif mtype == "error":
                            return f"pod error: {data.get('message') or data.get('code')}"

                send_task = asyncio.create_task(send_audio())
                recv_task = asyncio.create_task(recv_loop())
                done, pending = await asyncio.wait(
                    {send_task, recv_task},
                    return_when=asyncio.FIRST_EXCEPTION,
                )
                # Make sure both finish — if send died, recv will see
                # the close; if recv died, send may still be mid-loop.
                for t in pending:
                    try:
                        await asyncio.wait_for(t, timeout=10.0)
                    except Exception:
                        t.cancel()

                err = ""
                for t in done:
                    res = t.result() if not t.cancelled() else None
                    if isinstance(res, str) and res:
                        err = err or res

                if not final_text:
                    return None, err or "no final transcript"

                return {
                    "text": final_text,
                    "language": final_lang or language,
                }, ""
            finally:
                try:
                    await ws.close()
                except Exception:
                    pass
    finally:
        try:
            await pod_cm.__aexit__(None, None, None)
        except Exception:
            pass


_COMMUNITY_VOICE_CACHE: dict[str, tuple[bytes, str]] = {}


async def load_community_voice(voice_id: str) -> tuple[bytes, str]:
    """Return (audio_bytes, reference_text) for an approved community-contributed
    voice (``approved_voice_id`` = ``community-<...>`` in ``voice_submissions``).

    Unlike static sample voices, the submission already carries a human-provided
    ``ref_text``, so no STT round-trip is needed. Cached per process. Raises
    RuntimeError if the voice isn't an approved submission.
    """
    cached = _COMMUNITY_VOICE_CACHE.get(voice_id)
    if cached:
        return cached

    from local_db import get_connection
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT audio_url, ref_text FROM voice_submissions "
            "WHERE approved_voice_id = ? AND status = 'approved'",
            (voice_id,),
        )).fetchone()
    finally:
        await conn.close()
    if row is None:
        raise RuntimeError(f"unknown community voice: {voice_id}")

    audio_url = (row["audio_url"] or "").strip()
    ref_text = (row["ref_text"] or "").strip()
    if not audio_url:
        raise RuntimeError(f"community voice {voice_id} has no audio")

    import aiohttp
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(audio_url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"community voice audio fetch failed ({resp.status})")
            audio = await resp.read()

    if not ref_text:
        # Fallback: transcribe if a legacy row somehow lacks ref_text.
        stt_result, stt_err = await transcribe_audio(audio_bytes=audio)
        ref_text = (stt_result or {}).get("text", "").strip() if stt_result else ""
        if not ref_text:
            raise RuntimeError(f"community voice {voice_id}: no reference text ({stt_err})")

    _COMMUNITY_VOICE_CACHE[voice_id] = (audio, ref_text)
    return audio, ref_text


def voice_clone_chute_configured() -> bool:
    """True if clone is usable: STUDIO_VOICE_CLONE_URL and/or legacy Chutes slug."""
    return bool(STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG)


def voice_clone_endpoint_label() -> str:
    """Short label for DB history (clone host or Chutes slug)."""
    if STUDIO_VOICE_CLONE_URL:
        parsed = urlparse(STUDIO_VOICE_CLONE_URL)
        if parsed.netloc:
            return parsed.netloc
        return STUDIO_VOICE_CLONE_URL[:120]
    return STUDIO_VOICE_CLONE_CHUTE_SLUG or "clone"


def _is_riff_wav(b: bytes) -> bool:
    return len(b) >= 12 and b[:4] == b"RIFF" and b[8:12] == b"WAVE"


def normalize_reference_audio_for_voice_clone(raw: bytes) -> bytes:
    """Many clone endpoints only accept WAV PCM. Browser / MediaRecorder often sends WebM/Opus.

    If ``ffmpeg`` is on PATH, transcode non-WAV input to 16 kHz mono PCM WAV. Otherwise return bytes unchanged.
    """
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
            _log.debug(
                "ffmpeg ref-audio transcode failed rc=%s stderr=%s",
                proc.returncode,
                (proc.stderr or b"").decode("utf-8", errors="replace")[:300],
            )
            return raw
        out = proc.stdout
        if _is_riff_wav(out):
            return out
    except Exception as e:
        _log.debug("ffmpeg ref-audio transcode exception: %s", e)
    return raw


async def voice_clone_synthesize(
    *,
    reference_audio_bytes: bytes,
    reference_text: str,
    target_text: str,
    chute_slug: str | None = None,
    base_url: str | None = None,
) -> tuple[bytes | None, str]:
    """POST to clone service: ref audio + ref text + target text.

    STUDIO_VOICE_CLONE_REQUEST_MODE: json (default), form (multipart + base64 string), form_file (multipart + WAV file).
    Prefer STUDIO_VOICE_CLONE_URL. Optional Bearer STUDIO_VOICE_CLONE_API_KEY.
    Legacy Chutes: JSON only to https://{slug}.chutes.ai{path} with CHUTES_AUTH_KEY.

    Response: raw audio, or JSON with a recognized *_b64 field.
    """
    reference_audio_bytes = normalize_reference_audio_for_voice_clone(reference_audio_bytes)
    b64_audio = base64.b64encode(reference_audio_bytes).decode("utf-8")
    payload = {
        STUDIO_VOICE_CLONE_KEY_REF_AUDIO: b64_audio,
        STUDIO_VOICE_CLONE_KEY_REF_TEXT: reference_text or "",
        STUDIO_VOICE_CLONE_KEY_TARGET: target_text or "",
    }
    headers: dict[str, str] = {}

    # Try the ops dispatcher first when ops pods are registered.
    pod_cm = None
    ops_url: str | None = None
    if base_url is None:
        try:
            from ops import pool as gpu_pool
            if gpu_pool.online_pod_count("voice_clone") > 0:
                pod_cm = gpu_pool.pick_pod("voice_clone")
                pod = await pod_cm.__aenter__()
                ops_url = pod.url + "/voice-clone"
                if pod.api_key:
                    headers["Authorization"] = f"Bearer {pod.api_key}"
        except Exception as e:
            try:
                from ops.pool import NoCapacity
                if isinstance(e, NoCapacity):
                    return None, "voice_clone fleet busy (all pods at capacity)"
            except ImportError:
                pass
            pod_cm = None

    effective_url = ops_url or (base_url or STUDIO_VOICE_CLONE_URL or "").strip()
    if effective_url:
        url = effective_url
        if not headers.get("Authorization") and STUDIO_VOICE_CLONE_API_KEY:
            headers["Authorization"] = f"Bearer {STUDIO_VOICE_CLONE_API_KEY}"
        req_mode = STUDIO_VOICE_CLONE_REQUEST_MODE
    else:
        slug = (chute_slug or STUDIO_VOICE_CLONE_CHUTE_SLUG).strip()
        if not slug:
            # Log the operator-facing detail (env var names) but return
            # a generic user-facing message — exposing internal env
            # vars to API callers leaks deployment topology and gives
            # the false impression that the customer can act on it.
            _log.error(
                "studio_tts: voice clone not configured — set STUDIO_VOICE_CLONE_URL "
                "OR STUDIO_VOICE_CLONE_CHUTE_SLUG (admin ops form). Until then "
                "all voice-clone synthesis on this deployment will 503."
            )
            return None, "voice synthesis temporarily unavailable"
        url = _chute_voice_clone_url(slug)
        if CHUTES_AUTH_KEY:
            headers["Authorization"] = f"Bearer {CHUTES_AUTH_KEY}"
        req_mode = "json"
    try:
        async with aiohttp.ClientSession() as session:
            if req_mode in ("form", "multipart", "form-data"):
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
            elif req_mode in ("form_file", "multipart_file", "file"):
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
    finally:
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass


def voice_design_llm_model_ids_for_catalog() -> list[str]:
    """
    Individual model ids from VOICE_DESIGN_LLM_MODEL for GET /v1/models validation.
    Strips known routing suffixes (e.g. :throughput) from the segment that includes them.
    """
    raw = (VOICE_DESIGN_LLM_MODEL or "").strip()
    if not raw:
        return []
    out: list[str] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        if ":" in p:
            base, _, suf = p.rpartition(":")
            if suf.lower() in CHUTES_LLM_ROUTING_SUFFIXES:
                p = base.strip()
        out.append(p)
    return out


def voice_design_llm_configured() -> bool:
    """Chutes LLM chat completions: needs model id + API key (CHUTES_API_KEY / CHUTES_AUTH_KEY)."""
    return bool(VOICE_DESIGN_LLM_MODEL and CHUTES_AUTH_KEY)


def clamp_sample_script_words(text: str, low: int | None = None, high: int | None = None) -> str:
    """Force sample line to target word range (defaults from env). Pad or truncate."""
    lo = low if low is not None else VOICE_DESIGN_SAMPLE_WORDS_MIN
    hi = high if high is not None else VOICE_DESIGN_SAMPLE_WORDS_MAX
    if hi < lo:
        lo, hi = hi, lo
    raw = (text or "").strip()
    if (raw.startswith('"') and raw.endswith('"')) or (raw.startswith("'") and raw.endswith("'")):
        raw = raw[1:-1].strip()
    words = raw.split() if raw else []
    if len(words) > hi:
        words = words[:hi]
    if len(words) < lo:
        filler = [
            "hey", "thanks", "so", "much", "for", "being", "here", "today",
            "I", "really", "appreciate", "you", "taking", "the", "time",
            "to", "listen", "and", "enjoy", "this", "moment", "with", "me",
        ]
        i = 0
        while len(words) < lo and i < len(filler):
            if filler[i] not in {w.lower() for w in words}:
                words.append(filler[i])
            i += 1
        while len(words) < lo:
            words.append("today")
    return " ".join(words)


def _assistant_message_text(message: object) -> str:
    """
    Normalize assistant message.content for OpenAI-compatible APIs.
    Some models (e.g. Kimi on Chutes) return content as a list of {type, text} parts instead of a string.
    """
    if not isinstance(message, dict):
        return ""
    raw = message.get("content")
    if raw is None:
        raw = ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, list):
        parts: list[str] = []
        for item in raw:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                t = item.get("text")
                if isinstance(t, str):
                    parts.append(t)
                elif isinstance(item.get("content"), str):
                    parts.append(item["content"])
        return "".join(parts)
    return str(raw)


def _assistant_text_from_choice(ch: object) -> str:
    """Best-effort assistant text from one chat.completion choice."""
    if not isinstance(ch, dict):
        return ""
    msg = ch.get("message")
    text = _assistant_message_text(msg) if isinstance(msg, dict) else ""
    if text.strip():
        return text
    # Some stacks expose legacy "text" on the choice
    legacy = ch.get("text")
    if isinstance(legacy, str) and legacy.strip():
        return legacy
    # Reasoning-style models may expose reasoning / reasoning_content only (avoid as primary JSON source)
    if isinstance(msg, dict):
        for key in ("reasoning", "reasoning_content", "thinking"):
            r = msg.get(key)
            if isinstance(r, str) and r.strip():
                return r
    return ""


def _extract_json_dict_from_llm_text(text: str) -> dict | None:
    t = (text or "").strip()
    if not t:
        return None
    if t.startswith("```"):
        lines = t.split("\n")
        if lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    try:
        data = json.loads(t)
        return data if isinstance(data, dict) else None
    except Exception:
        pass
    start = t.find("{")
    end = t.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(t[start : end + 1])
            return data if isinstance(data, dict) else None
        except Exception:
            return None
    return None


def _parse_voice_design_llm_payload(data: dict) -> tuple[str | None, str | None]:
    """Return (sample_script, revised_instruction) from various key conventions."""
    script = (
        data.get("sample_script")
        or data.get("sample_text")
        or data.get("script")
        or data.get("demo_text")
    )
    revised = (
        data.get("revised_instruction")
        or data.get("revised_voice_description")
        or data.get("revised_description")
        or data.get("instruction")
    )
    if isinstance(script, str):
        script = script.strip()
    else:
        script = None
    if isinstance(revised, str):
        revised = revised.strip()
    else:
        revised = None
    return script, revised


async def voice_design_llm_plan(*, voice_description: str) -> tuple[dict | None, str]:
    """Voice Design plan (sample_script + revised_instruction) via the
    unified llm_client. Routes to the local Qwen3-4B endpoint by default,
    falls back to Chutes (with VOICE_DESIGN_LLM_MODEL) on error."""
    # Avoid import cycles: voicechat / agents may import this module.
    from llm_client import chat_complete, llm_configured

    if not llm_configured():
        return None, "no LLM configured (set LOCAL_LLM_BASE_URL or VOICE_DESIGN_LLM_MODEL+CHUTES_AUTH_KEY)"
    user_desc = (voice_description or "").strip()
    if not user_desc:
        return None, "voice description is empty"
    system_rules = (
        "You help design voices for PromptTTS. Reply with a single JSON object only, no markdown. "
        'Keys: "sample_script" (string) and "revised_instruction" (string). '
        f"sample_script MUST be natural spoken dialogue of exactly {VOICE_DESIGN_SAMPLE_WORDS_MIN} to "
        f"{VOICE_DESIGN_SAMPLE_WORDS_MAX} words in English — about 1–2 sentences that feel natural when spoken aloud "
        "and fit the vibe of the described voice. "
        "revised_instruction: one clear English instruction for a TTS model describing timbre, age, emotion, pace, tone — "
        "improved from the user's wording, no quotes inside the values."
    )
    messages = [
        {"role": "system", "content": system_rules},
        {"role": "user", "content": f"The user wants this voice:\n{user_desc}"},
    ]
    last_err = ""
    max_tries = max(1, VOICE_DESIGN_LLM_RETRY_MAX)
    try:
        for attempt in range(max_tries):
            try:
                content = await chat_complete(
                    messages,
                    temperature=VOICE_DESIGN_LLM_TEMPERATURE,
                    max_tokens=VOICE_DESIGN_LLM_MAX_TOKENS,
                    retries=0,  # we handle retries here for the bigger backoff
                )
            except RuntimeError as exc:
                last_err = str(exc)
                msg = last_err.lower()
                transient = ("returned 5" in msg) or ("returned 429" in msg) or ("timed out" in msg) or ("connect" in msg)
                _log.warning(
                    "voice_design_llm_plan: attempt %s/%s failed (transient=%s): %s",
                    attempt + 1, max_tries, transient, last_err[:300],
                )
                if attempt + 1 >= max_tries or not transient:
                    return None, last_err
                delay = min(VOICE_DESIGN_LLM_RETRY_BASE_SEC * (2 ** attempt), 120.0)
                await asyncio.sleep(delay)
                continue

            if not content:
                _log.error("voice_design_llm_plan: empty content")
                return None, "LLM returned empty content"

            inner = _extract_json_dict_from_llm_text(content)
            if not inner:
                _log.error(
                    "voice_design_llm_plan: no JSON in assistant text. content=%r",
                    content[:400],
                )
                return None, "LLM response did not contain a JSON object with sample_script and revised_instruction"
            script, revised = _parse_voice_design_llm_payload(inner)
            if not script or not revised:
                _log.error(
                    "voice_design_llm_plan: missing keys after parse script_empty=%s revised_empty=%s",
                    not bool(script),
                    not bool(revised),
                )
                return None, "LLM JSON missing sample_script or revised_instruction"
            script = clamp_sample_script_words(script)
            revised = revised.strip()
            if len(revised) < 8:
                _log.error("voice_design_llm_plan: revised_instruction too short len=%s", len(revised))
                return None, "revised_instruction too short"
            return {
                "sample_script": script,
                "revised_instruction": revised,
                "raw": {"content": content},
            }, ""
        _log.error(
            "voice_design_llm_plan: loop exhausted without success last_err=%r",
            last_err,
        )
        return None, last_err or "LLM retries exhausted"
    except asyncio.TimeoutError:
        _log.error(
            "voice_design_llm_plan: timeout timeout_sec=%s",
            VOICE_DESIGN_LLM_TIMEOUT_SEC,
        )
        return None, "voice design LLM timed out"
    except Exception as e:
        _log.exception("voice_design_llm_plan: request error")
        return None, str(e)


def download_object_bytes(bucket: str, key: str) -> bytes | None:
    try:
        client = _minio_client()
        obj = client.get_object(bucket, key)
        try:
            return obj.read()
        finally:
            obj.close()
            obj.release_conn()
    except Exception:
        return None


def delete_object(bucket: str, key: str) -> None:
    try:
        _minio_client().remove_object(bucket, key)
    except Exception:
        pass


def copy_wav_in_bucket(user_id: str, src_bucket: str, src_key: str, dest_key_prefix: str = "voice-design/saved") -> tuple[str, str, datetime] | None:
    """Copy existing object to new key under user_id; returns (bucket, new_key, expires_at)."""
    data = download_object_bytes(src_bucket, src_key)
    if not data:
        return None
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    new_key = f"{user_id}/{dest_key_prefix}/{uuid.uuid4().hex}.wav"
    expires_at = datetime.now(timezone.utc) + timedelta(days=STUDIO_TTS_EXPIRY_DAYS)

    client.put_object(
        bucket,
        new_key,
        BytesIO(data),
        length=len(data),
        content_type="audio/wav",
    )
    return bucket, new_key, expires_at


def ensure_bucket(client: Minio, bucket: str) -> None:
    """Create bucket if it does not exist. Skipped for R2 (buckets created via dashboard)."""
    if BUCKET_PROVIDER == "r2":
        return  # R2 buckets are created in Cloudflare dashboard
    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def upload_wav_preview(user_id: str, preview_token: str, variant: str, wav_bytes: bytes) -> tuple[str, str, datetime]:
    """Short-TTL preview WAV under voice-design/preview/. Returns (bucket, key, expires_at)."""
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    key = f"{user_id}/voice-design/preview/{preview_token}/{variant}.wav"
    expires_at = datetime.now(timezone.utc) + timedelta(hours=VOICE_DESIGN_PREVIEW_EXPIRY_HOURS)
    client.put_object(
        bucket,
        key,
        BytesIO(wav_bytes),
        length=len(wav_bytes),
        content_type="audio/wav",
    )
    return bucket, key, expires_at


# ---------------------------------------------------------------------------
# Call-recording helpers (stereo WAVs from voice agent sessions)
#
# Layout: ``{user_id}/call-recordings/{session_id}.wav`` in the active
# bucket (R2 by default). Key is deterministic — session_id is server-
# issued + unique — so uploads are idempotent and the audio endpoint
# can build the presigned URL straight from session_id without an
# extra round trip.
# ---------------------------------------------------------------------------

CALL_RECORDING_SUBDIR = "call-recordings"


# ---------------------------------------------------------------------------
# Public-asset uploads (blog images, etc)
#
# Layout: ``blog/<uuid>.<ext>`` in the active bucket. No user_id prefix —
# blog assets are global. The bucket is served by the configured
# ``R2_PUBLIC_DOMAIN`` (e.g. audio.vocence.ai) so the returned URL is
# direct-public (no presigning, no expiry). If the deployment hasn't
# configured a public R2 domain we fall back to a long-lived presigned
# URL — works but blog images would need rotation every PRESIGNED_EXPIRY.
# ---------------------------------------------------------------------------

BLOG_IMAGES_SUBDIR = "blog"


def upload_public_blog_image(
    content: bytes,
    *,
    extension: str,
    content_type: str,
) -> tuple[str, str, str]:
    """Upload an admin-supplied blog image to the active public bucket.
    Returns ``(bucket, key, public_url)``. The public_url is what gets
    written into ``blog_posts.image`` and served to every visitor.

    Admin-only call (blog editor). Image-only content-type is enforced
    at the router; this helper trusts its inputs.
    """
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    safe_ext = (extension or "jpg").lstrip(".").lower() or "jpg"
    key = f"{BLOG_IMAGES_SUBDIR}/{uuid.uuid4().hex}.{safe_ext}"
    client.put_object(
        bucket,
        key,
        BytesIO(content),
        length=len(content),
        content_type=content_type or "application/octet-stream",
    )
    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        public_url = f"https://{R2_PUBLIC_DOMAIN}/{key}"
    else:
        # Hippius / no public domain configured — long-lived presigned
        # URL. Caller logs this as a misconfig because it'll expire.
        public_url = _minio_client().presigned_get_object(
            bucket, key, expires=timedelta(days=7)
        )
    return bucket, key, public_url


def upload_call_recording_wav(
    user_id: str,
    session_id: str,
    wav_bytes: bytes,
) -> tuple[str, str]:
    """Upload one session's stereo WAV to the active object store.
    Returns ``(bucket, key)``. Object stays until the retention sweep
    or a manual delete removes it via ``delete_call_recording_object``.
    """
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    key = f"{user_id}/{CALL_RECORDING_SUBDIR}/{session_id}.wav"
    client.put_object(
        bucket,
        key,
        BytesIO(wav_bytes),
        length=len(wav_bytes),
        content_type="audio/wav",
    )
    return bucket, key


def delete_call_recording_object(bucket: str, key: str) -> bool:
    """Remove a single recording object. Returns True on success or
    when the object was already gone (idempotent); False on a real
    bucket error so the caller can leave the DB row's pointer intact
    and retry on the next pass."""
    try:
        _minio_client().remove_object(bucket, key)
        return True
    except Exception:
        # MinIO's remove_object swallows "not found" by default — a
        # raised exception here means something else (auth, bucket
        # missing, transient network). Caller should NOT clear the
        # DB pointer; next sweep will retry.
        return False


def presigned_call_recording_url(
    bucket: str,
    key: str,
    expires_seconds: int = 3600,
    *,
    download_filename: str | None = None,
) -> str | None:
    """One-hour presigned GET URL for a recording. The browser's
    ``<audio>`` element follows the URL with normal Range requests so
    seek works. ``download_filename`` adds a Content-Disposition
    header for the explicit download button."""
    try:
        client = _minio_client()
        headers: dict[str, str] = {}
        if download_filename:
            headers["response-content-disposition"] = (
                f'attachment; filename="{download_filename}"'
            )
        return client.presigned_get_object(
            bucket,
            key,
            expires=timedelta(seconds=expires_seconds),
            response_headers=headers or None,
        )
    except Exception:
        return None


def upload_wav_to_hippius(user_id: str, wav_bytes: bytes, subdir: str = "") -> tuple[str, str, datetime]:
    """Upload WAV bytes to the active bucket (R2 or Hippius). Returns (bucket, key, expires_at).

    Args:
        subdir: Optional subdirectory under user_id, e.g. "tts", "music", "clone".
                Produces key: {user_id}/{subdir}/{uuid}.wav
    """
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
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


def upload_video_to_bucket(
    user_id: str,
    video_bytes: bytes,
    *,
    subdir: str = "video-dub",
    extension: str = "mp4",
    content_type: str = "video/mp4",
    retention_days: int | None = None,
) -> tuple[str, str, datetime | None]:
    """Upload video bytes to the active bucket. Returns (bucket, key, expires_at).

    Video counterpart of :func:`upload_wav_to_hippius`, but it does not force
    a ``.wav``/``audio/wav`` pair, so the object serves correctly to a browser
    ``<video>`` element.

    ``retention_days=None`` (the default) means **keep permanently** and
    returns ``expires_at=None``. Dubbed video is retained for every plan tier,
    free included: a dub is a deliverable the user paid credits to produce and
    often the only copy of a translated asset, unlike a regenerable TTS clip.
    Pass an integer to opt a caller back into a retention window.
    """
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    safe_ext = (extension or "mp4").lstrip(".").lower() or "mp4"
    key = f"{user_id}/{subdir}/{uuid.uuid4().hex}.{safe_ext}"
    expires_at = (
        None if retention_days is None
        else datetime.now(timezone.utc) + timedelta(days=retention_days)
    )
    client.put_object(
        bucket,
        key,
        BytesIO(video_bytes),
        length=len(video_bytes),
        content_type=content_type or "video/mp4",
    )
    return bucket, key, expires_at


def presigned_url_for_permanent_object(bucket: str, key: str, *, public: bool = False) -> str | None:
    """URL for an object with no retention window.

    Presigned links are inherently time-boxed, so a "permanent" asset gets a
    freshly-minted, maximum-length link on every request rather than one
    long-lived URL. Premium accounts on R2 get the public domain instead,
    which needs no signing at all.
    """
    if public and BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        return f"https://{R2_PUBLIC_DOMAIN}/{key}"
    horizon = datetime.now(timezone.utc) + timedelta(seconds=PRESIGNED_EXPIRY_SECONDS)
    return get_presigned_url(bucket, key, horizon, public=False)


def assert_user_owned_object(bucket: str, key: str, user_id: str, allowed_subdir: str) -> None:
    """Raise RuntimeError if the (bucket, key) pair isn't an object that:
    - lives in our active bucket
    - is namespaced under ``{user_id}/`` (matching the key shape that
      /uploads/presign produces)
    - sits under the expected ``allowed_subdir``

    Use this in workers before calling ``download_object_bytes`` or
    ``delete_object`` on a (bucket, key) pair that came from the client's
    job payload — otherwise a crafted payload could read/delete other
    users' files (the backend has full R2 credentials).
    """
    if bucket != _active_bucket():
        raise RuntimeError("Access denied: invalid bucket for audio source")
    parts = key.split("/", 2)
    if len(parts) < 3 or not parts[0] or not parts[1] or not parts[2]:
        raise RuntimeError("Access denied: malformed audio key")
    if parts[0] != user_id:
        raise RuntimeError("Access denied: audio key does not belong to this user")
    if parts[1] != allowed_subdir:
        raise RuntimeError(f"Access denied: audio key must be under {allowed_subdir!r}, got {parts[1]!r}")


# Cap on bytes pulled out of R2 for any single worker download. Mirrors
# the presign cap so a client can't bypass it by uploading a 10 GB file
# (the presigned URL doesn't sign Content-Length).
R2_MAX_DOWNLOAD_BYTES = int(os.environ.get("R2_MAX_DOWNLOAD_BYTES", str(300 * 1024 * 1024)))


def download_object_bytes_capped(bucket: str, key: str, max_bytes: int = R2_MAX_DOWNLOAD_BYTES) -> bytes | None:
    """Download an R2 object, refusing to load more than ``max_bytes``.
    Uses ``stat_object`` to check size before reading so we never pull a
    huge file into memory.
    """
    try:
        client = _minio_client()
        stat = client.stat_object(bucket, key)
        if stat.size is not None and stat.size > max_bytes:
            raise RuntimeError(
                f"Audio object exceeds maximum size: {stat.size} bytes > {max_bytes}"
            )
        obj = client.get_object(bucket, key)
        try:
            return obj.read()
        finally:
            obj.close()
            obj.release_conn()
    except RuntimeError:
        raise
    except Exception:
        return None


def presigned_put_url(bucket: str, key: str, expires_seconds: int = 900) -> str:
    """Generate a presigned PUT URL the browser can use to upload directly to R2.
    The signed URL is valid for ``expires_seconds`` (default 15 minutes) and
    points at the storage provider's domain (e.g. ``*.r2.cloudflarestorage.com``),
    not your API domain — so the byte transfer bypasses your domain's Cloudflare
    proxy entirely.
    """
    from datetime import timedelta as _td
    client = _minio_client()
    ensure_bucket(client, bucket)
    return client.presigned_put_object(bucket, key, expires=_td(seconds=expires_seconds))


def upload_audio_bytes_to_bucket(
    user_id: str,
    audio_bytes: bytes,
    *,
    subdir: str,
    extension: str = "wav",
    content_type: str = "audio/wav",
) -> tuple[str, str]:
    """Upload arbitrary audio bytes (any format) to the active bucket.
    Returns (bucket, key). Used for short-lived source-audio uploads
    submitted by the user for retake/repaint/edit/extend/audio2audio.
    """
    bucket = _active_bucket()
    client = _minio_client()
    ensure_bucket(client, bucket)
    safe_ext = (extension or "wav").lstrip(".").lower() or "wav"
    key = f"{user_id}/{subdir}/{uuid.uuid4().hex}.{safe_ext}"
    client.put_object(
        bucket,
        key,
        BytesIO(audio_bytes),
        length=len(audio_bytes),
        content_type=content_type or "application/octet-stream",
    )
    return bucket, key


def get_presigned_url(bucket: str, key: str, expires_at: datetime, *, public: bool = False) -> str | None:
    """Return a URL for the audio object.

    Args:
        public: If True AND R2 public domain is configured, returns a direct
                public URL that never expires. Used for premium Studio users only.
                Developer API and normal users always get presigned URLs.
    """
    # Public URL path — premium Studio users only
    if public and BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        return f"https://{R2_PUBLIC_DOMAIN}/{key}"

    # Presigned URL path (all API users, normal Studio users, or Hippius)
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
        filename = PurePosixPath(key).name or "vocence-tts.wav"
        return client.presigned_get_object(
            bucket,
            key,
            expires=timedelta(seconds=expiry_sec),
            response_headers={
                "response-content-disposition": f'attachment; filename="{filename}"',
            },
        )
    except Exception:
        return None
