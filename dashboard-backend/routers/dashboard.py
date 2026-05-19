"""Dashboard API routes."""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from database import acquire
from local_db import ensure_tables, get_connection, log_admin_action
from studio_tts_service import get_presigned_url
from ranking import (
    RANKING_WINDOW_EVALS,
    get_ranked_miner_stats_for_validator,
    sort_miners_for_display,
)
from routers.auth import _get_user_by_id, require_admin_session, require_auth
from schemas import (
    ADMIN_EMAIL,
    ActivityBucketResponse,
    ActivityResponse,
    AddValidatorRequest,
    AdminAuthHistoryRow,
    AdminCreditTransactionRow,
    AdminPaginatedAuthHistoryResponse,
    AdminPaginatedCreditsResponse,
    AdminPaginatedPaymentsResponse,
    AdminPaginatedTtsResponse,
    AdminPaymentRow,
    AdminTtsHistoryRow,
    AdminUserActivitySummary,
    BlocklistAddRequest,
    BlocklistResponse,
    BlogPostCreateRequest,
    BlogPostListResponse,
    BlogPostResponse,
    BlogPostUpdateRequest,
    GlobalScoringSnapshotResponse,
    MinerResponse,
    MinersResponse,
    OverviewResponse,
    RecentEvaluationResponse,
    RecentEvaluationsResponse,
    ValidationStatusResponse,
    LivePendingItem,
    SubnetGraphActivityResponse,
    SubnetGraphNodeResponse,
    SubnetGraphResponse,
    RegisteredUserRegisterRequest,
    RegisteredUserResponse,
    RegisteredUsersListResponse,
    WebsiteOverviewResponse,
    WebsiteUsageDayResponse,
    PlanDistributionResponse,
    RecentPaymentResponse,
    UserRecentActivityItem,
    UserRecentActivityResponse,
    ValidatorResponse,
    ValidatorsResponse,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def _clamp_page_size(page_size: int, default: int = 20, max_size: int = 100) -> int:
    if page_size < 1:
        return default
    return min(page_size, max_size)


# Admin endpoints require a valid JWT session (Authorization: Bearer <token>) where
# the decoded email matches ADMIN_EMAIL — see routers.auth.require_admin_session.


@router.get("/overview", response_model=OverviewResponse)
async def get_overview():
    """Aggregated counts and last activity for dashboard header/stats."""
    async with acquire() as conn:
        miners_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM registered_miners")
        valid_row = await conn.fetchrow(
            "SELECT COUNT(*) AS n FROM registered_miners WHERE is_valid = true"
        )
        validators_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM validator_registry")
        evals_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM validator_evaluations")
        last_row = await conn.fetchrow("""
            SELECT COALESCE(
                (SELECT MAX(last_validated_at) FROM registered_miners),
                (SELECT MAX(evaluated_at) FROM validator_evaluations)
            ) AS last_activity
        """)
    total_miners = int(miners_row["n"] or 0)
    valid_miners = int(valid_row["n"] or 0)
    total_validators = int(validators_row["n"] or 0)
    total_evaluations = int(evals_row["n"] or 0)
    last_activity = last_row["last_activity"]
    return OverviewResponse(
        total_miners=total_miners,
        valid_miners=valid_miners,
        total_validators=total_validators,
        total_evaluations=total_evaluations,
        last_activity=last_activity.isoformat() if last_activity else None,
    )


@router.get("/global-scoring", response_model=GlobalScoringSnapshotResponse | None)
async def get_global_scoring():
    """Latest persisted global scoring snapshot from the owner metrics worker."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT snapshot_data
            FROM global_scoring_snapshots
            WHERE is_latest = true
            ORDER BY generated_at DESC, id DESC
            LIMIT 1
            """
        )
    if not row:
        return None
    payload = row["snapshot_data"]
    if isinstance(payload, str):
        return json.loads(payload)
    return payload


@router.get("/subnet-graph", response_model=SubnetGraphResponse)
async def get_subnet_graph():
    """Live subnet graph payload for the dashboard operations map."""
    async with acquire() as conn:
        validator_rows = await conn.fetch(
            """
            SELECT uid, hotkey, stake, s3_bucket, last_seen_at
            FROM validator_registry
            ORDER BY uid ASC
            """
        )
        miner_rows = await conn.fetch(
            """
            SELECT uid, miner_hotkey, is_valid, last_validated_at, invalid_reason
            FROM registered_miners
            ORDER BY uid ASC
            """
        )
        activity_rows = await conn.fetch(
            """
            SELECT activity_type, activity_key, validator_hotkey, status, payload_json, started_at, expires_at
            FROM graph_activity_leases
            WHERE expires_at >= NOW()
            ORDER BY started_at DESC, id DESC
            """
        )

    nodes: list[SubnetGraphNodeResponse] = [
        SubnetGraphNodeResponse(id="owner-api", node_type="owner_api", label="Owner API", status="active"),
        SubnetGraphNodeResponse(id="subtensor", node_type="subtensor", label="Subtensor", status="active"),
    ]

    for row in validator_rows:
        hotkey = row["hotkey"]
        nodes.append(
            SubnetGraphNodeResponse(
                id=f"validator:{hotkey}",
                node_type="validator",
                hotkey=hotkey,
                uid=row["uid"],
                label=f"V{row['uid']}",
                status="active",
                stake=float(row["stake"] or 0),
                last_seen_at=row["last_seen_at"].isoformat() if row["last_seen_at"] else None,
            )
        )
        nodes.append(
            SubnetGraphNodeResponse(
                id=f"bucket:{hotkey}",
                node_type="bucket",
                hotkey=hotkey,
                validator_hotkey=hotkey,
                label=(row["s3_bucket"] or f"bucket-{str(hotkey)[:6]}"),
                status="active",
                bucket_name=row["s3_bucket"],
            )
        )

    for row in miner_rows:
        hotkey = row["miner_hotkey"]
        is_valid = bool(row["is_valid"])
        nodes.append(
            SubnetGraphNodeResponse(
                id=f"miner:{hotkey}",
                node_type="miner",
                hotkey=hotkey,
                uid=row["uid"],
                label=f"M{row['uid']}",
                status="active" if is_valid else "inactive",
                valid=is_valid,
                last_validated_at=row["last_validated_at"].isoformat() if row["last_validated_at"] else None,
                invalid_reason=row["invalid_reason"],
            )
        )

    activities: list[SubnetGraphActivityResponse] = []
    for row in activity_rows:
        payload = row["payload_json"]
        if isinstance(payload, str):
            try:
                payload = json.loads(payload) if payload else {}
            except Exception:
                payload = {}
        activities.append(
            SubnetGraphActivityResponse(
                activity_type=row["activity_type"],
                activity_key=row["activity_key"],
                validator_hotkey=row["validator_hotkey"],
                status=row["status"],
                payload=payload or {},
                started_at=row["started_at"].isoformat(),
                expires_at=row["expires_at"].isoformat(),
            )
        )

    return SubnetGraphResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        nodes=nodes,
        activities=activities,
    )


def _main_validator_hotkey(validators_rows: list) -> str | None:
    """Main validator: LIVE_VALIDATION_MAIN_VALIDATOR_HOTKEY or first in list."""
    main = (os.environ.get("LIVE_VALIDATION_MAIN_VALIDATOR_HOTKEY") or "").strip()
    if main:
        return main
    return validators_rows[0]["hotkey"] if validators_rows else None


