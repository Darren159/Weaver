"""
Unified Elasticsearch client.

Two indices:
  DRIVE_INDEX  — Google Drive documents (PDFs, Google Docs)
  GITHUB_INDEX — GitHub markdown files

Both use semantic_text on the `content` field for hybrid search.
"""

import logging
from elasticsearch import Elasticsearch
from backend.config import settings

logger = logging.getLogger(__name__)

DRIVE_INDEX = "drive-docs"
GITHUB_INDEX = "github-docs"
ALL_INDICES = f"{DRIVE_INDEX},{GITHUB_INDEX}"

_client: Elasticsearch | None = None

_INDEX_MAPPING = {
    "mappings": {
        "properties": {
            "title":         {"type": "text", "analyzer": "english"},
            "content":       {"type": "semantic_text"},
            "doc_type":      {"type": "keyword"},
            "tags":          {"type": "keyword"},
            "source":        {"type": "keyword"},
            "last_modified": {"type": "date"},
            "chunk_index":   {"type": "integer"},
        }
    }
}


def get_client() -> Elasticsearch:
    global _client
    if _client is None:
        _client = Elasticsearch(settings.es_node, api_key=settings.es_api_key)
        logger.info("Elasticsearch client initialised → %s", settings.es_node)
    return _client


def ensure_index(index: str) -> None:
    client = get_client()
    if client.indices.exists(index=index):
        logger.info("Index '%s' already exists", index)
        return
    client.indices.create(index=index, **_INDEX_MAPPING)
    logger.info("Created index '%s'", index)


def ensure_indices() -> None:
    ensure_index(DRIVE_INDEX)
    ensure_index(GITHUB_INDEX)
