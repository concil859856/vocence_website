# Subnet configuration values

Key Vocence subnet configuration values: subnet ID is 78 on Bittensor mainnet. Cycle length is 150 blocks, roughly 30 minutes between weight-setting passes. Minimum evaluations to compete is 40 per validator bucket. Minimum validator appearances is 3 distinct active validator buckets. Threshold margin for displacing an earlier eligible miner is 2% on global win rate. Pass threshold for a binary win is 0.9 on the continuous score. Maximum evaluations used for scoring is the most recent 50 per bucket. Maximum on-chain commits per hotkey is 2 (after block 8,081,000). Active-validator window is the last 24 hours of submissions.

# Why these numbers matter

The 40-eval / 3-validator minimum prevents any single validator from anointing a winner — a miner has to be tested across multiple independent validator buckets before it's even eligible. The 2% margin requirement plus the earliest-commit ordering means newer miners can't displace an established winner with a tiny improvement; they have to be measurably better. The winner-take-all design forces all subnet competition into one slot per cycle, concentrating rewards on the actual best performer.