@router.get("/miners", response_model=MinersResponse)
async def get_miners(
    limit: int = Query(100, ge=1, le=500),
    valid: bool = True,
    validator_hotkey: str | None = Query(None, description="Show miners for this validator only (default: main)"),
):
    """List miners: owner #1 when no eligible or no one beats owner; else eligible (by win_rate) then non-eligible (by win_rate)."""
    async with acquire() as conn:
        val_rows = await conn.fetch("""
            SELECT uid, hotkey FROM validator_registry ORDER BY uid ASC
        """)
    main_hotkey = _main_validator_hotkey(val_rows)
    chosen = (validator_hotkey or "").strip() or main_hotkey
    if not chosen:
        return MinersResponse(miners=[])

    async with acquire() as conn:
        stats = await get_ranked_miner_stats_for_validator(conn, chosen, RANKING_WINDOW_EVALS)
        if not stats:
            return MinersResponse(miners=[])
        ordered = sort_miners_for_display(stats)
        hotkeys = [s["miner_hotkey"] for s in ordered]
        miners_rows = await conn.fetch("""
            SELECT uid, miner_hotkey, block, model_name, model_revision,
                   chute_id, chute_slug, is_valid, invalid_reason, last_validated_at
            FROM registered_miners
            WHERE miner_hotkey = ANY($1::text[])
              AND ($2::boolean IS FALSE OR is_valid = true)
        """, hotkeys, valid)
        rm_by_hotkey = {r["miner_hotkey"]: r for r in miners_rows}
    miners = []
    for s in ordered:
        if s["miner_hotkey"] not in rm_by_hotkey:
            continue
        m = rm_by_hotkey[s["miner_hotkey"]]
        total_ev = int(s["total_evaluations"] or 0)
        total_wins = int(s["total_wins"] or 0)
        win_rate = round(float(s["win_rate"] or 0) * 10000 / 100, 2) if total_ev > 0 else 0.0
        last_val = m["last_validated_at"]
        miners.append(
            MinerResponse(
                uid=m["uid"],
                hotkey=m["miner_hotkey"],
                block=m["block"],
                model_name=m["model_name"],
                model_revision=m["model_revision"],
                chute_id=m["chute_id"],
                chute_slug=m["chute_slug"],
                is_valid=m["is_valid"],
                invalid_reason=m["invalid_reason"],
                last_validated_at=last_val.isoformat() if last_val else None,
                total_evaluations=total_ev,
                total_wins=total_wins,
                win_rate=win_rate,
            )
        )
        if len(miners) >= limit:
            break
    return MinersResponse(miners=miners)


@router.get("/validators", response_model=ValidatorsResponse)
async def get_validators():
    """List validators from validator_registry. is_main marks the default for miner rankings."""
    async with acquire() as conn:
        rows = await conn.fetch("""
            SELECT uid, hotkey, stake, s3_bucket, last_seen_at, created_at
            FROM validator_registry
            ORDER BY uid ASC
        """)
    main_hotkey = _main_validator_hotkey(rows)
    validators = [
        ValidatorResponse(
            uid=r["uid"],
            hotkey=r["hotkey"],
            stake=float(r["stake"] or 0),
            s3_bucket=r["s3_bucket"],
            last_seen_at=r["last_seen_at"].isoformat() if r["last_seen_at"] else None,
            created_at=r["created_at"].isoformat() if r["created_at"] else None,
            is_main=(r["hotkey"] == main_hotkey) if main_hotkey else (i == 0),
        )
        for i, r in enumerate(rows)
    ]
    return ValidatorsResponse(validators=validators)


