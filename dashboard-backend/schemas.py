"""Pydantic schemas for dashboard API responses."""

import os

from pydantic import BaseModel


class OverviewResponse(BaseModel):
    total_miners: int
    valid_miners: int
    total_validators: int
    total_evaluations: int
    last_activity: str | None


class MinerResponse(BaseModel):
    uid: int
    hotkey: str
    block: int | None
    model_name: str | None
    model_revision: str | None
    chute_id: str | None
    chute_slug: str | None
    is_valid: bool
    invalid_reason: str | None
    last_validated_at: str | None
    total_evaluations: int
    total_wins: int
    win_rate: float


class MinersResponse(BaseModel):
    miners: list[MinerResponse]


class ValidatorResponse(BaseModel):
    uid: int
    hotkey: str
    stake: float
    s3_bucket: str | None
    last_seen_at: str | None
    created_at: str | None
    is_main: bool = False


class ValidatorsResponse(BaseModel):
    validators: list[ValidatorResponse]


class ActivityBucketResponse(BaseModel):
    at: str | None
    count: int


class ActivityResponse(BaseModel):
    range: str
    buckets: list[ActivityBucketResponse]


# Blocklist (blocked_entities table). Set ADMIN_EMAIL in .env.
ADMIN_EMAIL = (os.environ.get("ADMIN_EMAIL") or "").strip()


class BlocklistResponse(BaseModel):
    hotkeys: list[str]


class BlocklistAddRequest(BaseModel):
    hotkey: str


# Blog
class BlogPostResponse(BaseModel):
    id: str
    title: str
    excerpt: str
    category: str
    date: str
    read_time: str
    image: str
    content: str
    featured: bool
    created_at: str | None = None


class BlogPostListResponse(BaseModel):
    posts: list[BlogPostResponse]
    total: int = 0


class BlogPostCreateRequest(BaseModel):
    title: str
    excerpt: str
    category: str
    read_time: str = "5 min read"
    image: str
    content: str
    featured: bool = False


# ----- Registered users (local SQLite) -----


class RegisteredUserRegisterRequest(BaseModel):
    email: str
    name: str = ""
    picture: str | None = None


class RegisteredUserResponse(BaseModel):
    id: int
    email: str
    name: str
    picture: str | None
    created_at: str
    updated_at: str


class RegisteredUsersListResponse(BaseModel):
    users: list[RegisteredUserResponse]


# ----- Recent evaluations (Postgres read) -----


class RecentEvaluationResponse(BaseModel):
    id: int
    validator_hotkey: str
    evaluation_id: str
    miner_hotkey: str
    wins: bool
    evaluated_at: str
    prompt: str | None = None
    reasoning: str | None = None
    original_audio_url: str | None = None
    generated_audio_url: str | None = None


class RecentEvaluationsResponse(BaseModel):
    evaluations: list[RecentEvaluationResponse]
    total_count: int


# ----- Add validator (Postgres write, admin only) -----


class AddValidatorRequest(BaseModel):
    uid: int
    hotkey: str
    stake: float = 0.0
    s3_bucket: str | None = None


# ----- Live validation status (main validator only) -----


class LivePendingItem(BaseModel):
    """One pending evaluation (prompt generated, miners not yet evaluated)."""
    evaluation_id: str
    prompt_summary: str | None
    miner_hotkeys: list[str]
    created_at: str


class ValidationStatusResponse(BaseModel):
    """Response for GET /api/dashboard/validation-status."""
    pending: list[LivePendingItem]
    evaluations: list[RecentEvaluationResponse]
