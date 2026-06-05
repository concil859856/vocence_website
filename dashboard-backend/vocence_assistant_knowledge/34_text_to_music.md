# Text-to-Music

Text-to-Music generates an original track from a prompt. Describe the genre, mood, instruments, BPM, and vocal style — for example "lo-fi, piano, soft drums, vinyl crackle, 75 bpm, chill, mellow, warm, instrumental". Optionally provide lyrics, choose a duration and audio format, pick a quality mode, and generate. The track plays in the result panel and is saved to History and Playbooks. Open it at vocence.ai/studio/music. Each generation costs 50 credits, flat across all modes and qualities.

# Quality modes — Fast, Balanced, Max

Each music generation runs in one of three quality modes that trade off speed against fidelity. Fast mode finishes the quickest (typically around a minute) at 27 inference steps and supports tracks up to 400 seconds long. Balanced mode is the default — it uses 60 inference steps for clearly higher fidelity than Fast and supports tracks up to 300 seconds, taking roughly one to two minutes per render. Max mode is the highest-fidelity option at 120 inference steps, supports tracks up to 200 seconds, and typically takes two to four minutes.

The duration cap shrinks as quality goes up because the model spends more compute per second of audio in higher modes — capping length keeps every job inside the same wall-clock budget. If you switch quality mode after setting a long duration, Studio automatically clamps the duration down to whatever the new mode allows so you never accidentally submit a job that would be rejected.

# Genre presets

Studio has eight genre presets, each with a curated prompt and a starter lyric template: Upbeat Pop (disco-flavored), Hard Rock, Street Rap (drill-style), Club EDM (house), Smooth Jazz, Orchestral, Chill Lo-fi, and Soulful R&B. Click a preset to populate both the prompt and the lyrics with a sensible starting point, then edit either to taste. Once you've typed your own lyrics or generated them with AI, swapping genres only updates the prompt — your lyrics are protected from being overwritten.

# AI lyric generation

There's a "Generate lyrics with AI" button that calls a hosted LLM to write structured lyrics from a short brief. The output uses lyric structure tags ([verse], [chorus], [bridge], [outro], etc.) so the music model can plan the song's structure. Once AI lyrics are generated, they're treated as user-edited and protected from genre swaps. The lyric generation itself is free — only the music generation costs credits.

# Lyric structure tags

Lyrics use simple bracketed structure tags to mark sections: [verse], [chorus], [bridge], [intro], [outro], [pre-chorus], [hook], [break], [end], [solo], and [inst] (for instrumental sections). Lines without a tag are treated as a single section. You don't have to use them — instrumental tracks can leave the lyrics field blank entirely — but tagging usually produces more coherent songs.

# Instrumental mode

Toggle the instrumental switch to lock the lyrics field to [inst] and produce a vocal-free track. Useful for backing tracks, scoring, ambient pieces, or any case where you want music without singing.

# Audio format

Output format options are WAV, MP3, OGG, and FLAC. WAV is the default and gives the best fidelity at the cost of file size; MP3 trades size for slight quality loss; FLAC is lossless-compressed and useful when you want a smaller file than WAV but no quality loss.

# Music modes

Studio supports several music modes beyond plain Text-to-Music. Audio-to-Audio (Style Transfer) takes an existing clip and reapplies a new prompt to it. Retake produces a fresh take from the same prompt with a different seed. Repaint regenerates a section of an existing track. Edit modifies a section while keeping the rest. Extend pushes an existing track past its current end. Some of these modes are still rolling out — the UI flags any that are not yet enabled. All cost the same 50 credits per generation when active.

# Advanced parameters

The Advanced panel exposes the underlying generation parameters for power users: inference steps (1-200, default set by quality mode), guidance scale (default varies by mode — Fast 12, Balanced 15, Max 18), guidance interval (0-1, default 0.5), minimum guidance scale, omega scale, scheduler type (Euler, Heun, Pingpong), CFG type (APG, CFG, CFG Star), ERG flags for tag/lyric/diffusion, manual seeds for reproducibility, and a LoRA selector for style adapters. Most users never need these — the quality-mode defaults are tuned for typical use — but they're there if you need precise control.

# Random duration

Set duration to -1 to let the model pick its own length based on the prompt and lyrics structure. Useful when you want the model to decide where the song ends naturally rather than forcing a hard cap. The result still respects the quality mode's max — random duration won't blow past the 400/300/200 second ceiling for Fast/Balanced/Max.

# Music cost

Every music generation costs 50 credits, regardless of mode, quality tier, or duration. Failed generations are auto-refunded.

# Best practices — writing music prompts that produce good tracks

Front-load the genre. The first few words of the prompt set the strongest signal — "lo-fi hip-hop, dusty piano, soft drums…" is far easier for the model to grip than "a soft, slightly nostalgic track that sounds like…". Lead with the genre name, then add the mood and instrument list, then BPM and vocal style.

Name specific instruments, not abstract textures. "Slap bass, hi-hats, vinyl crackle, warm Rhodes piano" is much more directive than "rich textures and atmospheric layers". The model has strong handles for instrument names and weak handles for vibe poetry. If you're unsure which instruments fit the genre, lean on the eight presets — each one is curated to be a strong starting point for that style.

Specify BPM when tempo matters. "120 bpm" or "around 90 bpm" gives a real anchor; without it the model picks an arbitrary tempo that may or may not match what you imagined. For genres with strong tempo expectations (drum & bass, lo-fi, ballads) the right BPM is often the difference between "yes that's it" and "close but wrong".

Be explicit about vocals or no vocals. Add "instrumental" if you don't want singing, or specify "female vocals", "male vocals", "soft female harmonies", "spoken word", etc. when you do. Lyrics with structure tags ([verse], [chorus]) drive song structure more reliably than relying on the prompt to imply it.

Pick the right quality mode for the use case. Fast mode is for sketching ideas and iterating on prompts — render fast, listen, tweak the prompt, render again. Balanced is the right default for finished demos and most use cases. Max is worth the wait when the result is going somewhere it'll be heard carefully — a soundtrack, a release, a portfolio piece. Don't render directly in Max while still iterating; you'll burn time waiting for renders that you'd reject anyway.

Use Retake before changing the prompt. If you got a track that's almost right but the model made odd choices, hit Retake before tweaking the prompt. Retake gives a fresh seed on the same prompt — often the second or third take is what you wanted from the first attempt.

For lyrics, use structure tags. Even a simple [verse]/[chorus] split helps the model plan the song's energy curve. The "Generate lyrics with AI" button writes structured lyrics from a brief — useful when you have a vibe in mind but don't want to write the words yourself.

Match duration to the structure you're asking for. A 30-second track with [verse][chorus][bridge][outro] tags will rush through everything; a 4-minute track with one [verse] tag will feel sparse. Either give shorter lyrics for shorter durations or trust longer durations to space out longer lyric structures.

Save the prompts that work. There's no built-in prompt library, but every successful generation lives in History with the exact prompt visible — copy the ones you like into a notes file for reuse. Good prompts compound: a few solid templates per genre will produce better results than starting fresh every time.
