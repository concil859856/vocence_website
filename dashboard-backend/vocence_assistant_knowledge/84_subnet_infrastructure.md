# Subnet infrastructure — Bittensor, Chutes, Hippius

Vocence's subnet runs on three pieces of infrastructure beyond its own owner API. Bittensor is the chain — used for miner registration, weight assignment, and incentive distribution. Chutes (chutes.ai) is the model deployment platform — miners deploy as Chutes, and validators call those Chutes when running evaluation. Hippius is the S3-compatible storage layer used for corpus audio and validator evaluation samples.

# Owner API

The owner API is a centralized service operated by the Vocence team. It maintains the valid-miner list (filtering out malformed wrappers and blocklisted hotkeys), publishes the active-validator list, accepts evaluation submissions from validators, and serves metrics and dashboard data. Validators pull from this API at the start of every evaluation cycle. The owner API does NOT score miners directly — scoring happens on validators using the public evaluation pipeline, and the global consensus algorithm aggregates across them.

# Public dashboard

The public dashboard at vocence.ai/dashboard is read-only and shows live network state — totals, validator activity, miner ranking, and the most recent global scoring snapshot. The detailed evaluations view is at vocence.ai/dashboard/evaluations. No login is required to view the dashboard. It's the easiest way to see what's happening on the network without setting up a Bittensor wallet or running validator code yourself.
