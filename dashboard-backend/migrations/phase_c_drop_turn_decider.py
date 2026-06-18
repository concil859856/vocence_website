"""Phase C migration — strip the now-deprecated ``turn_decider`` field
from every agent's ``config_json`` blob.

Why: under the new pipeline (VOICE_PIPELINE=videosdk) there is only
one turn-detection path (the framework's TurnDetector ONNX). The
``turn_decider`` field — which used to pick between "ultravad" and
"fusion" on the legacy path — has no equivalent and no consumer.

Stays cheap and idempotent:
  - Reads every agents.config_json
  - Parses, pops "turn_decider" if present
  - Writes back only if a value was removed
  - Logs row count

Run once after VOICE_PIPELINE is flipped to videosdk and the legacy
turn-decider code paths are deleted. Safe to re-run — no-ops on
already-clean rows.

Usage:
    python3 migrations/phase_c_drop_turn_decider.py
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path


# Resolve project root so the local_db helpers import cleanly when
# this script is run from any cwd.
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from local_db import get_connection  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
_log = logging.getLogger("phase_c")


async def main() -> int:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT id, config_json FROM agents"
        )).fetchall()
    finally:
        pass  # keep conn for the updates below

    updated = 0
    scanned = 0
    try:
        for row in rows:
            scanned += 1
            agent_id = row["id"]
            raw = row["config_json"] or "{}"
            try:
                cfg = json.loads(raw)
            except Exception:
                _log.warning("agent %s: config_json malformed; skipping", agent_id)
                continue
            if not isinstance(cfg, dict) or "turn_decider" not in cfg:
                continue
            cfg.pop("turn_decider", None)
            new_json = json.dumps(cfg, separators=(",", ":"))
            await conn.execute(
                "UPDATE agents SET config_json = ?, updated_at = datetime('now') "
                "WHERE id = ?",
                (new_json, agent_id),
            )
            updated += 1
        await conn.commit()
    finally:
        await conn.close()

    _log.info("phase_c: scanned=%d updated=%d", scanned, updated)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
