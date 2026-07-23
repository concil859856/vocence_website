"""Video dubbing — pricing and vendor-leak tests.

Two things here are money- or contract-critical and cheap to regress:

1. ``credits_for`` must round partial minutes UP and multiply by language
   count. Both upstreams bill us per source-minute per output language, so
   under-charging on either axis loses money on every job.
2. No client-visible string may name the upstream engines.
"""

from __future__ import annotations

import os
import sys

import pytest


@pytest.fixture
def svc():
    """The canonical module, imported once.

    Deliberately NOT reloaded. importlib.reload creates a fresh DubbingError
    class object, while routers/video_dub.py still holds the one it imported
    at startup — so its ``except DubbingError`` would stop matching and route
    tests in the same session would see 500s instead of 400s. Tests that need
    different env values load an isolated copy instead (see
    _load_isolated_copy below).
    """
    import video_dub_service
    return video_dub_service


def _load_isolated_copy():
    """Load a private copy of the module under a throwaway name.

    Lets a test observe module-level constants built from patched env without
    mutating the canonical module every other test and router shares.
    """
    import importlib.util
    path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "video_dub_service.py",
    )
    name = "_video_dub_service_envtest"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    # Must be in sys.modules before exec: the module uses
    # ``from __future__ import annotations``, so @dataclass resolves its
    # string annotations via sys.modules[cls.__module__].
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    return mod


