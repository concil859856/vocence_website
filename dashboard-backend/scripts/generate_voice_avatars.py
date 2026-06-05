"""One-off generator for sample-voice avatars.

Reads the OpenAI key from /workspace/vocence/.env (OPENAI_AUTH_KEY), then
generates a 1024x1024 portrait for each new local voice via gpt-image-1,
downsizes to 256x256 WebP, and writes them to
``static/sample_voices/<id>.webp``. The frontend surfaces them via the
existing /api/dashboard/sample-voices/<file> static mount.

Run from the dashboard-backend directory:

    venv/bin/python scripts/generate_voice_avatars.py
"""

from __future__ import annotations

import base64
import io
import os
import sys
import time
from pathlib import Path

from PIL import Image
from openai import OpenAI


HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parent
OUT_DIR = BACKEND_ROOT / "static" / "sample_voices"
OUT_DIR.mkdir(parents=True, exist_ok=True)


# Each voice has a distinct subject AND a distinct style suffix (background +
# lighting + framing) so no two portraits feel like siblings. All ages
# strictly 25–40. Lighting is bright across the board.
VOICE_PROMPTS: dict[str, tuple[str, str, str]] = {
    # id: (display name, subject description, scene/style)
    "voc-atlas": (
        "Atlas",
        "an athletic Northern-European man around 33 with very short cropped dark brown hair, a sharp jawline and a clean shave, calm steady blue-grey eyes, wearing a crisp plain white t-shirt",
        "in a clean bright photo-studio, white seamless backdrop, even soft daylight, sharp tight portrait, modern editorial style",
    ),
    "voc-roman": (
        "Roman",
        "a Mediterranean man around 36 with neatly combed wavy dark-chestnut hair, a faint trimmed stubble, warm amber eyes, wearing an unbuttoned navy blazer over a crisp white shirt",
        "soft golden-hour sunlight pouring through a window, warm cream wall background, slightly cinematic, magazine-style portrait",
    ),
    "voc-vincent": (
        "Vincent",
        "an East-Asian man around 30 with neat short black hair and thin-rimmed round glasses, calm thoughtful expression, wearing a heather-light-grey fine-knit turtleneck",
        "minimalist bright background of pale cool blue, very clean diffuse light, modern Apple-keynote style portrait, sharp focus on face",
    ),
    "voc-maximus": (
        "Maximus",
        "a Latino man around 34 with a short cropped beard and short curly black hair, hazel eyes, confident relaxed expression, wearing a sand-beige henley",
        "outdoors on a sunny rooftop, soft blurred sky and light buildings in background, natural midday sunlight, lifestyle photo style",
    ),
    "voc-iris": (
        "Iris",
        "a Scandinavian woman around 27 with shoulder-length straight platinum-blonde hair, bright clear blue eyes, light freckles, soft genuine smile showing slight teeth, wearing a buttery yellow silk blouse",
        "in front of a clean off-white studio backdrop with airy soft daylight, fashion-editorial style, very crisp portrait",
    ),
    "voc-camille": (
        "Camille",
        "a Black woman around 31 with very dark skin, glossy black hair pulled into a sleek low bun, defined cheekbones, elegant subtle makeup with a glossy nude lip, wearing a blush-pink silk top",
        "soft pastel-pink seamless background, bright diffused beauty-shoot lighting, glossy luxury-magazine style portrait",
    ),
    "voc-harper": (
        "Harper",
        "a freckled mixed-race woman around 33 with shoulder-length copper-red wavy hair, warm hazel eyes, big friendly smile with dimples, wearing a soft mint-green knit cardigan",
        "in a sunlit cafe with bright warm window light and a softly blurred bright interior in the background, lifestyle warm-tone photo style",
    ),
    "voc-chase": (
        "Chase",
        "a man around 28 with bouncy light-brown curls, green eyes, mid-laugh expression with a wide bright smile, wearing a vivid orange crewneck sweatshirt",
        "vibrant pop-color studio backdrop in soft coral-orange, punchy clean lighting, energetic youthful brand-portrait style",
    ),
    "voc-lyle": (
        "Lyle",
        "a sun-kissed Australian-looking man around 32 with messy sandy-blond hair tucked behind ears, light stubble, easy half-smile, blue eyes, wearing an open white linen button-down",
        "outdoor coastal background of soft ocean haze and pale sand, golden afternoon sunlight, breezy lifestyle photography style",
    ),
    "voc-theo": (
        "Theo",
        "a Korean-American man around 35 with longer side-swept black hair partly over one eye, no glasses, calm reflective expression, light stubble, wearing a sage-green raglan sweatshirt",
        "indoor scene with soft natural window light and lush green houseplants gently blurred behind, biophilic minimalist apartment style",
    ),
    "voc-jasper": (
        "Jasper",
        "a man around 36 with medium-length wavy chestnut-brown hair, warm hazel eyes, kind friendly closed-mouth smile, neatly trimmed light beard, wearing a mustard-yellow merino sweater",
        "warm sunlit window-front portrait with soft cream curtains gently blurred behind, honey-toned natural light, cozy lifestyle photography style",
    ),
    "voc-owen": (
        "Owen",
        "a South-Asian man around 29 with neatly styled short black hair, warm brown eyes, fresh confident expression, wearing a clean light-blue oxford button-up shirt",
        "pure white studio backdrop, super-clean even bright lighting, polished corporate-headshot style with a modern tech vibe",
    ),
    "voc-nora": (
        "Nora",
        "a Latina woman around 28 with shoulder-length wavy chestnut-brown hair tucked behind one ear, warm brown eyes, soft natural closed-mouth smile, light freckles across the nose, wearing a cream-colored fine-knit sweater",
        "warm cafe interior softly blurred behind, soft window daylight from the side, cozy lifestyle editorial photography style",
    ),
    "voc-sienna": (
        "Sienna",
        "a confident Italian woman around 30 with long loose auburn waves, hazel-green eyes, expressive bright open-mouth smile, wearing a vivid burgundy silk blouse",
        "deep burgundy gradient studio backdrop, bright key light with subtle dramatic falloff, glossy magazine-cover portrait style",
    ),
    "voc-penny": (
        "Penny",
        "a freckled British woman around 27 with chin-length strawberry-blonde hair, sparkling pale-green eyes, joyful natural laughing expression showing slight teeth, wearing a sky-blue cotton sweater",
        "vibrant pale-blue seamless studio backdrop, very bright clean diffused lighting, optimistic friendly brand-shoot style",
    ),
    "voc-quinn": (
        "Quinn",
        "an Irish-American woman around 26 with short choppy dark-brown hair tucked behind one ear, light tan skin, soft natural makeup with a touch of lavender on the lids, big open-mouth laugh, wearing a marigold-yellow t-shirt",
        "bright coral-pink seamless studio backdrop, punchy soft even lighting, upbeat youthful brand-portrait style",
    ),
    "voc-eliza": (
        "Eliza",
        "a poised Eastern-European woman around 35 with sleek shoulder-length jet-black bob hair, sharp dark-blue eyes, elegant subtle makeup with a deep red lip, calm composed expression, wearing a tailored navy blazer over a white shell",
        "clean slate-grey seamless studio backdrop, balanced bright soft lighting, broadcast-quality polished anchor-portrait style",
    ),
    "voc-magnus": (
        "Magnus",
        "a Northern-European man around 38 with a completely shaved head, very short dark stubble across the jaw, calm sharp cool-grey eyes, serious composed expression, wearing a charcoal-grey crewneck t-shirt",
        "neutral light-grey seamless backdrop, very even bright soft studio lighting, premium clean editorial portrait style",
    ),
    "voc-felix": (
        "Felix",
        "a French-Canadian man around 30 with short loose light-brown curls, warm brown eyes, gentle friendly closed-mouth smile with faint dimples, light stubble, wearing a soft moss-green hoodie",
        "cozy bookshelf softly blurred in the background, warm natural daylight from the side, indie-podcast lifestyle photography style",
    ),
    "voc-bennett": (
        "Bennett",
        "an athletic African-American man around 34 with a sharp high-fade haircut and short crisp beard, intense dark-brown eyes, focused passionate expression, wearing a graphite-grey blazer over a black crew t-shirt",
        "brushed steel-grey studio backdrop with a subtle cool blue rim light from one side, bright clean key light on the face, conference-keynote portrait style",
    ),
    "voc-milo": (
        "Milo",
        "a Brazilian man around 27 with messy dark curly hair, warm dark-brown eyes, big toothy laughing expression, smooth tan skin, wearing a vibrant teal short-sleeve button-up shirt",
        "bright tropical-teal seamless studio backdrop, sunny clean even lighting, joyful youthful brand-portrait style",
    ),
}


