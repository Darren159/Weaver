from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

_WEAVER_MARKER = "__weaver__"


class ToolConfig(BaseModel):
    name: str
    enabled: bool = True
    config: Dict[str, Any] | None = None


class AgentConfig(BaseModel):
    """
    High-level agent configuration used by Weaver.

    Intentionally decoupled from Elastic Fleet's raw JSON; instances are
    serialised into the description field of an agent policy so that no
    Fleet-registered package is required.
    """

    name: str
    description: Optional[str] = None
    system_instructions: str = Field(..., min_length=1)
    tools: List[ToolConfig] = Field(default_factory=list)
    metadata: Dict[str, Any] | None = None


class AgentRecord(BaseModel):
    """Materialised agent as stored in Fleet (backed by an agent policy)."""

    id: str                          # Fleet agent policy id
    agent_policy_id: str
    config: AgentConfig


def agent_config_to_agent_policy(agent: AgentConfig, namespace: str = "default") -> Dict[str, Any]:
    """
    Build a Fleet agent policy payload that embeds AgentConfig in its
    description as a JSON string prefixed with the Weaver marker.

    The returned dict is suitable for POST/PUT /api/fleet/agent_policies.
    """
    encoded = json.dumps({
        _WEAVER_MARKER: True,
        "config": agent.model_dump(mode="json"),
    })
    return {
        "name": agent.name,
        "description": encoded,
        "namespace": namespace,
        "monitoring_enabled": [],
    }


def agent_policy_to_agent_record(policy: Dict[str, Any]) -> AgentRecord | None:
    """
    Parse a Fleet agent policy into an AgentRecord.

    Returns None if the policy was not created by Weaver (i.e. its description
    does not contain the Weaver marker), so callers can skip unrelated policies.
    """
    policy_id = str(policy.get("id", ""))
    raw_desc = policy.get("description") or ""

    try:
        parsed = json.loads(raw_desc)
    except (json.JSONDecodeError, TypeError):
        return None

    if not parsed.get(_WEAVER_MARKER):
        return None

    config_data = parsed.get("config") or {}
    try:
        config = AgentConfig(**config_data)
    except Exception:
        return None

    return AgentRecord(
        id=policy_id,
        agent_policy_id=policy_id,
        config=config,
    )