# ---------------------------------------------------------------------------
# Rounding
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "duration_sec,expected_seconds",
    [
        (0.1, 1),      # sub-second still bills a whole second, never zero
        (1, 1),
        (6, 6),        # the measured case: 6s lipsync cost exactly $0.20
        (6.4, 7),      # partial seconds round UP, never down
        (59, 59),
        (60, 60),
        (61, 61),
        (600, 600),
    ],
)
def test_billing_is_per_second_not_per_minute(svc, duration_sec, expected_seconds):
    """The upstreams bill per second with no minimum; so do we.

    Rounding up to a whole minute would charge 12x cost on a 6-second clip,
    which is the common case for short-form content.
    """
    got = svc.credits_for(svc.TIER_STANDARD, duration_sec, 1)
    expected = -(-(expected_seconds * svc.VIDEO_DUB_CREDITS_PER_MIN) // 60)
    assert got == expected


def test_six_second_lipsync_matches_measured_upstream_cost(svc):
    """Regression lock on cost parity.

    Measured 2026-07-21 against the live API: a 6.0s clip cost 12 HeyGen
    credits = $0.20. At the 400 credits/$ crypto rate that is 80 of our
    credits. If this drifts we are either subsidising or overcharging.
    """
    assert svc.credits_for(svc.TIER_LIPSYNC, 6.0, 1) == 80
    assert 80 * 0.0025 == pytest.approx(0.20)


def test_four_language_job_matches_measured_concurrent_cost(svc):
    """The 4x concurrent test cost exactly $0.80 for 4 x 6s."""
    assert svc.credits_for(svc.TIER_LIPSYNC, 6.0, 4) == 320
    assert 320 * 0.0025 == pytest.approx(0.80)


def test_a_full_minute_costs_the_headline_rate(svc):
    assert svc.credits_for(svc.TIER_LIPSYNC, 60, 1) == svc.VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN
    assert svc.credits_for(svc.TIER_STANDARD, 60, 1) == svc.VIDEO_DUB_CREDITS_PER_MIN


def test_zero_duration_still_bills_a_second(svc):
    """Guards against a 0-length probe producing a free job."""
    assert svc.credits_for(svc.TIER_STANDARD, 0, 1) > 0


# ---------------------------------------------------------------------------
# Language multiplier
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("languages", [1, 2, 3])
def test_cost_scales_linearly_with_languages(svc, languages):
    one = svc.credits_for(svc.TIER_STANDARD, 90, 1)
    assert svc.credits_for(svc.TIER_STANDARD, 90, languages) == one * languages


def test_zero_languages_floors_to_one(svc):
    """Never produce a zero charge from an empty list — the router rejects
    that case first, but the pricing function must not be the weak link."""
    assert svc.credits_for(svc.TIER_STANDARD, 60, 0) == svc.VIDEO_DUB_CREDITS_PER_MIN


# ---------------------------------------------------------------------------
# Tier separation
# ---------------------------------------------------------------------------


def test_lipsync_costs_more_than_standard(svc):
    standard = svc.credits_for(svc.TIER_STANDARD, 120, 2)
    lipsync = svc.credits_for(svc.TIER_LIPSYNC, 120, 2)
    assert lipsync > standard


def test_unknown_tier_prices_as_standard(svc):
    """An unrecognised tier must never fall through to the cheaper rate by
    accident — it maps to standard, and the router rejects it separately."""
    assert svc.credits_for("nonsense", 60, 1) == svc.credits_for(svc.TIER_STANDARD, 60, 1)


def test_env_overrides_are_respected(monkeypatch):
    monkeypatch.setenv("STUDIO_VIDEO_DUB_CREDITS_PER_MIN", "111")
    monkeypatch.setenv("STUDIO_VIDEO_DUB_LIPSYNC_CREDITS_PER_MIN", "999")
    mod = _load_isolated_copy()
    assert mod.credits_for(mod.TIER_STANDARD, 60, 1) == 111
    assert mod.credits_for(mod.TIER_LIPSYNC, 60, 1) == 999


# ---------------------------------------------------------------------------
# Availability fails closed
# ---------------------------------------------------------------------------


def test_tiers_report_unconfigured_without_keys(svc, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("HEYGEN_API_KEY", raising=False)
    assert svc.tier_configured(svc.TIER_STANDARD) is False
    assert svc.tier_configured(svc.TIER_LIPSYNC) is False


def test_tiers_are_independently_configurable(svc, monkeypatch):
    """One tier being down must not disable the other."""
    monkeypatch.setenv("ELEVENLABS_API_KEY", "sk-test")
    monkeypatch.delenv("HEYGEN_API_KEY", raising=False)
    assert svc.tier_configured(svc.TIER_STANDARD) is True
    assert svc.tier_configured(svc.TIER_LIPSYNC) is False


# ---------------------------------------------------------------------------
# Vendor names must not reach the client
# ---------------------------------------------------------------------------

_VENDOR_WORDS = ("elevenlabs", "eleven labs", "heygen", "hey gen", "xi-api")


def test_error_public_messages_never_name_a_vendor(svc):
    """Upstream bodies get embedded in the log message; the public one must
    stay clean even when the body is hostile."""
    hostile = "ElevenLabs says: your HeyGen quota is gone"
    for factory in (svc._std_error, svc._lip_error):
        for status in (400, 401, 402, 429, 500, 503):
            err = factory(status, hostile)
            public = err.public_message.lower()
            for word in _VENDOR_WORDS:
                assert word not in public, f"{factory.__name__}({status}) leaked {word!r}"


def test_not_configured_error_is_clean(svc):
    err = svc.DubbingNotConfigured(svc.TIER_LIPSYNC)
    assert not any(w in err.public_message.lower() for w in _VENDOR_WORDS)


def test_router_module_exposes_no_vendor_names():
    """The whole client-facing router file must be vendor-free — response
    bodies, docstrings and language labels included."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routers", "video_dub.py")
    with open(path, encoding="utf-8") as fh:
        source = fh.read().lower()
    for word in _VENDOR_WORDS:
        assert word not in source, f"routers/video_dub.py mentions {word!r}"


def test_history_payload_reports_boolean_not_tier_name(svc):
    """The history endpoint maps tier → ``lipsync: bool`` so the internal
    tier vocabulary never reaches the client."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "routers", "video_dub.py")
    with open(path, encoding="utf-8") as fh:
        source = fh.read()
    assert '"lipsync": tier == TIER_LIPSYNC' in source


# ---------------------------------------------------------------------------
# Source limits — these guard real upstream spend, so they are per-tier
# ---------------------------------------------------------------------------


def test_lipsync_rejects_over_2k_resolution(svc):
    with pytest.raises(svc.DubbingError) as ei:
        svc.validate_source(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=1024, width=3840, height=2160)
    assert "2048" in ei.value.public_message


def test_lipsync_resolution_uses_longest_side(svc):
    """A 2160x3840 portrait video is just as over-cap as landscape 4K."""
    with pytest.raises(svc.DubbingError):
        svc.validate_source(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=1024, width=2160, height=3840)


def test_standard_tier_allows_high_resolution(svc):
    """Only the lip-sync engine repaints frames, so only it has a pixel cap."""
    svc.validate_source(tier=svc.TIER_STANDARD, duration_sec=60, size_bytes=1024, width=3840, height=2160)


def test_lipsync_has_tighter_size_cap_than_standard(svc):
    big = 150 * 1024 * 1024
    svc.validate_source(tier=svc.TIER_STANDARD, duration_sec=60, size_bytes=big)
    with pytest.raises(svc.DubbingError):
        svc.validate_source(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=big)


def test_unknown_dimensions_skip_the_resolution_check(svc):
    """The router only has client-declared values and may pass zeros; that
    must not hard-fail, because the worker probes for real afterwards."""
    svc.validate_source(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=1024, width=0, height=0)


def test_duration_cap_applies_to_both_tiers(svc):
    for tier in (svc.TIER_STANDARD, svc.TIER_LIPSYNC):
        with pytest.raises(svc.DubbingError):
            svc.validate_source(tier=tier, duration_sec=svc.VIDEO_DUB_MAX_DURATION_SEC + 1, size_bytes=1024)


def test_limit_messages_never_name_a_vendor(svc):
    cases = [
        dict(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=1024, width=4096, height=2160),
        dict(tier=svc.TIER_LIPSYNC, duration_sec=60, size_bytes=200 * 1024 * 1024),
        dict(tier=svc.TIER_STANDARD, duration_sec=99999, size_bytes=1024),
    ]
    for kw in cases:
        with pytest.raises(svc.DubbingError) as ei:
            svc.validate_source(**kw)
        msg = ei.value.public_message.lower()
        assert not any(w in msg for w in _VENDOR_WORDS)


# ---------------------------------------------------------------------------
# Free-plan lip-sync duration cap (policy, not an engine limit)
# ---------------------------------------------------------------------------


def test_free_lipsync_is_capped(svc):
    cap = svc.VIDEO_DUB_LIPSYNC_FREE_MAX_SEC
    # At/under the cap is fine.
    svc.check_plan_limits(svc.TIER_LIPSYNC, cap, is_premium=False)
    # Over the cap is refused, with an actionable message.
    with pytest.raises(svc.DubbingError) as ei:
        svc.check_plan_limits(svc.TIER_LIPSYNC, cap + 1, is_premium=False)
    msg = ei.value.public_message.lower()
    assert str(cap) in msg and ("upgrade" in msg or "premium" in msg)


def test_premium_lipsync_is_uncapped(svc):
    svc.check_plan_limits(svc.TIER_LIPSYNC, 600, is_premium=True)  # no raise


def test_standard_dubbing_is_never_capped_by_plan(svc):
    # Long standard dub is fine for free and premium alike — only credits gate it.
    svc.check_plan_limits(svc.TIER_STANDARD, 600, is_premium=False)
    svc.check_plan_limits(svc.TIER_STANDARD, 600, is_premium=True)


def test_plan_cap_message_never_names_a_vendor(svc):
    with pytest.raises(svc.DubbingError) as ei:
        svc.check_plan_limits(svc.TIER_LIPSYNC, 9999, is_premium=False)
    assert not any(w in ei.value.public_message.lower() for w in _VENDOR_WORDS)
