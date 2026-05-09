# Voice Design

Voice Design lets you create a brand-new voice by describing it in plain English — for example "warm female narrator, calm, slightly raspy, 30s, professional". An LLM revises your description into a tighter spec, then Studio generates two short audio previews (an A/B pair) so you can compare. Pick the one you prefer and save it. Saved voices live in My Voices and can be used to generate new speech anytime. Open it at vocence.ai/studio/voice-design.

# How the A/B preview works

You type a description (minimum 4 characters; longer descriptions usually produce better results). When you click preview, two things happen in parallel: the LLM rewrites your description into a refined voice instruction, and Studio renders two short sample lines — one using your raw description and one using the refined version. Both samples speak the same 6–7 word script so you can compare apples-to-apples. Pick whichever sounds closer to what you wanted.

# Voice description tips

Good descriptions name the voice qualities you care about: gender, approximate age, mood, accent, pace, vocal texture (warm, raspy, breathy, clean). For example: "young female, bright and cheerful, slightly nasal, fast-paced, American". Bad descriptions are too vague ("a nice voice") or contradictory ("calm and energetic"). The LLM rewrite step usually rescues vague inputs, but a sharper input gets a sharper preview.

# Saving a voice

After you preview, click Save and give the voice a name (up to 20 characters). The saved voice appears in My Voices. You can preview it from there, generate new speech with it (25 credits per generation, same as TTS), and delete it when you no longer want it. Saving itself has no extra credit cost beyond the preview you already paid for.

# Voice Design cost

Each A/B preview costs 120 credits. That covers both samples — there's no double charge for getting two variants. Saving the chosen voice has no additional fee. Generating new speech later from a saved voice costs 25 credits per generation, the same as a normal TTS request.

# Voice Design limits

The Normal plan allows up to 5 saved custom voices. The Premium plan removes that cap entirely — Premium users get unlimited custom voices. If you hit the cap on Normal, delete a voice to free up a slot, or upgrade to Premium for unlimited.

# Voices are read-only once saved

Saved voices are not editable — the design instruction is captured at save time and locked in. To "edit" a voice, design a new one with the tweaked description and delete the old one. This keeps every saved voice deterministic — it always sounds the same when you generate from it.

# Best practices — how to design a voice you'll actually want to keep

Lead with the dominant trait. Whatever matters most about the voice should come first in your description: gender, then age, then mood. "Young female, bright and warm, late twenties, conversational pace" lands more reliably than "conversational and bright, female, late twenties, warm".

Name vocal textures explicitly. Words like "raspy", "breathy", "smooth", "nasal", "gravelly", "resonant", "thin", "rich" all do work. The model has clear handles for those terms. Vague mood words like "interesting" or "nice" don't.

Include pace and energy. "Slow", "measured", "fast-paced", "energetic", "deliberate" all change how the voice paces sentences. Without a pace cue, you'll get the model's default pacing — usually mid-tempo — and you might re-render trying to fix something the description never asked for.

Include accent if it matters. "American", "British (received pronunciation)", "Southern US", "Australian", "Indian English" — be specific. The model picks an arbitrary accent if you don't specify one, and the same description rendered twice may pick different accents.

Don't contradict yourself. "Warm and harsh", "young and gravelly", "fast and lazy" produce muddy results. The LLM rewrite step does its best to resolve contradictions but the better path is to pick which trait actually matters.

Listen to both A and B. The two preview samples come from your raw description and the LLM-refined version — they often sound subtly different. Pick the one closer to what you wanted, even if both are usable. Don't autosave the first one out of habit.

Save with descriptive names. The 20-character name limit is small; use it for what you'll search for later. "Narrator-Warm-F" is more useful than "Voice 1" three months from now when My Voices has a dozen entries.

Iterate cheaply by listening, not redesigning. If a saved voice doesn't sound right when you actually use it for content, the cheap fix is generating new speech (25 credits) with different text or punctuation, not redesigning the voice (120 credits). The voice itself rarely changes between previews and full renders — usually the issue is text-side.
