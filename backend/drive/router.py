"""
Drive routes:
  GET /folders/list — list files in a Drive folder without downloading.

Also exports get_credentials and extract_folder_id for use by other routers.
"""

import logging
import re
from fastapi import APIRouter, Depends, HTTPException, Header, Query
from pydantic import BaseModel

from backend.config import settings
from backend.auth import token_store, google_oauth
from backend.drive import service as drive_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/folders", tags=["drive"])


# ── Auth dependency ───────────────────────────────────────────────────────────

def get_credentials(authorization: str = Header(...)):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Authorization header must be 'Bearer <user_id>'.")

    user_id = authorization.removeprefix("Bearer ").strip()
    token_data = token_store.load_token(user_id, settings.token_store_path)
    if not token_data:
        raise HTTPException(
            status_code=401,
            detail="No credentials found for this user. Please authenticate via GET /auth/google.",
        )

    creds = google_oauth.credentials_from_dict(token_data)
    creds = google_oauth.refresh_if_expired(creds)

    refreshed = google_oauth._creds_to_dict(creds)
    if refreshed.get("token") != token_data.get("token"):
        token_store.save_token(user_id, refreshed, settings.token_store_path)

    creds._user_id = user_id  # type: ignore[attr-defined]
    return creds


# ── URL helper ────────────────────────────────────────────────────────────────

def extract_folder_id(folder_link: str) -> str:
    """Extract folder ID from a Drive URL or return the raw ID if already one."""
    folder_link = folder_link.strip()

    match = re.search(r'/folders/([a-zA-Z0-9_-]+)', folder_link)
    if match:
        return match.group(1)

    match = re.search(r'[?&]id=([a-zA-Z0-9_-]+)', folder_link)
    if match:
        return match.group(1)

    if re.fullmatch(r'[a-zA-Z0-9_-]{10,}', folder_link):
        return folder_link

    raise HTTPException(status_code=400, detail=f"Invalid Google Drive folder link or ID: {folder_link}")


# ── Model ─────────────────────────────────────────────────────────────────────

class FileInfo(BaseModel):
    id: str
    name: str
    mime_type: str
    size: int | None


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/list", response_model=list[FileInfo])
def list_folder(
    folder_link: str = Query(..., description="Google Drive folder URL or folder ID"),
    recursive: bool = False,
    max_files: int | None = None,
    creds=Depends(get_credentials),
):
    """List files in a Drive folder without downloading anything."""
    folder_id = extract_folder_id(folder_link)
    files = drive_service.list_files(
        credentials=creds,
        folder_id=folder_id,
        recursive=recursive,
        max_files=max_files,
    )
    return [FileInfo(id=f.id, name=f.name, mime_type=f.mime_type, size=f.size) for f in files]
