"""Rolling audio buffer for the Smart Turn WebSocket endpoint.

The protocol streams PCM in small chunks (20–40 ms each); Smart Turn
needs the last N seconds at inference time. We keep a fixed-size ring
that always exposes the most-recent ``window_ms`` of audio in a
contiguous numpy array, ready to hand to ``model.infer``.

Why not just append + slice on every call? Two reasons:
  1. The hot path runs every ~150 ms per session. Allocating a fresh
     `np.concatenate` each time, at 64 concurrent sessions, would chew
     measurable CPU on the dispatcher box.
  2. Contiguous memory is what the feature extractor wants — a list of
     chunks would force a copy regardless.

The ring is fixed-size and overwrites in place: cheap, predictable,
no GC pressure.
"""

from __future__ import annotations

import numpy as np


class RollingAudioBuffer:
    """Fixed-capacity ring of PCM samples (int16 → float32 normalized).

    Always exposes a contiguous view of the most recent ``capacity_samples``
    audio via ``snapshot()``. Older samples are silently dropped as new
    ones arrive — exactly what an end-of-turn model wants.
    """

    def __init__(self, capacity_samples: int):
        if capacity_samples <= 0:
            raise ValueError("capacity_samples must be positive")
        self._cap = capacity_samples
        # Float32 normalized to [-1, 1] — matches what the feature
        # extractor consumes. Storing int16 and converting on snapshot
        # would save memory but spend CPU on every inference call; with
        # 4 s of audio @ 16 kHz that's just 256 kB per buffer.
        self._buf = np.zeros(self._cap, dtype=np.float32)
        # Pointer to the next write position. After every push the
        # tail of the buffer (length = ``filled``) is the most recent
        # audio. ``filled`` saturates at capacity.
        self._write = 0
        self._filled = 0

    @property
    def filled_samples(self) -> int:
        return self._filled

    def push_pcm16(self, pcm16_bytes: bytes) -> None:
        """Append a chunk of raw 16-bit little-endian signed PCM.

        Accepts an arbitrary length — including lengths much larger than
        the buffer capacity (we'd just keep the last `cap` samples). The
        client SHOULD send small chunks (20 ms typical) but we don't
        error on big ones — that's the WS handler's concern via the
        4413 close code on oversized frames.
        """
        if not pcm16_bytes:
            return
        # 2 bytes per sample. Truncate any trailing odd byte (would be a
        # protocol bug on the client side, but better to drop one sample
        # than crash mid-stream).
        if len(pcm16_bytes) % 2 == 1:
            pcm16_bytes = pcm16_bytes[:-1]
        samples = np.frombuffer(pcm16_bytes, dtype="<i2")
        # Normalize int16 → float32 in [-1, 1].
        floats = samples.astype(np.float32) * (1.0 / 32768.0)
        self._push(floats)

    def _push(self, samples: np.ndarray) -> None:
        # If the incoming chunk is larger than capacity, just keep its
        # tail. Older bytes were going to be evicted anyway.
        if samples.shape[0] >= self._cap:
            self._buf[:] = samples[-self._cap:]
            self._write = 0
            self._filled = self._cap
            return
        n = samples.shape[0]
        end = self._write + n
        if end <= self._cap:
            self._buf[self._write:end] = samples
        else:
            split = self._cap - self._write
            self._buf[self._write:] = samples[:split]
            self._buf[: end - self._cap] = samples[split:]
        self._write = end % self._cap
        self._filled = min(self._cap, self._filled + n)

    def snapshot(self) -> np.ndarray:
        """Contiguous view of the most recent audio. Returns a copy
        (a new array) because the underlying ring will be mutated by
        the next ``push_pcm16`` call from the WS frame handler.

        Returns an empty array when nothing has been pushed yet.
        """
        if self._filled == 0:
            return np.empty(0, dtype=np.float32)
        if self._filled < self._cap:
            # Buffer not yet full: the prefix [0:write] is valid.
            return self._buf[: self._write].copy()
        # Full ring: the most recent slice runs from `write` (wrapping)
        # forward through `write - 1`. ``np.concatenate`` makes one copy
        # which is what callers want anyway (they mutate freely).
        return np.concatenate((self._buf[self._write:], self._buf[: self._write]))

    def clear(self) -> None:
        """Drop all buffered audio. Called on ``reset`` from the client
        when a new utterance starts."""
        self._write = 0
        self._filled = 0
