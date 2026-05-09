# History

History at vocence.ai/history (also reachable via Studio's left sidebar) is a full log of every generation you've made — TTS, STT, Voice Cloning, Voice Design previews, and Music. For each entry you can replay the audio, download the file, copy the source text or prompt, and see timestamps, credit cost, and the model used.

# Columns shown

Each row in History shows a timestamp (time on top of date), a type badge (TTS / STT / Clone / Voice Design / Music), the content (truncated text or prompt with a copy button), the style or instruction prompt (also copyable), the model and any metadata as small badges, the audio duration with a tiny waveform thumbnail, and action buttons to play, download, or open the dedicated result page.

# Filtering and searching

Filter History by type — Text-to-Speech, Speech-to-Text, Voice Cloning, Voice Design, Music — to see just one feature's output. Filter by date range to narrow to recent items. There's also a text search that matches against the source content and the style prompt, useful when you remember roughly what you typed but not when. Pagination shows 10 items per page with Previous/Next navigation at the bottom.

# Retention

Normal-plan items expire after 7 days — both the database row and the audio file are removed. Premium-plan history never expires; everything you generate stays in your account indefinitely. You can always download any generation to your local machine while it's still in your History — once it expires, the file is gone.

# Audio storage and signed URLs

Generated audio is hosted on a fast CDN and accessed via short-lived signed URLs. The signed URL is fetched fresh whenever you replay or download a track, which is why old audio links from outside Vocence can stop working — the URL has expired even though the file is still there. From inside History, links always refresh automatically. Premium accounts with indefinite retention still get short-lived URLs each time — the underlying file persists, only the URL is short-lived.

# Download format

Downloads use whatever format the generation was rendered in — usually WAV for TTS and Voice Cloning, and the format you picked for Music (WAV, MP3, OGG, or FLAC). The filename includes the generation type and timestamp by default; rename it on your machine after download if you want.

# Replay

The play button starts inline playback in the History row itself. To open a dedicated result page with a fuller view (waveform, full prompt, metadata, share controls), click the row's "view" action. Inline play is fastest; the dedicated page is better when you want to copy the full prompt or share a link to the generation.
