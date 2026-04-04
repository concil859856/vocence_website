#!/usr/bin/env python3
"""
End-to-end Studio pipeline smoke test: Chutes LLM (Voice Design), TTS, STT, voice clone.

Loads dashboard-backend/.env before importing studio_tts_service (env is read at import time).

Usage (from dashboard-backend directory):
  python test/test_studio_pipeline.py
  python test/test_studio_pipeline.py --ref-audio test/clone_out009.wav
  python test/test_studio_pipeline.py --ref-audio /path/to/reference.wav
  python test/test_studio_pipeline.py --skip-clone
  python test/test_studio_pipeline.py --skip-tts   # LLM + STT + clone only if ref-audio set

Environment (see .env.example):
  CHUTES_API_KEY, VOICE_DESIGN_LLM_MODEL, STUDIO_MODEL_1_CHUTE_SLUG,
  STUDIO_VOICE_CLONE_URL, optional STUDIO_VOICE_CLONE_API_KEY

429 / capacity: production code retries with VOICE_DESIGN_LLM_RETRY_*; this script logs each step clearly.
"""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import logging
import os
import sys
import time
import wave
from pathlib import Path

# -----------------------------------------------------------------------------
# Load .env before studio_tts_service (module reads os.environ at import).
# -----------------------------------------------------------------------------
_BACKEND_ROOT = Path(__file__).resolve().parent.parent
try:
    from dotenv import load_dotenv

    _env_path = _BACKEND_ROOT / ".env"
    if _env_path.is_file():
        load_dotenv(_env_path)
        _loaded = str(_env_path)
    else:
        load_dotenv()
        _loaded = ".env (search)"
except ImportError:
    _loaded = "python-dotenv not installed; using process env only"

os.chdir(_BACKEND_ROOT)
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

import aiohttp

import studio_tts_service as sts

LOG = logging.getLogger("studio_pipeline_test")


def _mask(s: str | None, keep: int = 8) -> str:
    if not s:
        return "(empty)"
    s = s.strip()
    if len(s) <= keep * 2:
        return "***"
    return s[:keep] + "…" + s[-keep:]


def _setup_logging(verbose: bool) -> None:
    level = logging.DEBUG if verbose else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )


def _log_config() -> None:
    LOG.info("=== Environment summary (secrets masked) ===")
    LOG.info("dotenv: %s", _loaded)
    LOG.info("CHUTES_API_KEY: %s", _mask(os.environ.get("CHUTES_API_KEY") or os.environ.get("CHUTES_AUTH_KEY")))
    LOG.info("VOICE_DESIGN_LLM_BASE_URL: %s", sts.VOICE_DESIGN_LLM_BASE_URL)
    LOG.info("VOICE_DESIGN_LLM_MODEL: %s", sts.VOICE_DESIGN_LLM_MODEL or "(empty)")
    if (sts.VOICE_DESIGN_LLM_MODEL or "").strip() and "," not in sts.VOICE_DESIGN_LLM_MODEL:
        LOG.warning(
            "VOICE_DESIGN_LLM_MODEL is a single id — Chutes multi-pool failover uses a comma-separated list "
            "(optional :throughput on the last segment). See dashboard-backend/.env.example."
        )
    LOG.info("VOICE_DESIGN_LLM_RETRY_MAX: %s base_sec=%s", sts.VOICE_DESIGN_LLM_RETRY_MAX, sts.VOICE_DESIGN_LLM_RETRY_BASE_SEC)
    LOG.info("STUDIO_STT_CHUTES_URL: %s", sts.STUDIO_STT_CHUTES_URL)
    LOG.info("STUDIO_MODEL_1_CHUTE_SLUG (TTS): %s", os.environ.get("STUDIO_MODEL_1_CHUTE_SLUG") or "(empty)")
    LOG.info("STUDIO_VOICE_CLONE_URL: %s", sts.STUDIO_VOICE_CLONE_URL or "(empty)")
    LOG.info("STUDIO_VOICE_CLONE_REQUEST_MODE: %s", sts.STUDIO_VOICE_CLONE_REQUEST_MODE)
    LOG.info("voice_design_llm_configured(): %s", sts.voice_design_llm_configured())
    LOG.info("voice_clone_chute_configured(): %s", sts.voice_clone_chute_configured())
    LOG.info("=== End summary ===")


