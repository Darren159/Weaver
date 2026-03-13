from __future__ import annotations

from typing import List

from fastapi import APIRouter, HTTPException

from backend.agents.models import (
    AgentConfig,
    AgentRecord,
    agent_config_to_agent_policy,
    agent_policy_to_agent_record,
)
from backend.elastic_fleet import (
    create_agent_policy,
    delete_agent_policy,
    list_agent_policies,
    update_agent_policy,
)

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("", response_model=List[AgentRecord])
async def list_agents() -> List[AgentRecord]:
    """
    Return all Weaver-managed agents (agent policies whose description
    contains the Weaver marker JSON).
    """
    data = await list_agent_policies()
    items = data.get("items") or []

    records: List[AgentRecord] = []
    for policy in items:
        record = agent_policy_to_agent_record(policy)
        if record is not None:
            records.append(record)
    return records


@router.post("", response_model=AgentRecord, status_code=201)
async def create_agent(req: AgentConfig) -> AgentRecord:
    """
    Create a new Weaver agent backed by a Fleet agent policy.
    The full AgentConfig is embedded in the policy description as JSON.
    """
    payload = agent_config_to_agent_policy(req)
    resp = await create_agent_policy(payload)
    item = resp.get("item") or resp

    record = agent_policy_to_agent_record(item)
    if record is None:
        raise HTTPException(status_code=502, detail="Fleet returned an unexpected agent policy format.")
    return record


@router.put("/{agent_id}", response_model=AgentRecord)
async def update_agent(agent_id: str, req: AgentConfig) -> AgentRecord:
    """
    Update an existing Weaver agent (identified by its Fleet agent policy id).
    """
    payload = agent_config_to_agent_policy(req)
    resp = await update_agent_policy(agent_id, payload)
    item = resp.get("item") or resp

    record = agent_policy_to_agent_record(item)
    if record is None:
        raise HTTPException(status_code=502, detail="Fleet returned an unexpected agent policy format.")
    return record


@router.delete("/{agent_id}", status_code=204)
async def delete_agent(agent_id: str) -> None:
    """
    Delete a Weaver agent and its backing Fleet agent policy.
    """
    await delete_agent_policy(agent_id)
