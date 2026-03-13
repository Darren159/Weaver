"""
Smoke-test: verifies the Elasticsearch connection and indexes a single
synthetic chunk to confirm the pipeline works end-to-end.

Run inside Docker:
  make exec CMD="python -m backend.scripts.test_elastic"
"""

import sys
from backend.config import settings
from backend.storage.elastic_client import get_client, ensure_index, index_chunks


def main() -> None:
    print("Elasticsearch smoke-test")
    print(f"  Host:  {settings.elastic_host}")
    print(f"  Index: {settings.elastic_index}")
    print()

    if not settings.elastic_host or not settings.elastic_api_key:
        print("ERROR: ELASTIC_HOST and ELASTIC_API_KEY must be set in .env")
        sys.exit(1)

    client = get_client()

    print("Pinging cluster...", end=" ")
    if not client.ping():
        print("FAILED — could not reach cluster.")
        sys.exit(1)
    print("OK")

    ensure_index(client)
    print(f"Index '{settings.elastic_index}' ready.")

    test_chunk = {
        "chunk_id": "smoke-test-001",
        "chunk_index": 0,
        "total_chunks": 1,
        "chunk_text": "This is a smoke-test chunk to verify the Elasticsearch pipeline.",
        "file_id": "smoke-file-id",
        "file_name": "smoke_test.pdf",
        "mime_type": "application/pdf",
        "folder_id": "smoke-folder-id",
        "user_id": "smoke-user-id",
        "local_path": "/app/data/smoke_test.pdf",
    }

    print("Indexing one test chunk...", end=" ")
    indexed = index_chunks([test_chunk])
    if indexed == 1:
        print("OK")
    else:
        print(f"FAILED — expected 1, got {indexed}")
        sys.exit(1)

    print("Fetching indexed document...", end=" ")
    doc = client.get(index=settings.elastic_index, id="smoke-test-001")
    assert doc["_source"]["chunk_text"] == test_chunk["chunk_text"], "Content mismatch"
    print("OK")

    print()
    print("All checks passed. Elasticsearch pipeline is working correctly.")
    print(f"Test document is in index '{settings.elastic_index}' with id 'smoke-test-001'.")


if __name__ == "__main__":
    main()
