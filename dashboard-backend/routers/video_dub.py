"""Video dubbing endpoints.

Flow the client follows:
    1. POST /uploads/presign {kind: "video-dub-source"} → PUT bytes to R2
    2. GET  /video-dub/languages                        → populate the picker
    3. POST /video-dub/quote                            → show the credit cost
    4. POST /video-dub/start                            → enqueue, get job_id
    5. GET  /jobs/{id}                                  → poll (shared endpoint)
    6. GET  /video-dub/history                          → past dubs

The credit charge is computed here from (tier, duration, language count) and
passed to the queue — the client's own number is never trusted, because at the
lip-sync tier every minute is real upstream spend. The worker re-probes the
real duration with ffprobe and refuses the job if it was under-quoted.

Nothing in this module names the upstream engines. ``lipsync: true/false`` is
the only vocabulary the client sees.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from jobs import api as jobs_api
from local_db import get_connection
from routers.auth import require_auth
from routers.studio import _is_premium_user
from studio_tts_service import get_presigned_url, presigned_url_for_permanent_object
from video_dub_service import (
    TIER_LIPSYNC,
    TIER_STANDARD,
    VIDEO_DUB_LIPSYNC_FREE_MAX_SEC,
    VIDEO_DUB_MAX_DURATION_SEC,
    VIDEO_DUB_MAX_LANGUAGES,
    DubbingError,
    check_plan_limits,
    credits_for,
    tier_configured,
    validate_source,
)


_log = logging.getLogger(__name__)

router = APIRouter(prefix="/video-dub", tags=["video-dub"])


# Languages we accept as dubbing targets.
#
# A curated list, not a passthrough of either upstream catalogue. The two
# tiers run on different engines whose catalogues only partly overlap, so
# every entry declares which tiers can actually serve it. The picker greys
# out anything the currently-selected tier can't do, and ``/start`` rejects
# it server-side — a language must never be selectable, charged, and only
# then discovered to be unsupported.
#
# ``lipsync_label`` exists because the lip-sync engine keys on display names
# rather than ISO codes, and its spelling doesn't always match ours.
#
# Every ``lipsync_label`` below was verified against the live catalogue
# (190 languages) on 2026-07-21. See ``video_dub_service.LIPSYNC_CATALOGUE_NOTE``
# for how to re-run that check — a label mismatch is a submit-time rejection,
# which is exactly what this table exists to prevent.
SUPPORTED_LANGUAGES: list[dict] = [
    {"code": "en",  "label": "English",             "lipsync": True,  "lipsync_label": "English"},
    {"code": "es",  "label": "Spanish",             "lipsync": True,  "lipsync_label": "Spanish (Spain)"},
    {"code": "fr",  "label": "French",              "lipsync": True,  "lipsync_label": "French"},
    {"code": "de",  "label": "German",              "lipsync": True,  "lipsync_label": "German"},
    {"code": "it",  "label": "Italian",             "lipsync": True,  "lipsync_label": "Italian"},
    {"code": "pt",  "label": "Portuguese",          "lipsync": True,  "lipsync_label": "Portuguese (Portugal)"},
    {"code": "pl",  "label": "Polish",              "lipsync": True,  "lipsync_label": "Polish"},
    {"code": "tr",  "label": "Turkish",             "lipsync": True,  "lipsync_label": "Turkish"},
    {"code": "ru",  "label": "Russian",             "lipsync": True,  "lipsync_label": "Russian"},
    {"code": "nl",  "label": "Dutch",               "lipsync": True,  "lipsync_label": "Dutch"},
    {"code": "sv",  "label": "Swedish",             "lipsync": True,  "lipsync_label": "Swedish"},
    {"code": "id",  "label": "Indonesian",          "lipsync": True,  "lipsync_label": "Indonesian"},
    {"code": "fil", "label": "Filipino",            "lipsync": True,  "lipsync_label": "Filipino"},
    {"code": "ja",  "label": "Japanese",            "lipsync": True,  "lipsync_label": "Japanese"},
    {"code": "ko",  "label": "Korean",              "lipsync": True,  "lipsync_label": "Korean"},
    {"code": "zh",  "label": "Chinese (Mandarin)",  "lipsync": True,  "lipsync_label": "Chinese (Mandarin, Simplified)"},
    {"code": "hi",  "label": "Hindi",               "lipsync": True,  "lipsync_label": "Hindi"},
    {"code": "ar",  "label": "Arabic",              "lipsync": True,  "lipsync_label": "Arabic"},
    {"code": "vi",  "label": "Vietnamese",          "lipsync": True,  "lipsync_label": "Vietnamese"},
    {"code": "uk",  "label": "Ukrainian",           "lipsync": True,  "lipsync_label": "Ukrainian"},
    {"code": "cs",  "label": "Czech",               "lipsync": True,  "lipsync_label": "Czech"},
    {"code": "el",  "label": "Greek",               "lipsync": True,  "lipsync_label": "Greek"},
    {"code": "da",  "label": "Danish",              "lipsync": True,  "lipsync_label": "Danish"},
    {"code": "fi",  "label": "Finnish",             "lipsync": True,  "lipsync_label": "Finnish"},
    {"code": "no",  "label": "Norwegian",           "lipsync": True,  "lipsync_label": "Norwegian Bokmål (Norway)"},
    {"code": "ro",  "label": "Romanian",            "lipsync": True,  "lipsync_label": "Romanian"},
    {"code": "hu",  "label": "Hungarian",           "lipsync": True,  "lipsync_label": "Hungarian (Hungary)"},
    {"code": "ms",  "label": "Malay",               "lipsync": True,  "lipsync_label": "Malay"},
]

_LANG_BY_CODE = {x["code"]: x for x in SUPPORTED_LANGUAGES}
_LANG_CODES = set(_LANG_BY_CODE)


def _codes_for_tier(tier: str) -> set[str]:
    """Codes this tier can actually serve."""
    if tier == TIER_LIPSYNC:
        return {c for c, x in _LANG_BY_CODE.items() if x.get("lipsync")}
    return _LANG_CODES


def _upstream_name(code: str, tier: str) -> str:
    """Translate our code into whatever the tier's engine expects."""
    entry = _LANG_BY_CODE[code]
    return entry["lipsync_label"] if tier == TIER_LIPSYNC else code


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class QuoteRequest(BaseModel):
    duration_sec: float = Field(..., gt=0, description="Source video length in seconds")
    target_languages: list[str] = Field(..., min_length=1)
    lipsync: bool = False


