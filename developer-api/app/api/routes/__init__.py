from __future__ import annotations

from fastapi import APIRouter

from app.api.routes.account import router as account_router
from app.api.routes.agent_knowledge import router as agent_knowledge_router
from app.api.routes.agent_mgmt import router as agent_mgmt_router
from app.api.routes.agents import router as agents_router
from app.api.routes.agents_extra import router as agents_extra_router
from app.api.routes.embed_tokens import router as embed_tokens_router
from app.api.routes.feedback import router as feedback_router
from app.api.routes.streaming import router as streaming_router
from app.api.routes.v1 import router as v1_router

router = APIRouter()
router.include_router(v1_router)
router.include_router(agents_router)
router.include_router(agent_mgmt_router)
router.include_router(agents_extra_router)
router.include_router(agent_knowledge_router)
router.include_router(embed_tokens_router)
router.include_router(feedback_router)
router.include_router(streaming_router)
router.include_router(account_router)

