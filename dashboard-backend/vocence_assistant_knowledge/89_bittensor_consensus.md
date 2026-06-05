# Yuma Consensus — what it is

Yuma Consensus is the algorithm Bittensor uses to combine the weights all validators in a subnet set on miners into a single network-wide consensus score per miner. Validators each independently score the miners they observe and submit those scores on-chain as "weights" — a vector of values, one per miner, indicating how good each miner is. Yuma then aggregates those vectors across all active validators into a final consensus weight per miner that determines how emissions are distributed.

The intuition behind Yuma is simple: validators that broadly agree with the rough majority get paid; validators way off in left field get less weight in consensus and earn less. This makes the network resilient to a small number of malicious or buggy validators — they can't overwrite the consensus, and they pay an opportunity cost for being wrong. It also stops legitimate validators from being penalized for honest disagreement at the margins, since the algorithm is robust to noise rather than punishing every deviation.

# Stake-weighted aggregation

A validator's influence on consensus is proportional to the TAO stake bonded behind their hotkey — their own stake plus delegations from holders. More stake means their score vectors carry more weight. This aligns incentives: people put their TAO behind validators they trust to score honestly, and validators that misbehave lose delegators (and thus consensus influence) over time.

Vocence's subnet adds a refinement: when aggregating per-miner win rates across validators, Vocence uses sqrt(stake) weighting. The square-root softens the dominance of the very largest stakers, so a single mega-staked validator can't unilaterally swing consensus on Subnet 78. This is a subnet-specific design choice; not every subnet uses sqrt-weighting.

# Tempo — the weight-setting cycle

A "tempo" is the per-subnet cycle on which weights are aggregated and emissions distributed. Each subnet picks its own tempo. Vocence's tempo is 150 blocks, which is roughly 30 minutes (since Bittensor blocks are 12 seconds each). At the end of each tempo, the consensus algorithm runs, weights are finalized, and emissions for that cycle are paid out.

A short tempo means faster updates and more responsive ranking, but also more on-chain weight-setting traffic. A longer tempo gives more time to accumulate reliable evaluation data per cycle. 150 blocks is a middle-of-the-road choice for Vocence — long enough that each cycle's evaluations are statistically meaningful, short enough that the leaderboard reacts to new miners within hours, not days.

# Bonds — long-term reputation

Beyond per-cycle weights, Bittensor tracks "bonds" — a longer-running record of which validators have historically scored which miners highly. Bonds smooth out reputation across cycles so a miner that's been consistently good doesn't lose all its standing on a single bad cycle, and a validator that's been consistently honest can't be cheated by a one-tempo coordinated attack. Bonds decay over time but provide stability: brand new actors can't immediately game consensus because they have no bond history.

# What "winner-take-all" means on Subnet 78

Vocence's subnet uses a winner-take-all design within each tempo: only one miner receives weight per cycle. Other subnets distribute weights more broadly across many miners. Winner-take-all on Vocence is a deliberate choice — it concentrates rewards on the actual best performer, removes ambiguity about who's currently "best", and forces miners to genuinely beat the leader rather than being paid for being mid-pack. If no candidate beats the base model by the required margin, weight goes to the burn key (UID 0) and emissions for that cycle are burned.

# Validator effort and accuracy

Validators don't just submit weights — they have to actually run the evaluation pipeline to produce credible scores. On Vocence, that means downloading source audio from a corpus, running GPT-4o-audio to extract transcription and voice traits, querying every active miner's /speak endpoint, scoring each output via the AudioJudge, and aggregating the results. A validator that submits weights without doing the work would diverge from honest validators and earn less in consensus. Vocence requires validators to upload their evaluation samples to a public Hippius bucket — that way other validators (and curious observers) can audit their work. There is no "trust me" path; the evidence is on the wire.

# How a miner gets to first place on Subnet 78

To earn rewards on Vocence, a miner has to be eligible and beat every earlier eligible miner by a 2% margin on global win rate. Eligibility requires being evaluated by at least three distinct active validator buckets and having more than 40 evaluations across them. Tie-breaks favor higher win rate, then more validator coverage, then more weighted evaluations, then earliest commit, then lexicographically smaller hotkey. The base model is always the floor — newcomers must beat it, or rewards burn.
