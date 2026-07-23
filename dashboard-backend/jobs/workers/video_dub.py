"""Video dubbing task processor.

Flow:
    1. Validate payload + consent attestation
    2. Resolve the uploaded source from R2 (ownership-checked)
    3. Probe duration and re-verify the billed amount
    4. Submit to the tier's engine, poll to completion
    5. Mirror each finished render into R2
    6. Insert one studio_video_dub_history row per target language
    7. Return {results: [...], history_ids: [...]}

Unlike the pod-backed workers this job has no GPU pool — the compute is
upstream. Admission is therefore capped by a plain concurrency counter so a
burst of long videos can't run up an unbounded upstream bill.

Vendor names never appear in anything returned from here. Failures surface
``DubbingError.public_message``; the vendor detail is logged server-side only.
"""

from __future__ import annotations

import asyncio
import json as _json
import logging
import time
from datetime import datetime, timedelta, timezone

from audio_probe import extract_poster_frame, probe_video_metadata
from local_db import get_connection
from studio_tts_service import (
    assert_user_owned_object,
    upload_audio_bytes_to_bucket,
    delete_object,
    download_object_bytes_capped,
    get_presigned_url,
    presigned_url_for_permanent_object,
    upload_video_to_bucket,
)
from video_dub_service import (
    TIER_LIPSYNC,
    TIER_STANDARD,
    VALID_TIERS,
    VIDEO_DUB_MAX_LANGUAGES,
    DubbingError,
    check_plan_limits,
    credits_for,
    fetch_result,
    submit_dub,
    tier_configured,
    validate_source,
    wait_for_dub,
)

from .. import state
from ..timeouts import PHASE_TIMEOUT_VIDEO_DUB


_log = logging.getLogger(__name__)

_SOURCE_SUBDIR = "video-dub-source"

# How long the source video's presigned URL stays fetchable by the upstream
# lip-sync engine. Covers the full multi-language job budget plus margin —
# the engine downloads the source partway into a render, not at submit time.
SOURCE_URL_TTL_SEC = (PHASE_TIMEOUT_VIDEO_DUB * VIDEO_DUB_MAX_LANGUAGES) + 600


def _resolve_source(payload: dict, job_user_id: str) -> tuple[str, str, str]:
    """Return (bucket, key, filename) for the uploaded source video.

    SECURITY: bucket/key come from the client's job payload, so they are
    validated against this job's user and the video-dub-source subdir before
    any read — otherwise a crafted payload could pull another user's file
    out of R2 (the backend holds full credentials).
    """
    bucket = (payload.get("src_bucket") or "").strip()
    key = (payload.get("src_key") or "").strip()
    filename = (payload.get("src_filename") or "source.mp4").strip() or "source.mp4"
    if not bucket or not key:
        raise DubbingError(
            "video_dub payload missing src_bucket/src_key",
            "No source video was provided. Please upload a video and try again.",
        )
    assert_user_owned_object(bucket, key, job_user_id, allowed_subdir=_SOURCE_SUBDIR)
    return bucket, key, filename


def _cleanup_source(bucket: str, key: str, job_user_id: str) -> None:
    """Best-effort delete of the uploaded source once the dub is stored."""
    try:
        assert_user_owned_object(bucket, key, job_user_id, allowed_subdir=_SOURCE_SUBDIR)
    except RuntimeError as exc:
        _log.warning("[video_dub] refusing cleanup of unowned key: %s", exc)
        return
    try:
        delete_object(bucket, key)
    except Exception:
        _log.warning("[video_dub] failed to delete source bucket=%s key=%s", bucket, key)


async def _probe(video_bytes: bytes, filename: str) -> dict:
    """Authoritative duration + dimensions.

    Run on a thread: ffprobe parses the whole header and the source can be
    200 MB, which would stall every other job on the event loop.

    Returns zeros when ffprobe is missing or the file is unreadable; callers
    fall back to the client-declared duration and skip the resolution check
    rather than blocking the job on a missing system dependency.
    """
    try:
        meta = await asyncio.to_thread(probe_video_metadata, video_bytes, filename)
    except Exception:
        _log.warning("[video_dub] ffprobe failed on %s", filename, exc_info=True)
        meta = None
    return meta or {"duration": 0.0, "width": 0, "height": 0}


