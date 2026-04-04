from __future__ import annotations

import os
import random
import re

from fastapi import HTTPException


def _api_tts_env_prefix() -> str:
    """Prefer API_TTS_PROVIDER_* so API chutes stay separate from STUDIO_MODEL_*."""
    name_pat = re.compile(r"^API_TTS_PROVIDER_\d+_NAME$")
    for key in os.environ:
        if name_pat.match(key):
            return "API_TTS_PROVIDER"
    return "TTS_PROVIDER"


def select_api_tts_provider(model: str | None) -> tuple[str, str]:
    """Pick an API TTS chute via weighted random over all matching providers."""
    prefix = _api_tts_env_prefix()
    idx_pat = re.compile(rf"^{prefix}_(\d+)_NAME$")
    indices: list[int] = []
    for key in os.environ:
        m = idx_pat.match(key)
        if m:
            indices.append(int(m.group(1)))

    model_norm = (model or "").strip().lower()
    candidates: list[tuple[str, str, int]] = []
    for idx in sorted(set(indices)):
        enabled = os.environ.get(f"{prefix}_{idx}_ENABLED", "true").strip().lower() in {"1", "true", "yes"}
        name = (os.environ.get(f"{prefix}_{idx}_NAME") or "").strip()
        slug = (os.environ.get(f"{prefix}_{idx}_CHUTE_SLUG") or "").strip()
        if not enabled or not name or not slug:
            continue
        try:
            weight = int((os.environ.get(f"{prefix}_{idx}_WEIGHT") or "1").strip() or "1")
        except ValueError:
            weight = 1
        if weight < 1:
            weight = 1
        if not model_norm or model_norm == name.lower():
            candidates.append((name, slug, weight))

    if not candidates:
        raise HTTPException(
            status_code=503,
            detail="No API TTS provider configured (set API_TTS_PROVIDER_<N>_NAME and CHUTE_SLUG on developer-api)",
        )

    weights = [c[2] for c in candidates]
    chosen = random.choices(candidates, weights=weights, k=1)[0]
    return chosen[0], chosen[1]

