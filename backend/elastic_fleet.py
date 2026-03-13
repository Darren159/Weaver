import logging
from typing import Any, Dict

import httpx
from fastapi import HTTPException

from backend.config import settings

logger = logging.getLogger(__name__)


def _fleet_base_url() -> str:
    base = settings.kibana_url.rstrip("/")
    if not base:
        raise RuntimeError("Kibana URL is not configured (KIBANA_URL).")
    return base


def _auth_headers() -> Dict[str, str]:
    if settings.kibana_api_key:
        return {"Authorization": f"ApiKey {settings.kibana_api_key}"}
    raise RuntimeError("Kibana API key is not configured (KIBANA_API_KEY).")


async def _request(
    method: str,
    path: str,
    json: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    url = f"{_fleet_base_url()}{path}"
    headers = {
        "Content-Type": "application/json",
        "kbn-xsrf": "true",
        **_auth_headers(),
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.request(method, url, json=json, headers=headers)
    except Exception as e:  # pragma: no cover - network failure path
        logger.error("Fleet request failed: %s %s → %s", method, url, e)
        raise HTTPException(status_code=502, detail="Failed to reach Kibana Fleet API")

    if resp.status_code >= 400:
        detail: Any
        try:
            detail = resp.json()
        except Exception:  # pragma: no cover - non‑JSON error body
            detail = resp.text
        logger.warning(
            "Fleet API error: %s %s → %s %s",
            method,
            url,
            resp.status_code,
            detail,
        )
        raise HTTPException(
            status_code=resp.status_code,
            detail={"message": "Fleet API error", "body": detail},
        )

    try:
        return resp.json()
    except Exception as e:  # pragma: no cover - unexpected body
        logger.error("Failed to decode Fleet response JSON: %s", e)
        raise HTTPException(status_code=502, detail="Invalid response from Fleet API")


# ── Agent policies ──────────────────────────────────────────────────────────────


async def list_agent_policies() -> Dict[str, Any]:
    """
    Thin wrapper around GET /api/fleet/agent_policies.
    """
    return await _request("GET", "/api/fleet/agent_policies")


async def create_agent_policy(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Thin wrapper around POST /api/fleet/agent_policies.
    """
    return await _request("POST", "/api/fleet/agent_policies", json=payload)


async def update_agent_policy(agent_policy_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Thin wrapper around PUT /api/fleet/agent_policies/{agentPolicyId}.
    """
    path = f"/api/fleet/agent_policies/{agent_policy_id}"
    return await _request("PUT", path, json=payload)


async def delete_agent_policy(agent_policy_id: str) -> Dict[str, Any]:
    """
    Thin wrapper around POST /api/fleet/agent_policies/delete.

    The Fleet API uses a POST with a JSON body rather than DELETE + path param.
    """
    return await _request(
        "POST",
        "/api/fleet/agent_policies/delete",
        json={"agentPolicyId": agent_policy_id},
    )


# ── Package policies (integrations) ────────────────────────────────────────────


async def create_package_policy(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Thin wrapper around POST /api/fleet/package_policies.
    """
    return await _request("POST", "/api/fleet/package_policies", json=payload)


async def update_package_policy(package_policy_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Thin wrapper around PUT /api/fleet/package_policies/{packagePolicyId}.
    """
    path = f"/api/fleet/package_policies/{package_policy_id}"
    return await _request("PUT", path, json=payload)

