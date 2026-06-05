"""Protocol-level unit tests — no model loads, pure schema validation.

Catches the common drift modes: a renamed field, a relaxed Literal,
a missing type discriminator. These tests run in CI without any HF
download, so they catch regressions in <1 s.
"""

from __future__ import annotations

import pytest

from turn_detection.proto import (
    HistoryTurn,
    SmartTurnStart,
    TurnDetectorStart,
    TurnDetectorToken,
    parse_or_error,
)


class TestSmartTurnStart:
    def test_minimal_valid(self) -> None:
        msg = parse_or_error('{"type":"start"}', SmartTurnStart)
        assert isinstance(msg, SmartTurnStart)
        assert msg.sample_rate == 16000
        assert msg.window_ms == 4000

    def test_invalid_sample_rate_rejected(self) -> None:
        # 48000 is outside [16000, 16000]
        result = parse_or_error('{"type":"start","sample_rate":48000}', SmartTurnStart)
        assert isinstance(result, dict)
        assert result["type"] == "error"
        assert result["code"] == "bad_request"

    def test_invalid_encoding_rejected(self) -> None:
        result = parse_or_error(
            '{"type":"start","encoding":"opus"}', SmartTurnStart
        )
        assert isinstance(result, dict)
        assert result["code"] == "bad_request"

    def test_window_ms_clamped(self) -> None:
        # 9000 is above the 8000 cap
        result = parse_or_error('{"type":"start","window_ms":9000}', SmartTurnStart)
        assert isinstance(result, dict)
        assert result["code"] == "bad_request"

    def test_session_id_optional(self) -> None:
        msg = parse_or_error(
            '{"type":"start","session_id":"abc"}', SmartTurnStart
        )
        assert isinstance(msg, SmartTurnStart)
        assert msg.session_id == "abc"


class TestTurnDetectorStart:
    def test_history_default_empty(self) -> None:
        msg = parse_or_error('{"type":"start","language":"en"}', TurnDetectorStart)
        assert isinstance(msg, TurnDetectorStart)
        assert msg.history == []

    def test_history_roles_validated(self) -> None:
        result = parse_or_error(
            '{"type":"start","history":[{"role":"system","content":"hi"}]}',
            TurnDetectorStart,
        )
        assert isinstance(result, dict)
        assert result["code"] == "bad_request"

    def test_history_well_formed(self) -> None:
        msg = parse_or_error(
            '{"type":"start","history":[{"role":"user","content":"hi"},'
            '{"role":"assistant","content":"hello"}]}',
            TurnDetectorStart,
        )
        assert isinstance(msg, TurnDetectorStart)
        assert len(msg.history) == 2
        assert msg.history[0].role == "user"


class TestTurnDetectorToken:
    def test_minimal(self) -> None:
        msg = parse_or_error(
            '{"type":"token","text":"hello there"}', TurnDetectorToken
        )
        assert isinstance(msg, TurnDetectorToken)
        assert msg.is_final is False

    def test_is_final_optional(self) -> None:
        msg = parse_or_error(
            '{"type":"token","text":"hello","is_final":true}', TurnDetectorToken
        )
        assert isinstance(msg, TurnDetectorToken)
        assert msg.is_final is True


def test_garbage_input_returns_error_dict() -> None:
    result = parse_or_error("not json at all", SmartTurnStart)
    assert isinstance(result, dict)
    assert result["type"] == "error"


def test_validation_error_message_is_short() -> None:
    """Don't leak the full Pydantic error blob over the wire."""
    result = parse_or_error('{"type":"start","sample_rate":"foo"}', SmartTurnStart)
    assert isinstance(result, dict)
    # Should be a short human-readable line, not a JSON array of dicts.
    assert len(result["message"]) < 200
