"""
Ingest routes — chunk and index content into the appropriate ES index:
  POST /ingest/drive   — Google Drive folder (PDFs + Google Docs) → drive-docs
  POST /ingest/github  — GitHub repo/folder (markdown files) → github-docs
"""

import io
import re
import logging
import httpx

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from googleapiclient.http import MediaIoBaseDownload

from backend.drive import service as drive_service
from backend.drive.router import get_credentials, extract_folder_id
from backend.ingest.chunkers import chunk_pdf_bytes, chunk_text
from backend.elastic import get_client, DRIVE_INDEX, GITHUB_INDEX

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/ingest", tags=["ingest"])

BATCH_SIZE = 30
GDOC_MIME = "application/vnd.google-apps.document"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _bulk_index(docs: list[dict], index: str) -> tuple[int, list[str]]:
    """Bulk-index docs into the given index. Returns (success_count, errors)."""
    if not docs:
        return 0, []

    operations = []
    for doc in docs:
        operations.append({"index": {"_index": index}})
        operations.append(doc)

    result = get_client().bulk(operations=operations)
    errors = [
        str(item.get("index", {}).get("error", ""))
        for item in result["items"]
        if item.get("index", {}).get("error")
    ]
    return len(docs) - len(errors), errors


def _export_gdoc_as_text(creds, file_id: str) -> bytes:
    """Export a Google Doc as plain text bytes."""
    service = drive_service.build_drive_service(creds)
    request = service.files().export_media(fileId=file_id, mimeType="text/plain")
    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()
    return buffer.getvalue()


# ── Drive ingest ──────────────────────────────────────────────────────────────

class DriveIngestRequest(BaseModel):
    folder_link: str
    recursive: bool = False


class IngestResponse(BaseModel):
    indexed: int
    files_processed: int
    skipped: int
    errors: list[str]


@router.post("/drive", response_model=IngestResponse)
def ingest_drive(body: DriveIngestRequest, creds=Depends(get_credentials)):
    """
    Download all PDFs and Google Docs from a Drive folder in-memory,
    chunk them, and index into drive-docs.
    """
    folder_id = extract_folder_id(body.folder_link)
    files = drive_service.list_files(
        credentials=creds,
        folder_id=folder_id,
        recursive=body.recursive,
    )

    source = f"google-drive/{folder_id}"
    total_indexed = 0
    files_processed = 0
    skipped = 0
    all_errors: list[str] = []
    batch: list[dict] = []

    for f in files:
        try:
            if f.mime_type == GDOC_MIME:
                raw = _export_gdoc_as_text(creds, f.id)
                text = raw.decode("utf-8", errors="replace")
                chunks = chunk_text(text, f.name, source, "drive-doc")

            elif f.mime_type == "application/pdf":
                data, _, file_name = drive_service.download_file(creds, f)
                chunks = chunk_pdf_bytes(data, file_name, source)

            else:
                logger.debug("Skipping unsupported file type: %s (%s)", f.name, f.mime_type)
                skipped += 1
                continue

            if not chunks:
                skipped += 1
                continue

            files_processed += 1
            batch.extend(chunks)

            if len(batch) >= BATCH_SIZE:
                n, errs = _bulk_index(batch, DRIVE_INDEX)
                total_indexed += n
                all_errors.extend(errs)
                batch = []

        except Exception as exc:
            msg = f"{f.name}: {exc}"
            all_errors.append(msg)
            logger.error("Drive ingest error — %s", msg)

    if batch:
        n, errs = _bulk_index(batch, DRIVE_INDEX)
        total_indexed += n
        all_errors.extend(errs)

    return IngestResponse(
        indexed=total_indexed,
        files_processed=files_processed,
        skipped=skipped,
        errors=all_errors,
    )


# ── GitHub ingest ─────────────────────────────────────────────────────────────

class GithubIngestRequest(BaseModel):
    url: str
    token: str | None = None  # optional, for private repos


_GH_URL_RE = re.compile(
    r"github\.com/(?P<owner>[^/]+)/(?P<repo>[^/]+)"
    r"(?:/(?:tree|blob)/(?P<branch>[^/]+)(?P<path>/.*)?)?"
)


def _parse_github_url(url: str) -> tuple[str, str, str, str]:
    """Returns (owner, repo, branch, path). Raises HTTPException on bad URL."""
    m = _GH_URL_RE.search(url)
    if not m:
        raise HTTPException(status_code=400, detail=f"Could not parse GitHub URL: {url}")
    owner = m.group("owner")
    repo = m.group("repo")
    branch = m.group("branch") or "main"
    path = (m.group("path") or "").lstrip("/")
    return owner, repo, branch, path


def _list_md_files(owner: str, repo: str, branch: str, path: str, headers: dict) -> list[dict]:
    """Recursively list all .md files under path using the GitHub Contents API."""
    url = f"https://api.github.com/repos/{owner}/{repo}/contents/{path}"
    params = {"ref": branch}

    with httpx.Client(timeout=30.0) as client_http:
        resp = client_http.get(url, headers=headers, params=params)

    if resp.status_code == 404:
        raise HTTPException(status_code=404, detail=f"GitHub path not found: {path or '/'}")
    resp.raise_for_status()

    items = resp.json()
    if isinstance(items, dict):
        items = [items]

    md_files = []
    subdirs = []
    for item in items:
        if item["type"] == "file" and item["name"].endswith(".md"):
            md_files.append(item)
        elif item["type"] == "dir":
            subdirs.append(item["path"])

    for subpath in subdirs:
        md_files.extend(_list_md_files(owner, repo, branch, subpath, headers))

    return md_files


@router.post("/github", response_model=IngestResponse)
def ingest_github(body: GithubIngestRequest):
    """
    Fetch all .md files from a GitHub repo or folder URL,
    chunk them, and index into github-docs.
    """
    owner, repo, branch, path = _parse_github_url(body.url)
    source = f"github/{owner}/{repo}"

    gh_headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if body.token:
        gh_headers["Authorization"] = f"Bearer {body.token}"

    try:
        md_files = _list_md_files(owner, repo, branch, path, gh_headers)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub API error: {exc}")

    if not md_files:
        return IngestResponse(indexed=0, files_processed=0, skipped=0, errors=["No .md files found"])

    total_indexed = 0
    files_processed = 0
    skipped = 0
    all_errors: list[str] = []
    batch: list[dict] = []

    with httpx.Client(timeout=30.0) as http:
        for item in md_files:
            try:
                raw_url = item.get("download_url")
                if not raw_url:
                    skipped += 1
                    continue

                resp = http.get(raw_url, headers=gh_headers if body.token else {})
                resp.raise_for_status()

                chunks = chunk_text(resp.text, item["name"], source, "github-markdown")
                if not chunks:
                    skipped += 1
                    continue

                files_processed += 1
                batch.extend(chunks)

                if len(batch) >= BATCH_SIZE:
                    n, errs = _bulk_index(batch, GITHUB_INDEX)
                    total_indexed += n
                    all_errors.extend(errs)
                    batch = []

            except Exception as exc:
                msg = f"{item.get('path', item['name'])}: {exc}"
                all_errors.append(msg)
                logger.error("GitHub ingest error — %s", msg)

    if batch:
        n, errs = _bulk_index(batch, GITHUB_INDEX)
        total_indexed += n
        all_errors.extend(errs)

    return IngestResponse(
        indexed=total_indexed,
        files_processed=files_processed,
        skipped=skipped,
        errors=all_errors,
    )
