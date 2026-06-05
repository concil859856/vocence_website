# Voice Cloning

Voice Cloning reproduces the voice in a reference clip saying new text. You give the model a short reference audio of someone speaking, optionally provide its transcript (Studio will transcribe it for you if you don't), then type the target text — what you want the cloned voice to say — and click generate. The result is a WAV file in the cloned voice. Open it at vocence.ai/studio/cloning.

# Reference clip requirements

The reference clip must be between 5 and 20 seconds long. Anything shorter doesn't give the model enough voice characteristics; anything longer doesn't help and just wastes upload time. The clip should be clean speech — minimal background noise, no music, no overlapping voices. Supported formats are WAV, MP3, OGG, and FLAC, the same set the rest of Studio accepts.

# Target text limit

The target text — what you want the cloned voice to say — can be up to 2,000 characters per request. That's a much larger limit than the 300 characters TTS allows, since cloning is the right tool when you have a longer script and need it in a specific voice. Long target text is split internally into sentence-level chunks and rendered, then concatenated.

# Reference transcript

Optionally, you can provide the transcript of your reference clip. If you skip it, Studio runs a quick STT pass on the clip and uses that as the reference transcript — there's no extra credit charge for that auto-transcription, it's bundled into the 50-credit cost. Providing your own transcript helps when the reference audio is noisy, when the speaker has an accent the auto-STT might misread, or when you want exact spelling for proper nouns.

# Consent — every time

Studio shows a consent modal before every voice clone, not just the first one. The modal asks you to confirm you have the right to clone the voice in your reference clip. Click Continue to proceed; click Cancel to back out. There's no "don't show this again" checkbox by design — voice cloning is high-risk for misuse and the per-clone confirmation is intentional friction.

# Voice Cloning consent rules

You may only clone voices for which you have permission — your own voice, voices you have explicit, documented consent to use, or voices clearly licensed for synthesis. Cloning a real person without their consent is forbidden, including public figures and celebrities. Vocence may remove content and suspend accounts for unauthorized cloning. This is the most common reason accounts get suspended, so take it seriously.

# Voice Cloning cost and output

Each Voice Cloning generation costs 50 credits, flat. There is no extra fee for the auto-transcription of the reference clip. Output is WAV, played in the result panel and saved to History. Failed generations are auto-refunded. Normal-plan audio is retained for 7 days; Premium audio is kept indefinitely.

# Best practices — what makes a great clone

The reference clip is everything. Aim for clean, isolated speech recorded in a quiet room — no music behind it, no overlapping voices, no harsh reverb. A phone-call recording rarely sounds as good as a clip from a podcast, audiobook, or voice memo recorded with a decent microphone. If your clip has noise, denoise it before uploading; the model will faithfully reproduce noise it hears in the reference.

Pick a clip that captures the voice's natural range. A monotone "hello, this is a test" gives the model very little to work with. A clip with normal expression — questions, statements, a couple of different emotions — clones much better. The 5–20 second window is enough; aim for the upper end (12–20s) when you can, since more sample gives more voice information.

Match the reference language to the target text language. Voice cloning quality drops sharply when the reference is in one language and the target is in another. If you need a voice that speaks multiple languages, record (or find) a clean reference in each target language.

Provide your own reference transcript when the speaker has an accent, when the audio is noisy, or when the reference includes proper nouns the auto-STT might mishear. The auto-transcription is good but not perfect, and a wrong transcript subtly shifts the cloned prosody. Manual transcripts cost nothing extra and consistently improve quality on tricky inputs.

Write the target text the way you want it spoken — same punctuation, pacing, and prosody rules as TTS apply. Long target text gets internally chunked at sentence boundaries, so end your sentences cleanly with periods to give the model good split points. Avoid a single 2,000-character paragraph with no punctuation; the model will guess where to breathe and the result usually feels off.

For repeated use of the same voice, save the reference clip somewhere durable. Voice Cloning doesn't store reference clips between requests — every clone re-uploads the reference. If you're cloning the same voice many times across sessions, keep the WAV file and reuse it; or, if it fits the use case, use Voice Design to create a similar-sounding voice once and save it to My Voices for instant reuse.

If you have permission to use someone's voice but don't have a clean recording, ask them to record a 15-second clip following a script that exercises range — a sentence, a question, a statement with mild emotion. Twenty seconds of clean targeted recording beats two minutes of compressed phone audio every time.
