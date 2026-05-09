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
