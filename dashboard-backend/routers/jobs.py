"""Generation jobs API: submit, poll, cancel, list."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from jobs import api as jobs_api
from jobs.api import JobAdmissionRejected, JobError
from routers.auth import require_auth


router = APIRouter(prefix="/jobs", tags=["jobs"])


class StartJobRequest(BaseModel):
    type: str  # 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'
    payload: dict
    credits: int = 0  # caller computes / passes the per-type cost


class StartJobResponse(BaseModel):
    job_id: str
    status: str = "pending"
    queue_position: int
    load_warning: bool = False
    pool_snapshots: dict = {}


@router.post("/start", response_model=StartJobResponse)
async def start_job(body: StartJobRequest, user_id: str = Depends(require_auth)):
    try:
        result = await jobs_api.enqueue(
            user_id=user_id,
            type=body.type,
            payload=body.payload,
            credits_to_charge=int(body.credits),
        )
    except JobAdmissionRejected as e:
        raise HTTPException(
            status_code=503,
            detail=e.message,
            headers={"Retry-After": str(e.retry_after_seconds)},
        )
    except JobError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return StartJobResponse(
        job_id=result.job_id,
        queue_position=result.queue_position,
        load_warning=result.load_warning,
        pool_snapshots=result.pool_snapshots,
    )


@router.get("/{job_id}")
async def get_job(job_id: str, user_id: str = Depends(require_auth)):
    try:
        return await jobs_api.get_job(job_id=job_id, user_id=user_id)
    except JobError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.delete("/{job_id}")
async def cancel_job(job_id: str, user_id: str = Depends(require_auth)):
    try:
        cancelled = await jobs_api.cancel_job(job_id=job_id, user_id=user_id)
    except JobError as e:
        raise HTTPException(status_code=404, detail=str(e))
    return {"cancelled": cancelled}


@router.get("")
async def list_jobs(limit: int = 50, user_id: str = Depends(require_auth)):
    items = await jobs_api.list_jobs(user_id=user_id, limit=limit)
    return {"items": items}
