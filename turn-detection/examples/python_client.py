"""Reference Python client for both turn-detection WS endpoints.

Run against a live pod:

    python python_client.py text  --url ws://localhost:8117 --api-key <key>
    python python_client.py audio --url ws://localhost:8117 --api-key <key> \
        --audio ../tests/fixtures/complete_sentence.wav

Demonstrates the exact protocol shapes the Vocence dashboard backend
speaks. Use as a starting point for the equivalent client in any other
language — the wire format is plain JSON + binary frames.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import wave
from pathlib import Path

import numpy as np
import websockets


async def text_demo(url: str, api_key: str) -> None:
    """Stream a sequence of cumulative partials to the text endpoint
    and print every probability/end_of_turn event the server emits."""
    target_url = url.rstrip("/") + "/v1/turn-detector"
    print(f"→ connecting to {target_url}")
    async with websockets.connect(
        target_url, additional_headers={"X-API-Key": api_key}
    ) as ws:
        await ws.send(json.dumps({
            "type": "start",
            "history": [],
            "language": "en",
        }))
        print("← ready:", json.loads(await ws.recv()))

        # Each token frame carries the cumulative running transcript
        # so the model sees the full state at every step. This is what
        # the dashboard backend will do when it forwards STT partials.
        partials = [
            "what",
            "what time",
            "what time does",
            "what time does the store",
            "what time does the store open",
        ]
        for p in partials:
            await ws.send(json.dumps(
                {"type": "token", "text": p, "is_final": False}
            ))
            # Drain whatever events the server has emitted so far.
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.5))
                    print(f"  on '{p}':", msg)
                    if msg["type"] in ("error",):
                        await ws.close()
                        return
            except asyncio.TimeoutError:
                pass

        await ws.send(json.dumps({"type": "close"}))


async def audio_demo(url: str, api_key: str, audio_path: Path) -> None:
    """Stream a WAV file at 20ms chunks to the audio endpoint and print
    every probability / end_of_turn event the server emits."""
    target_url = url.rstrip("/") + "/v1/smart-turn"
    samples_16k_mono = _load_wav_mono_16k(audio_path)
    print(f"→ connecting to {target_url}")
    print(f"  audio: {audio_path.name}, "
          f"{samples_16k_mono.shape[0]/16000:.2f}s")

    async with websockets.connect(
        target_url, additional_headers={"X-API-Key": api_key}
    ) as ws:
        await ws.send(json.dumps({
            "type": "start",
            "sample_rate": 16000,
            "encoding": "pcm_s16le",
            "window_ms": 4000,
            "emit_every_ms": 150,
        }))
        print("← ready:", json.loads(await ws.recv()))

        # Send the file in 20 ms chunks (320 samples = 640 bytes) at
        # roughly real-time pace, so the server sees the same chunking
        # cadence a live mic would produce.
        chunk_samples = 320
        bytes_per_sample = 2
        # Convert float → int16 once.
        pcm16 = (samples_16k_mono * 32768).clip(-32768, 32767).astype("<i2")
        for i in range(0, pcm16.shape[0], chunk_samples):
            chunk = pcm16[i : i + chunk_samples].tobytes()
            # Pad the last chunk to the minimum acceptable frame size if
            # it's smaller than the protocol minimum (80 samples).
            if len(chunk) < 80 * bytes_per_sample:
                break
            await ws.send(chunk)
            await asyncio.sleep(0.020)
            # Drain any pending events before the next push.
            try:
                while True:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=0.001))
                    print(f"  t={i/16000:.2f}s:", msg)
            except asyncio.TimeoutError:
                pass

        await ws.send(json.dumps({"type": "close"}))


def _load_wav_mono_16k(path: Path) -> np.ndarray:
    """Load a WAV file into a float32 array, rejecting incompatible
    sample rates / channel counts. Matches what the WS endpoint
    expects after PCM normalization."""
    with wave.open(str(path), "rb") as wf:
        if wf.getframerate() != 16000:
            raise SystemExit(
                f"audio must be 16 kHz; got {wf.getframerate()} Hz"
            )
        if wf.getnchannels() != 1:
            raise SystemExit(
                f"audio must be mono; got {wf.getnchannels()} channels"
            )
        if wf.getsampwidth() != 2:
            raise SystemExit(
                f"audio must be 16-bit; got {wf.getsampwidth()*8} bits"
            )
        frames = wf.readframes(wf.getnframes())
    return np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0


def main() -> int:
    parser = argparse.ArgumentParser(description="Vocence turn-detection demo client")
    parser.add_argument("mode", choices=("text", "audio"))
    parser.add_argument("--url", default="ws://localhost:8117")
    parser.add_argument("--api-key", required=True)
    parser.add_argument("--audio", help="WAV file for the audio demo", type=Path)
    args = parser.parse_args()

    if args.mode == "audio" and not args.audio:
        parser.error("--audio is required for audio mode")

    if args.mode == "text":
        asyncio.run(text_demo(args.url, args.api_key))
    else:
        asyncio.run(audio_demo(args.url, args.api_key, args.audio))
    return 0


if __name__ == "__main__":
    sys.exit(main())