def make_silent_wav(duration_sec: float = 1.0, sample_rate: int = 16000) -> bytes:
    """Minimal mono 16-bit WAV (silence) for STT/clone smoke tests."""
    n = int(sample_rate * duration_sec)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(b"\x00\x00" * n)
    return buf.getvalue()


async def step_llm_models_list() -> bool:
    """GET /v1/models — lightweight Chutes LLM connectivity check."""
    base = sts.VOICE_DESIGN_LLM_BASE_URL.rstrip("/")
    url = f"{base}/models"
    headers = {"Authorization": f"Bearer {sts.CHUTES_AUTH_KEY}"}
    LOG.info("STEP: Chutes LLM list models GET %s", url)
    t0 = time.perf_counter()
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=60)) as resp:
                body = await resp.read()
                elapsed = time.perf_counter() - t0
                LOG.info("  -> status=%s elapsed=%.2fs bytes=%s", resp.status, elapsed, len(body))
                if resp.status != 200:
                    LOG.error("  body: %s", body[:500].decode("utf-8", errors="replace"))
                    return False
                data = json.loads(body.decode("utf-8"))
                models = data.get("data") if isinstance(data, dict) else None
                n = len(models) if isinstance(models, list) else 0
                LOG.info("  -> models count=%s", n)
                if sts.VOICE_DESIGN_LLM_MODEL and isinstance(models, list):
                    ids = {m.get("id") for m in models if isinstance(m, dict)}
                    want = sts.voice_design_llm_model_ids_for_catalog()
                    missing = [w for w in want if w not in ids]
                    ok = not missing
                    LOG.info(
                        "  -> VOICE_DESIGN_LLM_MODEL catalog check: %s (ids=%s)",
                        ok,
                        want if len(want) <= 6 else f"{want[:6]}…(+{len(want) - 6})",
                    )
                    if missing:
                        LOG.warning("  -> not in /v1/models: %s", missing)
                    if not ok and ids:
                        sample = sorted(ids)[:5]
                        LOG.warning("  sample catalog ids: %s ...", sample)
                return True
    except Exception as e:
        LOG.exception("  -> models list failed: %s", e)
        return False


async def step_voice_design_llm() -> dict | None:
    LOG.info("STEP: Voice Design LLM (voice_design_llm_plan)")
    desc = (
        "Warm female podcast host in her thirties, friendly and clear, slight smile, "
        "medium pacing for educational content."
    )
    t0 = time.perf_counter()
    plan, err = await sts.voice_design_llm_plan(voice_description=desc)
    elapsed = time.perf_counter() - t0
    if err:
        LOG.error("  -> FAIL after %.2fs: %s", elapsed, err)
        return None
    LOG.info("  -> OK in %.2fs", elapsed)
    LOG.info("  sample_script: %s", plan.get("sample_script"))
    LOG.info("  revised_instruction (trunc): %s…", str(plan.get("revised_instruction"))[:120])
    return plan


async def step_tts(chute_slug: str, text: str, instruction: str) -> bytes | None:
    LOG.info("STEP: TTS synthesize_speak slug=%s", chute_slug)
    LOG.info("  text=%s", text[:80] + ("…" if len(text) > 80 else ""))
    t0 = time.perf_counter()
    wav, err = await sts.synthesize_speak(chute_slug, text, instruction)
    elapsed = time.perf_counter() - t0
    if err or not wav:
        LOG.error("  -> FAIL after %.2fs: %s", elapsed, err or "no audio")
        return None
    LOG.info("  -> OK in %.2fs wav_bytes=%s", elapsed, len(wav))
    return wav


async def step_stt(audio_bytes: bytes, label: str) -> str | None:
    LOG.info("STEP: STT transcribe_audio (%s) bytes=%s", label, len(audio_bytes))
    t0 = time.perf_counter()
    result, err = await sts.transcribe_audio(audio_bytes=audio_bytes, language="en")
    elapsed = time.perf_counter() - t0
    if err or not result:
        LOG.error("  -> FAIL after %.2fs: %s", elapsed, err or "no result")
        return None
    text = str(result.get("text") or "").strip()
    LOG.info("  -> OK in %.2fs text=%s", elapsed, text[:200] + ("…" if len(text) > 200 else ""))
    return text


