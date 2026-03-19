"""Dashboard API routes."""

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, Header, HTTPException, Query, UploadFile
from fastapi.responses import JSONResponse

from database import acquire
from local_db import get_connection, ensure_tables
from ranking import (
    RANKING_WINDOW_EVALS,
    get_ranked_miner_stats_for_validator,
    sort_miners_for_display,
)
from schemas import (
    ADMIN_EMAIL,
    ActivityBucketResponse,
    ActivityResponse,
    AddValidatorRequest,
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
    ValidatorResponse,
    ValidatorsResponse,
)

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])


def require_admin_email(x_admin_email: str | None = Header(None, alias="X-Admin-Email")):
    if x_admin_email != ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="Admin access required")
    return x_admin_email


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
    _: str = Depends(require_admin_email),
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
    _: str = Depends(require_admin_email),
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
                       prompt, reasoning, original_audio_url, generated_audio_url
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
                       prompt, reasoning, original_audio_url, generated_audio_url
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
async def register_user(body: RegisteredUserRegisterRequest):
    """Register or update a website user (called after login). Stored in local SQLite only."""
    email = (body.email or "").strip()
    if not email:
        raise HTTPException(status_code=400, detail="email required")
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
            (email, body.name or "", body.picture),
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
async def list_registered_users(_: str = Depends(require_admin_email)):
    """List all registered website users (admin only). From local SQLite."""
    await ensure_tables()
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "SELECT id, email, name, picture, created_at, updated_at FROM registered_users ORDER BY created_at DESC"
        )
        rows = await cursor.fetchall()
    finally:
        await conn.close()
    users = [
        RegisteredUserResponse(
            id=r[0],
            email=r[1],
            name=r[2] or "",
            picture=r[3],
            created_at=r[4] or "",
            updated_at=r[5] or "",
        )
        for r in rows
    ]
    return RegisteredUsersListResponse(users=users)


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
    _: str = Depends(require_admin_email),
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
    _: str = Depends(require_admin_email),
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
    async with acquire() as conn:
        total_row = await conn.fetchrow("SELECT COUNT(*) AS n FROM blog_posts")
        total = int(total_row["n"] or 0)
        rows = await conn.fetch(
            """
            SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
            FROM blog_posts ORDER BY created_at DESC
            LIMIT $1 OFFSET $2
            """,
            limit,
            offset,
        )
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
            featured=r["featured"],
            created_at=r["created_at"].isoformat() if r["created_at"] else None,
        )
        for r in rows
    ]
    return BlogPostListResponse(posts=posts, total=total)


@router.get("/blog/{post_id}", response_model=BlogPostResponse)
async def get_blog_post(post_id: str):
    """Get a single blog post by id."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at FROM blog_posts WHERE id = $1",
            post_id,
        )
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
        featured=row["featured"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
    )


@router.post("/blog/upload")
async def upload_blog_image(
    file: UploadFile,
    _: str = Depends(require_admin_email),
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
    _: str = Depends(require_admin_email),
):
    """Create a blog post. Requires admin email header."""
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%B %d, %Y")
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO blog_posts (title, excerpt, category, date, read_time, image, content, featured)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, title, excerpt, category, date, read_time, image, content, featured, created_at
            """,
            body.title,
            body.excerpt,
            body.category,
            date_str,
            body.read_time,
            body.image,
            body.content,
            body.featured,
        )
    return BlogPostResponse(
        id=str(row["id"]),
        title=row["title"],
        excerpt=row["excerpt"],
        category=row["category"],
        date=row["date"],
        read_time=row["read_time"] or "5 min read",
        image=row["image"],
        content=row["content"],
        featured=row["featured"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
    )


@router.patch("/blog/{post_id}", response_model=BlogPostResponse)
async def update_blog_post(
    post_id: str,
    body: BlogPostUpdateRequest,
    _: str = Depends(require_admin_email),
):
    """Update a blog post. Date and created_at are left unchanged (published date preserved)."""
    async with acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE blog_posts
            SET title = $1, excerpt = $2, category = $3, read_time = $4, image = $5, content = $6, featured = $7
            WHERE id = $8
            RETURNING id, title, excerpt, category, date, read_time, image, content, featured, created_at
            """,
            body.title,
            body.excerpt,
            body.category,
            body.read_time,
            body.image,
            body.content,
            body.featured,
            post_id,
        )
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
        featured=row["featured"],
        created_at=row["created_at"].isoformat() if row["created_at"] else None,
    )


@router.delete("/blog/{post_id}")
async def delete_blog_post(
    post_id: str,
    _: str = Depends(require_admin_email),
):
    """Delete a blog post. Requires admin email header."""
    async with acquire() as conn:
        result = await conn.execute("DELETE FROM blog_posts WHERE id = $1", post_id)
    if result == "DELETE 0":
        raise HTTPException(status_code=404, detail="Post not found")
    return {"ok": True}
