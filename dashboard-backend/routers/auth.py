"""
Auth API (login, verify, users, credits, history).
Merged from backend-example; uses same SQLite as dashboard (auth_users, auth_history).
"""

import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from local_db import get_connection

JWT_SECRET = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30

router = APIRouter(prefix="/api", tags=["auth"])


# ----- Request/response models (match frontend / former Node API) -----


class LoginRequest(BaseModel):
    email: str
    name: str
    picture: str | None = None
    googleId: str


class UserOut(BaseModel):
    """User as returned to frontend (camelCase for createdAt)."""
    id: str
    email: str
    name: str
    picture: str | None
    credits: int
    createdAt: str


class LoginResponse(BaseModel):
    user: UserOut
    token: str


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    user: UserOut


class CreditsUpdateRequest(BaseModel):
    credits: int


class HistoryItemRequest(BaseModel):
    type: str
    content: str | None = None
    style_prompt: str | None = None
    model: str | None = None
    meta: str | None = None
    duration: str | None = None


def _user_row_to_out(row) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        name=row["name"],
        picture=row["picture"],
        credits=row["credits"],
        createdAt=row["created_at"],
    )


def _make_token(user_id: str, email: str) -> str:
    payload = {
        "userId": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


async def _get_user_by_id(user_id: str) -> UserOut | None:
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "SELECT id, email, name, picture, credits, created_at FROM auth_users WHERE id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return None
        return _user_row_to_out(row)
    finally:
        await conn.close()


def require_auth(authorization: str | None = Header(None, alias="Authorization")) -> str:
    """Dependency: Bearer token -> userId."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization.split(" ", 1)[1]
    decoded = _decode_token(token)
    return decoded["userId"]


# ----- Routes -----


@router.post("/auth/login", response_model=LoginResponse)
async def auth_login(body: LoginRequest):
    if not body.email or not body.name or not body.googleId:
        raise HTTPException(status_code=400, detail="Missing required fields")
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "SELECT id, email, name, picture, credits, created_at FROM auth_users WHERE email = ?",
            (body.email,),
        )
        row = await cursor.fetchone()
        if row is not None:
            user_out = _user_row_to_out(row)
            token = _make_token(user_out.id, user_out.email)
            return LoginResponse(user=user_out, token=token)
        created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        await conn.execute(
            """INSERT INTO auth_users (id, email, name, picture, credits, created_at)
               VALUES (?, ?, ?, ?, 100, ?)""",
            (body.googleId, body.email, body.name, body.picture or None, created_at),
        )
        await conn.commit()
        user_out = UserOut(
            id=body.googleId,
            email=body.email,
            name=body.name,
            picture=body.picture,
            credits=100,
            createdAt=created_at,
        )
        token = _make_token(user_out.id, user_out.email)
        return LoginResponse(user=user_out, token=token)
    finally:
        await conn.close()


@router.post("/auth/verify", response_model=VerifyResponse)
async def auth_verify(body: VerifyRequest):
    if not body.token:
        raise HTTPException(status_code=400, detail="No token provided")
    decoded = _decode_token(body.token)
    user = await _get_user_by_id(decoded["userId"])
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return VerifyResponse(user=user)


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: str, userId: str = Depends(require_auth)):
    if user_id != userId:
        raise HTTPException(status_code=403, detail="Unauthorized")
    user = await _get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.patch("/users/{user_id}/credits", response_model=UserOut)
async def update_credits(
    user_id: str, body: CreditsUpdateRequest, userId: str = Depends(require_auth)
):
    if user_id != userId:
        raise HTTPException(status_code=403, detail="Unauthorized")
    if not isinstance(body.credits, int):
        raise HTTPException(status_code=400, detail="Invalid credits value")
    conn = await get_connection()
    try:
        await conn.execute("UPDATE auth_users SET credits = ? WHERE id = ?", (body.credits, user_id))
        await conn.commit()
        user = await _get_user_by_id(user_id)
        if user is None:
            raise HTTPException(status_code=500, detail="Failed to fetch updated user")
        return user
    finally:
        await conn.close()


@router.post("/history")
async def post_history(
    body: HistoryItemRequest, userId: str = Depends(require_auth)
):
    history_id = str(int(datetime.now(timezone.utc).timestamp() * 1000))
    conn = await get_connection()
    try:
        await conn.execute(
            """INSERT INTO auth_history (id, user_id, type, content, style_prompt, model, meta, duration)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                history_id,
                userId,
                body.type,
                body.content,
                body.style_prompt,
                body.model,
                body.meta,
                body.duration,
            ),
        )
        await conn.commit()
        return {"id": history_id, "success": True}
    finally:
        await conn.close()


@router.get("/history")
async def get_history(userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """SELECT id, user_id, type, content, style_prompt, model, meta, duration, created_at
               FROM auth_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100""",
            (userId,),
        )
        rows = await cursor.fetchall()
        return [
            {
                "id": r["id"],
                "user_id": r["user_id"],
                "type": r["type"],
                "content": r["content"],
                "style_prompt": r["style_prompt"],
                "model": r["model"],
                "meta": r["meta"],
                "duration": r["duration"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        await conn.close()
