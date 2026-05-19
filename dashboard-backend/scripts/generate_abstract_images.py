"""Generate 50 abstract fallback images via OpenAI's gpt-image-1.

Produces colorful, painterly, square images suitable for use as cover
art on items that don't have their own image yet — voice agents,
audio tracks, music without artwork, etc. Uploaded to R2 under
``static/abstract/`` and registered in ``app/src/data/assets.json``
so the frontend's existing ``ABSTRACT_COVERS`` shuffle picks them up
automatically.

  Run from the dashboard-backend directory:
    venv/bin/python scripts/generate_abstract_images.py
    venv/bin/python scripts/generate_abstract_images.py --count 10
    venv/bin/python scripts/generate_abstract_images.py --dry-run

  Costs ~$0.011 per image at low quality → ~$0.55 for the default 50.

Color guard rails: we explicitly avoid bright/glaring palettes
(yellow, white-dominant, neon red, hot pink) per product feedback —
those don't sit well on Vocence's dark UI. Instead we pull from
jewel-tone, oceanic, and earthy palettes that look luxurious against
the #07080A background.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import os
import random
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

# Make dashboard-backend importable so we can reuse the R2 client setup.
_HERE = Path(__file__).resolve().parent
_BACKEND_ROOT = _HERE.parent
if str(_BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(_BACKEND_ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv(_BACKEND_ROOT / ".env")
except ImportError:
    pass

from openai import OpenAI  # noqa: E402
from studio_tts_service import (  # noqa: E402
    BUCKET_PROVIDER,
    R2_BUCKET_NAME,
    R2_PUBLIC_DOMAIN,
    _minio_client,
)


# ---------------------------------------------------------------------------
# Color palettes — explicitly chosen to sit well on #07080A dark UI.
# Each entry is a phrase the model interprets as a palette directive.
# ---------------------------------------------------------------------------

PALETTES = [
    # Jewel tones — luxurious + saturated without being neon
    "deep amethyst, plum, and indigo, with hints of midnight blue",
    "emerald, jade, and forest-teal with shadowed depths",
    "sapphire, cobalt, and deep ultramarine, accented with ocean teal",
    "burgundy, oxblood, and mauve, with smoky violet undertones",
    "rose-gold, dusty rose, copper, and deep mauve",
    "deep teal, peacock, and viridian with bronze shimmer",
    "twilight purple, cosmic blue, and faint magenta",
    # Oceanic
    "deep cerulean, abyssal blue, slate teal, with ripples of aquamarine",
    "stormy steel-blue, gunmetal, and inky navy with phosphorescent teal sparks",
    "tropical lagoon turquoise, midnight indigo, and sea-foam green-blue",
    # Earthy + moody
    "obsidian, charcoal, ash-grey, with burnt copper veins",
    "rich espresso brown, deep terracotta, plum, and mahogany",
    "muted olive, forest moss, charcoal, and bronze",
    "soft slate, oxidized copper, and aged-bronze patina",
    # Cosmic / aurora
    "aurora teal, cosmic violet, and deep indigo with starry depth",
    "nebula magenta, deep space navy, and soft electric purple",
    "northern-lights green, midnight purple, and inky black depth",
    # Soft + dusky (still saturated)
    "dusky lavender, plum, deep periwinkle, and graphite",
    "moody rose, burgundy, deep cocoa, and slate purple",
    "muted teal, slate, charcoal, with petrol-blue highlights",
]

# Negative cues — repeated into every prompt so we steer firmly away
# from the colors the product feedback flagged as bad on the dark UI.
NEGATIVE = (
    "Avoid bright yellow, neon-yellow, pure white dominance, "
    "bright red, hot pink, and any glaring neon-saturation. "
    "Avoid recognizable objects, text, faces, words, logos, or any "
    "identifiable subject — purely abstract."
)

# Style templates — varied so 50 images don't all feel like one batch.
# Each template ends with a hook the palette phrase slots into.
STYLE_TEMPLATES = [
    "Luxury abstract wallpaper with flowing pigment gradients, smooth swirling motion, cinematic soft lighting, painterly fluid textures, elegant composition, ultra-detailed, square format. Palette: {palette}.",
    "Colorful liquid pigments mixing in slow motion, fluid simulation art, smooth gradients, mesmerizing organic blends, soft diffused lighting, ultra-detailed close-up, square. Palette: {palette}.",
    "Abstract painterly explosion of richly blended colors, organic swirls and chaotic-yet-beautiful composition, modern digital fluid art, soft cinematic light, highly detailed, no objects, purely abstract, square. Palette: {palette}.",
    "Macro photograph of glossy resin pour art, rich layered gradients, organic marbling, smooth wet flow, professional studio lighting, ultra-detailed, square 1:1. Palette: {palette}.",
    "Abstract velvet-textured oil paint swirls, dreamy fluid motion, lush gradients, painterly depth, atmospheric soft light, elegant composition, square. Palette: {palette}.",
    "Abstract nebula-like cloudscape, soft cosmic gradients, slow-flowing colors, atmospheric haze, painterly modern digital art, square. Palette: {palette}.",
    "Iridescent silk-fabric flow, soft glossy folds, gradient color shifts, luxurious haute-couture aesthetic, cinematic lighting, abstract macro, square. Palette: {palette}.",
    "Abstract underwater ink-in-water swirls, organic feathered tendrils, fluid blooms, soft caustic lighting, painterly fine art, square. Palette: {palette}.",
    "Smooth marbled stone pattern with intricate veining, glossy polished finish, rich saturated tones, soft museum lighting, ultra-detailed, abstract, square. Palette: {palette}.",
    "Modern abstract digital painting, broad confident brush strokes, lush color blends, painterly fluid composition, gallery-print quality, square. Palette: {palette}.",
]


def build_prompts(count: int, seed: int) -> list[str]:
    """Combine style template × palette deterministically so re-runs
    produce a consistent set. The seed is included in the cache key
    so any caller can reproduce the exact batch."""
    rng = random.Random(seed)
    prompts: list[str] = []
    # Cycle through templates and palettes with offsets so no two
    # adjacent prompts share a template; spread palettes evenly.
    for i in range(count):
        tpl = STYLE_TEMPLATES[i % len(STYLE_TEMPLATES)]
        pal = PALETTES[(i * 7 + rng.randrange(len(PALETTES))) % len(PALETTES)]
        prompts.append(f"{tpl.format(palette=pal)} {NEGATIVE}")
    return prompts


# ---------------------------------------------------------------------------
# Output config
# ---------------------------------------------------------------------------

# 512x512 is the sweet spot for "fallback cover" use: large enough
# that the Studio player bar's 56-px artwork stays sharp at 2× DPI,
# small enough to keep R2 storage + bandwidth tiny. The frontend
# already uses 50 KB-ish abstract images at this size.
OUTPUT_DIMENSION = 512
WEBP_QUALITY = 88
WEBP_METHOD = 6  # slowest/best compression; we only do this once

# Where on R2 the images end up — must match the prefix the frontend
# manifest already uses for the existing 56 abstract images.
R2_PREFIX = "static/abstract/"
# Keyspace prefix in the manifest (assets.json). Existing entries use
# "abstract.abstract-NN" and "abstract.voice-abstract-NN"; we add our
# own series so we never collide with prior batches.
MANIFEST_GROUP = "abstract"
KEY_PREFIX = "agent-abstract"  # → manifest keys like "abstract.agent-abstract-01"

MANIFEST_PATH = _BACKEND_ROOT.parent / "app" / "src" / "data" / "assets.json"


# ---------------------------------------------------------------------------
# Per-image generation + upload
# ---------------------------------------------------------------------------


def _short_hash(data: bytes) -> str:
    """10-char sha1 prefix — matches the convention used by the
    existing abstract images on R2 (``abstract-05-d2df882707.webp``)."""
    return hashlib.sha1(data).hexdigest()[:10]


def generate_one(client: OpenAI, prompt: str) -> bytes:
    """Generate at 1024x1024 (gpt-image-1's minimum) then return raw
    PNG bytes. The downscale to 512 happens in the caller so we can
    cache the original if we ever want it."""
    resp = client.images.generate(
        model="gpt-image-1",
        prompt=prompt,
        size="1024x1024",
        # "low" quality is enough for ambient cover art and ~5× cheaper
        # than "high". We're not making magazine spreads here.
        quality="low",
        n=1,
    )
    b64 = resp.data[0].b64_json
    if not b64:
        raise RuntimeError("gpt-image-1 returned no b64_json")
    return base64.b64decode(b64)


def downsize_to_webp(png_bytes: bytes) -> bytes:
    img = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    img.thumbnail((OUTPUT_DIMENSION, OUTPUT_DIMENSION), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="WEBP", quality=WEBP_QUALITY, method=WEBP_METHOD)
    return out.getvalue()


def upload_to_r2(client_minio, key: str, webp_bytes: bytes) -> str:
    """Push the bytes to R2. Returns the public URL. Long immutable
    Cache-Control because the filename includes the content hash —
    a different content gets a different key, never an in-place update."""
    if BUCKET_PROVIDER != "r2" or not R2_PUBLIC_DOMAIN:
        raise RuntimeError(
            f"R2 not configured (BUCKET_PROVIDER={BUCKET_PROVIDER!r}, "
            f"R2_PUBLIC_DOMAIN={R2_PUBLIC_DOMAIN!r}). Cannot upload."
        )
    client_minio.put_object(
        R2_BUCKET_NAME,
        key,
        io.BytesIO(webp_bytes),
        length=len(webp_bytes),
        content_type="image/webp",
        metadata={"Cache-Control": "public, max-age=31536000, immutable"},
    )
    return f"https://{R2_PUBLIC_DOMAIN}/{key}"


# ---------------------------------------------------------------------------
# Manifest update
# ---------------------------------------------------------------------------


def load_manifest() -> dict:
    if not MANIFEST_PATH.exists():
        raise FileNotFoundError(f"manifest not found at {MANIFEST_PATH}")
    return json.loads(MANIFEST_PATH.read_text())


def save_manifest(manifest: dict) -> None:
    """Pretty-print with stable key order so git diffs stay readable."""
    manifest["generatedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def next_index(manifest: dict) -> int:
    """Find the next free ``agent-abstract-NN`` index so re-runs of
    this script append rather than overwrite."""
    assets = manifest.get("assets", {})
    used: set[int] = set()
    prefix = f"{MANIFEST_GROUP}.{KEY_PREFIX}-"
    for k in assets:
        if k.startswith(prefix):
            tail = k[len(prefix):]
            try:
                used.add(int(tail))
            except ValueError:
                continue
    n = 1
    while n in used:
        n += 1
    return n


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=50, help="how many images to generate (default 50)")
    parser.add_argument("--seed", type=int, default=42, help="prompt-mix seed (default 42)")
    parser.add_argument("--dry-run", action="store_true", help="don't call the API or upload")
    args = parser.parse_args()

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        print("error: OPENAI_API_KEY not set (expected in .env)", file=sys.stderr)
        return 2

    if args.dry_run:
        prompts = build_prompts(args.count, args.seed)
        print(f"DRY RUN — {len(prompts)} prompts that would be sent:\n")
        for i, p in enumerate(prompts, 1):
            print(f"--- {i} ---\n{p}\n")
        return 0

    client = OpenAI(api_key=api_key)
    minio = _minio_client()
    manifest = load_manifest()
    start_idx = next_index(manifest)
    prompts = build_prompts(args.count, args.seed)

    print(f"Generating {len(prompts)} images starting at {KEY_PREFIX}-{start_idx:02d}.")
    print(f"Uploading to bucket={R2_BUCKET_NAME!r} prefix={R2_PREFIX!r} (public {R2_PUBLIC_DOMAIN}).")
    print()

    succeeded = 0
    failed: list[tuple[int, str]] = []
    for offset, prompt in enumerate(prompts):
        idx = start_idx + offset
        label = f"{KEY_PREFIX}-{idx:02d}"
        t0 = time.time()
        print(f"  [{offset + 1}/{len(prompts)}] {label} … ", end="", flush=True)
        try:
            png = generate_one(client, prompt)
            webp = downsize_to_webp(png)
            content_hash = _short_hash(webp)
            object_key = f"{R2_PREFIX}{label}-{content_hash}.webp"
            url = upload_to_r2(minio, object_key, webp)
            manifest_key = f"{MANIFEST_GROUP}.{label}"
            manifest["assets"][manifest_key] = {
                "url": url,
                "type": "image/webp",
                "size": len(webp),
                "originalSize": len(png),
                "source": f"{label}.gpt-image-1",
            }
            # Persist after each success so a mid-run failure doesn't
            # cost the user the work already done.
            save_manifest(manifest)
            succeeded += 1
            print(f"✓ {len(webp):>7d} B  {time.time() - t0:.1f}s")
        except Exception as exc:
            failed.append((idx, str(exc)))
            print(f"✗ {exc}")

    print()
    print(f"Done. {succeeded}/{len(prompts)} succeeded; {len(failed)} failed.")
    if failed:
        for idx, err in failed:
            print(f"  - {KEY_PREFIX}-{idx:02d}: {err}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