@router.post("/validators", response_model=ValidatorResponse)
async def add_validator(
    body: AddValidatorRequest,
    _: str = Depends(require_admin_session),
):
    """Add a validator to validator_registry (admin only)."""
    hotkey = (body.hotkey or "").strip()
    if not hotkey:
        raise HTTPException(status_code=400, detail="hotkey required")
    async with acquire() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO validator_registry (uid, hotkey, stake, s3_bucket)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (uid) DO UPDATE SET hotkey = EXCLUDED.hotkey, stake = EXCLUDED.stake, s3_bucket = EXCLUDED.s3_bucket
                """,
                body.uid,
                hotkey,
                body.stake,
                body.s3_bucket,
            )
            row = await conn.fetchrow(
                "SELECT uid, hotkey, stake, s3_bucket, last_seen_at, created_at FROM validator_registry WHERE uid = $1",
                body.uid,
            )
        except Exception as e:
            if "does not exist" in str(e).lower():
                raise HTTPException(
                    status_code=503,
                    detail="validator_registry table not found. Ensure Vocence DB schema is applied.",
                )
            raise
    return ValidatorResponse(
        uid=row["uid"],
        hotkey=row["hotkey"],
        stake=float(row["stake"] or 0),
        s3_bucket=row["s3_bucket"],
        last_seen_at=row["last_seen_at"].isoformat() if row["last_seen_at"] else None,
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
    )


@router.delete("/validators/{uid:int}")
async def remove_validator(
    uid: int,
    _: str = Depends(require_admin_session),
):
    """Remove a validator from validator_registry by UID (admin only)."""
    async with acquire() as conn:
        try:
            result = await conn.execute(
                "DELETE FROM validator_registry WHERE uid = $1",
                uid,
            )
        except Exception as e:
            if "does not exist" in str(e).lower():
                raise HTTPException(
                    status_code=503,
                    detail="validator_registry table not found. Ensure Vocence DB schema is applied.",
                )
            raise
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Validator not found")
    return {"ok": True, "message": "Validator removed"}


def _decode_element_scores(raw) -> dict[str, float] | None:
    """Decode the JSON-encoded element_scores column into a {element: float} dict."""
    if raw is None:
        return None
    if isinstance(raw, dict):
        src = raw
    elif isinstance(raw, (str, bytes)):
        try:
            parsed = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if not isinstance(parsed, dict):
            return None
        src = parsed
    else:
        return None
    out: dict[str, float] = {}
    for k, v in src.items():
        try:
            out[str(k)] = float(v)
        except (TypeError, ValueError):
            continue
    return out or None


def _evaluations_from_rows(rows) -> list:
    return [
        RecentEvaluationResponse(
            id=r["id"],
            validator_hotkey=r["validator_hotkey"],
            evaluation_id=r["evaluation_id"],
            miner_hotkey=r["miner_hotkey"],
            wins=bool(r["wins"]),
            evaluated_at=r["evaluated_at"].isoformat() if r.get("evaluated_at") else "",
            prompt=r.get("prompt"),
            reasoning=r.get("reasoning"),
            original_audio_url=r.get("original_audio_url"),
            generated_audio_url=r.get("generated_audio_url"),
            score=float(r["score"]) if r.get("score") is not None else None,
            element_scores=_decode_element_scores(r.get("element_scores")),
        )
        for r in rows
    ]


def _evaluations_where(validator_hotkey: str | None, miner_hotkey: str | None) -> tuple[str, list]:
    """Build WHERE clause and args for evaluations query. Returns (where_sql, args)."""
    conds = []
    args = []
    n = 1
    if validator_hotkey and validator_hotkey.strip():
        conds.append(f"validator_hotkey = ${n}")
        args.append(validator_hotkey.strip())
        n += 1
    if miner_hotkey and miner_hotkey.strip():
        conds.append(f"miner_hotkey = ${n}")
        args.append(miner_hotkey.strip())
        n += 1
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    return where, args


@router.get("/validation-status", response_model=ValidationStatusResponse)
async def get_validation_status(
    limit_pending: int = Query(30, ge=1, le=100, description="Max pending entries for owner validator"),
    limit_evaluations: int = Query(100, ge=1, le=300, description="Max recent evaluations for owner validator"),
):
    """Live validation status for the owner validator only (dashboard status bar).
    Owner = LIVE_VALIDATION_MAIN_VALIDATOR_HOTKEY from env, or first validator in validator_registry.
    Returns pending and recent evaluated results only for that validator."""
    async with acquire() as conn:
        val_rows = await conn.fetch(
            "SELECT uid, hotkey FROM validator_registry ORDER BY uid ASC"
        )
    owner_hotkey = _main_validator_hotkey(val_rows)
    if not owner_hotkey:
        return ValidationStatusResponse(pending=[], evaluations=[])

    async with acquire() as conn:
        try:
            pending_rows = await conn.fetch(
                """
                SELECT validator_hotkey, evaluation_id, prompt_summary, miner_hotkeys, created_at
                FROM live_evaluation_pending
                WHERE validator_hotkey = $1
                ORDER BY created_at DESC
                LIMIT $2
                """,
                owner_hotkey,
                limit_pending,
            )
        except Exception:
            pending_rows = []
        try:
            eval_rows = await conn.fetch(
                """
                SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at,
                       prompt, reasoning, original_audio_url, generated_audio_url,
                       score, element_scores
                FROM validator_evaluations
                WHERE validator_hotkey = $1
                ORDER BY evaluated_at DESC
                LIMIT $2
                """,
                owner_hotkey,
                limit_evaluations,
            )
        except Exception:
            # Fallback for older DBs missing score/element_scores columns
            try:
                eval_rows = await conn.fetch(
                    """
                    SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at,
                           prompt, reasoning, original_audio_url, generated_audio_url
                    FROM validator_evaluations
                    WHERE validator_hotkey = $1
                    ORDER BY evaluated_at DESC
                    LIMIT $2
                    """,
                    owner_hotkey,
                    limit_evaluations,
                )
            except Exception:
                eval_rows = []

    pending = []
    for r in pending_rows:
        miner_hotkeys = []
        if r.get("miner_hotkeys"):
            try:
                miner_hotkeys = json.loads(r["miner_hotkeys"]) or []
            except Exception:
                pass
        pending.append(
            LivePendingItem(
                validator_hotkey=r.get("validator_hotkey") or "",
                evaluation_id=r["evaluation_id"],
                prompt_summary=r.get("prompt_summary"),
                miner_hotkeys=miner_hotkeys,
                created_at=r["created_at"].isoformat() if r.get("created_at") else "",
            )
        )
    evaluations = _evaluations_from_rows(eval_rows)
    return ValidationStatusResponse(pending=pending, evaluations=evaluations)


@router.get("/evaluations/recent", response_model=RecentEvaluationsResponse)
async def get_recent_evaluations(
    limit: int = Query(50, ge=1, le=50000),
    validator_hotkey: str | None = Query(None, description="Filter by validator hotkey"),
    miner_hotkey: str | None = Query(None, description="Filter by miner hotkey"),
):
    """Recent validator evaluations for dashboard (with optional filters)."""
    where, where_args = _evaluations_where(validator_hotkey, miner_hotkey)
    async with acquire() as conn:
        try:
            count_sql = "SELECT COUNT(*) AS n FROM validator_evaluations" + where
            total_row = await conn.fetchrow(count_sql, *where_args)
            total_count = int(total_row["n"] or 0)
            sel = f"""
                SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at,
                       prompt, reasoning, original_audio_url, generated_audio_url,
                       score, element_scores
                FROM validator_evaluations
                {where}
                ORDER BY evaluated_at DESC
                LIMIT ${len(where_args) + 1}
            """
            rows = await conn.fetch(sel, *where_args, limit)
        except Exception as e:
            if "does not exist" in str(e).lower() or "column" in str(e).lower():
                # Fallback if new columns not yet present
                try:
                    total_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM validator_evaluations" + where, *where_args)
                    total_count = int(total_row["n"] or 0)
                    sel = f"""
                        SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at
                        FROM validator_evaluations {where}
                        ORDER BY evaluated_at DESC
                        LIMIT ${len(where_args) + 1}
                    """
                    rows = await conn.fetch(sel, *where_args, limit)
                except Exception:
                    raise HTTPException(
                        status_code=503,
                        detail="validator_evaluations table not found. Ensure dashboard backend uses the same Postgres as the validator.",
                    )
            else:
                raise
    evaluations = _evaluations_from_rows(rows)
    return RecentEvaluationsResponse(evaluations=evaluations, total_count=total_count)


@router.get("/evaluations", response_model=RecentEvaluationsResponse)
async def get_all_evaluations(
    limit: int = Query(100, ge=1, le=50000),
    offset: int = Query(0, ge=0),
    validator_hotkey: str | None = Query(None),
    miner_hotkey: str | None = Query(None),
):
    """All validator evaluations (for View whole list). Supports same filters as /evaluations/recent."""
    where, where_args = _evaluations_where(validator_hotkey, miner_hotkey)
    args = list(where_args) + [limit, offset]
    limit_param = len(where_args) + 1
    offset_param = len(where_args) + 2
    async with acquire() as conn:
        try:
            total_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM validator_evaluations" + where, *where_args)
            total_count = int(total_row["n"] or 0)
            rows = await conn.fetch(
                f"""
                SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at,
                       prompt, reasoning, original_audio_url, generated_audio_url,
                       score, element_scores
                FROM validator_evaluations
                {where}
                ORDER BY evaluated_at DESC
                LIMIT ${limit_param}
                OFFSET ${offset_param}
                """,
                *args,
            )
        except Exception as e:
            if "column" in str(e).lower():
                rows = await conn.fetch(
                    f"""
                    SELECT id, validator_hotkey, evaluation_id, miner_hotkey, wins, evaluated_at
                    FROM validator_evaluations {where}
                    ORDER BY evaluated_at DESC
                    LIMIT ${limit_param}
                    OFFSET ${offset_param}
                    """,
                    *args,
                )
            elif "does not exist" in str(e).lower():
                raise HTTPException(
                    status_code=503,
                    detail="validator_evaluations table not found.",
                )
            else:
                raise
    evaluations = _evaluations_from_rows(rows)
    return RecentEvaluationsResponse(evaluations=evaluations, total_count=total_count)


@router.get("/activity", response_model=ActivityResponse)
async def get_activity(range_param: str = Query("24h", alias="range")):
    """Evaluations over time for the activity chart (24h by hour, 7d by day)."""
    r = (range_param or "24h").lower()
    is_24h = r in ("24h", "24")
    async with acquire() as conn:
        if is_24h:
            rows = await conn.fetch("""
                SELECT date_trunc('hour', evaluated_at AT TIME ZONE 'UTC') AS bucket,
                       COUNT(*)::int AS count
                FROM validator_evaluations
                WHERE evaluated_at >= NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours'
                GROUP BY 1
                ORDER BY 1 ASC
            """)
        else:
            rows = await conn.fetch("""
                SELECT date_trunc('day', evaluated_at AT TIME ZONE 'UTC') AS bucket,
                       COUNT(*)::int AS count
                FROM validator_evaluations
                WHERE evaluated_at >= NOW() AT TIME ZONE 'UTC' - INTERVAL '7 days'
                GROUP BY 1
                ORDER BY 1 ASC
            """)
    buckets = [
        ActivityBucketResponse(
            at=row["bucket"].isoformat() if row["bucket"] else None,
            count=int(row["count"] or 0),
        )
        for row in rows
    ]
    return ActivityResponse(range="24h" if is_24h else "7d", buckets=buckets)


# ----- Registered users (local SQLite) -----


@router.post("/users/register", response_model=RegisteredUserResponse)
async def register_user(
    body: RegisteredUserRegisterRequest,
    user_id: str = Depends(require_auth),
):
    """Register or update a website user (called after login). Stored in local SQLite only.

    SECURITY: prior to 2026-05-14 this endpoint had no auth — anyone
    could POST to spam fake rows or overwrite a real user's name/picture
    via the ON CONFLICT update. Now requires a valid Bearer JWT, and the
    submitted email/name/picture are IGNORED in favor of the values on
    the authenticated ``auth_users`` row (so a logged-in attacker still
    can't forge or overwrite a different account)."""
    me = await _get_user_by_id(user_id)
    if me is None:
        raise HTTPException(status_code=401, detail="Unknown user")
    email = (me.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="Authenticated user has no email")
    name = me.name or ""
    picture = me.picture
    _ = body  # body fields ignored — preserved for backwards compatibility with old clients
    await ensure_tables()
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO registered_users (email, name, picture, created_at, updated_at)
            VALUES (?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT (email) DO UPDATE SET
                name = excluded.name,
                picture = excluded.picture,
                updated_at = datetime('now')
            """,
            (email, name, picture),
        )
        await conn.commit()
        cursor = await conn.execute(
            "SELECT id, email, name, picture, created_at, updated_at FROM registered_users WHERE email = ?",
            (email,),
        )
        r = await cursor.fetchone()
    finally:
        await conn.close()
    return RegisteredUserResponse(
        id=r[0],
        email=r[1],
        name=r[2] or "",
        picture=r[3],
        created_at=r[4] or "",
        updated_at=r[5] or "",
    )


@router.get("/users", response_model=RegisteredUsersListResponse)
async def list_registered_users(
    _: str = Depends(require_admin_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=200),
):
    """List website users (auth_users) with search and pagination. Admin only."""
    await ensure_tables()
    ps = _clamp_page_size(page_size)
    offset = (page - 1) * ps
    q_strip = (q or "").strip()
    conn = await get_connection()
    try:
        if q_strip:
            pat = f"%{q_strip}%"
            count_row = await (
                await conn.execute(
                    """
                    SELECT COUNT(*) AS n FROM auth_users
                    WHERE email LIKE ? OR name LIKE ? OR id LIKE ?
                    """,
                    (pat, pat, pat),
                )
            ).fetchone()
            cursor = await conn.execute(
                """
                SELECT id, email, name, picture, credits, plan_code, plan_status, created_at, updated_at, last_login_at
                FROM auth_users
                WHERE email LIKE ? OR name LIKE ? OR id LIKE ?
                ORDER BY datetime(created_at) DESC
                LIMIT ? OFFSET ?
                """,
                (pat, pat, pat, ps, offset),
            )
        else:
            count_row = await (await conn.execute("SELECT COUNT(*) AS n FROM auth_users")).fetchone()
            cursor = await conn.execute(
                """
                SELECT id, email, name, picture, credits, plan_code, plan_status, created_at, updated_at, last_login_at
                FROM auth_users
                ORDER BY datetime(created_at) DESC
                LIMIT ? OFFSET ?
                """,
                (ps, offset),
            )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    total = int(count_row["n"] or 0)
    users = [
        RegisteredUserResponse(
            id=r["id"],
            email=r["email"],
            name=r["name"] or "",
            picture=r["picture"],
            credits=int(r["credits"] or 0),
            plan_code=r["plan_code"] or "normal",
            plan_status=r["plan_status"] or "active",
            last_login_at=r["last_login_at"],
            created_at=r["created_at"] or "",
            updated_at=r["updated_at"] or "",
        )
        for r in rows
    ]
    return RegisteredUsersListResponse(users=users, total=total, page=page, page_size=ps)


@router.get("/website-overview", response_model=WebsiteOverviewResponse)
async def get_website_overview(_: str = Depends(require_admin_session)):
    """Website-only admin metrics from website.db."""
    await ensure_tables()
    conn = await get_connection()
    try:
        total_users = await (await conn.execute("SELECT COUNT(*) AS n FROM auth_users")).fetchone()
        active_users = await (await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM auth_users
            WHERE last_login_at IS NOT NULL
              AND datetime(last_login_at) >= datetime('now', '-7 days')
            """
        )).fetchone()
        usage_rows = await (await conn.execute(
            """
            SELECT day, tts_generation_count, unique_users, credits_used, revenue_usd, credits_purchased
            FROM daily_usage_stats
            ORDER BY day ASC
            """
        )).fetchall()

        # Per-day counts for the other studio types (computed at query time so we
        # don't need a schema migration to daily_usage_stats).
        stt_by_day = {
            r["day"]: int(r["n"] or 0) for r in await (await conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS n FROM studio_stt_history WHERE status = 'completed' GROUP BY day"
            )).fetchall()
        }
        clone_by_day = {
            r["day"]: int(r["n"] or 0) for r in await (await conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS n FROM studio_clone_history "
                "WHERE status = 'completed' AND COALESCE(source_mode, '') != 'designed_voice' GROUP BY day"
            )).fetchall()
        }
        vd_by_day = {
            r["day"]: int(r["n"] or 0) for r in await (await conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS n FROM studio_clone_history "
                "WHERE status = 'completed' AND source_mode = 'designed_voice' GROUP BY day"
            )).fetchall()
        }
        music_by_day = {
            r["day"]: int(r["n"] or 0) for r in await (await conn.execute(
                "SELECT date(created_at) AS day, COUNT(*) AS n FROM studio_music_history WHERE status = 'completed' GROUP BY day"
            )).fetchall()
        }
        plan_rows = await (await conn.execute(
            """
            SELECT plan_code, COUNT(*) AS user_count
            FROM auth_users
            GROUP BY plan_code
            ORDER BY user_count DESC, plan_code ASC
            """
        )).fetchall()
        payment_rows = await (await conn.execute(
            """
            SELECT id, user_id, provider, plan_code, amount_usd, credits_granted, status, created_at
            FROM payments
            ORDER BY datetime(created_at) DESC
            LIMIT 10
            """
        )).fetchall()
        totals = await (await conn.execute(
            """
            SELECT
                COALESCE((SELECT COUNT(*) FROM studio_tts_history WHERE status = 'completed'), 0) AS total_generations,
                COALESCE((SELECT SUM(-amount) FROM credit_transactions WHERE amount < 0), 0) AS total_credits_used,
                COALESCE((SELECT SUM(amount_usd) FROM payments WHERE status IN ('paid', 'completed')), 0) AS total_revenue_usd
            """
        )).fetchone()
        # Union of all days across daily_usage_stats and the per-type tables, so a day
        # with only STT/clone/music activity (no TTS) still shows up in the chart.
        usage_by_day: dict[str, dict] = {
            row["day"]: {
                "tts_generation_count": int(row["tts_generation_count"] or 0),
                "unique_users": int(row["unique_users"] or 0),
                "credits_used": int(row["credits_used"] or 0),
                "revenue_usd": float(row["revenue_usd"] or 0),
                "credits_purchased": int(row["credits_purchased"] or 0),
            }
            for row in usage_rows
        }
        all_days = set(usage_by_day) | set(stt_by_day) | set(clone_by_day) | set(vd_by_day) | set(music_by_day)
        empty_day = {"tts_generation_count": 0, "unique_users": 0, "credits_used": 0, "revenue_usd": 0.0, "credits_purchased": 0}
        usage = [
            WebsiteUsageDayResponse(
                day=day,
                tts_generation_count=usage_by_day.get(day, empty_day)["tts_generation_count"],
                stt_count=stt_by_day.get(day, 0),
                clone_count=clone_by_day.get(day, 0),
                voice_design_count=vd_by_day.get(day, 0),
                music_count=music_by_day.get(day, 0),
                unique_users=usage_by_day.get(day, empty_day)["unique_users"],
                credits_used=usage_by_day.get(day, empty_day)["credits_used"],
                revenue_usd=usage_by_day.get(day, empty_day)["revenue_usd"],
                credits_purchased=usage_by_day.get(day, empty_day)["credits_purchased"],
            )
            for day in sorted(all_days)
        ]
        distribution = [
            PlanDistributionResponse(
                plan_code=row["plan_code"] or "normal",
                user_count=int(row["user_count"] or 0),
            )
            for row in plan_rows
        ]
        recent_payments = [
            RecentPaymentResponse(
                id=row["id"],
                user_id=row["user_id"],
                provider=row["provider"],
                plan_code=row["plan_code"],
                amount_usd=float(row["amount_usd"] or 0),
                credits_granted=int(row["credits_granted"] or 0),
                status=row["status"],
                created_at=row["created_at"],
            )
            for row in payment_rows
        ]
        return WebsiteOverviewResponse(
            total_users=int(total_users["n"] or 0),
            active_users_7d=int(active_users["n"] or 0),
            total_generations=int(totals["total_generations"] or 0),
            total_credits_used=int(totals["total_credits_used"] or 0),
            total_revenue_usd=float(totals["total_revenue_usd"] or 0),
            usage=usage,
            plan_distribution=distribution,
            recent_payments=recent_payments,
        )
    finally:
        await conn.close()


