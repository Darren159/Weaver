"""
Shared chunking utilities for the ingest module.

Two entry points:
  chunk_pdf_bytes(data, file_name, source)      — PDF files (in-memory, no disk write)
  chunk_text(text, file_name, source, doc_type) — plain text / markdown files
Both return list[dict] ready to bulk-index into drive-docs or github-docs.
"""

import io
import re
import logging
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader

logger = logging.getLogger(__name__)

CHUNK_SIZE = 1500
CHUNK_OVERLAP = 200
_SEPARATORS = ["\n\n", "\n", ". ", " ", ""]

_HEADING_SPLIT_RE = re.compile(r"(?=^#{2,3} )", re.MULTILINE)
_HEADING_LINE_RE = re.compile(r"^(#{1,3}) (.+)$", re.MULTILINE)


# ── Shared split logic ────────────────────────────────────────────────────────

def _recursive_split(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    if len(text) <= chunk_size:
        return [text] if text.strip() else []

    for sep in _SEPARATORS:
        if sep == "":
            parts = [text[i:i + chunk_size] for i in range(0, len(text), chunk_size - overlap)]
            return [p for p in parts if p.strip()]

        segments = text.split(sep)
        if len(segments) == 1:
            continue

        chunks: list[str] = []
        current = ""
        for seg in segments:
            candidate = (current + sep + seg).lstrip(sep) if current else seg
            if len(candidate) <= chunk_size:
                current = candidate
            else:
                if current.strip():
                    chunks.append(current.strip())
                overlap_text = current[-overlap:] if overlap and current else ""
                current = (overlap_text + sep + seg).lstrip(sep) if overlap_text else seg

        if current.strip():
            chunks.append(current.strip())

        if len(chunks) > 1:
            return chunks

    return [text]


# ── Doc builder ───────────────────────────────────────────────────────────────

def _build_doc(
    title: str,
    content: str,
    chunk_index: int,
    file_name: str,
    source: str,
    doc_type: str,
    tags: list[str] | None = None,
) -> dict:
    stem = Path(file_name).stem
    return {
        "title": title,
        "content": content,
        "doc_type": doc_type,
        "tags": tags or [source, stem],
        "source": source,
        "last_modified": datetime.now(timezone.utc).isoformat(),
        "chunk_index": chunk_index,
    }


# ── PDF chunker ───────────────────────────────────────────────────────────────

def chunk_pdf_bytes(data: bytes, file_name: str, source: str) -> list[dict]:
    """Extract text from PDF bytes and return chunks ready for indexing."""
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as exc:
        logger.error("Failed to read PDF '%s': %s", file_name, exc)
        return []

    pages_text = []
    for page in reader.pages:
        text = (page.extract_text() or "").strip()
        if text:
            pages_text.append(text)

    if not pages_text:
        logger.info("No extractable text in PDF '%s'", file_name)
        return []

    full_text = "\n\n".join(pages_text)
    raw_chunks = _recursive_split(full_text)

    return [
        _build_doc(
            title=file_name,
            content=chunk,
            chunk_index=i,
            file_name=file_name,
            source=source,
            doc_type="drive-pdf",
        )
        for i, chunk in enumerate(raw_chunks)
    ]


# ── Text / markdown chunker ───────────────────────────────────────────────────

def chunk_text(text: str, file_name: str, source: str, doc_type: str) -> list[dict]:
    """
    Split plain text or markdown into heading-aware chunks.
    Falls back to paragraph/character splitting for non-markdown content.
    """
    h1_match = re.search(r"^# (.+)$", text, re.MULTILINE)
    h1_title = h1_match.group(1).strip() if h1_match else Path(file_name).stem

    sections = [s for s in _HEADING_SPLIT_RE.split(text) if s.strip()]
    if not sections:
        sections = [text]

    docs: list[dict] = []
    chunk_index = 0

    for section in sections:
        heading_match = _HEADING_LINE_RE.search(section)
        section_title = heading_match.group(2).strip() if heading_match else h1_title
        content = section.strip()

        if len(content) < 60:
            continue

        raw_chunks = _recursive_split(content)
        for chunk in raw_chunks:
            if len(chunk.strip()) < 60:
                continue
            docs.append(
                _build_doc(
                    title=section_title,
                    content=chunk,
                    chunk_index=chunk_index,
                    file_name=file_name,
                    source=source,
                    doc_type=doc_type,
                    tags=[source, h1_title, section_title],
                )
            )
            chunk_index += 1

    return docs
