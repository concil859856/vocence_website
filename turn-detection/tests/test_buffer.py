"""Rolling buffer unit tests — the hot-path helper for the Smart Turn WS.

Correctness of the ring (no off-by-one on wraparound, snapshot order
matches push order, capacity clamping works) is critical: a buffer bug
silently produces wrong probabilities that look plausible.
"""

from __future__ import annotations

import numpy as np

from turn_detection.smart_turn.buffer import RollingAudioBuffer


def _pcm16_bytes(samples: list[int]) -> bytes:
    """Helper: build a raw int16-le byte buffer from a Python list."""
    return np.array(samples, dtype="<i2").tobytes()


class TestRollingAudioBuffer:
    def test_empty(self) -> None:
        b = RollingAudioBuffer(100)
        assert b.filled_samples == 0
        assert b.snapshot().shape == (0,)

    def test_push_under_capacity(self) -> None:
        b = RollingAudioBuffer(10)
        b.push_pcm16(_pcm16_bytes([1000, 2000, 3000]))
        assert b.filled_samples == 3
        snap = b.snapshot()
        assert snap.shape == (3,)
        # int16 → float32 [-1, 1] normalization: 1000 / 32768 ≈ 0.0305
        np.testing.assert_allclose(snap, np.array([1000, 2000, 3000]) / 32768)

    def test_push_exact_capacity(self) -> None:
        b = RollingAudioBuffer(5)
        b.push_pcm16(_pcm16_bytes([1, 2, 3, 4, 5]))
        assert b.filled_samples == 5
        snap = b.snapshot()
        assert snap.shape == (5,)
        np.testing.assert_allclose(snap * 32768, [1, 2, 3, 4, 5], atol=0.5)

    def test_push_over_capacity_drops_oldest(self) -> None:
        """When the ring is full, oldest samples should fall off."""
        b = RollingAudioBuffer(5)
        b.push_pcm16(_pcm16_bytes([1, 2, 3, 4, 5]))
        b.push_pcm16(_pcm16_bytes([6, 7]))
        assert b.filled_samples == 5
        snap = b.snapshot()
        # Most-recent 5 are [3, 4, 5, 6, 7], in arrival order.
        np.testing.assert_allclose(snap * 32768, [3, 4, 5, 6, 7], atol=0.5)

    def test_huge_push_truncated_to_tail(self) -> None:
        b = RollingAudioBuffer(4)
        b.push_pcm16(_pcm16_bytes(list(range(10))))
        assert b.filled_samples == 4
        # Tail of 0..9 is 6, 7, 8, 9
        np.testing.assert_allclose(b.snapshot() * 32768, [6, 7, 8, 9], atol=0.5)

    def test_wraparound_preserves_order(self) -> None:
        """Multiple small pushes that span the wraparound point should
        produce a snapshot in the correct chronological order."""
        b = RollingAudioBuffer(5)
        b.push_pcm16(_pcm16_bytes([1, 2, 3]))
        b.push_pcm16(_pcm16_bytes([4, 5]))     # ring now [1, 2, 3, 4, 5]
        b.push_pcm16(_pcm16_bytes([6, 7]))     # ring wraps to [6, 7, 3, 4, 5] internally; snapshot order [3, 4, 5, 6, 7]
        snap = b.snapshot()
        np.testing.assert_allclose(snap * 32768, [3, 4, 5, 6, 7], atol=0.5)

    def test_clear_drops_everything(self) -> None:
        b = RollingAudioBuffer(5)
        b.push_pcm16(_pcm16_bytes([1, 2, 3]))
        b.clear()
        assert b.filled_samples == 0
        assert b.snapshot().shape == (0,)

    def test_odd_byte_truncated(self) -> None:
        """A protocol bug on the client side might send odd-length bytes.
        We should drop the trailing byte rather than crash."""
        b = RollingAudioBuffer(5)
        b.push_pcm16(b"\x10\x00\x20")  # 3 bytes — one int16 + a stray byte
        assert b.filled_samples == 1

    def test_empty_push_is_noop(self) -> None:
        b = RollingAudioBuffer(5)
        b.push_pcm16(b"")
        assert b.filled_samples == 0

    def test_invalid_capacity_raises(self) -> None:
        import pytest
        with pytest.raises(ValueError):
            RollingAudioBuffer(0)
        with pytest.raises(ValueError):
            RollingAudioBuffer(-1)
