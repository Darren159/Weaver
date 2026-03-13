"""
Google Drive v3 service: list and download files from a folder.

- Binary files  → files.get(alt='media')
- Google Docs   → files.export(mimeType='application/pdf')
- Google Sheets → files.export(mimeType='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
- Google Slides → files.export(mimeType='application/vnd.openxmlformats-officedocument.presentationml.presentation')

Pagination is handled automatically; all pages are returned.
"""

import io
from dataclasses import dataclass
from typing import Generator

from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from google.oauth2.credentials import Credentials

# Maps Google Workspace MIME types → export MIME types and file extensions.
GOOGLE_EXPORT_MAP: dict[str, tuple[str, str]] = {
    "application/vnd.google-apps.document": (
        "application/pdf",
        ".pdf",
    ),
    "application/vnd.google-apps.spreadsheet": (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".xlsx",
    ),
    "application/vnd.google-apps.presentation": (
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".pdf",
    ),
}

# Google Workspace types that cannot be downloaded directly.
GOOGLE_WORKSPACE_TYPES = set(GOOGLE_EXPORT_MAP.keys())


@dataclass
class DriveFile:
    id: str
    name: str
    mime_type: str
    size: int | None  # None for Google Workspace files


def build_drive_service(credentials: Credentials):
    return build("drive", "v3", credentials=credentials)


def list_files(
    credentials: Credentials,
    folder_id: str,
    recursive: bool = False,
    mime_type_filter: list[str] | None = None,
    max_files: int | None = None,
) -> list[DriveFile]:
    """
    Return all files in `folder_id`.
    If `recursive=True`, also recurse into sub-folders.
    `mime_type_filter` restricts results to specific MIME types.
    `max_files` caps the total number of items returned.
    """
    service = build_drive_service(credentials)
    results: list[DriveFile] = []
    _collect_files(
        service=service,
        folder_id=folder_id,
        recursive=recursive,
        mime_type_filter=mime_type_filter,
        max_files=max_files,
        results=results,
    )
    return results


def _collect_files(
    service,
    folder_id: str,
    recursive: bool,
    mime_type_filter: list[str] | None,
    max_files: int | None,
    results: list[DriveFile],
) -> None:
    page_token: str | None = None
    while True:
        query = f"'{folder_id}' in parents and trashed = false"
        response = (
            service.files()
            .list(
                q=query,
                pageSize=100,
                fields="nextPageToken, files(id, name, mimeType, size)",
                pageToken=page_token,
                supportsAllDrives=True,
                includeItemsFromAllDrives=True,
            )
            .execute()
        )

        for item in response.get("files", []):
            if max_files is not None and len(results) >= max_files:
                return

            mime = item["mimeType"]

            if mime == "application/vnd.google-apps.folder":
                if recursive:
                    _collect_files(
                        service=service,
                        folder_id=item["id"],
                        recursive=recursive,
                        mime_type_filter=mime_type_filter,
                        max_files=max_files,
                        results=results,
                    )
                continue

            if mime_type_filter and mime not in mime_type_filter:
                continue

            results.append(
                DriveFile(
                    id=item["id"],
                    name=item["name"],
                    mime_type=mime,
                    size=int(item["size"]) if item.get("size") else None,
                )
            )

        page_token = response.get("nextPageToken")
        if not page_token:
            break


def download_file(credentials: Credentials, drive_file: DriveFile) -> tuple[bytes, str, str]:
    """
    Download or export a Drive file.
    Returns (file_bytes, content_type, file_name).
    """
    service = build_drive_service(credentials)

    if drive_file.mime_type in GOOGLE_WORKSPACE_TYPES:
        export_mime, extension = GOOGLE_EXPORT_MAP[drive_file.mime_type]
        file_name = drive_file.name + extension
        request = service.files().export_media(
            fileId=drive_file.id, mimeType=export_mime
        )
        content_type = export_mime
    else:
        file_name = drive_file.name
        request = service.files().get_media(fileId=drive_file.id, supportsAllDrives=True)
        content_type = drive_file.mime_type

    buffer = io.BytesIO()
    downloader = MediaIoBaseDownload(buffer, request)
    done = False
    while not done:
        _, done = downloader.next_chunk()

    return buffer.getvalue(), content_type, file_name
