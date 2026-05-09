# Sample voice catalog — overview

Vocence ships 28 sample voices that work for both Voice Cloning targets and as default voices for in-product features (the floating Vocence Assistant uses one). They cover a broad range of vibes — deep male, warm female, podcast hosts, character voices, and stylized "designed" voices. Pick any of them by name and Studio will route the request to the clone-streaming server with a pre-cached reference clip.

# Voice catalog — male voices

Atlas (deep, commanding male voice). Chase (energetic, engaging podcast host). Dante (deep, confident male voice). Theo (thoughtful, measured male voice). Kai (smooth, friendly male voice). Roman (rich, classical male tone). Maximus (bold, authoritative male voice). Owen (clear, professional podcast voice). Vincent (refined, baritone male voice). Lyle (smooth, easy-listening male voice). Marcus (authoritative, mature male voice). Jasper (warm, friendly storytelling voice). Rafael (charismatic, expressive male voice). Neutral Male (clear, neutral male narrator).

# Voice catalog — female voices

Aria (bright, energetic female voice). Harper (warm, conversational podcast voice). Camille (smooth, polished female voice). Aurora (soft, dreamy female voice). Iris (bright, articulate female voice). Sophia (warm, expressive female voice). Luna (mysterious, ethereal female voice). Yuki (calm, gentle female voice). Happy Female (cheerful, upbeat female voice). Ember (warm, soulful female voice — the default voice for the Vocence Assistant).

# Voice catalog — character voices

Friendly AI Assistant (pleasant, helpful assistant voice). Epic Warrior (heroic, booming battle voice). Little Girl (young, playful child voice). Military Commander (stern, commanding officer voice). These are stylized character voices designed for narrative and roleplay use cases — TTS pages have them as named presets.

# How to use a sample voice

In Studio, sample voices appear in pickers across General TTS, Voice Cloning, and Agent setup. Pick one by name and Studio handles routing — it pulls the pre-cached reference clip and pre-transcribed reference text from the backend, so you don't pay the latency of a fresh STT pass on first use. The 28 voices are a fixed curated set; the catalog is in app/src/data/sampleVoices.ts and the backend mirror is sample_voices_data.py.
