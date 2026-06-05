# Subnet roles — miners

Miners train PromptTTS models, publish them on Hugging Face, and deploy them on Chutes (a model deployment platform) using a canonical Vocence wrapper. Each miner exposes a single /speak API endpoint that takes an instruction plus text and returns WAV audio. Miners register on-chain with a Bittensor wallet and commit their model plus Chute ID. The chute name must contain "vocence" for validation. Each hotkey is limited to 2 valid on-chain commits after block 8,081,000.

# Subnet roles — validators

Validators pull the list of valid miners from the owner API, then run a continuous evaluation pipeline. They download source audio from a corpus, extract the transcription and voice traits via GPT-4o-audio, query each miner's /speak endpoint, run a forced-choice evaluation with GPT-4o as the AudioJudge, and upload results to their own Hippius (S3-compatible) storage bucket. Every ~150 blocks (~30 minutes) validators compute scores and set weights on-chain. Validators need Chutes access (granted by the Vocence team), the owner API endpoint, Hippius bucket credentials, and an OpenAI key for the audio judge.

# Subnet roles — owner

The owner runs a centralized API service that manages participant validation — checking wrapper integrity, Chutes deployment, blocklist — publishes the valid miner list, and provides metrics and dashboard data. The owner also deploys a base model that miners must beat to win rewards. The Vocence team does not self-mine; the owner runs only one validator. Self-mining is structurally impossible with this architecture.
