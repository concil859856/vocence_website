# Text-to-Speech (TTS)

Text-to-Speech turns short text into spoken audio. The hard input cap is 300 characters per request — that's a deliberate choice to keep latency low and quality consistent. For longer scripts, split them into multiple generations or use the Developer API which handles longer payloads. Open it at vocence.ai/studio/tts.

# How a TTS request works

You provide three things: the text content (up to 300 characters), a style — either picked from the preset list or written as a free-form description — and a voice. Click generate, the request goes to the active miner on Subnet 78, and the audio plays in the result panel within a few seconds. The output is a WAV file, downloadable from the result panel and saved to History automatically.

# Style presets

There are 13 curated style presets in the picker: Neutral Male, Neutral Female, Urgent Support, Friendly AI Assistant, Dragon Warrior, Dark Villain, Anime Hero, Military Commander, Narrator/Trailer, Cyberpunk AI, Orc/Monster, Viking, and Little Girl. Pick one from the dropdown for a one-click style, or skip the dropdown and write your own free-form description like "old British professor, slow pace, slightly weary". Custom descriptions feed the same model as the preset names — there's no quality difference between picking a preset and describing one yourself.

# TTS cost and limits

Each TTS generation costs a flat 25 credits, regardless of how short or long the text is, as long as it fits in the 300-character limit. The style description does not bill separately; the 25 credits cover the whole call. Failed generations are auto-refunded — you only pay for successful renders.

# Output and storage

Output is WAV. The audio is stored on a fast CDN and accessed via a short-lived signed URL — that's why old audio links from outside Vocence sometimes stop working: the URL expired even though the file is still there. Replays from inside Studio always fetch a fresh URL automatically. Normal-plan audio is retained for 7 days; Premium audio is kept indefinitely.

# Model routing

Studio routes each TTS request to the current top miner on Subnet 78, with the top three miners shown as selectable options when the model selector is exposed. The default ("auto") picks the highest-ranked model — generally what you want unless you're specifically testing a different one.

# Best practices — how to get great TTS results

Write the text the way you want it spoken. Punctuation steers prosody more than people expect: a period gives a real pause, a comma a small one, a question mark lifts the end of the sentence, an em-dash creates a thoughtful break, ellipses slow the pace. If a line should be emphatic, end it with an exclamation mark. If it should sound natural, write conversational sentences, not telegraphic fragments — "Hey, glad you could make it." sounds better than "Hello user welcome".

Spell tricky words phonetically when the model mispronounces them. Numbers, acronyms, and brand names are common offenders. "API" often reads as a single word; spell it "A P I" if you want each letter. "2024" might read as "two thousand twenty-four" or "twenty twenty-four" depending on context — write it whichever way you want it spoken. Foreign names usually sound better in their phonetic anglicization than in their native spelling.

Pick the right style preset for the voice you want, but don't fight it. The preset names — Anime Hero, Dark Villain, Military Commander — are strong style anchors; if you want a calm professional read, don't pair it with the Dragon Warrior preset. For voices that don't match any preset, skip the dropdown and write your own description like "warm female narrator, slow pace, soft tone, 30s, professional". Free-form descriptions are usually better than picking a preset that's only roughly right.

Keep each request close to one paragraph. The 300-character cap is a quality choice, not a limitation — long monologues sound more natural when split into multiple shorter renders that flow into each other. For longer scripts, generate each paragraph separately and stitch them in your audio editor; the seams are nearly invisible if the style description is consistent.

Iterate on style, not text. If a render isn't quite right, change the style description before changing the text. The model is responsive to small style tweaks — adding "slightly slower" or "warmer tone" to the description often fixes pacing or feel without re-engineering the whole prompt. Save the credits you'd spend rewriting text and spend them tweaking style.

Listen on the playback you'll actually use. Studio plays through your browser at default volume; that often masks issues that show up when the audio is mixed under music or voiced through a phone speaker. If the output is going somewhere specific, audition it in that context before deciding it's done.

For longer scripts, consider Voice Cloning instead. The 300-character TTS cap is tight for narration; Voice Cloning accepts up to 2,000 characters of target text per request, and you can provide a reference clip in any voice you have rights to (including a voice you generated yourself with TTS, then used as the reference). That gives you longer continuous renders without stitching.