async def _store_result(
    *,
    job: state.Job,
    video_bytes: bytes,
    lang: str,
    tier: str,
    source_lang: str,
    source_filename: str,
    duration_sec: float,
    credits_used: int,
    latency_ms: int,
) -> dict:
    # retention_days=None -> kept permanently, on every plan tier.
    bucket, key, expires_at = upload_video_to_bucket(
        job.user_id, video_bytes, subdir="video-dub", retention_days=None
    )

    # Poster frame for the library card. Best-effort on a thread — ffmpeg is
    # not a hard dependency and a missing thumbnail must never fail a dub the
    # user already paid for.
    poster_bucket = poster_key = None
    try:
        poster = await asyncio.to_thread(extract_poster_frame, video_bytes, f"{lang}.mp4")
        if poster:
            poster_bucket, poster_key = upload_audio_bytes_to_bucket(
                job.user_id, poster, subdir="video-dub-poster",
                extension="jpg", content_type="image/jpeg",
            )
    except Exception:
        _log.warning("[video_dub] poster extraction failed for job=%s lang=%s", job.id, lang, exc_info=True)

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_video_dub_history
            (user_id, source_filename, source_language, target_language, tier,
             job_id, duration_sec, video_s3_bucket, video_s3_key,
             poster_s3_bucket, poster_s3_key, expires_at,
             credits_used, latency_ms, status, consent_attested,
             consent_attested_at, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?, ?, datetime('now'))
            """,
            (
                job.user_id,
                source_filename[:255],
                source_lang,
                lang,
                tier,
                # Groups this row with its sibling languages from the same job.
                job.id,
                float(duration_sec),
                bucket,
                key,
                poster_bucket,
                poster_key,
                expires_at.isoformat() if expires_at else "",
                int(credits_used),
                latency_ms,
                datetime.now(timezone.utc).isoformat(),
                _json.dumps({"job_id": job.id}),
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    return {
        "language": lang,
        "video_url": presigned_url_for_permanent_object(bucket, key) or "",
        "history_id": history_id,
        "expires_at": expires_at.isoformat() if expires_at else "",
    }


async def process_video_dub(job: state.Job) -> dict:
    payload = job.payload

    tier = (payload.get("tier") or TIER_STANDARD).lower()
    if tier not in VALID_TIERS:
        raise DubbingError(f"unknown dubbing tier {tier!r}", "Unknown dubbing option selected.")
    if not tier_configured(tier):
        raise DubbingError(
            f"tier {tier!r} has no upstream credentials configured",
            "This dubbing option is temporarily unavailable. Please try again later.",
        )

    # The lip-sync engine holds us responsible for likeness consent, so a job
    # without an explicit attestation never reaches an upstream call.
    if not payload.get("consent_attested"):
        raise DubbingError(
            "video_dub submitted without consent attestation",
            "You must confirm you have the rights to the people appearing in this video.",
        )

    target_langs = [str(x).strip() for x in (payload.get("target_languages") or []) if str(x).strip()]
    if not target_langs:
        raise DubbingError("no target languages", "Please choose at least one language to dub into.")
    if len(target_langs) > VIDEO_DUB_MAX_LANGUAGES:
        raise DubbingError(
            f"too many target languages: {len(target_langs)}",
            f"You can dub into at most {VIDEO_DUB_MAX_LANGUAGES} languages per video.",
        )

    source_lang = (payload.get("source_language") or "auto").strip() or "auto"
    num_speakers = max(1, min(int(payload.get("num_speakers") or 1), 8))
    precision = bool(payload.get("precision"))

    bucket, key, filename = _resolve_source(payload, job.user_id)

    await state.update_status(job.id, phase="preparing video")
    video_bytes = download_object_bytes_capped(bucket, key)
    if not video_bytes:
        raise DubbingError(
            f"could not fetch source video bucket={bucket} key={key}",
            "Your uploaded video could not be read. Please re-upload and try again.",
        )

    meta = await _probe(video_bytes, filename)
    duration_sec = float(meta["duration"]) or float(payload.get("duration_sec") or 0.0)
    if duration_sec <= 0:
        raise DubbingError(
            f"could not determine duration for {filename}",
            "We couldn't read this video's length. Please try a different file.",
        )

    # Dubbing translates speech, so a source with no audio track can only ever
    # fail — and it would fail upstream, minutes later, with a vague message.
    # ffprobe already knows, so refuse here. Only trust a definite "no audio":
    # when the probe itself failed it reports zeros and no streams, and we must
    # not turn an unreadable probe into a wrong accusation about the file.
    probe_worked = float(meta.get("duration") or 0) > 0
    if probe_worked and not meta.get("has_audio", True):
        raise DubbingError(
            f"source has no audio stream: {filename}",
            "This video has no audio track, so there's nothing to dub. "
            "Upload a video that contains speech.",
        )

    # Authoritative gate. The router ran the same checks against the client's
    # declared numbers; this run uses what ffprobe actually found, so a
    # mis-declared upload is caught before we spend anything upstream.
    validate_source(
        tier=tier,
        duration_sec=duration_sec,
        size_bytes=len(video_bytes),
        width=int(meta["width"]),
        height=int(meta["height"]),
    )
    # Plan cap, re-checked against the REAL duration. is_premium is set by the
    # router (server-derived, not client-supplied), so a free account can't
    # slip a 5-minute lip-sync past a mis-declared 8-second upload.
    check_plan_limits(tier, duration_sec, bool(payload.get("is_premium")))

    # Re-derive the price server-side. enqueue() charged whatever the client
    # asked for; if the real duration bills higher than that, refuse rather
    # than absorb the upstream cost difference.
    owed = credits_for(tier, duration_sec, len(target_langs))
    if owed > int(job.credits_charged or 0):
        raise DubbingError(
            f"under-charged: owed={owed} charged={job.credits_charged} dur={duration_sec}s",
            "This video is longer than the amount quoted. Please start the job again.",
        )

    # The lip-sync engine fetches by URL (its own upload endpoint caps at
    # 32 MB); the standard engine takes the bytes directly.
    source_url = None
    if tier == TIER_LIPSYNC:
        # The URL must stay valid until the upstream engine has fetched the
        # source, which happens some way into a render that can run for
        # minutes per language. The window therefore covers the whole job
        # budget with margin — presigning for "now" yields a zero-second
        # window and get_presigned_url returns None.
        source_url_expiry = datetime.now(timezone.utc) + timedelta(
            seconds=SOURCE_URL_TTL_SEC
        )
        source_url = get_presigned_url(bucket, key, source_url_expiry, public=False)
        if not source_url:
            raise DubbingError(
                "could not presign source video for lipsync tier",
                "Your uploaded video could not be prepared. Please try again.",
            )

    await state.update_status(job.id, phase="dubbing")
    started = time.perf_counter()

    dub_job = await submit_dub(
        tier=tier,
        video_bytes=video_bytes if tier == TIER_STANDARD else None,
        source_url=source_url,
        filename=filename,
        source_lang=source_lang,
        target_langs=target_langs,
        num_speakers=num_speakers,
        watermark=False,
        precision=precision,
        callback_id=job.id,
    )

    # Languages are billed and delivered independently, so one failing must not
    # discard the ones that succeeded. Failures are collected; the credits for
    # exactly those languages are refunded at the end. Only an all-languages
    # failure raises, which lets dispatch refund the whole job.
    per_language_credits = int(job.credits_charged or 0) // max(1, len(target_langs))
    results: list[dict] = []
    failures: list[dict] = []

    for lang in target_langs:
        try:
            await state.update_status(job.id, phase=f"dubbing → {lang}")
            status = await wait_for_dub(dub_job, lang, timeout_sec=PHASE_TIMEOUT_VIDEO_DUB)
            if status.state != "done":
                raise DubbingError(
                    f"dub failed tier={tier} lang={lang}: {status.detail}",
                    status.detail or "This video could not be dubbed.",
                )

            await state.update_status(job.id, phase=f"storing {lang}")
            out_bytes = await fetch_result(dub_job, lang, status)
            if not out_bytes:
                raise DubbingError(
                    f"empty result for lang={lang}",
                    "The dubbed video came back empty. Please try again.",
                )

            results.append(
                await _store_result(
                    job=job,
                    video_bytes=out_bytes,
                    lang=lang,
                    tier=tier,
                    source_lang=source_lang,
                    source_filename=filename,
                    duration_sec=duration_sec,
                    credits_used=per_language_credits,
                    latency_ms=int((time.perf_counter() - started) * 1000),
                )
            )
        except DubbingError as exc:
            _log.error("[video_dub] job=%s lang=%s failed: %s", job.id, lang, exc)
            failures.append({"language": lang, "message": exc.public_message})

    if not results:
        # Nothing delivered — re-raise so dispatch fails the job and refunds
        # the full amount. Surfacing the first failure keeps the message specific.
        raise DubbingError(
            f"all {len(target_langs)} languages failed for job {job.id}",
            failures[0]["message"] if failures else "This video could not be dubbed.",
        )

    if failures:
        # Partial success: refund only the languages we didn't deliver.
        refund = per_language_credits * len(failures)
        try:
            from jobs import api as jobs_api
            await jobs_api._refund_credits(job, amount=refund)
            _log.info("[video_dub] job=%s partial refund %s for %d failed language(s)",
                      job.id, refund, len(failures))
        except Exception:
            _log.exception("[video_dub] partial refund failed for job=%s", job.id)

    _cleanup_source(bucket, key, job.user_id)

    return {
        "tier": tier,
        "duration_sec": duration_sec,
        "results": results,
        "failures": failures,
        # Convenience aliases so the generic result UI can show something
        # without special-casing multi-language jobs.
        "video_url": results[0]["video_url"],
        "history_id": results[0]["history_id"],
        "expires_at": results[0]["expires_at"],
        "latency_ms": int((time.perf_counter() - started) * 1000),
    }