class QuoteResponse(BaseModel):
    credits: int
    tier: str
    billable_minutes: int
    language_count: int


class StartRequest(BaseModel):
    src_bucket: str = Field(..., min_length=1)
    src_key: str = Field(..., min_length=1)
    src_filename: str = Field("source.mp4", max_length=255)
    duration_sec: float = Field(..., gt=0)
    # Client-declared, used only to fail fast with a helpful message. The
    # worker re-probes with ffprobe and re-validates before spending anything,
    # so a client that lies here gains nothing.
    size_bytes: int = Field(0, ge=0)
    width: int = Field(0, ge=0)
    height: int = Field(0, ge=0)
    source_language: str = Field("auto", max_length=16)
    target_languages: list[str] = Field(..., min_length=1)
    lipsync: bool = False
    num_speakers: int = Field(1, ge=1, le=8)
    # Rights attestation. The lip-sync engine puts the likeness-consent
    # obligation on us as the API caller, so we refuse the job without it
    # and record it against the resulting history rows.
    consent_attested: bool = False
    # Optional one-shot completion callback (see job_callbacks.py). The URL
    # is POSTed the terminal status; the secret (if given) signs the body in
    # the X-Vocence-Signature format so webhooks.verify() works unchanged.
    callback_url: str = Field("", max_length=2000)
    callback_secret: str = Field("", max_length=128)


class StartResponse(BaseModel):
    job_id: str
    credits_charged: int
    queue_position: int = 0
    # True when the queue is above the load-warning threshold; the UI shows a
    # "busy right now" hint. Matches EnqueueResult.load_warning.
    load_warning: bool = False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _validate_languages(codes: list[str], tier: str) -> list[str]:
    cleaned = [c.strip().lower() for c in codes if c and c.strip()]
    if not cleaned:
        raise HTTPException(400, "Choose at least one language to dub into.")
    if len(cleaned) > VIDEO_DUB_MAX_LANGUAGES:
        raise HTTPException(400, f"You can dub into at most {VIDEO_DUB_MAX_LANGUAGES} languages per video.")

    unknown = [c for c in cleaned if c not in _LANG_CODES]
    if unknown:
        raise HTTPException(400, f"Unsupported language: {unknown[0]}")

    # Checked against the tier, not the global list — lip-sync serves a
    # narrower set, and picking outside it must fail here rather than after
    # the user has been charged.
    allowed = _codes_for_tier(tier)
    unsupported = [c for c in cleaned if c not in allowed]
    if unsupported:
        name = _LANG_BY_CODE[unsupported[0]]["label"]
        raise HTTPException(400, f"{name} isn't available with lip-sync. Turn lip-sync off, or pick another language.")

    # De-dupe but keep order — each language is billed separately.
    seen: set[str] = set()
    return [c for c in cleaned if not (c in seen or seen.add(c))]