# ----- Admin: detailed website usage (SQLite, paginated) -----


@router.get("/admin/website-usage/tts", response_model=AdminPaginatedTtsResponse)
async def admin_website_usage_tts(
    _: str = Depends(require_admin_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=300),
    user_id: str | None = Query(None, max_length=128),
):
    """Paginated studio TTS history with user email/name; optional search and user filter."""
    await ensure_tables()
    ps = _clamp_page_size(page_size)
    offset = (page - 1) * ps
    q_strip = (q or "").strip()
    conn = await get_connection()
    try:
        where_parts = ["1=1"]
        params: list[object] = []
        if user_id and user_id.strip():
            where_parts.append("h.user_id = ?")
            params.append(user_id.strip())
        if q_strip:
            pat = f"%{q_strip}%"
            where_parts.append(
                "(IFNULL(u.email,'') LIKE ? OR IFNULL(u.name,'') LIKE ? OR h.user_id LIKE ? "
                "OR h.model_name LIKE ? OR h.prompt_text LIKE ? OR h.miner_hotkey LIKE ? OR h.style_instruction LIKE ?)"
            )
            params.extend([pat] * 7)
        where_sql = " AND ".join(where_parts)
        count_row = await (
            await conn.execute(
                f"""
                SELECT COUNT(*) AS n
                FROM studio_tts_history h
                LEFT JOIN auth_users u ON u.id = h.user_id
                WHERE {where_sql}
                """,
                params,
            )
        ).fetchone()
        total = int(count_row["n"] or 0)
        list_params = list(params) + [ps, offset]
        cursor = await conn.execute(
            f"""
            SELECT h.id, h.user_id, u.email AS user_email, u.name AS user_name,
                   h.miner_hotkey, h.model_name, h.prompt_text, h.style_instruction,
                   h.credits_used, h.status, h.latency_ms, h.error_message, h.created_at
            FROM studio_tts_history h
            LEFT JOIN auth_users u ON u.id = h.user_id
            WHERE {where_sql}
            ORDER BY datetime(h.created_at) DESC
            LIMIT ? OFFSET ?
            """,
            list_params,
        )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    items = [
        AdminTtsHistoryRow(
            id=int(r["id"]),
            user_id=r["user_id"],
            user_email=r["user_email"],
            user_name=r["user_name"],
            miner_hotkey=r["miner_hotkey"],
            model_name=r["model_name"],
            prompt_text=r["prompt_text"],
            style_instruction=r["style_instruction"] or "",
            credits_used=int(r["credits_used"] or 0),
            status=r["status"] or "",
            latency_ms=r["latency_ms"],
            error_message=r["error_message"],
            created_at=r["created_at"] or "",
        )
        for r in rows
    ]
    return AdminPaginatedTtsResponse(items=items, total=total, page=page, page_size=ps)


