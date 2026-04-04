#!/usr/bin/env python3
"""
Simple STT test script for Chutes Whisper endpoint.

Usage:
  python test/test_stt_chutes.py /absolute/or/relative/path/to/audio.wav
  python test/test_stt_chutes.py ./sample.mp3 --language en
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path
from urllib import error, request


DEFAULT_STT_URL = "https://chutes-whisper-large-v3.chutes.ai/transcribe"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Test Chutes STT transcription.")
    parser.add_argument("audio_path", help="Path to input audio file")
    parser.add_argument(
        "--language",
        default=None,
        help="Optional language code (e.g. en, fr, es)",
    )
    parser.add_argument(
        "--url",
        default=os.environ.get("CHUTES_WHISPER_STT_URL", DEFAULT_STT_URL),
        help=f"STT endpoint URL (default: {DEFAULT_STT_URL})",
    )
    return parser.parse_args()


def load_api_token() -> str:
    token = (os.environ.get("CHUTES_API_TOKEN") or os.environ.get("CHUTES_API_KEY") or os.environ.get("CHUTES_AUTH_KEY") or "").strip()
    if not token:
        raise RuntimeError(
            "Missing API token. Set CHUTES_API_TOKEN (or CHUTES_API_KEY / CHUTES_AUTH_KEY)."
        )
    return token


def main() -> int:
    args = parse_args()
    token = ""

    path = Path(args.audio_path).expanduser().resolve()
    if not path.exists() or not path.is_file():
        print(f"Audio file not found: {path}", file=sys.stderr)
        return 1

    audio_bytes = path.read_bytes()
    if not audio_bytes:
        print("Audio file is empty.", file=sys.stderr)
        return 1

    payload: dict[str, str] = {
        "audio_b64": base64.b64encode(audio_bytes).decode("utf-8"),
    }
    if args.language:
        payload["language"] = args.language

    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        args.url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )

    try:
        with request.urlopen(req, timeout=180) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            data = json.loads(raw)
    except error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {err_body}", file=sys.stderr)
        return 2
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 2

    # Some Chutes deployments return an object; others may return a list of objects.
    if isinstance(data, list):
        first = data[0] if data else {}
        if not isinstance(first, dict):
            first = {}
        payload_obj = first
    elif isinstance(data, dict):
        payload_obj = data
    else:
        payload_obj = {}

    text = str(payload_obj.get("text") or "").strip()
    print("\n=== Transcription ===")
    print(text if text else "(empty)")

    language = payload_obj.get("language")
    if language:
        print(f"\nDetected language: {language}")

    chunks = payload_obj.get("chunks")
    if isinstance(chunks, list) and chunks:
        print(f"\nChunks: {len(chunks)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
