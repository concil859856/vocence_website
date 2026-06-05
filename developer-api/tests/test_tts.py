"""``/v1/tts/*`` and ``/v1/voices/{id}/speak`` — TTS validation surface.

These endpoints do real work (call GPU providers, upload WAV to object
storage, deduct credits transactionally) so happy-path tests would
need a fully-mocked DB + provider + bucket — at which point we're
testing the mocks, not the endpoint. This file focuses on the
short-circuit validation paths that run BEFORE any of that work, since
those are the ones a single typo can break.

Happy-path coverage for these endpoints lives in the staging smoke
suite which hits the real backend; not in this unit-test directory.
"""

from __future__ import annotations


# ---------------------------------------------------------------- /v1/tts/generate


def test_tts_generate_rejects_empty_text(client) -> None:
    """Empty ``text`` 422s at Pydantic's ``min_length=1`` BEFORE the
    handler runs (so no credit deduction can happen)."""
    resp = client.post("/v1/tts/generate", json={"text": ""})
    assert resp.status_code == 422


def test_tts_generate_rejects_whitespace_only_text(client) -> None:
    """Whitespace passes Pydantic min_length but the handler strips
    + 400s. Without the strip the caller could waste credits on a clip
    that's just silence."""
    resp = client.post("/v1/tts/generate", json={"text": "    \n\t  "})
    assert resp.status_code == 400


def test_tts_generate_rejects_missing_text_field(client) -> None:
    """Pydantic 422 when the field isn't present at all."""
    resp = client.post("/v1/tts/generate", json={})
    assert resp.status_code == 422


def test_tts_generate_rejects_text_over_limit(client) -> None:
    """Schema caps ``text`` to ``API_TTS_MAX_CHARS`` (default 2000).
    Anything over is rejected client-side at the Pydantic layer."""
    resp = client.post("/v1/tts/generate", json={"text": "a" * 100_000})
    assert resp.status_code == 422


# ---------------------------------------------------------------- /v1/tts/speak


def test_tts_speak_rejects_empty_text(client) -> None:
    """Pydantic min_length=1 → 422 (text field) BEFORE handler runs."""
    resp = client.post("/v1/tts/speak", json={"text": "", "voice": "voc-atlas"})
    assert resp.status_code == 422


def test_tts_speak_rejects_empty_voice(client) -> None:
    """``voice`` likely also has min_length=1 schema-side; either 422
    (schema) or 400 (handler strip+check) is a valid short-circuit."""
    resp = client.post("/v1/tts/speak", json={"text": "hello", "voice": ""})
    assert resp.status_code in (400, 422)


def test_tts_speak_rejects_missing_voice(client) -> None:
    resp = client.post("/v1/tts/speak", json={"text": "hello"})
    assert resp.status_code == 422


def test_tts_speak_rejects_missing_text(client) -> None:
    resp = client.post("/v1/tts/speak", json={"voice": "voc-atlas"})
    assert resp.status_code == 422


# ---------------------------------------------------------------- /v1/voices/{id}/speak

# Voice-id-pinned variant. Validation runs BEFORE auth touches the DB.

def test_voices_speak_rejects_empty_text(client) -> None:
    resp = client.post("/v1/voices/42/speak", json={"text": ""})
    # The handler runs validation either via Pydantic (422) or via its
    # own ``if not text`` check (400). Either is acceptable as a
    # short-circuit before credit deduction.
    assert resp.status_code in (400, 422)


def test_voices_speak_rejects_malformed_voice_id(client) -> None:
    """Voice ids are integers (the schema enforces ``[1, 9999999...]``).
    Letters in the path 422 at routing before the body is even parsed."""
    resp = client.post("/v1/voices/not-a-number/speak", json={"text": "hi"})
    assert resp.status_code == 422