@router.get("/admin/website-usage/credits", response_model=AdminPaginatedCreditsResponse)
async def admin_website_usage_credits(
    _: str = Depends(require_admin_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=300),
    user_id: str | None = Query(None, max_length=128),
):
    """Paginated credit_transactions with user info."""
    await ensure_tables()
    ps = _clamp_page_size(page_size)
    offset = (page - 1) * ps
    q_strip = (q or "").strip()
    conn = await get_connection()
    try:
        where_parts = ["1=1"]
        params: list[object] = []
        if user_id and user_id.strip():
            where_parts.append("c.user_id = ?")
            params.append(user_id.strip())
        if q_strip:
            pat = f"%{q_strip}%"
            where_parts.append(
                "(IFNULL(u.email,'') LIKE ? OR IFNULL(u.name,'') LIKE ? OR c.user_id LIKE ? "
                "OR c.transaction_type LIKE ? OR IFNULL(c.description,'') LIKE ? "
                "OR IFNULL(c.reference_type,'') LIKE ? OR IFNULL(c.reference_id,'') LIKE ?)"
            )
            params.extend([pat] * 7)
        where_sql = " AND ".join(where_parts)
        count_row = await (
            await conn.execute(
                f"""
                SELECT COUNT(*) AS n
                FROM credit_transactions c
                LEFT JOIN auth_users u ON u.id = c.user_id
                WHERE {where_sql}
                """,
                params,
            )
        ).fetchone()
        total = int(count_row["n"] or 0)
        list_params = list(params) + [ps, offset]
        cursor = await conn.execute(
            f"""
            SELECT c.id, c.user_id, u.email AS user_email, u.name AS user_name,
                   c.transaction_type, c.amount, c.balance_after, c.description,
                   c.reference_type, c.reference_id, c.created_at
            FROM credit_transactions c
            LEFT JOIN auth_users u ON u.id = c.user_id
            WHERE {where_sql}
            ORDER BY datetime(c.created_at) DESC
            LIMIT ? OFFSET ?
            """,
            list_params,
        )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    items = [
        AdminCreditTransactionRow(
            id=r["id"],
            user_id=r["user_id"],
            user_email=r["user_email"],
            user_name=r["user_name"],
            transaction_type=r["transaction_type"],
            amount=int(r["amount"] or 0),
            balance_after=int(r["balance_after"] or 0),
            description=r["description"] or "",
            reference_type=r["reference_type"],
            reference_id=r["reference_id"],
            created_at=r["created_at"] or "",
        )
        for r in rows
    ]
    return AdminPaginatedCreditsResponse(items=items, total=total, page=page, page_size=ps)


