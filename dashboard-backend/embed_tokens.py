"""Embed-token issuance + validation.

An embed token (``vet_<24 random hex chars>``) lets an anonymous
visitor on a customer's website open a voicechat session against a
specific Vocence agent. The agent owner generates one from Studio,
pastes the resulting snippet into their site, and any traffic from
that snippet is billed to them.

Wire shape: the widget passes ``?token=vet_...`` on the voicechat WS
URL the same place a normal user JWT would go. The voicechat router
sniffs the prefix and dispatches to ``validate_embed_token`` here
instead of the JWT path.

Storage:
  * ``token_hash`` (SHA-256 of plaintext) is stored. Plaintext shown
    only once at issuance.
  * ``token_prefix`` (first 6 chars of plaintext, including the
    ``vet_`` namespace) is stored for UI display.
  * Per-token usage history lives in ``agent_embed_token_uses`` for
    rolling-window rate limit enforcement.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import logging
import secrets
import time
import uuid
from dataclasses import dataclass
from urllib.parse import urlparse

import aiosqlite


_log = logging.getLogger(__name__)


TOKEN_PREFIX = "vet_"
_TOKEN_RANDOM_HEX_LEN = 24   # 96 bits of entropy + prefix


@dataclass(frozen=True)
class EmbedTokenContext:
    """Resolved validation result. Returned to the voicechat router
    when an incoming WS hands us a token that passes every gate."""
    token_id: str
    token_hash: str
    agent_id: str
    owner_user_id: str
    max_session_seconds: int


# ---------------------------------------------------------------------------
# Issuance
# ---------------------------------------------------------------------------

def mint() -> tuple[str, str, str]:
    """Generate a new (plaintext, hash, prefix) triple.

    Plaintext shape: ``vet_`` + 24 hex chars (96 bits of entropy from
    ``secrets.token_hex(12)``). Hash is SHA-256. Prefix is the first
    six chars of the plaintext — used for UI display only.
    """
    body = secrets.token_hex(_TOKEN_RANDOM_HEX_LEN // 2)
    plaintext = f"{TOKEN_PREFIX}{body}"
    token_hash = _hash(plaintext)
    prefix = plaintext[:6]   # ``vet_aa``
    return plaintext, token_hash, prefix


def _hash(plaintext: str) -> str:
    """Constant-time-friendly hash. SHA-256 is fine since the input is
    random — collision search would need to brute-force 96 bits."""
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


async def create_token(
    conn: aiosqlite.Connection,
    *,
    agent_id: str,
    owner_user_id: str,
    label: str,
    allowed_origins: list[str],
    rate_limit_per_ip_per_hour: int,
    max_session_minutes: int,
) -> tuple[str, dict]:
    """Mint + insert a new token. Returns ``(plaintext, row)`` so the
    issuance endpoint can show the plaintext exactly once to the
    operator."""
    plaintext, token_hash, prefix = mint()
    token_id = uuid.uuid4().hex
    await conn.execute(
        """
        INSERT INTO agent_embed_tokens
            (id, agent_id, owner_user_id, token_hash, token_prefix,
             label, allowed_origins_json,
             rate_limit_per_ip_per_hour, max_session_minutes,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            token_id, agent_id, owner_user_id, token_hash, prefix,
            label or "", json.dumps(allowed_origins or []),
            rate_limit_per_ip_per_hour, max_session_minutes,
        ),
    )
    await conn.commit()
    row = {
        "id": token_id,
        "agent_id": agent_id,
        "owner_user_id": owner_user_id,
        "token_prefix": prefix,
        "label": label,
        "allowed_origins": allowed_origins or [],
        "rate_limit_per_ip_per_hour": rate_limit_per_ip_per_hour,
        "max_session_minutes": max_session_minutes,
    }
    return plaintext, row


