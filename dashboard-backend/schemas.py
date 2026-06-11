"""Pydantic schemas for dashboard API responses."""

import os

from pydantic import BaseModel, Field


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
    id: str | int
    email: str
    name: str
    picture: str | None
    credits: int | None = None
    plan_code: str | None = None
    plan_status: str | None = None
    last_login_at: str | None = None
    created_at: str
    updated_at: str


class RegisteredUsersListResponse(BaseModel):
    users: list[RegisteredUserResponse]
    total: int = 0
    page: int = 1
    page_size: int = 20


# ----- Admin website usage (local SQLite, paginated) -----


class AdminTtsHistoryRow(BaseModel):
    id: int
    user_id: str
    user_email: str | None = None
    user_name: str | None = None
    miner_hotkey: str
    model_name: str
    prompt_text: str
    style_instruction: str
    credits_used: int
    status: str
    latency_ms: int | None = None
    error_message: str | None = None
    created_at: str


class AdminPaginatedTtsResponse(BaseModel):
    items: list[AdminTtsHistoryRow]
    total: int
    page: int
    page_size: int


class AdminCreditTransactionRow(BaseModel):
    id: str
    user_id: str
    user_email: str | None = None
    user_name: str | None = None
    transaction_type: str
    amount: int
    balance_after: int
    description: str
    reference_type: str | None = None
    reference_id: str | None = None
    created_at: str


class AdminPaginatedCreditsResponse(BaseModel):
    items: list[AdminCreditTransactionRow]
    total: int
    page: int
    page_size: int


class AdminPaymentRow(BaseModel):
    id: str
    user_id: str
    user_email: str | None = None
    user_name: str | None = None
    provider: str
    plan_code: str | None = None
    amount_usd: float
    credits_granted: int
    status: str
    mode: str | None = None
    stripe_checkout_session_id: str | None = None
    credits_applied_at: str | None = None
    created_at: str


class AdminPaginatedPaymentsResponse(BaseModel):
    items: list[AdminPaymentRow]
    total: int
    page: int
    page_size: int


class AdminAuthHistoryRow(BaseModel):
    id: str
    user_id: str
    user_email: str | None = None
    user_name: str | None = None
    type: str
    content: str | None = None
    style_prompt: str | None = None
    model: str | None = None
    meta: str | None = None
    duration: str | None = None
    created_at: str


class AdminPaginatedAuthHistoryResponse(BaseModel):
    items: list[AdminAuthHistoryRow]
    total: int
    page: int
    page_size: int


class AdminUserActivitySummary(BaseModel):
    user_id: str
    email: str
    name: str
    credits: int
    plan_code: str
    plan_status: str
    created_at: str
    last_login_at: str | None = None
    tts_completed_count: int
    tts_total_credits: int
    credit_tx_count: int
    payments_count: int
    # Per-user voicechat rate-limit override. NULL = use platform defaults.
    # 0 = no cap. Set by admins for enterprise / sales accounts.
    voicechat_rate_limit_turns: int | None = None
    voicechat_rate_limit_window_sec: int | None = None
    # The effective values after override resolution — handy for the UI
    # so it can display "current: 999999/3600" without re-reading env.
    voicechat_rate_limit_turns_effective: int
    voicechat_rate_limit_window_sec_effective: int
    # Per-user Developer-API rate-limit override (rpm). NULL = no
    # override, the per-key resolution + env default applies.
    # 0 = uncapped. ``effective`` is the rpm a request would face
    # right now (assuming no per-key NULL exemption — that's a
    # multi-key state we don't surface in this summary).
    api_rate_limit_rpm: int | None = None
    api_rate_limit_rpm_effective: int


class AdminSetVoicechatRateLimitIn(BaseModel):
    """Request body for PATCH /admin/website-usage/user/{id}/voicechat-rate-limit.

    Send {turns: null, window_sec: null} to RESET to defaults.
    Send {turns: 999999, window_sec: 60} (or any large number) for
    "effectively unlimited" with a real bucket.
    Send {turns: 0, window_sec: 0} (or either as 0) to disable the
    cap entirely (skips bucket bookkeeping for that user).
    """
    turns: int | None = None
    window_sec: int | None = None
    reason: str = ""


class AdminSetApiRateLimitIn(BaseModel):
    """Request body for PATCH /admin/website-usage/user/{id}/api-rate-limit.

    Send {rpm: null} to RESET to platform defaults (per-key + env).
    Send {rpm: 0} to remove the cap entirely (admin-granted unlimited).
    Send {rpm: N} for a custom N requests-per-minute cap for the user.
    """
    rpm: int | None = None
    reason: str = ""