@router.get("/admin/website-usage/payments", response_model=AdminPaginatedPaymentsResponse)
async def admin_website_usage_payments(
    _: str = Depends(require_admin_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=300),
    user_id: str | None = Query(None, max_length=128),
):
    """Paginated payments with user info."""
    await ensure_tables()
    ps = _clamp_page_size(page_size)
    offset = (page - 1) * ps
    q_strip = (q or "").strip()
    conn = await get_connection()
    try:
        where_parts = ["1=1"]
        params: list[object] = []
        if user_id and user_id.strip():
            where_parts.append("p.user_id = ?")
            params.append(user_id.strip())
        if q_strip:
            pat = f"%{q_strip}%"
            where_parts.append(
                "(IFNULL(u.email,'') LIKE ? OR IFNULL(u.name,'') LIKE ? OR p.user_id LIKE ? "
                "OR p.provider LIKE ? OR IFNULL(p.plan_code,'') LIKE ? OR p.status LIKE ? "
                "OR IFNULL(p.stripe_checkout_session_id,'') LIKE ?)"
            )
            params.extend([pat] * 7)
        where_sql = " AND ".join(where_parts)
        count_row = await (
            await conn.execute(
                f"""
                SELECT COUNT(*) AS n
                FROM payments p
                LEFT JOIN auth_users u ON u.id = p.user_id
                WHERE {where_sql}
                """,
                params,
            )
        ).fetchone()
        total = int(count_row["n"] or 0)
        list_params = list(params) + [ps, offset]
        cursor = await conn.execute(
            f"""
            SELECT p.id, p.user_id, u.email AS user_email, u.name AS user_name,
                   p.provider, p.plan_code, p.amount_usd, p.credits_granted, p.status,
                   p.mode, p.stripe_checkout_session_id, p.credits_applied_at, p.created_at
            FROM payments p
            LEFT JOIN auth_users u ON u.id = p.user_id
            WHERE {where_sql}
            ORDER BY datetime(p.created_at) DESC
            LIMIT ? OFFSET ?
            """,
            list_params,
        )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    items = [
        AdminPaymentRow(
            id=r["id"],
            user_id=r["user_id"],
            user_email=r["user_email"],
            user_name=r["user_name"],
            provider=r["provider"],
            plan_code=r["plan_code"],
            amount_usd=float(r["amount_usd"] or 0),
            credits_granted=int(r["credits_granted"] or 0),
            status=r["status"] or "",
            mode=r["mode"],
            stripe_checkout_session_id=r["stripe_checkout_session_id"],
            credits_applied_at=r["credits_applied_at"],
            created_at=r["created_at"] or "",
        )
        for r in rows
    ]
    return AdminPaginatedPaymentsResponse(items=items, total=total, page=page, page_size=ps)


@router.get("/admin/website-usage/auth-history", response_model=AdminPaginatedAuthHistoryResponse)
async def admin_website_usage_auth_history(
    _: str = Depends(require_admin_session),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    q: str = Query("", max_length=300),
    user_id: str | None = Query(None, max_length=128),
):
    """Paginated auth_history (user activity log from app)."""
    await ensure_tables()
    ps = _clamp_page_size(page_size)
    offset = (page - 1) * ps
    q_strip = (q or "").strip()
    conn = await get_connection()
    try:
        where_parts = ["1=1"]
        params: list[object] = []
        if user_id and user_id.strip():
            where_parts.append("h.user_id = ?")
            params.append(user_id.strip())
        if q_strip:
            pat = f"%{q_strip}%"
            where_parts.append(
                "(IFNULL(u.email,'') LIKE ? OR IFNULL(u.name,'') LIKE ? OR h.user_id LIKE ? "
                "OR h.type LIKE ? OR IFNULL(h.content,'') LIKE ? OR IFNULL(h.model,'') LIKE ?)"
            )
            params.extend([pat] * 6)
        where_sql = " AND ".join(where_parts)
        count_row = await (
            await conn.execute(
                f"""
                SELECT COUNT(*) AS n
                FROM auth_history h
                LEFT JOIN auth_users u ON u.id = h.user_id
                WHERE {where_sql}
                """,
                params,
            )
        ).fetchone()
        total = int(count_row["n"] or 0)
        list_params = list(params) + [ps, offset]
        cursor = await conn.execute(
            f"""
            SELECT h.id, h.user_id, u.email AS user_email, u.name AS user_name,
                   h.type, h.content, h.style_prompt, h.model, h.meta, h.duration, h.created_at
            FROM auth_history h
            LEFT JOIN auth_users u ON u.id = h.user_id
            WHERE {where_sql}
            ORDER BY datetime(h.created_at) DESC
            LIMIT ? OFFSET ?
            """,
            list_params,
        )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    items = [
        AdminAuthHistoryRow(
            id=r["id"],
            user_id=r["user_id"],
            user_email=r["user_email"],
            user_name=r["user_name"],
            type=r["type"],
            content=r["content"],
            style_prompt=r["style_prompt"],
            model=r["model"],
            meta=r["meta"],
            duration=r["duration"],
            created_at=r["created_at"] or "",
        )
        for r in rows
    ]
    return AdminPaginatedAuthHistoryResponse(items=items, total=total, page=page, page_size=ps)


@router.get("/admin/website-usage/user/{user_id}/summary", response_model=AdminUserActivitySummary)
async def admin_website_usage_user_summary(
    user_id: str,
    _: str = Depends(require_admin_session),
):
    """Per-user rollup for admin drill-down."""
    await ensure_tables()
    conn = await get_connection()
    try:
        urow = await (
            await conn.execute(
                """
                SELECT id, email, name, credits, plan_code, plan_status, created_at, last_login_at
                FROM auth_users WHERE id = ?
                """,
                (user_id,),
            )
        ).fetchone()
        if not urow:
            raise HTTPException(status_code=404, detail="User not found")
        tts_row = await (
            await conn.execute(
                """
                SELECT COUNT(*) AS n, COALESCE(SUM(credits_used), 0) AS credits
                FROM studio_tts_history
                WHERE user_id = ? AND status = 'completed'
                """,
                (user_id,),
            )
        ).fetchone()
        tx_row = await (
            await conn.execute(
                "SELECT COUNT(*) AS n FROM credit_transactions WHERE user_id = ?",
                (user_id,),
            )
        ).fetchone()
        pay_row = await (
            await conn.execute(
                "SELECT COUNT(*) AS n FROM payments WHERE user_id = ?",
                (user_id,),
            )
        ).fetchone()
    finally:
        await conn.close()
    return AdminUserActivitySummary(
        user_id=urow["id"],
        email=urow["email"],
        name=urow["name"] or "",
        credits=int(urow["credits"] or 0),
        plan_code=urow["plan_code"] or "normal",
        plan_status=urow["plan_status"] or "active",
        created_at=urow["created_at"] or "",
        last_login_at=urow["last_login_at"],
        tts_completed_count=int(tts_row["n"] or 0),
        tts_total_credits=int(tts_row["credits"] or 0),
        credit_tx_count=int(tx_row["n"] or 0),
        payments_count=int(pay_row["n"] or 0),
    )


