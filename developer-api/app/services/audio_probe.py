"""Audio duration probe via ffprobe.

Mirror of dashboard-backend/audio_probe.py. Used by per-minute billing
paths (noise remover) to compute the actual usage before charging the
user. Returns None when ffprobe is unavailable; callers should treat
None as "unknown" and fall back to the worst-case (max-cap) bill.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


def probe_audio_duration_seconds(audio_bytes: bytes, filename_hint: str | None = None) -> float | None:
    """Return duration in seconds, or None if ffprobe can't determine it."""
    if not audio_bytes:
        return 0.0

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
        return None
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
