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


def extract_poster_frame(
    video_bytes: bytes,
    filename_hint: str | None = None,
    *,
    at_seconds: float = 1.0,
    width: int = 480,
) -> bytes | None:
    """Grab one frame as a JPEG thumbnail, or None if ffmpeg can't.

    A library of videos rendered as text rows reads like a spreadsheet, so
    every stored dub gets a poster. Seeks to ``at_seconds`` rather than frame
    0 because the first frame of real footage is very often black or a fade-in.
    Falls back to frame 0 when the clip is shorter than the seek point.

    Height is derived from ``width`` to preserve aspect ratio. Returns None on
    any failure — a missing poster degrades the card, it must never fail the job.
    """
    if not video_bytes:
        return None

    suffix = ""
    if filename_hint:
        ext = Path(filename_hint).suffix.lower()
        if ext and len(ext) <= 6:
            suffix = ext

    tmp_path: Path | None = None
    out_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(video_bytes)
            tmp_path = Path(f.name)
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            out_path = Path(f.name)

        for seek in (at_seconds, 0.0):
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-v", "error",
                    "-ss", str(seek),
                    "-i", str(tmp_path),
                    "-frames:v", "1",
                    "-vf", f"scale={width}:-2",
                    "-f", "image2",
                    str(out_path),
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                return out_path.read_bytes()
        return None
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    finally:
        for p in (tmp_path, out_path):
            if p is not None:
                try:
                    p.unlink()
                except OSError:
                    pass


def probe_video_metadata(video_bytes: bytes, filename_hint: str | None = None) -> dict | None:
    """Return ``{duration, width, height}`` for a video, or None if unreadable.

    Separate from :func:`probe_audio_duration_seconds` because dubbing needs
    the frame dimensions too — the lip-sync engine rejects sources above 2K,
    and finding that out only after we've charged the user and burned an
    upstream call is the expensive way to learn it.

    ``width``/``height`` are 0 when the file has no video stream (an
    audio-only upload with a video extension), which callers should treat as
    "not a video" rather than "small video".

    ``has_audio`` is False when the file carries no audio stream at all.
    Dubbing translates speech, so a silent source can never succeed — catching
    it here means we can refuse before charging instead of after an upstream
    round trip returns an unhelpful error.

    Sync, like its sibling — call it via ``asyncio.to_thread`` from async
    code, since ffprobe reads the whole header and a 200 MB file is not fast.
    """
    if not video_bytes:
        return None

    suffix = ""
    if filename_hint:
        ext = Path(filename_hint).suffix.lower()
        if ext and len(ext) <= 6:
            suffix = ext

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
            f.write(video_bytes)
            tmp_path = Path(f.name)

        result = subprocess.run(
            [
                "ffprobe",
                "-v", "error",
                "-show_entries", "format=duration",
                "-show_entries", "stream=codec_type,width,height",
                "-of", "json",
                str(tmp_path),
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout or "{}")

        duration = data.get("format", {}).get("duration")
        width = height = 0
        has_audio = False
        seen_video = False
        for stream in data.get("streams", []) or []:
            codec_type = stream.get("codec_type")
            if codec_type == "audio":
                has_audio = True
            elif codec_type == "video" and not seen_video:
                width = int(stream.get("width") or 0)
                height = int(stream.get("height") or 0)
                seen_video = True

        return {
            "duration": float(duration) if duration is not None else 0.0,
            "width": width,
            "height": height,
            "has_audio": has_audio,
        }
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, OSError):
        return None
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


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