def _validate_duration(duration_sec: float) -> None:
    if duration_sec <= 0:
        raise HTTPException(400, "Could not read the video's length.")
    if duration_sec > VIDEO_DUB_MAX_DURATION_SEC:
        raise HTTPException(400, f"Videos must be under {VIDEO_DUB_MAX_DURATION_SEC // 60} minutes.")


def _tier_of(lipsync: bool) -> str:
    return TIER_LIPSYNC if lipsync else TIER_STANDARD


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/languages")
async def list_languages(user_id: str = Depends(require_auth)) -> dict:
    """Target languages, plus whether each tier is currently available."""
    return {
        # ``lipsync_label`` is an internal mapping detail — strip it.
        "languages": [
            {"code": x["code"], "label": x["label"], "lipsync": bool(x.get("lipsync"))}
            for x in SUPPORTED_LANGUAGES
        ],
        "max_languages": VIDEO_DUB_MAX_LANGUAGES,
        "max_duration_sec": VIDEO_DUB_MAX_DURATION_SEC,
        "standard_available": tier_configured(TIER_STANDARD),
        "lipsync_available": tier_configured(TIER_LIPSYNC),
        # Free-plan lip-sync length cap (0 = uncapped). The client greys out
        # lip-sync for longer clips; the server enforces it authoritatively.
        "lipsync_free_max_sec": VIDEO_DUB_LIPSYNC_FREE_MAX_SEC,
        "is_premium": await _is_premium_user(user_id),
    }


