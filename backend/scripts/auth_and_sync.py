import json
import os
import re
import sys
import time

import httpx

API_BASE = os.getenv("API_BASE_URL", "http://app:8000")
HANDOFF_FILE = "/app/data/latest_auth.json"
AUTH_TIMEOUT_SECS = 120


def _extract_folder_id(folder_link: str) -> str:
    s = folder_link.strip()

    # Common forms:
    # - https://drive.google.com/drive/folders/<FOLDER_ID>
    # - https://drive.google.com/drive/u/0/folders/<FOLDER_ID>
    # - https://drive.google.com/open?id=<FOLDER_ID>
    m = re.search(r"/folders/([a-zA-Z0-9_-]+)", s)
    if m:
        return m.group(1)

    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", s)
    if m:
        return m.group(1)

    # Raw folder id pasted directly.
    if re.fullmatch(r"[a-zA-Z0-9_-]{10,}", s):
        return s

    raise ValueError(f"Could not extract folder_id from: {s!r}")


def step_auth() -> str:
    """
    Direct the user to the backend's /auth/google endpoint in their browser.
    Once the OAuth flow completes, the backend writes the user_id to a shared
    file which this script picks up automatically — no copy-paste needed.
    """
    # Remove any leftover handoff file from a previous auth.
    if os.path.exists(HANDOFF_FILE):
        os.remove(HANDOFF_FILE)

    print()
    print("Step 1 – Google Authentication")
    print("--------------------------------")
    print("Open this URL in your browser to authorise with Google:")
    print()
    print("  http://localhost:8000/auth/google")
    print()
    print(f"Waiting for you to complete auth in the browser (timeout: {AUTH_TIMEOUT_SECS}s)...")

    deadline = time.time() + AUTH_TIMEOUT_SECS
    while time.time() < deadline:
        if os.path.exists(HANDOFF_FILE):
            with open(HANDOFF_FILE) as f:
                data = json.load(f)
            user_id = data.get("user_id", "").strip()
            if user_id:
                os.remove(HANDOFF_FILE)
                print(f"Auth complete! user_id: {user_id}")
                return user_id
        time.sleep(1)

    print("Timed out waiting for authentication. Exiting.")
    sys.exit(1)


def step_sync(user_id: str) -> None:
    print()
    print("Step 2 – Google Drive Folder Sync")
    print("-----------------------------------")
    folder_link = input("Paste Google Drive folder link (or folder_id): ").strip()
    folder_id = _extract_folder_id(folder_link)

    recursive = input("Include subfolders? [y/N]: ").strip().lower() in {"y", "yes"}
    dry_run = input("Dry run (list only, no download)? [y/N]: ").strip().lower() in {"y", "yes"}

    url = f"{API_BASE}/folders/{folder_id}/sync"
    print()
    print(f"Syncing folder: {folder_id}")
    print(f"  recursive={recursive}  dry_run={dry_run}")
    print()

    with httpx.Client(timeout=600.0) as client:
        resp = client.post(
            url,
            headers={"Authorization": f"Bearer {user_id}"},
            json={"recursive": recursive, "dry_run": dry_run},
        )
        resp.raise_for_status()
        data = resp.json()

    print("Sync complete.")
    print(f"  files_found:    {data.get('files_found')}")
    print(f"  files_uploaded: {data.get('files_uploaded')}")

    if data.get("errors"):
        print("  errors:")
        for e in data["errors"]:
            print(f"    - {e}")

    if data.get("results"):
        print()
        print("  Downloaded files:")
        for r in data["results"]:
            print(f"    {r.get('name')}  →  {r.get('location')}")

    if not dry_run:
        print()
        print("Files are in ./data/ on your local machine.")


def main() -> None:
    print("================================================")
    print("  Google Drive Auth + Sync")
    print("================================================")
    print("The backend must already be running: docker compose up")

    user_id = step_auth()
    step_sync(user_id)


if __name__ == "__main__":
    main()

