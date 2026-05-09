# Bittensor in plain English

Bittensor is a decentralized AI network. Think of it as an open marketplace where anyone in the world can plug in an AI model, get scored on how well it performs a specific task, and earn rewards in the network's native token, TAO. There is no central company deciding which model is "best" — the network does it through measurable evaluation, and the best-performing models earn the most.

The whole thing is built on its own blockchain. The chain coordinates who's participating, distributes rewards, and records the scores that validators submit. The actual AI work — model inference, training, scoring — happens off-chain on hardware that miners and validators run themselves. The chain just keeps the bookkeeping honest.

# Subnets — specialized AI markets

A subnet is a specialized market on Bittensor focused on one task. Each subnet defines what miners must do, how validators score them, and what counts as "good". One subnet might focus on large-language-model inference, another on image generation, another on prediction markets, another on code completion, another on storage. Vocence is Subnet 78 — focused on voice intelligence (Prompt-based Text-to-Speech, with STT, voice cloning, and music coming next).

There are roughly a hundred subnets active on the network as of 2026, ranging from foundational research subnets (like the original LLM subnets that pre-date everything else) to highly specialized ones for niche tasks. The network keeps growing — anyone can register a new subnet by paying a registration fee in TAO, designing the incentive mechanism, and standing up the validator pipeline.

# Miners and validators

In every subnet, two roles run the work. Miners deploy AI models and expose them to the network for evaluation. Validators run the evaluation pipeline — they query miners, score the outputs, and submit those scores on-chain. Both roles need a Bittensor wallet (a hotkey/coldkey pair) and on-chain registration in that subnet.

Miners are paid TAO based on how well their model scores relative to other miners in the same subnet. Validators are paid TAO based on running the evaluation pipeline accurately and consistently — they're rewarded for being honest and active. Validators need to stake TAO (their own or delegated) to validate; the more stake, the more weight their scores carry in consensus. Miners typically don't need to stake — just pay registration and deploy.

# Owners and subnet creators

Each subnet has an owner — the entity that registered it and defines its incentive mechanism, evaluation pipeline, and acceptance criteria. The owner is rewarded a share of the subnet's emissions. Owners typically run their own validators (sometimes one, sometimes more), publish the open-source code that miners and validators use, and maintain the off-chain APIs that coordinate evaluation. For Vocence, the Vocence team is the owner, runs one validator, and does not self-mine.

# Wallets — coldkey and hotkey

Every Bittensor participant has a wallet made of two keys. The coldkey is the long-term key — it owns balances, can transfer TAO, and stays in cold storage. The hotkey is the operational key — it signs the day-to-day on-chain actions like registering on a subnet, setting weights as a validator, or claiming rewards as a miner. Coldkeys can have multiple hotkeys; you'd typically use a separate hotkey per subnet. If a hotkey is compromised the coldkey can rotate it; the coldkey itself you keep offline.

# How rewards flow

Each subnet has its own emission stream. The network mints new TAO over time and routes it to subnets, then within a subnet to miners, validators, and the owner based on weights. Validators set per-miner "weights" on-chain that capture how good each miner is; those weights aggregate into network-wide consensus through Yuma Consensus, and emissions are distributed proportional to the consensus result every "tempo" (the weight-setting cycle for that subnet). Vocence's tempo is 150 blocks, roughly 30 minutes.

# TAO — the token

TAO is Bittensor's native token. It's used to pay for subnet registration, stake into validators, transfer between wallets, and is what miners and validators are rewarded with. Maximum supply is capped at 21 million, mirroring Bitcoin's design. Emissions follow a halving schedule that cuts the issuance rate roughly in half on a four-year cadence — the first halving has already happened. The smallest unit is a "rao" — one TAO equals one billion (10^9) rao. Holders can stake TAO to validators (their own or someone else's) to earn a share of validator emissions in return.

# dTAO — subnet alpha tokens

In 2025 Bittensor moved from a system where root validators set subnet weights centrally to "dTAO" (dynamic TAO), where each subnet has its own "alpha" token. Each subnet's emission is now market-driven: the alpha price (TAO/alpha exchange rate inside an automated market maker pool for that subnet) determines what share of network emissions that subnet earns. If a subnet is highly demanded, its alpha appreciates and its share of emissions grows; if it's underused, the opposite. This made the network more market-driven and gave each subnet a kind of mini-economy of its own. Vocence has its own alpha token tied to Subnet 78.

# Yuma Consensus — the scoring math

Yuma Consensus is the algorithm Bittensor uses to combine the weights all validators set into a single network-wide consensus score per miner. The intuition: validators who agree with the rough majority get rewarded, validators way off in left field get less weight. This makes the network resilient to a small number of malicious or buggy validators — the consensus survives them. Stake-weighted aggregation means a validator's influence scales with how much TAO is staked behind their hotkey. Vocence uses sqrt(stake) weighting when aggregating across validators to soften the influence of the largest stakers.

# Block time and tempos

Bittensor blocks are 12 seconds. A "tempo" is a subnet-level cycle of N blocks during which weights are aggregated and emissions distributed. Vocence's tempo is 150 blocks (about 30 minutes). Other subnets pick different tempos based on how often their evaluation pipeline produces fresh scores.

# Substrate, not Ethereum

Bittensor is built on Substrate — the same blockchain framework Polkadot uses. It's not an Ethereum L2 or a Cosmos chain; it's its own L1 with its own validators (the chain validators, separate from subnet validators) running the consensus protocol. Substrate gives Bittensor the flexibility to define custom on-chain logic for emissions, registrations, and weight-setting that wouldn't be practical on a general-purpose smart-contract chain.

# Origins and stewardship

Bittensor was started by the Opentensor Foundation, the non-profit that stewards the protocol. The two co-founders are publicly known by their pseudonyms Const (Jacob Steeves) and Rao (Ala Shaabana). Both came from machine-learning backgrounds. The earliest research paper, published in 2021, laid out a peer-to-peer "intelligence market" where models reward each other for useful outputs. The Finney mainnet — the version running today — went live in 2023, replacing earlier testnets, and the network has grown from a single LLM subnet to roughly a hundred specialized subnets.

# Where to learn more

For the official docs, see bittensor.com and docs.bittensor.com. For a list of all subnets, see taostats.io. For the Bittensor SDK and CLI, see github.com/opentensor/bittensor. To participate in Vocence specifically — run a miner or validator on Subnet 78 — start at vocence.ai/docs and the open-source repo at github.com/vocence-78/vocence.

# What this means for Vocence end users

If you're just using Studio at vocence.ai to generate audio, you don't need to think about Bittensor at all — Vocence routes your request to the best miner behind the scenes and bills you in regular USD-priced credits, not TAO. The decentralized network powers the quality and speed of generation but is invisible to the user. Vocence's job is to make the subnet feel like a clean SaaS product. The Bittensor side becomes interesting only if you want to mine or validate on Subnet 78 yourself, or you're curious about how the model competition under the hood works.
