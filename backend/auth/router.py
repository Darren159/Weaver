"""
Auth routes:
  GET  /auth/google          → redirect to Google consent screen
  POST /auth/google/start    → start OAuth with custom credentials
  GET  /auth/google/callback → exchange code, store refresh_token, return token
  DELETE /auth/google        → revoke stored credentials for the user
"""

import json
import os
import uuid
from threading import Lock

from fastapi import APIRouter, HTTPException, Query, Body
from fastapi.responses import RedirectResponse, JSONResponse, HTMLResponse
from pydantic import BaseModel

from backend.config import settings
from backend.auth import google_oauth, token_store

router = APIRouter(prefix="/auth", tags=["auth"])

_states_lock = Lock()


class GoogleAuthStartRequest(BaseModel):
    client_id: str
    client_secret: str
    redirect_uri: str = "http://localhost:8000/auth/google/callback"


class GoogleAuthStartResponse(BaseModel):
    auth_url: str
    user_id: str


def _states_path() -> str:
    return os.path.join(os.path.dirname(settings.token_store_path), "pending_states.json")


def _load_states() -> dict:
    path = _states_path()
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def _save_states(data: dict) -> None:
    path = _states_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f)


@router.get("/google")
def google_login():
    """
    Initiate the Google OAuth 2.0 flow.
    Returns a redirect to the Google consent page.
    """
    flow = google_oauth.build_flow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=settings.oauth_redirect_uri,
    )
    code_verifier, code_challenge = google_oauth.generate_pkce_pair()
    auth_url, state = google_oauth.get_authorization_url(flow, code_challenge)

    user_id = str(uuid.uuid4())
    with _states_lock:
        data = _load_states()
        data[state] = {"user_id": user_id, "code_verifier": code_verifier}
        _save_states(data)

    return RedirectResponse(auth_url)


class GoogleInitResponse(BaseModel):
    auth_url: str
    user_id: str


@router.get("/google/init", response_model=GoogleInitResponse)
def google_init():
    """
    Return the Google OAuth URL and a pre-assigned user_id without redirecting.
    The frontend opens the auth_url in a popup, then polls /auth/google/status.
    """
    flow = google_oauth.build_flow(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=settings.oauth_redirect_uri,
    )
    code_verifier, code_challenge = google_oauth.generate_pkce_pair()
    auth_url, state = google_oauth.get_authorization_url(flow, code_challenge)

    user_id = str(uuid.uuid4())
    with _states_lock:
        data = _load_states()
        data[state] = {"user_id": user_id, "code_verifier": code_verifier}
        _save_states(data)

    return GoogleInitResponse(auth_url=auth_url, user_id=user_id)


@router.get("/google/status")
def google_status(user_id: str = Query(...)):
    """Return whether the given user_id has stored credentials."""
    token = token_store.load_token(user_id, settings.token_store_path)
    return {"authenticated": token is not None}


@router.post("/google/start", response_model=GoogleAuthStartResponse)
def google_auth_start(request: GoogleAuthStartRequest = Body(...)):
    """
    Initiate the Google OAuth 2.0 flow with custom credentials.
    Accepts client_id and client_secret in the request body.
    Returns the authorization URL and user_id.
    """
    flow = google_oauth.build_flow(
        client_id=request.client_id,
        client_secret=request.client_secret,
        redirect_uri=request.redirect_uri,
    )
    code_verifier, code_challenge = google_oauth.generate_pkce_pair()
    auth_url, state = google_oauth.get_authorization_url(flow, code_challenge)

    user_id = str(uuid.uuid4())
    with _states_lock:
        data = _load_states()
        data[state] = {
            "user_id": user_id,
            "code_verifier": code_verifier,
            "client_id": request.client_id,
            "client_secret": request.client_secret,
            "redirect_uri": request.redirect_uri,
        }
        _save_states(data)

    return GoogleAuthStartResponse(auth_url=auth_url, user_id=user_id)


@router.get("/google/callback")
def google_callback(
    code: str = Query(...),
    state: str = Query(...),
):
    """
    Handle Google's OAuth callback.
    Exchanges the auth code for tokens, persists the refresh_token,
    and returns the assigned user_id (acts as an opaque API key for dev).
    """
    with _states_lock:
        data = _load_states()
        entry = data.pop(state, None)
        if entry is not None:
            _save_states(data)

    if entry is None:
        raise HTTPException(status_code=400, detail="Unknown or expired OAuth state.")

    user_id = entry["user_id"]
    code_verifier = entry["code_verifier"]
    
    # Use stored credentials if available (from POST /auth/google/start),
    # otherwise fall back to environment variables (for GET /auth/google)
    client_id = entry.get("client_id", settings.google_client_id)
    client_secret = entry.get("client_secret", settings.google_client_secret)
    redirect_uri = entry.get("redirect_uri", settings.oauth_redirect_uri)

    flow = google_oauth.build_flow(
        client_id=client_id,
        client_secret=client_secret,
        redirect_uri=redirect_uri,
    )
    flow.fetch_token(code=code, code_verifier=code_verifier)
    token_data = google_oauth._creds_to_dict(flow.credentials)

    token_store.save_token(user_id, token_data, settings.token_store_path)

    # Write user_id to a shared file so CLI scripts can pick it up without manual copy-paste.
    handoff_path = os.path.join(os.path.dirname(settings.token_store_path), "latest_auth.json")
    with open(handoff_path, "w") as f:
        json.dump({"user_id": user_id}, f)

    return HTMLResponse("""
<!doctype html>
<html>
<head><title>Authenticated</title></head>
<body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f4f8;">
  <div style="text-align:center;">
    <h2 style="color:#1f5134;">&#10003; Google Drive connected!</h2>
    <p style="color:#4b5563;">You can close this window and return to Weaver.</p>
    <script>window.close();</script>
  </div>
</body>
</html>
""")


@router.delete("/google")
def google_logout(user_id: str = Query(..., description="user_id returned by callback")):
    """Remove stored credentials for this user."""
    token_store.delete_token(user_id, settings.token_store_path)
    return {"message": "Credentials removed."}
