"""Audio metadata probe — duration in seconds via ffprobe.

Used to reject over-cap uploads on STT and Noise Remover before they
reach the expensive backend (subnet inference or DeepFilterNet).
Returns None when ffprobe isn't installed or fails to parse; callers
should treat None as "unknown" rather than "zero" and fall back to a
post-call duration check from the provider response.

Sync wrapper around subprocess — duration probe is fast (typically
< 50ms) so we don't bother making it async. If you call this from
an async route, wrap in ``asyncio.to_thread`` to avoid blocking
the event loop on big files (ffprobe parses the whole header).
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


def probe_audio_duration_seconds(audio_bytes: bytes, filename_hint: str | None = None) -> float | None:
    """Return audio duration in seconds, or None if ffprobe can't determine it.

    Writes to a temp file because ffprobe's stdin support is unreliable
    for compressed formats (ogg / flac / m4a often need to seek).
    Cleans up the temp file even on subprocess error.
    """
    if not audio_bytes:
        return 0.0

    # Use the filename extension as a hint so ffprobe picks the right
    # demuxer immediately instead of probing all of them.
    suffix = ""
    if filename_hint:
        ext = Path(filename_hint).suffix.lower()
        if ext and len(ext) <= 6:
            suffix = ext

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(audio_bytes)
            tmp_path = Path(f.name)

        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "json",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or "{}")
        dur = data.get("format", {}).get("duration")
        if dur is None:
            return None
        return float(dur)
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, OSError):
        # ffprobe absent or broken — caller falls back to post-call check.
        return None
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
