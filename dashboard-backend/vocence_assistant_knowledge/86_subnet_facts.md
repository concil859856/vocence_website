# Important subnet facts

The Vocence team does not self-mine. All validators score independently and separately; the owner runs only one validator. Self-mining is structurally impossible with the architecture: the global consensus algorithm requires evaluations from at least 3 distinct active validator buckets before a miner is eligible for rewards, and validators are operated by independent parties. The owner API can publish the valid-miner list and the base model, but it cannot directly assign rewards.

# Subnet history and licensing

The Vocence subnet registered on Bittensor in April 2026. The open-source repository is github.com/vocence-78/vocence on the master branch under the MIT License. Anyone can clone, fork, audit, or contribute to the subnet code. The evaluation pipeline is part of the public repo — there is no closed scoring logic. Improvements to evaluation flow are proposed publicly with an emphasis on backward-compatible upgrades.

# Whitepaper highlights

The Vocence whitepaper at vocence.ai/whitepaper covers the full design: motivation (existing voice models lack prompt-control evaluation, run on closed datasets, and centralize innovation), the dual-axis evaluation strategy (content correctness, audio quality, prompt adherence), the open evaluation pipeline, the incentive alignment that rewards measurable improvement, and the roadmap from PromptTTS through STT, voice cloning, STS, and Text-to-Music. Q3 of the roadmap targets cross-subnet integrations and platform-level voice agents.
