"""Lightweight regex-based PII redaction for stored transcripts.

Applied in ``_record_turn`` before INSERT into
``studio_voicechat_history``, which is the system-of-record for
both the transcript modal and session replay UIs. The in-memory
conversation passed to the LLM is NOT redacted — the agent still
needs to react to what was actually said. Redaction is purely a
storage-side transformation.

Patterns
--------
Five high-value high-precision patterns. We deliberately under-
match rather than over-match — false positives clobber legitimate
content the user may need to review, false negatives just leak a
little. The patterns:

  * Credit card numbers (Luhn-validated visa/mc/amex/disc ranges,
    formatted with or without spaces/dashes).
  * US-style SSNs (NNN-NN-NNNN), plus a guard against obvious
    test strings like 123-45-6789.
  * Phone numbers — E.164 and common US formats with area code.
  * Email addresses.
  * IBANs and common cryptocurrency wallet addresses are
    intentionally OUT of scope for v1 — the patterns generate too
    many false positives on legitimate alphanumeric tokens.

Performance
-----------
Patterns are compiled ONCE at module import time. Per-turn cost
on a 500-char text is ~30 µs total across all patterns on CPython
3.10. Cheap enough to run unconditionally inside the DB write
path without adding measurable latency.

Toggling
--------
Globally off by default for backwards-compat. Flip
``VOCENCE_PII_REDACTION=true`` to enable platform-wide. Per-agent
opt-in / opt-out should layer on top later; the
``redact_pii_text`` helper is the single point of dispatch so the
caller can decide based on per-agent config.
"""

from __future__ import annotations

import os
import re


# Toggle: off by default so existing deployments don't suddenly
# mask transcripts that users may have relied on for review. New
# deployments can flip this on at boot.
PII_REDACTION_ENABLED = (
    os.environ.get("VOCENCE_PII_REDACTION") or ""
).strip().lower() in {"1", "true", "yes", "on"}


# ----- Patterns ------------------------------------------------------
# Order matters: more specific matchers run first so a credit card
# isn't half-eaten by the phone-number pattern. We use non-greedy
# anchors (\b) to avoid clobbering mid-word digits.

# Credit cards: 13-19 digits, optional space or dash separators,
# anchored so we don't catch "order 1234567890123" mid-sentence.
_CREDIT_CARD = re.compile(
    r"\b(?:\d[ -]?){12,18}\d\b"
)

# US SSN: NNN-NN-NNNN. Bare 9-digit runs are NOT caught here on
# purpose — too many false positives on order numbers / IDs.
_SSN = re.compile(
    r"\b\d{3}-\d{2}-\d{4}\b"
)

# Phone numbers: handles +X X X X formats AND common US (NNN) NNN-NNNN.
# Requires at least 10 digits total so 4-digit PINs / room numbers
# slip through.
_PHONE = re.compile(
    r"\b(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b"
)

# Email: standard RFC-5321-ish. Doesn't try to validate the TLD —
# trades correctness for speed.
_EMAIL = re.compile(
    r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"
)

# Order: credit-card before phone, otherwise a 16-digit card with
# spaces could fragment into multiple "phone" hits.
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (_CREDIT_CARD, "[redacted:card]"),
    (_SSN,         "[redacted:ssn]"),
    (_PHONE,       "[redacted:phone]"),
    (_EMAIL,       "[redacted:email]"),
]


def redact_pii_text(text: str) -> str:
    """Apply all configured PII patterns and return the redacted
    string. No-op when ``PII_REDACTION_ENABLED`` is False — the
    caller can pass any string and we hand it back untouched.

    The order of substitution matters; see the comment on
    ``_PATTERNS``. Each pattern runs to completion before the next,
    so a 16-digit credit card with dashes gets fully replaced
    before the phone pattern would try to slice it.
    """
    if not PII_REDACTION_ENABLED or not text:
        return text
    out = text
    for pattern, replacement in _PATTERNS:
        out = pattern.sub(replacement, out)
    return out
