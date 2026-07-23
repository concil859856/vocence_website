"""probe_video_metadata must report whether a source has an audio track.

Dubbing translates speech, so a silent upload can never succeed. Before this
signal existed the job was charged, queued, sent upstream, and failed minutes
later with a vague message. The worker now refuses it up front, which only
works if the probe reports audio presence accurately.

Uses ffmpeg to synthesize real files — mocking ffprobe here would test the
mock, and the stream-parsing loop is exactly what regressed.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from audio_probe import probe_video_metadata  # noqa: E402


def _ffmpeg_missing() -> bool:
    try:
        subprocess.run(["ffmpeg", "-version"], capture_output=True, timeout=10)
        return False
    except Exception:
        return True


pytestmark = pytest.mark.skipif(_ffmpeg_missing(), reason="ffmpeg not installed")


def _make(path: Path, *, audio: bool) -> bytes:
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=d=1:s=320x240"]
    if audio:
        cmd += ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest"]
    cmd += ["-pix_fmt", "yuv420p", str(path)]
    subprocess.run(cmd, capture_output=True, timeout=60)
    return path.read_bytes()


def test_video_with_audio_reports_has_audio(tmp_path):
    meta = probe_video_metadata(_make(tmp_path / "a.mp4", audio=True), "a.mp4")
    assert meta and meta["has_audio"] is True
    assert meta["width"] == 320 and meta["height"] == 240
    assert meta["duration"] > 0


def test_silent_video_reports_no_audio(tmp_path):
    """The case users actually hit — screen recordings and muted exports."""
    meta = probe_video_metadata(_make(tmp_path / "s.mp4", audio=False), "s.mp4")
    assert meta and meta["has_audio"] is False
    # Still a readable video, so the rest of the metadata must be intact —
    # the worker distinguishes "no audio" from "probe failed" using duration.
    assert meta["duration"] > 0
    assert meta["width"] == 320


def test_unreadable_input_returns_none():
    """A failed probe must not masquerade as a silent file, or the worker
    would blame the user's audio for what is really an unreadable upload."""
    assert probe_video_metadata(b"this is not a video", "x.mp4") is None
    assert probe_video_metadata(b"", "x.mp4") is None