class WebsiteUsageDayResponse(BaseModel):
    day: str
    tts_generation_count: int
    stt_count: int = 0
    clone_count: int = 0
    voice_design_count: int = 0
    music_count: int = 0
    unique_users: int
    credits_used: int
    revenue_usd: float
    credits_purchased: int


class UserRecentActivityItem(BaseModel):
    id: int
    type: str  # 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'
    created_at: str
    title: str  # short content snippet for display
    detail: str | None = None  # secondary line (model, language, prompt fragment)
    credits_used: int = 0
    status: str | None = None
    audio_url: str | None = None
    user_id: str | None = None
    user_email: str | None = None
    user_name: str | None = None


class UserRecentActivityResponse(BaseModel):
    user_id: str | None = None  # null when this is a global feed
    items: list[UserRecentActivityItem]
    by_day: list[dict]  # [{day: 'YYYY-MM-DD', tts: N, stt: N, ...}]


class PlanDistributionResponse(BaseModel):
    plan_code: str
    user_count: int


class RecentPaymentResponse(BaseModel):
    id: str
    user_id: str
    provider: str
    plan_code: str | None = None
    amount_usd: float
    credits_granted: int
    status: str
    created_at: str


class WebsiteOverviewResponse(BaseModel):
    total_users: int
    active_users_7d: int
    total_generations: int
    total_credits_used: int
    total_revenue_usd: float
    usage: list[WebsiteUsageDayResponse]
    plan_distribution: list[PlanDistributionResponse]
    recent_payments: list[RecentPaymentResponse]


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
    score: float | None = None
    element_scores: dict[str, float] | None = None


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
    credits: int  # new balance after TTS deduction (from website.db auth_users)


class StudioTranscribeResponse(BaseModel):
    id: int
    text: str
    language: str | None = None
    credits: int  # new balance after deducting STT credits
    duration_seconds: float | None = None


class StudioTranscribeRequest(BaseModel):
    user_id: str
    language: str | None = None


class StudioCloneResponse(BaseModel):
    id: int
    audio_url: str
    expires_at: str
    credits: int
    reference_text: str
    detected_language: str | None = None


class StudioTtsSampleVoiceRequest(BaseModel):
    sample_voice_id: str
    target_text: str
    target_language: str | None = None


class StudioHistoryItemResponse(BaseModel):
    id: int
    entry_type: str = "tts"  # "tts", "stt", "clone", "voice_design", "music", or "noise_remover"
    miner_hotkey: str
    model_name: str
    display_name: str
    prompt_text: str | None = None
    style_instruction: str
    audio_url: str | None
    expires_at: str
    created_at: str
    expired: bool
    transcribed_text: str | None = None
    source_audio_filename: str | None = None
    source_language: str | None = None
    duration_seconds: float | None = None
    reference_text: str | None = None
    target_text: str | None = None
    clone_source: str | None = None
    # Music-only fields. ``lyrics`` is shared by every music task;
    # ``music_task`` distinguishes which generator produced this row
    # (text2music / audio2audio / retake / repaint / edit / extend);
    # ``music_metadata_json`` carries the mode-specific params
    # (retake_variance, repaint_start/end, edit_target_prompt, etc.)
    # the frontend needs to render and copy. Always null for non-music
    # rows so the schema stays backward-compatible.
    lyrics: str | None = None
    music_task: str | None = None
    music_metadata_json: str | None = None


class StudioHistoryResponse(BaseModel):
    items: list[StudioHistoryItemResponse]


# ----- Studio Voice Design (LLM sample line + A/B TTS preview, save, clone) -----


class StudioVoiceDesignConfigResponse(BaseModel):
    llm_configured: bool
    preview_credits: int
    sample_words_min: int
    sample_words_max: int


class StudioVoiceDesignPreviewRequest(BaseModel):
    user_id: str
    voice_description: str
    miner_hotkey: str
    model_name: str
    chute_id: str = ""
    chute_slug: str


class StudioVoiceDesignPreviewResponse(BaseModel):
    preview_token: str
    sample_script: str
    voice_description: str
    revised_instruction: str
    audio_a_url: str
    audio_b_url: str
    expires_at: str
    credits: int
    miner_hotkey: str
    model_name: str
    chute_slug: str


class StudioVoiceDesignSaveRequest(BaseModel):
    user_id: str
    preview_token: str
    chosen_variant: str  # "original" | "revised"
    display_name: str = Field(..., max_length=20)


class StudioVoiceDesignSaveResponse(BaseModel):
    voice_id: int
    audio_url: str
    expires_at: str
    credits: int
    ref_script: str