async def list_tokens(
    conn: aiosqlite.Connection, *, agent_id: str,
) -> list[dict]:
    """List all tokens (active + revoked) for one agent — used by the
    Studio token-management UI."""
    cur = await conn.execute(
        """
        SELECT id, token_prefix, label, allowed_origins_json,
               rate_limit_per_ip_per_hour, max_session_minutes,
               last_used_at, revoked_at, created_at
        FROM agent_embed_tokens
        WHERE agent_id = ?
        ORDER BY created_at DESC
        """,
        (agent_id,),
    )
    rows = await cur.fetchall()
    return [
        {
            "id": r["id"],
            "token_prefix": r["token_prefix"],
            "label": r["label"],
            "allowed_origins": json.loads(r["allowed_origins_json"] or "[]"),
            "rate_limit_per_ip_per_hour": r["rate_limit_per_ip_per_hour"],
            "max_session_minutes": r["max_session_minutes"],
            "last_used_at": r["last_used_at"],
            "revoked_at": r["revoked_at"],
            "created_at": r["created_at"],
        }
        for r in rows
    ]


async def revoke_token(
    conn: aiosqlite.Connection, *, token_id: str, agent_id: str,
) -> bool:
    """Mark a token revoked. Idempotent — re-revoking is a no-op.
    Returns True if a row was actually changed."""
    cur = await conn.execute(
        """
        UPDATE agent_embed_tokens
        SET revoked_at = datetime('now')
        WHERE id = ? AND agent_id = ? AND revoked_at IS NULL
        """,
        (token_id, agent_id),
    )
    await conn.commit()
    return cur.rowcount > 0


# ---------------------------------------------------------------------------
# Validation — the hot path used on every embed WS handshake
# ---------------------------------------------------------------------------

