# Subnet winner selection — global consensus

As of v0.1.2, scoring is global across all active validator buckets, not per-validator. Each validator reads recent evaluation windows from every active validator's bucket via shared read-only credentials. Per-hotkey win rates are aggregated across validators using sqrt(stake) weighting. A miner is eligible only if it has more than 40 evaluations in at least 3 distinct active validator buckets — this prevents a single validator from anointing a winner alone.

# Eligibility and ordering

Once eligible, miners are ordered by commit block (earliest first). The base model is always first with a virtual commit block of 1000. A candidate wins only if it beats every earlier eligible miner by at least a 2% margin on global win rate. Tie-breaks go in this order: highest global win rate, then most validator appearances, then most weighted evaluations, then earliest commit, then lexicographically smaller hotkey.

# Winner-take-all and burn

Winner selection is winner-take-all — only one miner receives weight each cycle. A "cycle" is 150 blocks, roughly 30 minutes. If no miner qualifies — e.g. no candidate beats the base model by the 2% margin — weight 1.0 is set on UID 0 (the burn key) and all incentives for that cycle are burned rather than distributed. This keeps the network honest: the only way to earn is to actually beat the bar.

# Base model protocol

The owner deploys a reference base model that is never committed on-chain through the normal commit flow. Instead it's injected with a fixed early commit block (1000) so it sits at the top of the eligibility-by-commit-block ordering. Miners must beat the base model's win rate by the 2% threshold margin to displace it. This prevents a miner from simply re-uploading or copying the base model and collecting rewards for free.
