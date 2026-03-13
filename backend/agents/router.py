from __future__ import annotations

from typing import List

from fastapi import APIRouter

from backend.agents.models import AgentRecord, agent_builder_to_agent_record
from backend.elastic_fleet import list_agent_builder_agents

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("", response_model=List[AgentRecord])
async def list_agents() -> List[AgentRecord]:
    """Return all agents from the Kibana Agent Builder."""
    data = await list_agent_builder_agents()
    return [agent_builder_to_agent_record(a) for a in (data.get("results") or [])]