async def _build_recent_activity(
    user_id: str | None,
    limit: int,
) -> UserRecentActivityResponse:
    """Shared logic — pulls recent generations across all 5 studio history tables,
    optionally filtered to one user, and returns a unified, sorted list with
    presigned audio URLs and user identification.
    """
    await ensure_tables()
    limit = max(1, min(int(limit), 500))
    user_clause = "WHERE user_id = ?" if user_id else ""
    user_args: tuple = (user_id,) if user_id else ()

    conn = await get_connection()
    try:
        tts = await (await conn.execute(
            f"""SELECT id, user_id, created_at, prompt_text, model_name, credits_used, status,
                       audio_s3_bucket, audio_s3_key, expires_at
                FROM studio_tts_history {user_clause}
                ORDER BY datetime(created_at) DESC LIMIT ?""",
            (*user_args, limit),
        )).fetchall()
        stt = await (await conn.execute(
            f"""SELECT id, user_id, created_at, transcribed_text, source_audio_filename, source_language, credits_used, status
                FROM studio_stt_history {user_clause}
                ORDER BY datetime(created_at) DESC LIMIT ?""",
            (*user_args, limit),
        )).fetchall()
        clones = await (await conn.execute(
            f"""SELECT id, user_id, created_at, target_text, reference_text, source_mode, credits_used, status,
                       audio_s3_bucket, audio_s3_key, expires_at
                FROM studio_clone_history {user_clause}
                ORDER BY datetime(created_at) DESC LIMIT ?""",
            (*user_args, limit),
        )).fetchall()
        music = await (await conn.execute(
            f"""SELECT id, user_id, created_at, prompt_text, task, credits_used, status,
                       audio_s3_bucket, audio_s3_key, expires_at
                FROM studio_music_history {user_clause}
                ORDER BY datetime(created_at) DESC LIMIT ?""",
            (*user_args, limit),
        )).fetchall()

        # Collect user IDs so we can resolve email/name in one query.
        user_ids: set[str] = set()
        for r in tts:    user_ids.add(r["user_id"])
        for r in stt:    user_ids.add(r["user_id"])
        for r in clones: user_ids.add(r["user_id"])
        for r in music:  user_ids.add(r["user_id"])
        users_map: dict[str, dict[str, str | None]] = {}
        if user_ids:
            placeholders = ",".join("?" * len(user_ids))
            urows = await (await conn.execute(
                f"SELECT id, email, name FROM auth_users WHERE id IN ({placeholders})",
                tuple(user_ids),
            )).fetchall()
            for u in urows:
                users_map[u["id"]] = {"email": u["email"], "name": u["name"] or ""}
    finally:
        await conn.close()

    now = datetime.now(timezone.utc)

    def _resolve_audio(bucket: str | None, key: str | None, exp: str | None) -> str | None:
        if not bucket or not key or not exp:
            return None
        try:
            expires_at = datetime.fromisoformat(str(exp).replace("Z", "+00:00"))
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= now:
                return None
            return get_presigned_url(bucket, key, expires_at)
        except Exception:
            return None

    def _user_fields(uid: str) -> dict[str, str | None]:
        u = users_map.get(uid) or {}
        return {"user_id": uid, "user_email": u.get("email"), "user_name": u.get("name")}

    items: list[UserRecentActivityItem] = []
    for r in tts:
        items.append(UserRecentActivityItem(
            id=int(r["id"]), type="tts", created_at=str(r["created_at"] or ""),
            title=(r["prompt_text"] or "")[:160], detail=r["model_name"] or None,
            credits_used=int(r["credits_used"] or 0), status=r["status"] or None,
            audio_url=_resolve_audio(r["audio_s3_bucket"], r["audio_s3_key"], r["expires_at"]),
            **_user_fields(r["user_id"]),
        ))
    for r in stt:
        items.append(UserRecentActivityItem(
            id=int(r["id"]), type="stt", created_at=str(r["created_at"] or ""),
            title=(r["transcribed_text"] or r["source_audio_filename"] or "")[:160],
            detail=r["source_language"] or None,
            credits_used=int(r["credits_used"] or 0), status=r["status"] or None,
            **_user_fields(r["user_id"]),
        ))
    for r in clones:
        is_designed = (r["source_mode"] or "").strip().lower() == "designed_voice"
        items.append(UserRecentActivityItem(
            id=int(r["id"]),
            type="voice_design" if is_designed else "clone",
            created_at=str(r["created_at"] or ""),
            title=(r["target_text"] or "")[:160],
            detail=(r["reference_text"] or "")[:80] if r["reference_text"] else None,
            credits_used=int(r["credits_used"] or 0),
            status=r["status"] or None,
            audio_url=_resolve_audio(r["audio_s3_bucket"], r["audio_s3_key"], r["expires_at"]),
            **_user_fields(r["user_id"]),
        ))
    for r in music:
        items.append(UserRecentActivityItem(
            id=int(r["id"]), type="music", created_at=str(r["created_at"] or ""),
            title=(r["prompt_text"] or "")[:160], detail=r["task"] or None,
            credits_used=int(r["credits_used"] or 0), status=r["status"] or None,
            audio_url=_resolve_audio(r["audio_s3_bucket"], r["audio_s3_key"], r["expires_at"]),
            **_user_fields(r["user_id"]),
        ))

    items.sort(key=lambda x: x.created_at, reverse=True)
    items = items[:limit]

    by_day_map: dict[str, dict[str, int]] = {}
    for it in items:
        day = (it.created_at or "")[:10]
        if not day:
            continue
        bucket = by_day_map.setdefault(day, {"tts": 0, "stt": 0, "clone": 0, "voice_design": 0, "music": 0})
        bucket[it.type] = bucket.get(it.type, 0) + 1
    by_day = [{"day": d, **counts} for d, counts in sorted(by_day_map.items())]

    return UserRecentActivityResponse(user_id=user_id, items=items, by_day=by_day)


@router.get(
    "/admin/website-usage/user/{user_id}/recent-activity",
    response_model=UserRecentActivityResponse,
)
async def admin_user_recent_activity(
    user_id: str,
    limit: int = 100,
    _: str = Depends(require_admin_session),
):
    """Per-user recent activity across all studio types."""
    return await _build_recent_activity(user_id, limit)


@router.get(
    "/admin/recent-activity",
    response_model=UserRecentActivityResponse,
)
async def admin_recent_activity(
    limit: int = 100,
    user_id: str | None = None,
    _: str = Depends(require_admin_session),
):
    """Global feed of recent activity across all users + all studio types.

    If `user_id` is provided, behaves like the per-user endpoint.
    Items include presigned `audio_url` (when still valid), user email/name,
    and a `by_day` breakdown for stacking charts.
    """
    return await _build_recent_activity(user_id, limit)


# ----- Admin: blocklist (blocked_entities table) -----


@router.get("/blocklist", response_model=BlocklistResponse)
async def get_blocklist():
    """List all blacklisted hotkeys (blocked_entities)."""
    async with acquire() as conn:
        try:
            rows = await conn.fetch("SELECT hotkey FROM blocked_entities ORDER BY created_at DESC")
        except Exception as e:
            if "does not exist" in str(e).lower():
                return BlocklistResponse(hotkeys=[])
            raise
    return BlocklistResponse(hotkeys=[r["hotkey"] for r in rows])


