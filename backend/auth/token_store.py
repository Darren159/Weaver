"""
Simple file-backed token store for development.
In production, replace with a database (Postgres, Redis, etc.).
Each entry is keyed by user_id and stores the serialised OAuth credentials.
"""

import json
import os
from threading import Lock

_lock = Lock()


def _load(path: str) -> dict:
    if not os.path.exists(path):
        return {}
    with open(path) as f:
        return json.load(f)


def _save(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


def save_token(user_id: str, token_data: dict, store_path: str) -> None:
    with _lock:
        data = _load(store_path)
        data[user_id] = token_data
        _save(store_path, data)


def load_token(user_id: str, store_path: str) -> dict | None:
    with _lock:
        data = _load(store_path)
        return data.get(user_id)


def delete_token(user_id: str, store_path: str) -> None:
    with _lock:
        data = _load(store_path)
        data.pop(user_id, None)
        _save(store_path, data)
