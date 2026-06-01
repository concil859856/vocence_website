"""Feedback endpoints — ``/v1/feedback``.

Thin proxy over the dashboard-backend's ``/api/dashboard/feedback`` user
routes. Lets an API-key holder record thumbs-up / thumbs-down on a
specific generation (TTS, STT, voice-clone, voice-design, music,
noise-remover, agent-call, agent-message) so they can collect quality
signal on the AI outputs they're serving to their own users.

The admin-side aggregate endpoints (``/feedback/admin/*``) are NOT
exposed here — those require the dashboard's admin-sudo unlock and
belong to the Vocence team's quality dashboard, not customer apps.
"""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.services.dashboard_proxy import call_dashboard

router = APIRouter()


# entry_type values mirror dashboard-backend/routers/feedback.py exactly.
# Kept in sync manually — the SDK's enum is the canonical client-side
# list.
_ALLOWED_ENTRY_TYPES = {
    "tts", "stt", "voice_clone", "voice_design", "music",
    "noise_remover", "agent_call", "agent_message",
}


class FeedbackSubmitIn(BaseModel):
    """Submit (or update) thumbs on a single generation."""

    entry_type: str = Field(
        description="Feature the rating applies to — one of: "
        "tts, stt, voice_clone, voice_design, music, noise_remover, "
        "agent_call, agent_message.",
    )
    entry_id: str = Field(
        min_length=1, max_length=128,
        description="Stable identifier you assigned to this generation "
        "(e.g. job_id, message_id). Used as the upsert key.",
    )
    rating: int = Field(
        ge=-1, le=1,
        description="-1 = thumbs-down, 1 = thumbs-up, 0 = clear the "
        "rating (un-vote).",
    )
    comment: Optional[str] = Field(
        default=None, max_length=2000,
        description="Optional free-text comment shown to admins in the "
        "Quality dashboard. Most useful on thumbs-down.",
    )


@router.post(
    "/v1/feedback",
    tags=["Feedback"],
    summary="Submit or update thumbs feedback on a generation",
)
async def submit_feedback(
    body: FeedbackSubmitIn,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Upsert thumbs on a single (entry_type, entry_id) pair. Sending
    ``rating=0`` removes any existing rating for that pair, so the
    rating can be cleared without deleting the underlying generation."""
    if body.entry_type not in _ALLOWED_ENTRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"entry_type must be one of: {sorted(_ALLOWED_ENTRY_TYPES)}",
        )
    user_id = auth_ctx["user_id"]
    return await call_dashboard(
        "POST",
        "/api/dashboard/feedback",
        user_id=user_id,
        json=body.model_dump(exclude_none=True),
    )


@router.get(
    "/v1/feedback",
    tags=["Feedback"],
    summary="Fetch your current thumbs for a single generation",
)
async def get_feedback(
    entry_type: str = Query(..., description="Same enum as POST."),
    entry_id: str = Query(..., min_length=1, max_length=128),
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Returns ``{rating: -1|0|1, comment: str|null}``. ``rating=0``
    means no rating exists yet (the GET never 404s — absence is just
    represented as zero so callers don't need a separate branch)."""
    if entry_type not in _ALLOWED_ENTRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"entry_type must be one of: {sorted(_ALLOWED_ENTRY_TYPES)}",
        )
    user_id = auth_ctx["user_id"]
    # Query strings aren't first-class in call_dashboard — encode into
    # the path. Both values are validated above so injection is moot.
    from urllib.parse import quote
    qs = f"entry_type={quote(entry_type)}&entry_id={quote(entry_id)}"
    return await call_dashboard(
        "GET",
        f"/api/dashboard/feedback?{qs}",
        user_id=user_id,
    )
