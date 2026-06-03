"""STT, voice clone, voice design, audio noise-remover endpoints.

Same validation-focused strategy as test_tts.py — these all do heavy
work (DB credit deduction + provider calls + bucket uploads), so we
test the short-circuit input validation paths and let staging smoke
tests cover the full integration.

Covers:
  * POST /v1/stt/transcribe
  * POST /v1/voice/clone
  * POST /v1/voice/clone/save
  * POST /v1/voice/design/preview
  * POST /v1/voice/design/save
  * POST /v1/audio/noise-remover
"""

from __future__ import annotations


# ---------------------------------------------------------------- STT


def test_stt_rejects_empty_audio(client) -> None:
    """Empty ``audio_b64`` 422s at Pydantic min_length=1."""
    resp = client.post("/v1/stt/transcribe", json={"audio_b64": ""})
    assert resp.status_code == 422


def test_stt_rejects_missing_audio(client) -> None:
    resp = client.post("/v1/stt/transcribe", json={})
    assert resp.status_code == 422


def test_stt_rejects_iso_language_code(client) -> None:
    """``STT_LANGUAGE`` is a Literal of canonical English names —
    ISO codes like ``en`` are explicitly rejected."""
    resp = client.post("/v1/stt/transcribe", json={
        "audio_b64": "ZGVhZGJlZWY=", "language": "en",
    })
    assert resp.status_code == 422


def test_stt_accepts_canonical_language(client) -> None:
    """Canonical names like ``English`` pass schema validation. The
    handler will then try (and fail) the audio decode + provider call,
    but the 422 case is what we're confirming here — anything other
    than 422 means we got past schema."""
    resp = client.post("/v1/stt/transcribe", json={
        "audio_b64": "ZGVhZGJlZWY=", "language": "English",
    })
    # Should NOT be 422; downstream will fail with 4xx/5xx due to
    # invalid audio + missing DB, but schema check passed.
    assert resp.status_code != 422


# ---------------------------------------------------------------- Voice clone


def test_voice_clone_rejects_missing_reference(client) -> None:
    resp = client.post("/v1/voice/clone", json={"target_text": "hello"})
    assert resp.status_code == 422


def test_voice_clone_rejects_missing_target_text(client) -> None:
    resp = client.post("/v1/voice/clone", json={
        "reference_audio_b64": "ZGVhZGJlZWY=",
    })
    assert resp.status_code == 422


def test_voice_clone_rejects_overlong_text(client) -> None:
    """Schema caps target_text at 2000 chars."""
    resp = client.post("/v1/voice/clone", json={
        "reference_audio_b64": "ZGVhZGJlZWY=",
        "target_text": "a" * 3000,
    })
    assert resp.status_code == 422


def test_voice_clone_save_rejects_missing_fields(client) -> None:
    """``voice/clone/save`` saves a clip + transcribes for later reuse —
    needs reference_audio + name at minimum."""
    resp = client.post("/v1/voice/clone/save", json={})
    assert resp.status_code == 422


# ---------------------------------------------------------------- Voice design


def test_voice_design_preview_rejects_missing_prompt(client) -> None:
    """Generate-from-prompt requires a prompt string."""
    resp = client.post("/v1/voice/design/preview", json={})
    assert resp.status_code == 422


def test_voice_design_save_rejects_missing_fields(client) -> None:
    resp = client.post("/v1/voice/design/save", json={})
    assert resp.status_code == 422


# ---------------------------------------------------------------- Audio noise-remover


def test_noise_remover_rejects_missing_audio(client) -> None:
    resp = client.post("/v1/audio/noise-remover", json={})
    assert resp.status_code == 422


def test_noise_remover_rejects_empty_audio(client) -> None:
    resp = client.post("/v1/audio/noise-remover", json={"audio_b64": ""})
    assert resp.status_code == 422
