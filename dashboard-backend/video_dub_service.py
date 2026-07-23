"""Video dubbing — provider layer.

Two quality tiers, each served by a different upstream engine:

    standard  → translate + revoice, keeps the speaker's voice, video untouched
    lipsync   → translate + revoice + re-render the speaker's mouth

IMPORTANT — upstream vendor names must never reach the client. Nothing in
this module's return values, raised messages, or the rows it writes may name
the engine behind a tier. Callers surface ``DubbingError.public_message``;
the vendor detail stays in the server log. Tier names ("standard"/"lipsync")
are the only vocabulary the API and UI know about.

Both engines are async job APIs: submit → poll → download. We normalise them
behind :func:`submit_dub` / :func:`poll_dub` / :func:`fetch_result` so the
worker is provider-agnostic and a tier can be repointed at a different engine
(or an in-house pod) without touching the worker, router, or UI.
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------

TIER_STANDARD = "standard"
TIER_LIPSYNC = "lipsync"
VALID_TIERS = (TIER_STANDARD, TIER_LIPSYNC)

# Per-minute-per-language credit cost, billed PER SECOND (see credits_for).
#
# Set at cost parity: what we charge equals what the upstream charges us.
# Derived at the 400 credits/$ crypto rate — the cheapest credits anyone can
# buy — so break-even there is break-even or slightly better for card buyers
# (333 cr/$). Deliberately zero-margin; storage, egress and refunded failures
# are not recovered, so the true position is marginally negative.
#
#   standard : $0.50/min upstream  ->  200 credits/min
#   lipsync  : $2.00/min upstream  ->  800 credits/min   (measured 2026-07-21:
#              a 6.0s clip cost exactly 12 HeyGen credits = $0.20 = $2.00/min)
#
# Both upstreams bill per source second PER OUTPUT LANGUAGE, so our price
# scales the same way or multi-language jobs lose money.
VIDEO_DUB_CREDITS_PER_MIN = int(os.environ.get("STUDIO_VIDEO_DUB_CREDITS_PER_MIN", "200"))
VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN = int(os.environ.get("STUDIO_VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN", "800"))

# Cost containment. At the lipsync tier a 30-minute video costs us real money
# upstream, so the default ceiling is deliberately well below what the
# engines themselves accept.
VIDEO_DUB_MAX_DURATION_SEC = int(os.environ.get("STUDIO_VIDEO_DUB_MAX_DURATION_SEC", "600"))
VIDEO_DUB_MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_VIDEO_DUB_MAX_UPLOAD_BYTES", str(200 * 1024 * 1024)))
VIDEO_DUB_MAX_LANGUAGES = int(os.environ.get("STUDIO_VIDEO_DUB_MAX_LANGUAGES", "3"))

# The lipsync engine rejects >100MB / >2K source, tighter than our own cap.
LIPSYNC_MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_VIDEO_DUB_LIPSYNC_MAX_BYTES", str(100 * 1024 * 1024)))
LIPSYNC_MAX_DIMENSION = int(os.environ.get("STUDIO_VIDEO_DUB_LIPSYNC_MAX_DIM", "2048"))

# Free-plan cap on lip-sync video length. Lip-sync is the expensive tier
# ($2.00/min upstream), and 300 signup credits would otherwise buy 22s of it,
# so free accounts are capped to a short trial clip. Standard dubbing has no
# plan cap — it is cheap enough to leave gated only by the credit balance.
# 0 disables the cap (treat every plan as unlimited).
VIDEO_DUB_LIPSYNC_FREE_MAX_SEC = int(os.environ.get("STUDIO_VIDEO_DUB_LIPSYNC_FREE_MAX_SEC", "10"))


def validate_source(
    *,
    tier: str,
    duration_sec: float,
    size_bytes: int,
    width: int = 0,
    height: int = 0,
) -> None:
    """Reject a source the tier's engine would refuse, before we charge for it.

    The lip-sync engine has tighter limits than the standard one (100 MB and
    sub-2K, versus our own 200 MB ceiling), so the caps are per-tier. Passing
    ``width``/``height`` of 0 skips the resolution check — used by the router,
    which only has the client's declared numbers; the worker probes for real
    and calls this again with authoritative values.

    Raises :class:`DubbingError` with a client-safe message.
    """
    if duration_sec > VIDEO_DUB_MAX_DURATION_SEC:
        raise DubbingError(
            f"video too long: {duration_sec:.1f}s > {VIDEO_DUB_MAX_DURATION_SEC}s",
            f"Videos must be under {VIDEO_DUB_MAX_DURATION_SEC // 60} minutes.",
        )

    max_bytes = LIPSYNC_MAX_UPLOAD_BYTES if tier == TIER_LIPSYNC else VIDEO_DUB_MAX_UPLOAD_BYTES
    if size_bytes > max_bytes:
        mb = max_bytes // (1024 * 1024)
        extra = " when lip-sync is enabled" if tier == TIER_LIPSYNC else ""
        raise DubbingError(
            f"video too large for {tier}: {size_bytes} > {max_bytes}",
            f"Videos must be under {mb} MB{extra}.",
        )

    if tier == TIER_LIPSYNC and width and height:
        longest = max(width, height)
        if longest > LIPSYNC_MAX_DIMENSION:
            raise DubbingError(
                f"resolution too high for lipsync: {width}x{height}",
                (
                    f"Lip-sync supports videos up to {LIPSYNC_MAX_DIMENSION}p on the "
                    f"longest side. This video is {width}×{height} — downscale it, "
                    "or dub without lip-sync."
                ),
            )


def check_plan_limits(tier: str, duration_sec: float, is_premium: bool) -> None:
    """Enforce plan-tier caps that are policy, not engine limits.

    Kept separate from :func:`validate_source` because these are business
    rules ("your plan allows N seconds") rather than technical ones ("the
    engine rejects 4K"), and they carry different, upgrade-oriented messages.

    Today: free accounts get a short lip-sync trial only. Standard dubbing is
    uncapped on every plan. Premium lip-sync is uncapped.
    """
    if (
        tier == TIER_LIPSYNC
        and not is_premium
        and VIDEO_DUB_LIPSYNC_FREE_MAX_SEC > 0
        and duration_sec > VIDEO_DUB_LIPSYNC_FREE_MAX_SEC
    ):
        cap = VIDEO_DUB_LIPSYNC_FREE_MAX_SEC
        raise DubbingError(
            f"free-tier lip-sync cap: {duration_sec:.1f}s > {cap}s",
            f"Lip-sync is limited to {cap} seconds on the free plan. "
            f"Trim the video to {cap}s, turn off lip-sync for the full length, "
            "or upgrade to Premium.",
        )


def credits_for(tier: str, duration_sec: float, language_count: int) -> int:
    """Billable credits: per SECOND of source, times the language count.

    The upstreams bill per second with no minimum and no per-job overhead —
    verified against the live API, where a 6.0s clip cost exactly 1/10th of a
    minute. So we bill per second too. Rounding up to a whole minute (the
    earlier behaviour) would have charged 12x cost on a short clip, which is
    indefensible on exactly the short-form content people dub most.

    Seconds are rounded up, so a 6.4s source bills 7s — sub-cent, and it keeps
    the charge an integer number of credits without ever under-billing.
    """
    per_min = VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN if tier == TIER_LIPSYNC else VIDEO_DUB_CREDITS_PER_MIN
    seconds = max(1, -(-int(duration_sec * 1000) // 1000))          # ceil, ≥1s
    per_language = -(-(seconds * per_min) // 60)                     # ceil to whole credits
    return per_language * max(1, language_count)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class DubbingError(RuntimeError):
    """Failure with a client-safe message.

    ``public_message`` is what the user sees and must never name a vendor.
    The full upstream detail goes to ``args[0]`` for the server log only.
    """

    def __init__(self, log_message: str, public_message: str, retryable: bool = False):
        super().__init__(log_message)
        self.public_message = public_message
        self.retryable = retryable


class DubbingNotConfigured(DubbingError):
    def __init__(self, tier: str):
        super().__init__(
            f"No credentials configured for dubbing tier {tier!r}",
            "Video dubbing is temporarily unavailable. Please try again later.",
        )


# ---------------------------------------------------------------------------
# Normalised job handle
# ---------------------------------------------------------------------------


@dataclass
class DubJob:
    """A submitted dubbing job, normalised across providers."""

    tier: str
    provider_job_ids: dict[str, str]       # language_code -> upstream job id
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"tier": self.tier, "provider_job_ids": self.provider_job_ids, "extra": self.extra}

    @classmethod
    def from_dict(cls, d: dict) -> "DubJob":
        return cls(
            tier=d.get("tier") or TIER_STANDARD,
            provider_job_ids=d.get("provider_job_ids") or {},
            extra=d.get("extra") or {},
        )


@dataclass
class DubStatus:
    state: str                 # "running" | "done" | "failed"
    detail: str = ""
    media_url: str | None = None   # short-lived upstream URL, mirror it promptly


# ---------------------------------------------------------------------------
# Standard tier
# ---------------------------------------------------------------------------

_STD_BASE = "https://api.elevenlabs.io/v1"


def _std_key() -> str:
    return (os.environ.get("ELEVENLABS_API_KEY") or "").strip()


def standard_configured() -> bool:
    return bool(_std_key())


async def _std_submit(
    *,
    video_bytes: bytes,
    filename: str,
    source_lang: str,
    target_langs: list[str],
    num_speakers: int,
    watermark: bool,
) -> DubJob:
    """One upstream job per target language (the engine dubs one at a time)."""
    key = _std_key()
    if not key:
        raise DubbingNotConfigured(TIER_STANDARD)

    ids: dict[str, str] = {}
    timeout = aiohttp.ClientTimeout(total=300)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for lang in target_langs:
            form = aiohttp.FormData()
            form.add_field("file", video_bytes, filename=filename, content_type="video/mp4")
            form.add_field("target_lang", lang)
            if source_lang and source_lang != "auto":
                form.add_field("source_lang", source_lang)
            form.add_field("num_speakers", str(num_speakers))
            form.add_field("watermark", "true" if watermark else "false")
            form.add_field("highest_resolution", "true")

            async with session.post(f"{_STD_BASE}/dubbing", headers={"xi-api-key": key}, data=form) as resp:
                body = await resp.text()
                if resp.status >= 400:
                    _log.error("[video_dub] standard submit failed lang=%s status=%s body=%s", lang, resp.status, body[:500])
                    raise _std_error(resp.status, body)
                try:
                    data = await _json_of(body)
                    ids[lang] = data["dubbing_id"]
                except (KeyError, ValueError) as exc:
                    raise DubbingError(
                        f"standard submit returned unparseable body: {body[:300]}",
                        "Dubbing could not be started. Please try again.",
                    ) from exc

    return DubJob(tier=TIER_STANDARD, provider_job_ids=ids)


async def _std_poll(job: DubJob, lang: str) -> DubStatus:
    key = _std_key()
    job_id = job.provider_job_ids.get(lang)
    if not job_id:
        return DubStatus(state="failed", detail="missing job id")

    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"{_STD_BASE}/dubbing/{job_id}", headers={"xi-api-key": key}) as resp:
            body = await resp.text()
            if resp.status >= 400:
                raise _std_error(resp.status, body)
            data = await _json_of(body)

    status = (data.get("status") or "").lower()
    if status == "dubbed":
        return DubStatus(state="done")
    if status == "failed":
        # Upstream error text can name the vendor — log it, don't forward it.
        _log.error("[video_dub] standard job %s failed: %s", job_id, data.get("error"))
        return DubStatus(state="failed", detail="The dubbing engine could not process this video.")
    return DubStatus(state="running", detail="dubbing")


async def _std_fetch(job: DubJob, lang: str) -> bytes:
    key = _std_key()
    job_id = job.provider_job_ids[lang]
    timeout = aiohttp.ClientTimeout(total=600)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"{_STD_BASE}/dubbing/{job_id}/audio/{lang}", headers={"xi-api-key": key}) as resp:
            if resp.status >= 400:
                raise _std_error(resp.status, await resp.text())
            return await resp.read()


def _std_error(status: int, body: str) -> DubbingError:
    if status == 401:
        return DubbingError(f"standard auth failed: {body[:200]}", "Video dubbing is temporarily unavailable.")
    if status == 429:
        return DubbingError(f"standard rate limited: {body[:200]}", "Too many dubbing jobs right now. Please retry shortly.", retryable=True)
    if status in (402, 403):
        return DubbingError(f"standard quota/permission: {body[:200]}", "Video dubbing is temporarily unavailable.")
    if status >= 500:
        return DubbingError(f"standard upstream {status}: {body[:200]}", "The dubbing service is busy. Please try again.", retryable=True)
    return DubbingError(f"standard error {status}: {body[:300]}", "This video could not be dubbed. Check the file and try again.")


# ---------------------------------------------------------------------------
# Lipsync tier
# ---------------------------------------------------------------------------

_LIP_BASE = "https://api.heygen.com/v3"

# Operator note, kept here rather than in the router — routers/video_dub.py is
# asserted vendor-free by tests/test_video_dub_pricing.py, since everything in
# it is reachable by a client.
#
# The lipsync language table in routers/video_dub.py (``SUPPORTED_LANGUAGES``,
# fields ``lipsync`` and ``lipsync_label``) is transcribed from HeyGen's
# published catalogue. Once HEYGEN_API_KEY is set, reconcile it against:
#
#     GET https://api.heygen.com/v3/video-translations/languages
#         headers: {"X-Api-Key": <key>}
#
# That endpoint returns exact display-name strings; ``output_languages`` must
# match them verbatim or the submit 400s. Any language it does not list should
# have ``lipsync`` set to False so the picker greys it out.
LIPSYNC_CATALOGUE_NOTE = __doc__


def _lip_key() -> str:
    return (os.environ.get("HEYGEN_API_KEY") or "").strip()


def lipsync_configured() -> bool:
    return bool(_lip_key())


async def _lip_submit(
    *,
    source_url: str,
    source_lang: str,
    target_langs: list[str],
    num_speakers: int,
    watermark: bool,
    precision: bool,
    callback_id: str | None = None,
) -> DubJob:
    """Submit one translation covering every language.

    The engine takes a public URL rather than an upload (its own upload
    endpoint caps at 32 MB, too small for video), so the caller passes a
    presigned R2 URL. It returns one job id per requested language, in the
    order requested.
    """
    key = _lip_key()
    if not key:
        raise DubbingNotConfigured(TIER_LIPSYNC)

    payload = {
        "video": {"type": "url", "url": source_url},
        "output_languages": target_langs,
        "mode": "precision" if precision else "speed",
        "speaker_num": num_speakers,
        "translate_audio_only": False,
        "enable_watermark": bool(watermark),
        "enable_dynamic_duration": True,
    }
    if source_lang and source_lang != "auto":
        payload["input_language"] = source_lang
    if callback_id:
        payload["callback_id"] = callback_id

    headers = {"X-Api-Key": key, "Content-Type": "application/json"}
    if callback_id:
        # Retries within 24h are free and idempotent upstream.
        headers["Idempotency-Key"] = callback_id

    timeout = aiohttp.ClientTimeout(total=180)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(f"{_LIP_BASE}/video-translations", headers=headers, json=payload) as resp:
            body = await resp.text()
            if resp.status >= 400:
                _log.error("[video_dub] lipsync submit failed status=%s body=%s", resp.status, body[:500])
                raise _lip_error(resp.status, body)
            data = await _json_of(body)

    raw_ids = (data.get("data") or {}).get("video_translation_ids") or []
    if len(raw_ids) < len(target_langs):
        raise DubbingError(
            f"lipsync returned {len(raw_ids)} ids for {len(target_langs)} languages: {body[:300]}",
            "Dubbing could not be started. Please try again.",
        )
    return DubJob(tier=TIER_LIPSYNC, provider_job_ids=dict(zip(target_langs, raw_ids)))


async def _lip_poll(job: DubJob, lang: str) -> DubStatus:
    key = _lip_key()
    job_id = job.provider_job_ids.get(lang)
    if not job_id:
        return DubStatus(state="failed", detail="missing job id")

    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(f"{_LIP_BASE}/video-translations/{job_id}", headers={"X-Api-Key": key}) as resp:
            body = await resp.text()
            if resp.status >= 400:
                raise _lip_error(resp.status, body)
            data = (await _json_of(body)).get("data") or {}

    status = (data.get("status") or "").lower()
    if status == "completed":
        return DubStatus(state="done", media_url=data.get("video_url"))
    if status == "failed":
        _log.error("[video_dub] lipsync job %s failed: %s", job_id, data.get("failure_message"))
        return DubStatus(state="failed", detail="The dubbing engine could not process this video.")
    return DubStatus(state="running", detail="rendering")


async def _lip_fetch(job: DubJob, lang: str, media_url: str) -> bytes:
    """Download the finished render. The URL is presigned and short-lived."""
    timeout = aiohttp.ClientTimeout(total=900)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(media_url) as resp:
            if resp.status >= 400:
                raise DubbingError(
                    f"lipsync download failed {resp.status}",
                    "The dubbed video could not be retrieved. Please try again.",
                    retryable=True,
                )
            return await resp.read()


def _lip_error(status: int, body: str) -> DubbingError:
    if status == 401:
        return DubbingError(f"lipsync auth failed: {body[:200]}", "Lip-sync dubbing is temporarily unavailable.")
    if status == 402:
        return DubbingError(f"lipsync insufficient credit: {body[:200]}", "Lip-sync dubbing is temporarily unavailable.")
    if status == 429:
        return DubbingError(f"lipsync rate limited: {body[:200]}", "Too many lip-sync jobs right now. Please retry shortly.", retryable=True)
    if status >= 500:
        return DubbingError(f"lipsync upstream {status}: {body[:200]}", "The lip-sync service is busy. Please try again.", retryable=True)
    return DubbingError(f"lipsync error {status}: {body[:300]}", "This video could not be lip-synced. Check the file and try again.")


# ---------------------------------------------------------------------------
# Public, provider-agnostic surface
# ---------------------------------------------------------------------------


def tier_configured(tier: str) -> bool:
    return lipsync_configured() if tier == TIER_LIPSYNC else standard_configured()


async def submit_dub(
    *,
    tier: str,
    video_bytes: bytes | None,
    source_url: str | None,
    filename: str,
    source_lang: str,
    target_langs: list[str],
    num_speakers: int = 1,
    watermark: bool = False,
    precision: bool = False,
    callback_id: str | None = None,
) -> DubJob:
    if tier == TIER_LIPSYNC:
        if not source_url:
            raise DubbingError("lipsync tier requires a fetchable source_url", "Could not start dubbing for this upload.")
        return await _lip_submit(
            source_url=source_url, source_lang=source_lang, target_langs=target_langs,
            num_speakers=num_speakers, watermark=watermark, precision=precision,
            callback_id=callback_id,
        )
    if video_bytes is None:
        raise DubbingError("standard tier requires video bytes", "Could not start dubbing for this upload.")
    return await _std_submit(
        video_bytes=video_bytes, filename=filename, source_lang=source_lang,
        target_langs=target_langs, num_speakers=num_speakers, watermark=watermark,
    )


async def poll_dub(job: DubJob, lang: str) -> DubStatus:
    return await (_lip_poll(job, lang) if job.tier == TIER_LIPSYNC else _std_poll(job, lang))


async def fetch_result(job: DubJob, lang: str, status: DubStatus) -> bytes:
    if job.tier == TIER_LIPSYNC:
        if not status.media_url:
            raise DubbingError("lipsync completed without a media url", "The dubbed video could not be retrieved.")
        return await _lip_fetch(job, lang, status.media_url)
    return await _std_fetch(job, lang)


async def wait_for_dub(
    job: DubJob,
    lang: str,
    *,
    timeout_sec: float,
    poll_interval_sec: float = 5.0,
    on_progress=None,
) -> DubStatus:
    """Poll until the job finishes, fails, or the budget runs out.

    Transient poll errors are swallowed and retried — a single failed status
    check shouldn't kill a job the upstream is still working on. A retryable
    error only becomes fatal once the overall budget expires.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_sec
    last_error: DubbingError | None = None

    while loop.time() < deadline:
        try:
            status = await poll_dub(job, lang)
            last_error = None
            if status.state in ("done", "failed"):
                return status
            if on_progress:
                await on_progress(status)
        except DubbingError as exc:
            if not exc.retryable:
                raise
            last_error = exc
            _log.warning("[video_dub] transient poll error, retrying: %s", exc)
        except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
            last_error = DubbingError(f"poll transport error: {exc}", "The dubbing service is busy. Please try again.", retryable=True)
            _log.warning("[video_dub] poll transport error, retrying: %s", exc)

        await asyncio.sleep(poll_interval_sec)

    if last_error:
        raise last_error
    raise DubbingError(
        f"dub job timed out after {timeout_sec}s (tier={job.tier}, lang={lang})",
        "Dubbing took too long and was cancelled. You have not been charged.",
    )


async def _json_of(body: str) -> dict:
    import json
    return json.loads(body)
