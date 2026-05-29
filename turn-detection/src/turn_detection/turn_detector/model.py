"""LiveKit Turn Detector v2 ONNX wrapper.

Inference protocol (matches LiveKit's official inference example):

  1. Format the conversation as a chat-template string:
       <|im_start|>user
       <prior user turn>
       <|im_end|>
       <|im_start|>assistant
       <prior assistant turn>
       <|im_end|>
       ...
       <|im_start|>user
       <current in-progress transcript>

     Note the LAST user message has the ``<|im_start|>`` opener but
     **no closing ``<|im_end|>``** — that's the missing token the model
     is predicting the probability of.

  2. Tokenize with the model's own tokenizer (Qwen2-style BPE).

  3. Run the ONNX session — output is ``logits`` of shape
     ``(1, seq_len, vocab=49154)``.

  4. Take the last-token logits, apply softmax over the vocab axis,
     read ``probs[<|im_end|>_token_id]``. That's ``p_end_of_turn``.

History is truncated to the last ``MAX_HISTORY_TURNS`` so the input
length stays bounded — long sessions don't grow inference latency
without limit.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Final

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from transformers import AutoTokenizer


_log = logging.getLogger(__name__)


# Match LiveKit's default: keep at most the last 4 turns of context.
# Longer contexts don't measurably help accuracy and they slow down
# inference linearly.
MAX_HISTORY_TURNS: Final = 4

# The Qwen chat-template end-of-utterance marker — the token whose
# probability we're reading at inference time.
_EOU_TOKEN: Final = "<|im_end|>"


# Singletons, populated by ``load()``.
_session: ort.InferenceSession | None = None
_tokenizer = None  # type: ignore[var-annotated]
_eou_token_id: int | None = None
_load_lock = threading.Lock()


def _all_tokenizer_files(repo_id: str, cache_dir: str | None) -> str:
    """Download the tokenizer-related files alongside the ONNX model.

    HF's ``AutoTokenizer.from_pretrained`` will fetch what it needs if
    given a repo id and online access, but in our deployment we want a
    fully-local path so the function can run with HF in offline mode
    (e.g. inside Docker with no outbound network).

    Returns the snapshot directory containing all the files — that's
    what ``AutoTokenizer.from_pretrained`` expects when given a path.
    """
    # Files the SmolLM/Qwen tokenizer needs. Anything missing causes a
    # cryptic error on tokenizer init; downloading them explicitly here
    # gives us one obvious failure point.
    for fname in (
        "tokenizer.json",
        "tokenizer_config.json",
        "vocab.json",
        "merges.txt",
        "special_tokens_map.json",
        "added_tokens.json",
        "config.json",
    ):
        try:
            hf_hub_download(repo_id=repo_id, filename=fname, cache_dir=cache_dir)
        except Exception:  # noqa: BLE001
            # ``added_tokens.json`` doesn't exist on every model; the
            # AutoTokenizer falls back gracefully when it's absent. Other
            # missing files are real failures and will surface later when
            # AutoTokenizer.from_pretrained throws.
            pass
    # Pick the snapshot directory of one of the files we just fetched.
    sample = hf_hub_download(
        repo_id=repo_id, filename="tokenizer.json", cache_dir=cache_dir
    )
    return os.path.dirname(sample)


def load(
    *,
    repo_id: str,
    onnx_filename: str,
    cache_dir: str | None,
) -> None:
    """Download the ONNX + tokenizer assets and build the session.

    Called once at app startup. Idempotent — multiple calls just no-op
    after the first. Thread-safe.
    """
    global _session, _tokenizer, _eou_token_id
    with _load_lock:
        if _session is not None and _tokenizer is not None:
            return
        _log.info("turn_detector: downloading %s/%s", repo_id, onnx_filename)
        t0 = time.perf_counter()
        onnx_path = hf_hub_download(
            repo_id=repo_id, filename=onnx_filename, cache_dir=cache_dir
        )
        tok_dir = _all_tokenizer_files(repo_id, cache_dir)
        _log.info(
            "turn_detector: download done in %.1fs (onnx=%d bytes)",
            time.perf_counter() - t0,
            Path(onnx_path).stat().st_size,
        )

        sess_opts = ort.SessionOptions()
        sess_opts.intra_op_num_threads = 2
        sess_opts.inter_op_num_threads = 1
        _session = ort.InferenceSession(
            onnx_path, sess_options=sess_opts, providers=["CPUExecutionProvider"]
        )

        _tokenizer = AutoTokenizer.from_pretrained(tok_dir)
        # Fail-fast if the tokenizer doesn't have the EOU marker — that
        # would mean we downloaded an incompatible tokenizer and every
        # inference would silently return garbage.
        token_id = _tokenizer.convert_tokens_to_ids(_EOU_TOKEN)
        if token_id is None or token_id <= 0:
            raise RuntimeError(
                f"turn_detector: tokenizer is missing {_EOU_TOKEN!r}; "
                "this would silently break inference. Check the model files."
            )
        _eou_token_id = int(token_id)
        _log.info("turn_detector: ready (EOU token id = %d)", _eou_token_id)


def is_loaded() -> bool:
    return (
        _session is not None and _tokenizer is not None and _eou_token_id is not None
    )


def infer(
    history: list[dict[str, str]],
    in_progress: str,
) -> tuple[float, int, int]:
    """Compute ``p(end_of_turn)`` for the given conversation state.

    Args:
        history: prior turns, list of ``{"role": "user"|"assistant",
            "content": "..."}`` dicts. Trimmed to the last
            ``MAX_HISTORY_TURNS`` entries.
        in_progress: the user's current in-progress transcript
            (cumulative, NOT a delta).

    Returns ``(p_end_of_turn, tokens_seen, inference_ms)``.

    Thread-safe.
    """
    if _session is None or _tokenizer is None or _eou_token_id is None:
        raise RuntimeError("turn_detector.infer() called before load()")

    # Truncate history. We keep the most-recent turns because they carry
    # the conversational state the model uses to decide what a "complete"
    # next user utterance looks like.
    trimmed_history = history[-MAX_HISTORY_TURNS:] if history else []
    messages = list(trimmed_history) + [{"role": "user", "content": in_progress}]

    t0 = time.perf_counter()
    # ``add_generation_prompt=False`` because we want the chat template
    # to leave the conversation as-is (with the trailing <|im_end|> for
    # the last user message), and we'll strip that ourselves below.
    text = _tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=False
    )
    # Strip the trailing <|im_end|>\n so the model is predicting whether
    # the NEXT token would be <|im_end|>. (If we left it in, the model
    # would just predict the *following* token and probabilities would
    # be meaningless for our purposes.)
    suffix_with_nl = _EOU_TOKEN + "\n"
    if text.endswith(suffix_with_nl):
        text = text[: -len(suffix_with_nl)]
    elif text.endswith(_EOU_TOKEN):
        text = text[: -len(_EOU_TOKEN)]
    ids = _tokenizer(text, return_tensors="np")["input_ids"].astype(np.int64)

    logits = _session.run(None, {"input_ids": ids})[0]
    # logits shape: (batch=1, seq_len, vocab). We care about the last
    # position's distribution — that's the prediction for the next token.
    last = logits[0, -1, :]
    # Stable softmax: subtract the max before exp to avoid overflow on
    # large logits.
    last = last - last.max()
    exp = np.exp(last)
    probs = exp / exp.sum()
    p = float(probs[_eou_token_id])
    inference_ms = int((time.perf_counter() - t0) * 1000)
    return p, int(ids.shape[1]), inference_ms