class StudioDesignedVoiceItem(BaseModel):
    id: int
    display_name: str
    voice_description: str
    revised_instruction: str
    chosen_variant: str
    ref_script: str
    miner_hotkey: str
    model_name: str
    chute_slug: str
    audio_url: str | None
    expires_at: str
    created_at: str
    expired: bool
    # ``source`` differentiates how the voice entered My Voices:
    #   "designed" — generated via Voice Design's LLM prompt flow
    #   "cloned"   — uploaded by the user as a real-voice reference
    # Default 'designed' for back-compat with rows created before the
    # column existed. The frontend uses this to render a small badge
    # so the picker doesn't lump them under one ambiguous label.
    source: str = "designed"
    source_language: str | None = None


class StudioDesignedVoicesResponse(BaseModel):
    voices: list[StudioDesignedVoiceItem]


class StudioDesignedVoiceSpeakRequest(BaseModel):
    user_id: str
    voice_id: int
    target_text: str


class StudioClonedVoiceSaveResponse(BaseModel):
    voice_id: int
    display_name: str
    ref_script: str
    source_language: str | None = None
    audio_url: str | None
    expires_at: str
    credits: int


# ----- Studio Music Generation (ACE-Step proxy) -----


class StudioMusicText2MusicRequest(BaseModel):
    user_id: str
    prompt: str
    lyrics: str = ""
    audio_duration: float = 60.0
    format: str = "wav"
    infer_step: int = 60
    guidance_scale: float = 15.0
    scheduler_type: str = "euler"
    cfg_type: str = "apg"
    omega_scale: float = 10.0
    manual_seeds: str = ""
    guidance_interval: float = 0.5
    guidance_interval_decay: float = 0.0
    min_guidance_scale: float = 3.0
    use_erg_tag: bool = True
    use_erg_lyric: bool = False
    use_erg_diffusion: bool = True
    oss_steps: str = ""
    guidance_scale_text: float = 0.0
    guidance_scale_lyric: float = 0.0
    lora_name_or_path: str = "none"


class StudioMusicGenerateResponse(BaseModel):
    id: int
    audio_url: str
    expires_at: str
    credits: int
    task: str = "text2music"


class StudioMusicLyricsRequest(BaseModel):
    """Request body for AI-generated lyrics. ``topic`` is what the song
    should be about (free-form, user-supplied); ``prompt`` mirrors the
    music-prompt tags so the lyric model can match the genre's vibe."""
    topic: str
    prompt: str = ""
    section_count: int = 5  # rough number of structure sections to aim for


class StudioMusicLyricsResponse(BaseModel):
    lyrics: str


class StudioMusicHistoryItemResponse(BaseModel):
    id: int
    entry_type: str = "music"
    task: str
    prompt_text: str
    lyrics: str
    audio_duration: float
    audio_url: str | None
    expires_at: str
    created_at: str
    expired: bool
    metadata_json: str = "{}"


class StudioMusicHistoryResponse(BaseModel):
    items: list[StudioMusicHistoryItemResponse]


# ----- Playbooks -----


class PlaybookCreateRequest(BaseModel):
    title: str = "Untitled Playbook"
    description: str = ""


class PlaybookUpdateRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    visibility: str | None = None
    cover_image_url: str | None = None


class PlaybookTrackAddRequest(BaseModel):
    title: str
    subtitle: str = ""
    audio_url: str
    image_url: str | None = None
    source_type: str = "generated"
    duration_seconds: float | None = None


class PlaybookTracksAddRequest(BaseModel):
    tracks: list[PlaybookTrackAddRequest]


class PlaybookTrackReorderRequest(BaseModel):
    track_ids: list[int]


class PlaybookTrackResponse(BaseModel):
    id: int
    position: int
    title: str
    subtitle: str
    audio_url: str
    image_url: str | None
    source_type: str
    duration_seconds: float | None
    added_at: str


class PlaybookResponse(BaseModel):
    id: int
    title: str
    description: str
    cover_image_url: str | None
    visibility: str
    track_count: int = 0
    total_duration: float = 0
    # Public-playbook play counter. Incremented every time someone hits
    # Play in the Studio UI. Private playbooks always report 0 (their
    # plays don't accrue) so the number stays meaningful when a playbook
    # flips between public and private.
    play_count: int = 0
    # Thumb-up vote count (public for all playbooks). ``viewer_voted`` is
    # True only when the request is authenticated and the signed-in user
    # has cast a thumb on this playbook; for anonymous requests it's
    # always False.
    vote_count: int = 0
    viewer_voted: bool = False
    created_at: str
    updated_at: str


class PlaybookDetailResponse(PlaybookResponse):
    tracks: list[PlaybookTrackResponse]
    is_owner: bool = True


class PlaybookListResponse(BaseModel):
    playbooks: list[PlaybookResponse]


class PublicPlaybookResponse(PlaybookResponse):
    user_name: str = ""
    user_picture: str | None = None


class PublicPlaybookListResponse(BaseModel):
    playbooks: list[PublicPlaybookResponse]
