"""
Ranking logic for miners: same as validator side.

Uses the most recent RANKING_WINDOW_EVALS evaluations (by evaluation_id) per validator
to compute win_rate = wins / total. Display order:
- If no eligible miners, or eligible exist but no one beats owner by THRESHOLD_MARGIN:
  owner chute is #1, then eligible (by win_rate DESC), then non-eligible (by win_rate DESC).
- Otherwise: eligible first (by win_rate DESC), then non-eligible (by win_rate DESC).
"""

import os

# Match validator (vocence domain/config.py)
RANKING_WINDOW_EVALS = int(os.environ.get("RANKING_WINDOW_EVALS", "50"))
MIN_EVALS_TO_COMPETE = int(os.environ.get("MIN_EVALS_TO_COMPETE", "40"))
THRESHOLD_MARGIN = float(os.environ.get("THRESHOLD_MARGIN", "0.05"))
OWNER_HOTKEY = (os.environ.get("OWNER_HOTKEY") or "").strip() or None


async def get_ranked_miner_stats_for_validator(conn, validator_hotkey: str, window_evals: int | None = None):
    """
    Compute miner stats from validator_evaluations using the same recent-window
    logic as the validator. Returns list of dicts with miner_hotkey, total_evaluations,
    total_wins, win_rate (0..1). Order is not applied here; use sort_miners_for_display.
    """
    n = window_evals if window_evals is not None else RANKING_WINDOW_EVALS
    rows = await conn.fetch(
        """
        WITH recent_evals AS (
            SELECT DISTINCT evaluation_id
            FROM validator_evaluations
            WHERE validator_hotkey = $1
            ORDER BY evaluation_id DESC
            LIMIT $2
        ),
        agg AS (
            SELECT e.miner_hotkey,
                   COUNT(*)::int AS total_evaluations,
                   SUM(CASE WHEN e.wins THEN 1 ELSE 0 END)::int AS total_wins
            FROM validator_evaluations e
            WHERE e.validator_hotkey = $1
              AND e.evaluation_id IN (SELECT evaluation_id FROM recent_evals)
            GROUP BY e.miner_hotkey
        )
        SELECT miner_hotkey, total_evaluations, total_wins,
               (total_wins::float / NULLIF(total_evaluations, 0)) AS win_rate
        FROM agg
        """,
        validator_hotkey,
        n,
    )
    return [dict(r) for r in rows]


def sort_miners_for_display(stats: list[dict], owner_hotkey: str | None = None) -> list[dict]:
    """
    Order stats for dashboard/studio:
    - Owner chute is always #1 when OWNER_HOTKEY (or explicit owner_hotkey) is configured.
    - Among the rest, eligible miners (total_evaluations >= MIN_EVALS_TO_COMPETE) come first by
      win_rate DESC, then non-eligible miners by win_rate DESC.
    Each stat dict gets an "eligible" key.
    """
    if not stats:
        return []

    owner_hotkey = (owner_hotkey or "").strip() or OWNER_HOTKEY
    min_evals = MIN_EVALS_TO_COMPETE

    for s in stats:
        total = int(s.get("total_evaluations") or 0)
        s["eligible"] = total >= min_evals

    stats_by_hk = {s["miner_hotkey"]: s for s in stats}
    eligible_list = [s for s in stats if s["eligible"]]
    non_eligible_list = [s for s in stats if not s["eligible"]]

    eligible_list.sort(key=lambda x: (-float(x.get("win_rate") or 0), x["miner_hotkey"]))
    non_eligible_list.sort(key=lambda x: (-float(x.get("win_rate") or 0), x["miner_hotkey"]))

    ordered = eligible_list + non_eligible_list

    if owner_hotkey:
        # If owner exists in stats, move to front; otherwise inject a synthetic owner row
        if owner_hotkey in stats_by_hk:
            owner_row = stats_by_hk[owner_hotkey]
            rest = [s for s in ordered if s["miner_hotkey"] != owner_hotkey]
            return [owner_row] + rest

        owner_row = {
            "miner_hotkey": owner_hotkey,
            "total_evaluations": 0,
            "total_wins": 0,
            "win_rate": 0.0,
            "eligible": False,
        }
        return [owner_row] + ordered

    return ordered
