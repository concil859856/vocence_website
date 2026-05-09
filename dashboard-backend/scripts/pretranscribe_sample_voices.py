"""One-time pre-transcription of all sample voices.

Runs every voice in ``sample_voices_data`` through the configured STT
service and writes the results to ``sample_voice_transcripts.json``
next to the backend code. The voicechat clone path then reads from
that file at runtime instead of re-STT'ing on first use.

Run it once whenever you add or change sample voices:

    cd /workspace/vocence_website/dashboard-backend
    source venv/bin/activate
    python scripts/pretranscribe_sample_voices.py            # skip already-done
    python scripts/pretranscribe_sample_voices.py --force    # re-do all
    python scripts/pretranscribe_sample_voices.py voc-iris   # one voice
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / ".env")

from sample_voices_data import (  # noqa: E402
    SAMPLE_VOICE_AUDIO_URLS,
    SAMPLE_VOICE_LOCAL_FILES,
    get_sample_url,
    read_local_sample_bytes,
)
from studio_tts_service import transcribe_audio  # noqa: E402


OUT_PATH = ROOT / "sample_voice_transcripts.json"


def _all_voice_ids() -> list[str]:
    return list(SAMPLE_VOICE_LOCAL_FILES.keys()) + list(SAMPLE_VOICE_AUDIO_URLS.keys())


async def _fetch_remote(url: str) -> bytes:
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as s:
        async with s.get(url) as r:
            r.raise_for_status()
            return await r.read()


async def _transcribe(voice_id: str) -> str:
    audio = read_local_sample_bytes(voice_id)
    if audio is None:
        url = get_sample_url(voice_id)
        if not url:
            raise RuntimeError(f"no audio source for {voice_id}")
        audio = await _fetch_remote(url)
    data, err = await transcribe_audio(audio_bytes=audio)
    if not data:
        raise RuntimeError(f"STT failed for {voice_id}: {err}")
    text = (data.get("text") or "").strip()
    if not text:
        raise RuntimeError(f"STT returned empty for {voice_id}")
    return text


def _load_existing() -> dict[str, str]:
    if not OUT_PATH.exists():
        return {}
    try:
        return json.loads(OUT_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(transcripts: dict[str, str]) -> None:
    # Sort for stable diffs
    ordered = {k: transcripts[k] for k in sorted(transcripts.keys())}
    OUT_PATH.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


async def main() -> int:
    args = sys.argv[1:]
    force = "--force" in args
    if force:
        args.remove("--force")
    targets = args or _all_voice_ids()

    existing = _load_existing()
    todo = [vid for vid in targets if force or vid not in existing or not existing[vid].strip()]
    skipped = [vid for vid in targets if vid not in todo]

    if skipped:
        print(f"skipping {len(skipped)} already-cached voices "
              f"(use --force to re-do)")
    if not todo:
        print(f"nothing to do — {len(existing)} voices already cached at {OUT_PATH.name}")
        return 0

    print(f"transcribing {len(todo)} voices via STT…")
    failures: list[tuple[str, str]] = []
    for vid in todo:
        try:
            text = await _transcribe(vid)
            existing[vid] = text
            preview = (text[:90] + "…") if len(text) > 90 else text
            print(f"  ✓ {vid:30} {preview!r}")
            _save(existing)  # persist as we go so a crash mid-run doesn't lose progress
        except Exception as exc:
            print(f"  ✗ {vid:30} FAILED: {exc}")
            failures.append((vid, str(exc)))

    print()
    print(f"saved {len(existing)} transcripts → {OUT_PATH}")
    if failures:
        print(f"{len(failures)} failures:")
        for vid, err in failures:
            print(f"  {vid}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
