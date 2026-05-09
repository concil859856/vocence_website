# Speech-to-Text (STT)

Speech-to-Text transcribes an audio clip into written text. Two ways to provide audio: upload a file, or record directly in the browser. Open it at vocence.ai/studio/stt. Each transcription costs 20 credits regardless of audio length.

# Audio input — upload

The upload field accepts WAV, MP3, OGG, and FLAC files. Maximum file size is 50 MB per upload — that's enough for roughly an hour of average-bitrate audio in most formats. Larger files need to be trimmed or compressed before uploading. Failed transcriptions (including format-rejected uploads) are auto-refunded.

# Audio input — in-browser recording

The in-browser recorder is capped at 3 minutes (180 seconds) per recording — long enough for memos, voice notes, and short interviews. For anything longer, record outside the browser and upload the file (which has the larger 50 MB cap). The recorder shows a live waveform and a stop button while recording.

# Language

You can leave the language as auto-detect or pick a specific language. Auto-detect works well for clear speech in any major language and is the right choice when you're unsure. Setting the language explicitly can help on noisy audio or when the speaker is mixing languages and you want one in particular to be the target.

# Result fields

The result panel shows the transcript, the detected language, the audio duration in seconds, and a latency value (how long the model took to transcribe). You can copy the transcript with one click, download it as a text file, and the entry is saved to History.

# STT cost

Each Speech-to-Text generation costs 20 credits, flat — that includes the 50 MB upload path and the 3-minute browser recording path. The cost does not scale with audio length within those caps. Failed transcriptions are auto-refunded.

# Best practices — getting accurate transcripts

Quiet audio transcribes far better than noisy audio. If you can pre-clean the recording (remove hum, hiss, room noise) it pays off in transcription accuracy more than any other single step. Free tools like Audacity and online denoisers handle most home-recording noise.

Set the language explicitly when the speaker is mixing languages or has a strong accent. Auto-detect does well on clear monolingual speech but can pick the wrong language on the first few seconds and then struggle to recover. If you know it's English, say so.

For long-form audio, upload as a file rather than recording in the browser. The browser cap is 3 minutes; uploads go up to 50 MB which usually covers an hour of average-bitrate audio. Splitting a long recording into 3-minute browser chunks costs more credits and produces seam artifacts at chunk boundaries.

Trim silence at the start and end. Every second of silence is a second the model has to decide is silence and not garble — usually fine, but sometimes the model hallucinates "um" or "you know" into long pauses. Trimming silence is free quality.

Split distinct speakers into separate transcriptions when you can. The model returns one transcript per request without speaker labels. If you need speaker diarization, give it one speaker at a time and label the results yourself, or do the split in your audio editor before uploading.

If the transcription is consistently wrong on a specific name or term, you've found a model limitation that no setting will fix. Note the wrong word and find-replace it in the transcript afterward. This is faster than re-running with different settings.
