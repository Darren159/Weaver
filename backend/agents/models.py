from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class ToolConfig(BaseModel):
    name: str
    enabled: bool = True


class AgentConfig(BaseModel):
    name: str
    description: Optional[str] = None
    system_instructions: str = ""
    tools: List[ToolConfig] = []
    readonly: bool = False


class AgentRecord(BaseModel):
    """An Elastic Agent Builder agent."""

    id: str
    config: AgentConfig


def agent_builder_to_agent_record(agent: Dict[str, Any]) -> AgentRecord:
    """
    Map a single result from GET /api/agent_builder/agents into an AgentRecord.
    """
    cfg = agent.get("configuration") or {}

    # tool_ids are nested: configuration.tools[0].tool_ids
    tool_ids: List[str] = []
    for tool_group in cfg.get("tools") or []:
        tool_ids.extend(tool_group.get("tool_ids") or [])

    return AgentRecord(
        id=str(agent.get("id", "")),
        config=AgentConfig(
            name=agent.get("name", ""),
            description=agent.get("description") or None,
            system_instructions=cfg.get("instructions") or "",
            tools=[ToolConfig(name=tid) for tid in tool_ids],
            readonly=bool(agent.get("readonly", False)),
        ),
    )
