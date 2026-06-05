"""Security incident cleanup — fraudulent ``manual_adjustment`` credit grants.

Background (2026-05-13):
    PATCH /users/{user_id}/credits was guarded only by ``require_auth`` plus
    a "user_id must equal caller" check, which let any logged-in user set
    their OWN credit balance to any integer. At least one user used this to
    grant themselves ~100k credits. The endpoint also writes a
    ``manual_adjustment`` row into ``credit_transactions``, so the abuse is
    traceable in the ledger.

    Separately, /auth/login did not verify the Google credential against
    Google's tokeninfo endpoint, so attackers could create accounts on
    arbitrary email domains (e.g. @nowhere.com, @vocence.io).

Both endpoints have been patched. This script:
    1. Reports auth_users with suspicious email domains.
    2. Reports every positive ``manual_adjustment`` credit_transactions row.
    3. Optionally (with --apply) reverses those grants: zero out the
       implicated user's credits AND write a compensating
       ``manual_adjustment`` ledger row so the audit trail is preserved.
    4. Optionally (with --delete-spam) deletes flagged spam auth_users
       rows (CASCADE drops their history). Skip this unless you've
       eyeballed the list — false positives are possible.

Run examples:
    python -m scripts.security_cleanup_credits                 # dry run, report only
    python -m scripts.security_cleanup_credits --apply         # reverse fraudulent credits
    python -m scripts.security_cleanup_credits --apply --delete-spam

All writes happen in a single transaction; abort cleanly if anything looks off.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "website.db"

# Heuristic: domains we've seen abused or that have no legitimate signup
# reason on this product. ADMIN_EMAIL is whitelisted regardless.
SPAM_DOMAINS = {
    "nowhere.com",
    "vocence.io",     # we own vocence.ai, not vocence.io
    "example.com",
    "example.org",
    "test.com",
    "mailinator.com",
    "guerrillamail.com",
    "tempmail.com",
    "10minutemail.com",
}


def _connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        sys.exit(f"DB not found at {db_path}. Pass --db /path/to/website.db")
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _domain(email: str) -> str:
    return (email or "").strip().lower().rsplit("@", 1)[-1] if "@" in (email or "") else ""


def _report_spam_users(conn: sqlite3.Connection, admin_email: str) -> list[sqlite3.Row]:
    rows = conn.execute(
        """
        SELECT id, email, name, credits, plan_code, created_at, last_login_at
        FROM auth_users
        ORDER BY datetime(created_at) DESC
        """
    ).fetchall()
    flagged = []
    for r in rows:
        email = (r["email"] or "").lower()
        if email == admin_email.lower():
            continue
        if _domain(email) in SPAM_DOMAINS:
            flagged.append(r)
    return flagged


def _report_manual_grants(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT
            ct.id, ct.user_id, ct.amount, ct.balance_after, ct.created_at,
            ct.description, u.email, u.credits AS current_credits
        FROM credit_transactions ct
        LEFT JOIN auth_users u ON u.id = ct.user_id
        WHERE ct.transaction_type = 'manual_adjustment'
          AND ct.amount > 0
        ORDER BY datetime(ct.created_at) DESC
        """
    ).fetchall()


def _print_table(title: str, rows: list[sqlite3.Row], cols: list[str]) -> None:
    print()
    print(f"=== {title} ({len(rows)} rows) ===")
    if not rows:
        print("  (none)")
        return
    widths = {c: max(len(c), *(len(str(r[c] if c in r.keys() else "")) for r in rows)) for c in cols}
    header = "  " + "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("  " + "  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  " + "  ".join(str(r[c] if c in r.keys() else "").ljust(widths[c]) for c in cols))


def _reverse_grant(
    conn: sqlite3.Connection,
    user_id: str,
    fraudulent_amount: int,
    description: str,
) -> None:
    """Zero out the user's credits and write a compensating ledger row.

    We do not delete the original fraudulent row — keeping it in the
    ledger gives auditors a complete trail of what happened.
    """
    cur = conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
    row = cur.fetchone()
    if row is None:
        return
    current = int(row["credits"] or 0)
    # Remove the fraudulent amount (clamped to >= 0 so we don't go negative
    # if the user has already spent some of it).
    new_balance = max(0, current - fraudulent_amount)
    conn.execute(
        "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
        (new_balance, user_id),
    )
    conn.execute(
        """
        INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after,
             description, reference_type, reference_id, metadata_json, created_at)
        VALUES (?, ?, 'manual_adjustment', ?, ?, ?, 'security', ?, '{}', datetime('now'))
        """,
        (
            str(uuid.uuid4()),
            user_id,
            -(current - new_balance),
            new_balance,
            f"SECURITY REVERSAL: {description}",
            user_id,
        ),
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=str(DEFAULT_DB), help="Path to website.db")
    p.add_argument("--apply", action="store_true", help="Actually mutate rows (default: dry run)")
    p.add_argument("--delete-spam", action="store_true", help="Also DELETE flagged spam auth_users rows")
    p.add_argument(
        "--admin-email",
        default=os.environ.get("ADMIN_EMAIL", ""),
        help="Whitelisted admin email (read from $ADMIN_EMAIL by default)",
    )
    args = p.parse_args()

    conn = _connect(Path(args.db))

    spam = _report_spam_users(conn, args.admin_email)
    grants = _report_manual_grants(conn)

    _print_table(
        "auth_users with suspicious email domains",
        spam,
        ["id", "email", "credits", "plan_code", "created_at"],
    )
    _print_table(
        "positive manual_adjustment grants (fraudulent or admin-initiated)",
        grants,
        ["created_at", "email", "amount", "balance_after", "user_id", "description"],
    )

    if not args.apply:
        print()
        print("Dry run — nothing changed. Re-run with --apply to reverse the grants.")
        print(f"Suspicious users:        {len(spam)}")
        print(f"Positive manual grants:  {len(grants)}")
        print(f"Total fraudulent credits granted: {sum(int(g['amount'] or 0) for g in grants)}")
        return 0

    print()
    print(f"APPLYING — reversing {len(grants)} grants...")
    started = datetime.now(timezone.utc).isoformat()
    try:
        for g in grants:
            _reverse_grant(
                conn,
                user_id=g["user_id"],
                fraudulent_amount=int(g["amount"] or 0),
                description=(g["description"] or "").strip()[:200],
            )

        if args.delete_spam and spam:
            print(f"DELETING {len(spam)} spam users (CASCADE drops history)...")
            ids = [r["id"] for r in spam]
            placeholders = ",".join("?" * len(ids))
            conn.execute(f"DELETE FROM auth_users WHERE id IN ({placeholders})", ids)

        conn.commit()
        print(f"Done. Started at {started}.")
    except Exception:
        conn.rollback()
        print("ROLLBACK — no changes applied.")
        raise
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
