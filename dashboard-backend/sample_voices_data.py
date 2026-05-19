"""Server-side mapping for sample voices used by the General TTS subpage.

Two storage modes:
  - REMOTE (CDN): id -> https://audio.vocence.ai/...opus  (older curated voices)
  - LOCAL  (disk): id -> filename under static/sample_voices/  (newer voices)

The clone worker resolves a sample_voice_id by consulting both maps. Local
files are read directly from disk; remote URLs are fetched once and cached.
Mirrors /workspace/vocence_website/app/src/data/sampleVoices.ts.
"""

from __future__ import annotations

from pathlib import Path

# CDN-hosted voices (id -> https URL)
SAMPLE_VOICE_AUDIO_URLS: dict[str, str] = {
    # Voice Design (9)
    "design-aria":   "https://audio.vocence.ai/static/voice-design-audio/aria-430470d4bc.opus",
    "design-aurora": "https://audio.vocence.ai/static/voice-design-audio/aurora-5078be7ccf.opus",
    "design-dante":  "https://audio.vocence.ai/static/voice-design-audio/dante-e98b26eca6.opus",
    "design-ember":  "https://audio.vocence.ai/static/voice-design-audio/ember-09b7e8ef06.opus",
    "design-kai":    "https://audio.vocence.ai/static/voice-design-audio/kai-b82e5df62f.opus",
    "design-luna":   "https://audio.vocence.ai/static/voice-design-audio/luna-446d33fe10.opus",
    "design-marcus": "https://audio.vocence.ai/static/voice-design-audio/marcus-c254472a39.opus",
    "design-rafael": "https://audio.vocence.ai/static/voice-design-audio/rafael-5c7827211c.opus",
    "design-yuki":   "https://audio.vocence.ai/static/voice-design-audio/yuki-e7d5720a09.opus",

    # Character Styles (6, sourced from TTS demos)
    "char-epic-warrior":          "https://audio.vocence.ai/static/tts-demos/epic-warrior-0945938ae3.opus",
    "char-friendly-ai-assistant": "https://audio.vocence.ai/static/tts-demos/friendly-ai-assistant-f4ef72fa75.opus",
    "char-happy-female":          "https://audio.vocence.ai/static/tts-demos/happy-female-e94b404b00.opus",
    "char-little-girl":           "https://audio.vocence.ai/static/tts-demos/little-girl-bc2488be64.opus",
    "char-military-commander":    "https://audio.vocence.ai/static/tts-demos/military-commander-7fe5db0d8d.opus",
    "char-neutral-male":          "https://audio.vocence.ai/static/tts-demos/neutral-male-9e7bce042a.opus",

    # Real voice (1, from clone demos)
    "real-sophia":       "https://audio.vocence.ai/static/clone-demos-audio/sophia-d2ed3e3ab9.opus",
}

# Local-disk voices (id -> filename under static/sample_voices/)
_STATIC_DIR = Path(__file__).resolve().parent / "static" / "sample_voices"
SAMPLE_VOICE_LOCAL_FILES: dict[str, str] = {
    # Deep masculine
    "voc-atlas":    "deep_male.wav",
    "voc-roman":    "deep_male2.wav",
    "voc-vincent":  "deep_male3.wav",
    "voc-maximus":  "deep_male4.wav",

    # Female (general)
    "voc-iris":     "feamle1.wav",
    "voc-camille":  "feamle2.wav",

    # Podcast (female)
    "voc-harper":   "pod_female.wav",

    # Podcast (male)
    "voc-chase":    "pod_male1.wav",
    "voc-lyle":     "pod_male2.wav",
    "voc-theo":     "pod_male3.wav",
    "voc-jasper":   "pod_male4.wav",
    "voc-owen":     "pod_male5.wav",
}


