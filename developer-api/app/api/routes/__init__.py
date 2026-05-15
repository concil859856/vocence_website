from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.account import router as account_router
from app.api.routes.agent_mgmt import router as agent_mgmt_router
from app.api.routes.agents import router as agents_router
from app.api.routes.v1 import router as v1_router

router = APIRouter()
router.include_router(v1_router)
router.include_router(agents_router)
router.include_router(agent_mgmt_router)
router.include_router(account_router)

