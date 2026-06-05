# Subnet scoring — 9 elements

Each miner output is evaluated on 9 elements with weights summing to 1.0. Script accuracy carries the most weight at 0.30 — measured as word error rate between the requested and actual transcription. Naturalness is 0.15 — a forced-choice between miner output and source audio, judged by GPT-4o. Gender match, speed match, emotion match, and age-group match each weigh 0.10. Pitch match, accent match, and tone match each weigh 0.05.

# Score weights table

The full breakdown of evaluation weights is: script accuracy 0.30 (word-error-rate vs target text); naturalness 0.15 (forced-choice judge vs source); gender match 0.10 (exact match); speed match 0.10 (ordinal scoring); emotion match 0.10 (exact match); age group match 0.10 (ordinal scoring); pitch match 0.05 (ordinal scoring); accent match 0.05 (exact match); tone match 0.05 (exact match). Total weight is 1.0.

# Pass threshold and ranking

A continuous score of 0.9 or higher counts as a binary "win" for that evaluation. The binary win rate is what drives ranking — the continuous score is only used for diagnostics. Models that produce nominally high audio quality but fail to follow the prompt's voice traits will still lose, because failing any of the trait-match dimensions drops the continuous score below 0.9.

# Audio judge

Vocence uses GPT-4o-audio-preview as the judge model. The judge sees the source audio, the miner's output, and the prompt, then produces forced-choice and trait-match scores. Because the judge is itself a frontier model, scoring is robust to surface tricks like loudness boosting that fool simpler metrics.