class EmbedTokenError(Exception):
    """Raised when a WS-handshake validation fails. The ``code`` field
    matches the reasons surfaced to the widget so the UI can show the
    right error message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def looks_like_embed_token(value: str | None) -> bool:
    """Quick prefix check so the voicechat router can decide which
    auth path (JWT vs embed) to take. Cheap — no DB hit."""
    return bool(value) and value.startswith(TOKEN_PREFIX)


async def validate_embed_token(
    conn: aiosqlite.Connection,
    *,
    plaintext: str,
    origin: str | None,
    ip: str | None,
    now_unix: float | None = None,
) -> EmbedTokenContext:
    """Validate a plaintext embed token against every gate in order:
      1. Looks like an embed token (prefix)
      2. Hash matches a stored row
      3. Token not revoked
      4. ``Origin`` matches the allowed list (if set)
      5. Per-IP rate limit not exceeded

    Raises ``EmbedTokenError`` on any failure. The caller (voicechat
    router) translates the error code into a WS close + JSON body the
    widget shows to the visitor.

    Side effect on success: records a usage row in
    ``agent_embed_token_uses`` so the rate-limit window can enforce.
    """
    if not looks_like_embed_token(plaintext):
        raise EmbedTokenError("auth_required", "not an embed token")
    token_hash = _hash(plaintext)
    cur = await conn.execute(
        """
        SELECT id, agent_id, owner_user_id, allowed_origins_json,
               rate_limit_per_ip_per_hour, max_session_minutes, revoked_at
        FROM agent_embed_tokens
        WHERE token_hash = ?
        """,
        (token_hash,),
    )
    row = await cur.fetchone()
    if row is None:
        raise EmbedTokenError("auth_required", "unknown token")
    if row["revoked_at"] is not None:
        raise EmbedTokenError("auth_required", "token revoked")

    # Origin restriction
    allowed = json.loads(row["allowed_origins_json"] or "[]")
    if allowed and not _origin_matches(origin, allowed):
        raise EmbedTokenError(
            "origin_not_allowed",
            f"origin {origin!r} not in this token's allowed_origins list",
        )

    # Per-IP rate limit (rolling 1-hour window). We don't store IPs
    # forever — old rows are pruned by a separate cleanup job; here we
    # just count the trailing hour.
    if ip:
        await _enforce_rate_limit(
            conn,
            token_id=row["id"],
            ip=ip,
            limit=int(row["rate_limit_per_ip_per_hour"]),
            now_unix=now_unix,
        )
        await conn.execute(
            "INSERT INTO agent_embed_token_uses (token_id, ip, at) VALUES (?, ?, datetime('now'))",
            (row["id"], ip),
        )
    # Update last_used_at — outside the rate-limit check so even
    # rate-limited requests still bump the "saw activity" timestamp
    # (helpful for owner abuse-detection dashboards).
    await conn.execute(
        "UPDATE agent_embed_tokens SET last_used_at = datetime('now') WHERE id = ?",
        (row["id"],),
    )
    await conn.commit()

    return EmbedTokenContext(
        token_id=row["id"],
        token_hash=token_hash,
        agent_id=row["agent_id"],
        owner_user_id=row["owner_user_id"],
        max_session_seconds=int(row["max_session_minutes"]) * 60,
    )


def _origin_matches(origin: str | None, allowed: list[str]) -> bool:
    """Match the request's ``Origin`` header against the allowed-list.

    Each allowed entry is either:
      * a bare hostname like ``docs.example.com`` (exact match), or
      * a glob like ``*.example.com`` (matches any subdomain).

    Schemes and ports are ignored — we compare the netloc only. If
    ``origin`` is missing entirely we reject by default; same-origin
    requests from a browser will always carry ``Origin`` on a WS
    upgrade.
    """
    if not origin:
        return False
    try:
        host = urlparse(origin).netloc.split(":", 1)[0].lower()
    except Exception:  # noqa: BLE001
        return False
    if not host:
        return False
    for pattern in allowed:
        ph = _pattern_host(pattern)
        if not ph:
            continue
        # fnmatch handles plain hostname and ``*.example.com`` cases.
        if fnmatch.fnmatch(host, ph):
            return True
    return False


def _pattern_host(pattern: str) -> str:
    """Normalize a stored allowed-origin entry to a bare host for matching.

    Stored entries come in several shapes depending on how the token was
    minted — a full origin (``http://localhost:8009``), a host:port
    (``localhost:8009``), a bare host (``docs.example.com``), or a glob
    (``*.example.com`` / ``*``). We compare on host only (scheme + port are
    ignored), so reduce every form to its host. Without this, a stored full
    origin never matches the request's extracted host → ``origin_not_allowed``.
    """
    p = (pattern or "").strip().lower()
    if not p:
        return ""
    if p == "*":
        return "*"
    if "://" in p:
        p = urlparse(p).netloc or p
    p = p.split("/", 1)[0]   # drop any path
    p = p.split(":", 1)[0]   # drop port
    return p


async def _enforce_rate_limit(
    conn: aiosqlite.Connection,
    *,
    token_id: str,
    ip: str,
    limit: int,
    now_unix: float | None,
) -> None:
    """Count rows in the trailing hour. Refuses if at or over the limit."""
    # SQLite handles datetime arithmetic; the cleanup job prunes old
    # rows so this scan stays bounded.
    cur = await conn.execute(
        """
        SELECT COUNT(*) AS n
        FROM agent_embed_token_uses
        WHERE token_id = ? AND ip = ? AND at > datetime('now', '-1 hour')
        """,
        (token_id, ip),
    )
    row = await cur.fetchone()
    count = int(row["n"]) if row else 0
    if count >= limit:
        raise EmbedTokenError(
            "rate_limited",
            f"too many sessions from this IP this hour ({count}/{limit})",
        )


async def prune_old_uses(
    conn: aiosqlite.Connection, *, older_than_hours: int = 24,
) -> int:
    """Delete usage rows older than the threshold. Called by a
    periodic cleanup task — keeps the rate-limit ledger small.

    Returns the number of rows removed."""
    cur = await conn.execute(
        f"DELETE FROM agent_embed_token_uses WHERE at < datetime('now', '-{older_than_hours} hours')",
    )
    await conn.commit()
    return cur.rowcount or 0


# Test helper — not used by production code.
def _test_hash(plaintext: str) -> str:  # pragma: no cover
    return _hash(plaintext)
