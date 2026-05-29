"""LiveKit Turn Detector v2 — text-based end-of-utterance model.

A 135M-parameter SmolLM v2 fine-tune that reads the streaming transcript
of a conversation (last N turns + the user's current in-progress
utterance) and predicts the probability that the next token would be
the ``<|im_end|>`` chat-template terminator. High probability = the user
has likely finished their thought.

We ship the int8-quantised ONNX variant from the official repo —
~165 MB on disk, ~7 ms per inference on CPU.

Reference: https://huggingface.co/livekit/turn-detector
License:   Apache-2.0
"""
