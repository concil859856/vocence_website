"""WebSocket message schemas.

Both endpoints share the same lifecycle skeleton (``start`` → ``ready``
→ continuous events → ``close``) so we share the validation helpers
here. Each endpoint has its own ``Start`` model because the parameters
differ.

We use Pydantic for parsing because (a) error messages are clear and
(b) ``Literal`` typing makes invalid ``type`` fields a 400 at parse
time rather than a runtime branch we have to remember to write.

The dashboard backend is the only intended client; protocol drift
between this pod and that client is a coordinated change in both
codebases, so being strict about the message shape is fine — we don't
need backward-compat slack.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, ValidationError


# ---------------------------------------------------------------------------
# Smart Turn (audio endpoint)
# ---------------------------------------------------------------------------

class SmartTurnStart(BaseModel):
    """First message from client on /v1/smart-turn."""
    type: Literal["start"]
    session_id: str | None = None
    sample_rate: int = Field(default=16000, ge=16000, le=16000)
    encoding: Literal["pcm_s16le"] = "pcm_s16le"
    # The model's receptive field is 8 s; default to 4 s so a single
    # window covers a typical utterance without padding too much silence.
    window_ms: int = Field(default=4000, ge=1000, le=8000)
    emit_every_ms: int = Field(default=150, ge=50, le=2000)


class SmartTurnReset(BaseModel):
    type: Literal["reset"]


class SmartTurnClose(BaseModel):
    type: Literal["close"]


# ---------------------------------------------------------------------------
# Turn Detector (text endpoint)
# ---------------------------------------------------------------------------

class HistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class TurnDetectorStart(BaseModel):
    type: Literal["start"]
    session_id: str | None = None
    history: list[HistoryTurn] = Field(default_factory=list)
    language: str = "en"


class TurnDetectorToken(BaseModel):
    """One token-stream event. ``text`` is the CUMULATIVE in-progress
    transcript (not a delta). The model needs the full current state
    on each inference."""
    type: Literal["token"]
    text: str
    is_final: bool = False


class TurnDetectorCommit(BaseModel):
    """Promote the current in-progress utterance to the history with
    the given final transcript. Subsequent ``token`` events start a
    fresh in-progress utterance."""
    type: Literal["commit"]
    content: str


class TurnDetectorClose(BaseModel):
    type: Literal["close"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_or_error(raw: str, model_cls: type[BaseModel]) -> BaseModel | dict:
    """Parse ``raw`` as JSON into ``model_cls`` or return a dict in the
    error-frame shape that the WS handler can send back over the wire.

    Returns the parsed model on success, or ``{"type":"error", ...}``
    on failure.
    """
    try:
        return model_cls.model_validate_json(raw)
    except ValidationError as exc:
        return {
            "type": "error",
            "code": "bad_request",
            "message": _summarise_validation_error(exc),
        }
    except ValueError as exc:
        return {"type": "error", "code": "bad_request", "message": str(exc)}


def _summarise_validation_error(exc: ValidationError) -> str:
    """Compact human-readable summary of a ValidationError. We don't
    surface the full Pydantic error blob over the wire — it's noisy and
    leaks our schema. The first error message is usually enough."""
    errors = exc.errors()
    if not errors:
        return "invalid request"
    first = errors[0]
    loc = ".".join(str(p) for p in first.get("loc", []))
    msg = first.get("msg", "invalid")
    return f"{loc}: {msg}" if loc else msg