@router.post("/blocklist", response_model=BlocklistResponse)
async def add_to_blocklist(
    body: BlocklistAddRequest,
    _: str = Depends(require_admin_session),
):
    """Add a hotkey to the blocklist. Requires admin email header."""
    hotkey = (body.hotkey or "").strip()
    if not hotkey:
        raise HTTPException(status_code=400, detail="hotkey required")
    async with acquire() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO blocked_entities (hotkey, reason, added_by)
                VALUES ($1, $2, $3)
                ON CONFLICT (hotkey) DO UPDATE SET reason = EXCLUDED.reason, added_by = EXCLUDED.added_by
                """,
                hotkey,
                "Added via dashboard",
                "dashboard-admin",
            )
            rows = await conn.fetch("SELECT hotkey FROM blocked_entities ORDER BY created_at DESC")
        except Exception as e:
            if "does not exist" in str(e).lower():
                raise HTTPException(
                    status_code=503,
                    detail="blocked_entities table not found. Ensure Vocence DB schema is applied.",
                )
            raise
    return BlocklistResponse(hotkeys=[r["hotkey"] for r in rows])


@router.delete("/blocklist/{hotkey:path}")
async def remove_from_blocklist(
    hotkey: str,
    _: str = Depends(require_admin_session),
):
    """Remove a hotkey from the blocklist. Requires admin email header."""
    async with acquire() as conn:
        try:
            result = await conn.execute(
                "DELETE FROM blocked_entities WHERE hotkey = $1",
                hotkey.strip(),
            )
        except Exception as e:
            if "does not exist" in str(e).lower():
                raise HTTPException(status_code=503, detail="blocked_entities table not found")
            raise
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Hotkey not in blocklist")
    return {"ok": True, "message": "Removed from blocklist"}


# ----- Admin: blog -----

UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"


@router.get("/blog", response_model=BlogPostListResponse)
async def list_blog_posts(
    limit: int = Query(12, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """List blog posts (newest first) with optional pagination. Admin may request up to 500."""
    await ensure_tables()
    conn = await get_connection()
    try:
        total_row = await (await conn.execute("SELECT COUNT(*) AS n FROM blog_posts WHERE is_published = 1")).fetchone()
        total = int(total_row["n"] or 0)
        rows = await (await conn.execute(
            """
            SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
            FROM blog_posts
            WHERE is_published = 1
            ORDER BY datetime(created_at) DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        )).fetchall()
    finally:
        await conn.close()
    posts = [
        BlogPostResponse(
            id=str(r["id"]),
            title=r["title"],
            excerpt=r["excerpt"],
            category=r["category"],
            date=r["date"],
            read_time=r["read_time"] or "5 min read",
            image=r["image"],
            content=r["content"],
            featured=bool(r["featured"]),
            created_at=r["created_at"],
        )
        for r in rows
    ]
    return BlogPostListResponse(posts=posts, total=total)


@router.get("/blog/{post_id}", response_model=BlogPostResponse)
async def get_blog_post(post_id: str):
    """Get a single blog post by id."""
    await ensure_tables()
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            """
            SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
            FROM blog_posts
            WHERE id = ? AND is_published = 1
            """,
            (post_id,),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    return BlogPostResponse(
        id=str(row["id"]),
        title=row["title"],
        excerpt=row["excerpt"],
        category=row["category"],
        date=row["date"],
        read_time=row["read_time"] or "5 min read",
        image=row["image"],
        content=row["content"],
        featured=bool(row["featured"]),
        created_at=row["created_at"],
    )


@router.post("/blog/upload")
async def upload_blog_image(
    file: UploadFile,
    _: str = Depends(require_admin_session),
):
    """Upload an image for a blog post. Returns the URL path to use in POST /blog."""
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="File must be an image")
    ext = Path(file.filename or "img").suffix or ".jpg"
    name = f"{uuid.uuid4().hex}{ext}"
    path = UPLOADS_DIR / name
    content = await file.read()
    path.write_bytes(content)
    return {"url": f"/api/dashboard/uploads/{name}"}


@router.post("/blog", response_model=BlogPostResponse)
async def create_blog_post(
    body: BlogPostCreateRequest,
    admin_email: str = Depends(require_admin_session),
):
    """Create a blog post. Requires admin email header."""
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%B %d, %Y")
    post_id = uuid.uuid4().hex
    await ensure_tables()
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO blog_posts (id, title, excerpt, category, date, read_time, image, content, featured, is_published, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
            """,
            (
                post_id,
                body.title,
                body.excerpt,
                body.category,
                date_str,
                body.read_time,
                body.image,
                body.content,
                int(body.featured),
            ),
        )
        await log_admin_action(
            conn,
            admin_email=admin_email,
            action="create_blog_post",
            target_type="blog_post",
            target_id=post_id,
            metadata={"title": body.title},
        )
        await conn.commit()
    finally:
        await conn.close()
    return BlogPostResponse(
        id=post_id,
        title=body.title,
        excerpt=body.excerpt,
        category=body.category,
        date=date_str,
        read_time=body.read_time or "5 min read",
        image=body.image,
        content=body.content,
        featured=body.featured,
        created_at=now.isoformat(),
    )


@router.patch("/blog/{post_id}", response_model=BlogPostResponse)
async def update_blog_post(
    post_id: str,
    body: BlogPostUpdateRequest,
    admin_email: str = Depends(require_admin_session),
):
    """Update a blog post. Date and created_at are left unchanged (published date preserved)."""
    await ensure_tables()
    conn = await get_connection()
    try:
        await conn.execute(
            """
            UPDATE blog_posts
            SET title = ?, excerpt = ?, category = ?, read_time = ?, image = ?, content = ?, featured = ?, updated_at = datetime('now')
            WHERE id = ?
            """,
            (
                body.title,
                body.excerpt,
                body.category,
                body.read_time,
                body.image,
                body.content,
                int(body.featured),
                post_id,
            ),
        )
        row = await (await conn.execute(
            """
            SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
            FROM blog_posts
            WHERE id = ?
            """,
            (post_id,),
        )).fetchone()
        await log_admin_action(
            conn,
            admin_email=admin_email,
            action="update_blog_post",
            target_type="blog_post",
            target_id=post_id,
            metadata={"title": body.title},
        )
        await conn.commit()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Post not found")
    return BlogPostResponse(
        id=str(row["id"]),
        title=row["title"],
        excerpt=row["excerpt"],
        category=row["category"],
        date=row["date"],
        read_time=row["read_time"] or "5 min read",
        image=row["image"],
        content=row["content"],
        featured=bool(row["featured"]),
        created_at=row["created_at"],
    )


@router.delete("/blog/{post_id}")
async def delete_blog_post(
    post_id: str,
    admin_email: str = Depends(require_admin_session),
):
    """Delete a blog post. Requires admin email header."""
    await ensure_tables()
    conn = await get_connection()
    try:
        cursor = await conn.execute("DELETE FROM blog_posts WHERE id = ?", (post_id,))
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Post not found")
        await log_admin_action(
            conn,
            admin_email=admin_email,
            action="delete_blog_post",
            target_type="blog_post",
            target_id=post_id,
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}
