"""Fernet wrapper for at-rest encryption of secrets in SQLite.

Encrypts the things we MUST NOT store plain-text on disk:
  * Per-server SSH private keys (rare — usually we point at a path on
    the backend host, but some users prefer to paste).
  * Per-pod environment variables that contain API keys (the bearer token
    each TTS pod expects, third-party API keys for tools, etc.).

The encryption key itself comes from the ``OPS_FERNET_KEY`` env var. The
backend refuses to start the ops module without it set — better than
silently storing plaintext.

Generate the key once with:
    python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
"""
from __future__ import annotations

import logging
import os
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

_log = logging.getLogger(__name__)


class OpsCryptoNotConfigured(RuntimeError):
    """Raised when OPS_FERNET_KEY is missing — caller should refuse to
    handle secret material and surface a useful error to the admin."""


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    raw = (os.environ.get("OPS_FERNET_KEY") or "").strip()
    if not raw:
        raise OpsCryptoNotConfigured(
            "OPS_FERNET_KEY is not set. Generate one with:\n"
            "  python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'\n"
            "Then add it to dashboard-backend/.env as OPS_FERNET_KEY=..."
        )
    try:
        return Fernet(raw.encode())
    except Exception as e:
        raise OpsCryptoNotConfigured(
            f"OPS_FERNET_KEY is not a valid Fernet key ({e}). "
            "It must be a base64-encoded 32-byte key."
        ) from e


def encrypt(plaintext: str) -> str:
    """Returns a base64-encoded Fernet token. Empty string in → empty out."""
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    """Inverse of encrypt(). Returns "" for empty input. Raises ValueError
    on tampered / wrong-key tokens — never silently returns garbage."""
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise ValueError("invalid Fernet token (wrong key or tampered)") from e


def is_configured() -> bool:
    """True if OPS_FERNET_KEY is set and valid. Useful for the /healthz of
    the ops module so the admin UI can surface 'OPS_FERNET_KEY missing'
    instead of cryptic 500s on every server-add attempt."""
    try:
        _fernet()
        return True
    except OpsCryptoNotConfigured:
        return False
