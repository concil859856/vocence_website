"""Pipecat Smart Turn v3 — audio-based end-of-utterance model.

The model is a Whisper-style mel-spectrogram encoder fine-tuned to
predict ``p(end_of_turn)`` from a rolling window of speech audio. We
ship the v3.2-cpu ONNX variant (~8.7 MB) — it runs in ~15–20 ms per
call on a modern CPU and is the public-recommended deployment choice
for CPU-only hosts.

Reference: https://github.com/pipecat-ai/smart-turn
Model:     https://huggingface.co/pipecat-ai/smart-turn-v3
License:   BSD-3-Clause
"""