@router.post("/quote", response_model=QuoteResponse)
async def quote(req: QuoteRequest, user_id: str = Depends(require_auth)) -> QuoteResponse:
    """What this job will cost, so the UI can show it before the user commits."""
    _validate_duration(req.duration_sec)
    tier = _tier_of(req.lipsync)
    langs = _validate_languages(req.target_languages, tier)
    return QuoteResponse(
        credits=credits_for(tier, req.duration_sec, len(langs)),
        tier=tier,
        billable_minutes=max(1, -(-int(req.duration_sec) // 60)),
        language_count=len(langs),
    )


@router.post("/start", response_model=StartResponse)
async def start(req: StartRequest, user_id: str = Depends(require_auth)) -> StartResponse:
    _validate_duration(req.duration_sec)
    tier = _tier_of(req.lipsync)
    langs = _validate_languages(req.target_languages, tier)

    if not req.consent_attested:
        raise HTTPException(
            400,
            "Please confirm you have the rights to the people appearing in this video.",
        )
    if not tier_configured(tier):
        raise HTTPException(503, "This dubbing option is temporarily unavailable. Please try again later.")

    # Callback URL is refused here — before any charge — not at delivery time.
    callback_url = (req.callback_url or "").strip()
    if callback_url:
        try:
            from job_callbacks import validate_callback_url

            validate_callback_url(callback_url)
        except ValueError as exc:
            raise HTTPException(400, f"callback_url rejected: {exc}") from exc

    # Cheap pre-flight on the client's declared numbers. Catches an oversized
    # or 4K upload here, with a message the user can act on, instead of after
    # the charge and an upstream round trip.
    try:
        validate_source(
            tier=tier,
            duration_sec=req.duration_sec,
            size_bytes=req.size_bytes,
            width=req.width,
            height=req.height,
        )
    except DubbingError as exc:
        raise HTTPException(400, exc.public_message) from exc

    # Priced server-side. The client's own estimate is never used.
    credits = credits_for(tier, req.duration_sec, len(langs))

    # Plan-tier caps (free lip-sync length limit). Checked before the charge,
    # against the user's real plan, so a free account is told to trim or
    # upgrade rather than being billed and then refused.
    is_premium = await _is_premium_user(user_id)
    try:
        check_plan_limits(tier, req.duration_sec, is_premium)
    except DubbingError as exc:
        raise HTTPException(403, exc.public_message) from exc

    # Balance pre-check. enqueue() also refuses, but it raises
    # JobAdmissionRejected — which the handler below maps to 503 "try again
    # shortly". That is the right answer for a full queue and the wrong one
    # for an empty wallet: retrying never helps, and the user needs to be
    # told the actual number. Dubbing is available on every plan, so this is
    # the common failure for a free account and deserves a real message.
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
    finally:
        await conn.close()
    balance = int((row[0] if row else 0) or 0)
    if balance < credits:
        raise HTTPException(
            402,
            f"This dub costs {credits:,} credits and you have {balance:,}. "
            f"Try a shorter video, fewer languages"
            + (", or turn off lip-sync" if tier == TIER_LIPSYNC else "")
            + ".",
        )

    payload = {
        "tier": tier,
        "src_bucket": req.src_bucket,
        "src_key": req.src_key,
        "src_filename": req.src_filename,
        "duration_sec": req.duration_sec,
        "source_language": (req.source_language or "auto").strip() or "auto",
        # Each engine wants a different spelling; resolve it here so the
        # worker never needs to know which one runs.
        "target_languages": [_upstream_name(c, tier) for c in langs],
        "target_language_codes": langs,
        "num_speakers": req.num_speakers,
        "precision": False,
        # Server-derived, not client-supplied — the worker re-checks the plan
        # cap against the real probed duration using this.
        "is_premium": is_premium,
        "consent_attested": True,
    }
    if callback_url:
        payload["callback_url"] = callback_url
        if (req.callback_secret or "").strip():
            payload["callback_secret"] = req.callback_secret.strip()

    # enqueue charges the credits and refunds them if the job later fails,
    # times out, or is cancelled. Returns an EnqueueResult dataclass.
    try:
        result = await jobs_api.enqueue(
            user_id=user_id,
            type="video_dub",
            payload=payload,
            credits_to_charge=credits,
        )
    except jobs_api.JobAdmissionRejected as exc:
        raise HTTPException(
            503, exc.message, headers={"Retry-After": str(exc.retry_after_seconds)}
        ) from exc
    except jobs_api.JobError as exc:
        # Insufficient credits lands here — surface it as 400, matching /jobs/start.
        raise HTTPException(400, str(exc)) from exc

    return StartResponse(
        job_id=result.job_id,
        credits_charged=credits,
        queue_position=result.queue_position,
        load_warning=result.load_warning,
    )


@router.get("/history")
async def history(limit: int = 50, offset: int = 0, user_id: str = Depends(require_auth)) -> dict:
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, source_filename, source_language, target_language, tier,
                   job_id, duration_sec, video_s3_bucket, video_s3_key,
                   poster_s3_bucket, poster_s3_key, expires_at,
                   credits_used, latency_ms, status, created_at
            FROM studio_video_dub_history
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (user_id, limit, offset),
        )
        rows = await cursor.fetchall()
        # Total drives pagination on the client. Counted in the same
        # connection so the page and the count can't disagree.
        total_row = await (await conn.execute(
            "SELECT COUNT(*) FROM studio_video_dub_history WHERE user_id = ?",
            (user_id,),
        )).fetchone()
        total = int(total_row[0] if total_row else 0)
    finally:
        await conn.close()

    items = []
    for r in rows:
        (rid, fname, src_lang, tgt_lang, tier, job_id, dur, bucket, key,
         poster_bucket, poster_key, expires_at, credits, latency, status, created_at) = r
        items.append({
            "id": rid,
            "source_filename": fname,
            "source_language": src_lang,
            "target_language": tgt_lang,
            # Surfaced as a boolean, not a tier name, so the UI never has to
            # know the internal vocabulary.
            "lipsync": tier == TIER_LIPSYNC,
            "duration_sec": dur,
            "credits_used": credits,
            "latency_ms": latency,
            "status": status,
            "created_at": created_at,
            "expires_at": expires_at,
            "video_url": _safe_url(bucket, key, expires_at),
            "poster_url": _safe_url(poster_bucket, poster_key, expires_at),
            # Groups the language variants produced by one dub job.
            "collection_id": job_id,
        })
    return {"items": items, "total": total, "limit": limit, "offset": offset}


@router.delete("/history/{item_id}")
async def delete_history_item(item_id: int, user_id: str = Depends(require_auth)) -> dict:
    """Purge a dubbed video — removes the object and the row."""
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "SELECT video_s3_bucket, video_s3_key FROM studio_video_dub_history WHERE id = ? AND user_id = ?",
            (item_id, user_id),
        )
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(404, "Not found")
        await conn.execute(
            "DELETE FROM studio_video_dub_history WHERE id = ? AND user_id = ?",
            (item_id, user_id),
        )
        await conn.commit()
    finally:
        await conn.close()

    try:
        from studio_tts_service import delete_object
        delete_object(row[0], row[1])
    except Exception:
        _log.warning("[video_dub] failed to delete object for history %s", item_id)

    return {"ok": True}


def _safe_url(bucket: str | None, key: str | None, expires_at: str) -> str:
    """Presign, tolerating expired/missing objects rather than 500-ing the list.

    An empty ``expires_at`` means the asset is retained permanently (all dubs
    written since that change), so it gets a freshly-minted maximum-length
    link rather than being treated as already expired.
    """
    if not bucket or not key:
        return ""
    try:
        from datetime import datetime
        if not expires_at:
            return presigned_url_for_permanent_object(bucket, key) or ""
        dt = datetime.fromisoformat(expires_at)
        return get_presigned_url(bucket, key, dt, public=False) or ""
    except Exception:
        return ""