STYLE_SUFFIX = (
    ". Square portrait, head-and-shoulders only, subject centered and looking toward the camera, "
    "skin tone and details photorealistic, sharp focus on the face, no text, no logos, no watermarks, no extra people"
)


def load_api_key() -> str:
    # Try .env files in order, then fall back to the process environment.
    for env_path in (Path("/workspace/vocence/.env"), BACKEND_ROOT / ".env"):
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            if k.strip() in ("OPENAI_AUTH_KEY", "OPENAI_API_KEY"):
                return v.strip().strip('"').strip("'")
    for k in ("OPENAI_AUTH_KEY", "OPENAI_API_KEY"):
        if os.environ.get(k):
            return os.environ[k]
    raise SystemExit("OpenAI API key not found in /workspace/vocence/.env or dashboard-backend/.env")


def main() -> int:
    api_key = load_api_key()
    client = OpenAI(api_key=api_key)

    args = sys.argv[1:]
    force = False
    if "--force" in args:
        force = True
        args.remove("--force")
    only_ids = set(args)  # optional: restrict to specific voice ids

    targets = (
        [(vid, *VOICE_PROMPTS[vid]) for vid in only_ids if vid in VOICE_PROMPTS]
        if only_ids
        else [(vid, name, subject, scene) for vid, (name, subject, scene) in VOICE_PROMPTS.items()]
    )
    if not targets:
        print(f"no matching voices in: {sorted(only_ids)}")
        return 2

    for vid, name, subject, scene in targets:
        out_path = OUT_DIR / f"{vid}.webp"
        if out_path.exists() and not force and not only_ids:
            print(f"skip {vid}: already exists (use --force to overwrite)")
            continue
        prompt = f"A photorealistic portrait of {subject}, {scene}{STYLE_SUFFIX}"
        print(f"→ generating {vid} ({name})")
        t0 = time.time()
        try:
            resp = client.images.generate(
                model="gpt-image-1",
                prompt=prompt,
                size="1024x1024",
                n=1,
            )
        except Exception as exc:
            print(f"  ✗ {vid} failed: {exc}")
            continue
        b64 = resp.data[0].b64_json
        if not b64:
            print(f"  ✗ {vid}: API returned no b64_json")
            continue
        png = base64.b64decode(b64)
        # Downscale + convert to WebP for the avatar size we actually display
        img = Image.open(io.BytesIO(png)).convert("RGB")
        img.thumbnail((256, 256), Image.LANCZOS)
        img.save(out_path, format="WEBP", quality=88, method=6)
        print(f"  ✓ {vid} → {out_path.name} ({out_path.stat().st_size} B, {time.time() - t0:.1f}s)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
