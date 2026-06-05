#!/usr/bin/env bash
#
# Online, WAL-safe backup of the website SQLite DB (users, credits, payments,
# API keys, studio history, ...). Uses `sqlite3 .backup`, which takes a
# consistent snapshot while the backends keep writing — do NOT just `cp` a
# live WAL database.
#
# Install (hourly): see the crontab line printed by scripts/install_backup_cron.sh
# Restore: gunzip a snapshot and point SQLITE_PATH at it (stop the backends first).
#
set -euo pipefail

# --- resolve the live DB path from the dashboard-backend .env (fallback default)
ENV_FILE="/deployment/vocence_website/dashboard-backend/.env"
DB_PATH="$(grep -E '^SQLITE_PATH=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true)"
DB_PATH="${DB_PATH:-/workspace/vocence_website/dashboard-backend/data/website.db}"

DEST_DIR="${WEBSITE_DB_BACKUP_DIR:-/deployment/backups/website-db}"
RETENTION="${WEBSITE_DB_BACKUP_RETENTION:-72}"   # keep last N snapshots (hourly => 3 days)
STAMP="$(date -u +%Y%m%d-%H%M%S)"
OUT="$DEST_DIR/website-$STAMP.db"

mkdir -p "$DEST_DIR"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup] ERROR: DB not found at $DB_PATH" >&2
  exit 1
fi

# Consistent online snapshot (safe with WAL + concurrent writers).
sqlite3 "$DB_PATH" ".backup '$OUT'"

# Integrity-check the snapshot before we trust it; discard if corrupt.
if [[ "$(sqlite3 "$OUT" 'PRAGMA integrity_check;')" != "ok" ]]; then
  echo "[backup] ERROR: integrity_check failed for $OUT — removing" >&2
  rm -f "$OUT"
  exit 1
fi

gzip -f "$OUT"
echo "[backup] wrote ${OUT}.gz ($(du -h "${OUT}.gz" | cut -f1))"

# Rotate: keep newest $RETENTION .gz snapshots, delete the rest.
mapfile -t OLD < <(ls -1t "$DEST_DIR"/website-*.db.gz 2>/dev/null | tail -n +$((RETENTION + 1)))
if (( ${#OLD[@]} > 0 )); then
  printf '%s\n' "${OLD[@]}" | xargs -r rm -f
  echo "[backup] rotated out ${#OLD[@]} old snapshot(s)"
fi

# --- OPTIONAL off-box copy (protects against disk/host loss). Uncomment and
# set the bucket once you have rclone/aws configured against R2:
#   rclone copy "${OUT}.gz" r2:vocence-backups/website-db/ 2>/dev/null || \
#     echo "[backup] WARN: off-box copy failed" >&2
