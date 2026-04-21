"""Upload static assets (audio/image/video) to Cloudflare R2 and maintain a manifest.

Reuses the R2 credentials from studio_tts_service (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_DOMAIN). Objects are uploaded under a
configurable prefix (default: "static/") with long immutable Cache-Control so they can
live alongside short-lived TTS output in the same bucket without conflict.

Usage:
    # Single file, logical key, manifest update
    python upload_static_assets.py public/demo.mp4 \
        --key video.demo --prefix static/videos/ \
        --manifest ../app/src/data/assets.json

    # Batch: all files in a directory with a naming template
    python upload_static_assets.py \
        --from ../app/public/samples/audios \
        --prefix static/samples/audios/ \
        --name-template "music.{stem}" \
        --manifest ../app/src/data/assets.json

    # Dry-run (no uploads, prints plan + manifest diff)
    python upload_static_assets.py ... --dry-run

Flags:
    --compress / --no-compress   WAV->Opus, PNG->WebP. Default: compress.
    --hash-name / --plain-name   Append short content hash to filename. Default: hash-name.
    --overwrite                  Upload even if a same-hash object already exists in manifest.

Requirements:
    pip install minio Pillow python-dotenv
    ffmpeg on PATH (only if --compress and any .wav files)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

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

# Reuse the already-configured R2 client + env vars from the service module.
from studio_tts_service import (  # noqa: E402
    BUCKET_PROVIDER,
    R2_BUCKET_NAME,
    R2_PUBLIC_DOMAIN,
    _minio_client,
)

# Extension -> MIME type. Falls back to mimetypes.guess_type if missing.
MIME_OVERRIDES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".opus": "audio/opus",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
}

# One year, immutable. Hashed filenames make this safe.
CACHE_CONTROL_IMMUTABLE = "public, max-age=31536000, immutable"


def guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in MIME_OVERRIDES:
        return MIME_OVERRIDES[ext]
    mime, _ = mimetypes.guess_type(str(path))
    return mime or "application/octet-stream"


def content_hash(data: bytes, length: int = 10) -> str:
    return hashlib.sha256(data).hexdigest()[:length]


def compress_wav_to_opus(src: Path) -> tuple[bytes, str]:
    """Use ffmpeg to transcode WAV -> Opus @ 96kbps. Returns (bytes, suggested_extension)."""
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg not found on PATH; install it or pass --no-compress")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", str(src),
        "-c:a", "libopus", "-b:a", "128k", "-vbr", "on",
        "-f", "ogg", "pipe:1",
    ]
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {src.name}: {proc.stderr.decode('utf-8', 'replace')[:400]}")
    return proc.stdout, ".opus"


def compress_png_to_webp(src: Path, quality: int = 82) -> tuple[bytes, str]:
    """Use Pillow to convert PNG -> WebP @ quality 82. Returns (bytes, suggested_extension)."""
    try:
        from PIL import Image
    except ImportError:
        raise RuntimeError("Pillow not installed; run `pip install Pillow` or pass --no-compress")
    with Image.open(src) as img:
        # Preserve alpha if present.
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA" if "A" in img.mode else "RGB")
        out = BytesIO()
        img.save(out, format="WEBP", quality=quality, method=6)
        return out.getvalue(), ".webp"


@dataclass
class UploadPlan:
    """One file to upload: source path, object key, logical manifest key, payload bytes, content type."""
    source: Path
    object_key: str
    manifest_key: str
    payload: bytes
    content_type: str
    original_size: int


def prepare_file(
    src: Path,
    *,
    manifest_key: str,
    prefix: str,
    compress: bool,
    hash_name: bool,
) -> UploadPlan:
    """Read src, optionally compress, compute key + hash, return an UploadPlan."""
    raw = src.read_bytes()
    original_size = len(raw)
    ext = src.suffix.lower()

    if compress and ext == ".wav":
        payload, new_ext = compress_wav_to_opus(src)
    elif compress and ext == ".png":
        payload, new_ext = compress_png_to_webp(src)
    else:
        payload, new_ext = raw, ext

    content_type = MIME_OVERRIDES.get(new_ext, guess_mime(src.with_suffix(new_ext)))

    stem = src.stem
    if hash_name:
        h = content_hash(payload)
        filename = f"{stem}-{h}{new_ext}"
    else:
        filename = f"{stem}{new_ext}"

    normalized_prefix = prefix.strip("/").strip()
    object_key = f"{normalized_prefix}/{filename}" if normalized_prefix else filename

    return UploadPlan(
        source=src,
        object_key=object_key,
        manifest_key=manifest_key,
        payload=payload,
        content_type=content_type,
        original_size=original_size,
    )


def load_manifest(path: Path) -> dict:
    if not path.exists():
        return {
            "version": 1,
            "baseUrl": f"https://{R2_PUBLIC_DOMAIN}" if R2_PUBLIC_DOMAIN else "",
            "generatedAt": "",
            "assets": {},
        }
    return json.loads(path.read_text("utf-8"))


def save_manifest(path: Path, manifest: dict) -> None:
    manifest["generatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if R2_PUBLIC_DOMAIN:
        manifest["baseUrl"] = f"https://{R2_PUBLIC_DOMAIN}"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def do_upload(plan: UploadPlan) -> str:
    """Upload one object. Returns the public URL."""
    if BUCKET_PROVIDER != "r2":
        raise RuntimeError(f"BUCKET_PROVIDER={BUCKET_PROVIDER}; this script only supports r2")
    if not R2_PUBLIC_DOMAIN:
        raise RuntimeError("R2_PUBLIC_DOMAIN is not set; cannot form public URL")

    client = _minio_client()
    client.put_object(
        R2_BUCKET_NAME,
        plan.object_key,
        BytesIO(plan.payload),
        length=len(plan.payload),
        content_type=plan.content_type,
        metadata={"Cache-Control": CACHE_CONTROL_IMMUTABLE},
    )
    return f"https://{R2_PUBLIC_DOMAIN}/{plan.object_key}"


def iter_sources(single: Path | None, batch_dir: Path | None) -> list[Path]:
    if single:
        return [single]
    if batch_dir:
        return sorted(p for p in batch_dir.iterdir() if p.is_file() and not p.name.startswith("."))
    return []


def resolve_manifest_key(
    *,
    explicit_key: str | None,
    name_template: str | None,
    src: Path,
) -> str:
    if explicit_key:
        return explicit_key
    if name_template:
        return name_template.format(stem=src.stem, name=src.name, ext=src.suffix.lstrip("."))
    return src.stem


def main() -> int:
    ap = argparse.ArgumentParser(description="Upload static assets to R2 and update the asset manifest.")
    ap.add_argument("source", nargs="?", help="Single file to upload (omit with --from for batch mode)")
    ap.add_argument("--from", dest="from_dir", help="Directory to batch-upload (non-recursive)")
    ap.add_argument("--prefix", default="static/", help="Object-key prefix (default: static/)")
    ap.add_argument("--key", help="Explicit manifest key for single-file mode (e.g. video.demo)")
    ap.add_argument("--name-template", help='Template for batch manifest keys, e.g. "music.{stem}"')
    ap.add_argument("--manifest", required=True, help="Path to assets.json (created if missing)")
    ap.add_argument("--compress", dest="compress", action="store_true", default=True)
    ap.add_argument("--no-compress", dest="compress", action="store_false")
    ap.add_argument("--hash-name", dest="hash_name", action="store_true", default=True)
    ap.add_argument("--plain-name", dest="hash_name", action="store_false")
    ap.add_argument("--overwrite", action="store_true", help="Re-upload even if manifest entry with same hash exists")
    ap.add_argument("--dry-run", action="store_true", help="Show plan without uploading")
    args = ap.parse_args()

    manifest_path = Path(args.manifest).resolve()
    manifest = load_manifest(manifest_path)

    single = Path(args.source).resolve() if args.source else None
    batch_dir = Path(args.from_dir).resolve() if args.from_dir else None

    if single and batch_dir:
        print("error: pass either a positional source OR --from, not both", file=sys.stderr)
        return 2
    if batch_dir and not batch_dir.is_dir():
        print(f"error: {batch_dir} is not a directory", file=sys.stderr)
        return 2
    if single and not single.is_file():
        print(f"error: {single} is not a file", file=sys.stderr)
        return 2
    if batch_dir and not args.name_template and not args.key:
        print("error: --from requires --name-template (e.g. 'music.{stem}')", file=sys.stderr)
        return 2

    sources = iter_sources(single, batch_dir)
    if not sources:
        print("error: no sources found", file=sys.stderr)
        return 2

    print(f"[plan] bucket={R2_BUCKET_NAME}  domain={R2_PUBLIC_DOMAIN or '(unset)'}  files={len(sources)}")
    print(f"[plan] compress={args.compress}  hash-name={args.hash_name}  dry-run={args.dry_run}")

    uploaded = 0
    skipped = 0
    total_in = 0
    total_out = 0

    for src in sources:
        manifest_key = resolve_manifest_key(
            explicit_key=args.key if single else None,
            name_template=args.name_template,
            src=src,
        )
        try:
            plan = prepare_file(
                src,
                manifest_key=manifest_key,
                prefix=args.prefix,
                compress=args.compress,
                hash_name=args.hash_name,
            )
        except Exception as e:
            print(f"  [!] {src.name}: {e}", file=sys.stderr)
            return 1

        total_in += plan.original_size
        total_out += len(plan.payload)

        existing = manifest["assets"].get(manifest_key)
        existing_key = existing.get("url", "").split("/")[-1] if existing else None
        target_key = plan.object_key.split("/")[-1]

        if existing and existing_key == target_key and not args.overwrite:
            print(f"  [=] {manifest_key:40s} unchanged ({target_key})")
            skipped += 1
            continue

        src_mb = plan.original_size / 1024 / 1024
        out_mb = len(plan.payload) / 1024 / 1024
        ratio = (len(plan.payload) / plan.original_size) if plan.original_size else 1.0
        print(f"  [{'·' if args.dry_run else '+'}] {manifest_key:40s} {src.name:28s} "
              f"{src_mb:6.2f}MB -> {out_mb:6.2f}MB ({ratio*100:5.1f}%)  key={plan.object_key}")

        if args.dry_run:
            continue

        url = do_upload(plan)
        manifest["assets"][manifest_key] = {
            "url": url,
            "type": plan.content_type,
            "size": len(plan.payload),
            "originalSize": plan.original_size,
            "source": src.name,
        }
        uploaded += 1

    if not args.dry_run:
        save_manifest(manifest_path, manifest)

    total_in_mb = total_in / 1024 / 1024
    total_out_mb = total_out / 1024 / 1024
    print(f"\n[done] uploaded={uploaded}  skipped={skipped}  "
          f"bytes_in={total_in_mb:.2f}MB  bytes_out={total_out_mb:.2f}MB")
    if args.dry_run:
        print("[done] dry-run — no uploads performed and manifest not written")
    else:
        print(f"[done] manifest: {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
