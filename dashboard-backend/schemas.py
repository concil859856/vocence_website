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


class GlobalScoringValidatorDetailResponse(BaseModel):
    validator_hotkey: str
    bucket_name: str
    label: str
    wins: int
    total: int
    win_rate: float
    weight: float
    display: str


class GlobalScoringThresholdCheckResponse(BaseModel):
    prior_hotkey: str
    prior_block: int
    prior_rate: float
    required_rate: float
    candidate_rate: float
    passed: bool


class GlobalScoringMinerResponse(BaseModel):
    rank: int
    hotkey: str
    uid: int
    block: int
    model_name: str | None
    model_revision: str | None
    chute_slug: str | None
    chute_id: str | None
    weighted_win_rate: float
    raw_win_rate: float
    wins: int
    total: int
    validator_count: int
    weighted_evals: float
    eligible: bool
    threshold_passed: bool
    is_winner: bool
    status_reason: str
    per_validator: list[GlobalScoringValidatorDetailResponse]
    threshold_checks: list[GlobalScoringThresholdCheckResponse]


class GlobalScoringActiveValidatorResponse(BaseModel):
    hotkey: str
    bucket_name: str
    label: str
    stake: float
    weight: float


class GlobalScoringWinnerResponse(GlobalScoringMinerResponse):
    pass


class GlobalScoringSnapshotResponse(BaseModel):
    generated_at: str
    max_evals_for_scoring: int
    min_evals_to_compete: int
    min_validator_appearances: int
    min_evals_per_validator: int
    threshold_margin: float
    active_validator_count: int
    valid_miner_count: int
    active_validators: list[GlobalScoringActiveValidatorResponse]
    winner: GlobalScoringWinnerResponse | None
    winner_reason: str | None
    miners: list[GlobalScoringMinerResponse]


class SubnetGraphNodeResponse(BaseModel):
    id: str
    node_type: str
    hotkey: str | None = None
    uid: int | None = None
    label: str
    status: str
    valid: bool | None = None
    validator_hotkey: str | None = None
    bucket_name: str | None = None
    stake: float | None = None
    last_seen_at: str | None = None
    last_validated_at: str | None = None
    invalid_reason: str | None = None


class SubnetGraphActivityResponse(BaseModel):
    activity_type: str
    activity_key: str
    validator_hotkey: str
    status: str
    payload: dict
    started_at: str
    expires_at: str


class SubnetGraphResponse(BaseModel):
    generated_at: str
    nodes: list[SubnetGraphNodeResponse]
    activities: list[SubnetGraphActivityResponse]


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


class BlogPostUpdateRequest(BaseModel):
    """Update post; date and created_at are never changed."""
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
    validator_hotkey: str
    evaluation_id: str
    prompt_summary: str | None
    miner_hotkeys: list[str]
    created_at: str


class ValidationStatusResponse(BaseModel):
    """Response for GET /api/dashboard/validation-status."""
    pending: list[LivePendingItem]
    evaluations: list[RecentEvaluationResponse]


# ----- Studio TTS (top models, generate, history) -----


class StudioTopModelResponse(BaseModel):
    """One of the top 3 miners by main validator; display_name = repo name only (no HF username)."""
    miner_hotkey: str
    model_name: str
    display_name: str
    chute_id: str
    chute_slug: str


class StudioTopModelsResponse(BaseModel):
    models: list[StudioTopModelResponse]


class StudioGenerateRequest(BaseModel):
    user_id: str
    miner_hotkey: str
    model_name: str
    chute_id: str
    chute_slug: str
    text: str
    style_instruction: str | None = None


class StudioGenerateResponse(BaseModel):
    id: int
    audio_url: str
    expires_at: str
    credits: int  # new balance after deducting 10 (from website.db auth_users)


class StudioHistoryItemResponse(BaseModel):
    id: int
    miner_hotkey: str
    model_name: str
    display_name: str
    prompt_text: str
    style_instruction: str
    audio_url: str | None
    expires_at: str
    created_at: str
    expired: bool


class StudioHistoryResponse(BaseModel):
    items: list[StudioHistoryItemResponse]