async def step_clone(ref_wav: bytes, ref_text: str, target: str) -> bool:
    LOG.info("STEP: voice_clone_synthesize url=%s", sts.STUDIO_VOICE_CLONE_URL or "(legacy chute)")
    t0 = time.perf_counter()
    out, err = await sts.voice_clone_synthesize(
        reference_audio_bytes=ref_wav,
        reference_text=ref_text,
        target_text=target,
    )
    elapsed = time.perf_counter() - t0
    if err or not out:
        LOG.error("  -> FAIL after %.2fs: %s", elapsed, err or "no audio")
        return False
    LOG.info("  -> OK in %.2fs output_bytes=%s", elapsed, len(out))
    return True


async def run_pipeline(args: argparse.Namespace) -> int:
    _setup_logging(args.verbose)
    _log_config()

    ok_models = await step_llm_models_list()
    if not ok_models and not args.force:
        LOG.warning("Models list failed; continuing anyway (--force to always continue)")

    plan = await step_voice_design_llm()
    if not plan:
        LOG.error("Pipeline aborted: Voice Design LLM failed.")
        return 1

    chute_slug = (os.environ.get("STUDIO_MODEL_1_CHUTE_SLUG") or "").strip()
    ref_wav: bytes | None = None
    ref_text: str | None = None

    if args.ref_audio:
        path = Path(args.ref_audio).expanduser().resolve()
        if not path.is_file():
            LOG.error("ref-audio not found: %s", path)
            return 1
        ref_wav = path.read_bytes()
        LOG.info("Loaded ref-audio from file: %s bytes=%s", path, len(ref_wav))
    elif not args.skip_tts and chute_slug:
        sample = str(plan.get("sample_script") or "Hello from the Vocence pipeline test.")
        revised = str(plan.get("revised_instruction") or "neutral clear voice")
        wav = await step_tts(chute_slug, sample, revised)
        if wav:
            ref_wav = wav
    else:
        LOG.info("No ref-audio file and (skip-tts or no chute slug); using silent WAV for STT/clone probes.")
        ref_wav = make_silent_wav(1.0)

    if args.skip_stt:
        ref_text = "Reference line for clone smoke test."
        LOG.info("STT skipped; using fixed ref_text for clone.")
    else:
        stt_label = "file" if args.ref_audio else "tts-or-silent"
        ref_text = await step_stt(ref_wav, stt_label) if ref_wav else None
        if not ref_text:
            LOG.warning("STT empty/failed; using fallback ref_text for clone attempt.")
            ref_text = "This is a fallback reference transcription for testing."

    if args.skip_clone:
        LOG.info("STEP: clone skipped (--skip-clone)")
        return 0

    if not sts.voice_clone_chute_configured():
        LOG.error("Clone not configured (STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG). Skipping.")
        return 0 if args.relaxed else 1

    if not ref_wav:
        LOG.error("No reference audio for clone.")
        return 1

    clone_ok = await step_clone(ref_wav, ref_text, args.clone_target)
    return 0 if clone_ok else (0 if args.relaxed else 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Studio pipeline integration test (LLM, TTS, STT, clone).")
    p.add_argument("--ref-audio", type=str, default=None, help="Optional WAV path; bypasses TTS for ref audio.")
    p.add_argument("--skip-tts", action="store_true", help="Do not call TTS (use silent wav unless --ref-audio).")
    p.add_argument("--skip-stt", action="store_true", help="Skip STT; use dummy ref text for clone.")
    p.add_argument("--skip-clone", action="store_true", help="Stop before voice clone.")
    p.add_argument("--clone-target", type=str, default="This is an automated clone check from the pipeline script.")
    p.add_argument("--force", action="store_true", help="Continue even if /v1/models list fails.")
    p.add_argument("--relaxed", action="store_true", help="Exit 0 if optional steps (e.g. clone) fail.")
    p.add_argument("-v", "--verbose", action="store_true")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(run_pipeline(args))
    except KeyboardInterrupt:
        LOG.warning("Interrupted.")
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