# Human-friendly catalog metadata. Mirrors the labels/descriptions in
# the frontend's app/src/data/sampleVoices.ts. Kept here so the same
# values can be served from the API and rendered in clients without a
# round trip through the website bundle. Update both files together.
SAMPLE_VOICE_METADATA: dict[str, dict[str, str]] = {
    # Local-disk voices
    "voc-atlas":    {"name": "Atlas",    "description": "Deep, commanding male voice"},
    "voc-roman":    {"name": "Roman",    "description": "Rich, classical male tone"},
    "voc-vincent":  {"name": "Vincent",  "description": "Refined, baritone male voice"},
    "voc-maximus":  {"name": "Maximus",  "description": "Bold, authoritative male voice"},
    "voc-iris":     {"name": "Iris",     "description": "Bright, articulate female voice"},
    "voc-camille":  {"name": "Camille",  "description": "Smooth, polished female voice"},
    "voc-harper":   {"name": "Harper",   "description": "Warm, conversational podcast voice"},
    "voc-chase":    {"name": "Chase",    "description": "Energetic, engaging podcast host"},
    "voc-lyle":     {"name": "Lyle",     "description": "Smooth, easy-listening male voice"},
    "voc-theo":     {"name": "Theo",     "description": "Thoughtful, measured male voice"},
    "voc-jasper":   {"name": "Jasper",   "description": "Warm, friendly storytelling voice"},
    "voc-owen":     {"name": "Owen",     "description": "Clear, professional podcast voice"},
    # Voice Design CDN voices
    "design-aria":   {"name": "Aria",   "description": "Bright, energetic female voice"},
    "design-aurora": {"name": "Aurora", "description": "Soft, dreamy female voice"},
    "design-dante":  {"name": "Dante",  "description": "Deep, confident male voice"},
    "design-ember":  {"name": "Ember",  "description": "Warm, soulful female voice"},
    "design-kai":    {"name": "Kai",    "description": "Smooth, friendly male voice"},
    "design-luna":   {"name": "Luna",   "description": "Mysterious, ethereal female voice"},
    "design-marcus": {"name": "Marcus", "description": "Authoritative, mature male voice"},
    "design-rafael": {"name": "Rafael", "description": "Charismatic, expressive male voice"},
    "design-yuki":   {"name": "Yuki",   "description": "Calm, gentle female voice"},
    # Character styles
    "char-epic-warrior":          {"name": "Epic Warrior",       "description": "Heroic, booming battle voice"},
    "char-friendly-ai-assistant": {"name": "Friendly AI",        "description": "Pleasant, helpful assistant voice"},
    "char-happy-female":          {"name": "Happy Female",       "description": "Cheerful, upbeat female voice"},
    "char-little-girl":           {"name": "Little Girl",        "description": "Young, playful child voice"},
    "char-military-commander":    {"name": "Military Commander", "description": "Stern, commanding officer voice"},
    "char-neutral-male":          {"name": "Neutral Male",       "description": "Clear, neutral male narrator"},
    # Real voice
    "real-sophia":   {"name": "Sophia", "description": "Warm, expressive female voice"},
}


def is_known_sample(voice_id: str) -> bool:
    return voice_id in SAMPLE_VOICE_AUDIO_URLS or voice_id in SAMPLE_VOICE_LOCAL_FILES


def get_sample_url(voice_id: str) -> str | None:
    """Returns a remote URL when the voice is CDN-hosted, else None.
    Use ``read_local_sample_bytes`` for local-disk voices."""
    return SAMPLE_VOICE_AUDIO_URLS.get(voice_id)


def get_sample_local_path(voice_id: str) -> Path | None:
    """Returns the on-disk path for a local sample voice, or None."""
    fname = SAMPLE_VOICE_LOCAL_FILES.get(voice_id)
    if not fname:
        return None
    p = _STATIC_DIR / fname
    return p if p.exists() else None


def read_local_sample_bytes(voice_id: str) -> bytes | None:
    p = get_sample_local_path(voice_id)
    if not p:
        return None
    return p.read_bytes()
