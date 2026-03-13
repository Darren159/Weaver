"""
seed_api.py — parses Node.js API docs (or any markdown docs), extracts
method signatures, parameters, and examples, then indexes into ES.

Usage:
    python seed_api.py ./node-docs/doc/api
"""

import os
import re
import sys
import json
from pathlib import Path
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from backend.elastic import get_client, DRIVE_INDEX, ensure_indices


BATCH_SIZE = 30


# ── Markdown chunker ─────────────────────────────────────────────────────────

HEADING_SPLIT_RE = re.compile(r"(?=^#{2,3} )", re.MULTILINE)
HEADING_LINE_RE = re.compile(r"^(#{1,3}) (.+)$", re.MULTILINE)


def chunk_markdown(source: str, max_chars: int = 1500) -> list[dict]:
    chunks = []
    chunk_index = 0

    h1_match = re.search(r"^# (.+)$", source, re.MULTILINE)
    h1_title = h1_match.group(1).strip() if h1_match else ""

    sections = [s for s in HEADING_SPLIT_RE.split(source) if s.strip()]

    for section in sections:
        heading_match = HEADING_LINE_RE.search(section)
        section_title = heading_match.group(2).strip() if heading_match else (h1_title or "Introduction")
        content = section.strip()

        if len(content) < 60:
            continue

        if len(content) <= max_chars:
            chunks.append({
                "title": section_title,
                "content": content,
                "chunk_index": chunk_index,
                "heading_path": [t for t in [h1_title, section_title] if t],
            })
            chunk_index += 1
        else:
            paragraphs = re.split(r"\n{2,}", content)
            buffer = ""
            for para in paragraphs:
                if buffer and len(buffer) + len(para) > max_chars:
                    chunks.append({
                        "title": section_title,
                        "content": buffer.strip(),
                        "chunk_index": chunk_index,
                        "heading_path": [t for t in [h1_title, section_title] if t],
                    })
                    chunk_index += 1
                    buffer = para
                else:
                    buffer += ("\n\n" + para if buffer else para)

            if buffer.strip() and len(buffer.strip()) > 60:
                chunks.append({
                    "title": section_title,
                    "content": buffer.strip(),
                    "chunk_index": chunk_index,
                    "heading_path": [t for t in [h1_title, section_title] if t],
                })
                chunk_index += 1

    return chunks


# ── Extraction helpers ────────────────────────────────────────────────────────

def extract_signature(title: str):
    """Extract method/property signature from chunk title like `fs.readFile(path[, options], callback)`"""
    match = re.search(r"`([a-zA-Z_$][\w.]*(?:\([^)]*\))?)`", title)
    if match:
        full = match.group(1)
        name = re.sub(r"\(.*$", "", full)
        return {"name": name, "signature": full}
    return None


def extract_params(content: str) -> str:
    """Extract parameter descriptions from Node.js doc format."""
    params = []
    for match in re.finditer(r"^\s*\*\s+`(\w+)`\s+\{([^}]+)\}\s*(.*)", content, re.MULTILINE):
        name, type_, desc = match.group(1), match.group(2), match.group(3).strip()
        desc_part = f" — {desc[:120]}" if desc else ""
        params.append(f"- {name} ({type_}){desc_part}")
    return "\n".join(params)


def extract_examples(content: str) -> str:
    """Extract code examples (fenced code blocks)."""
    examples = []
    for match in re.finditer(r"```(?:js|javascript|mjs|cjs)?\n([\s\S]*?)```", content):
        examples.append(match.group(1).strip())
        if sum(len(e) for e in examples) > 500:
            break
    return "\n\n".join(examples)[:600]


# ── Bulk indexing ─────────────────────────────────────────────────────────────

def bulk_index(batch: list[dict]):
    operations = []
    for doc in batch:
        operations.append({"index": {"_index": DRIVE_INDEX}})
        operations.append(doc)

    result = get_client().bulk(operations=operations)
    errors = [item for item in result["items"] if item.get("index", {}).get("error")]

    if errors:
        print(f"  ⚠ {len(errors)} bulk error(s). First: {json.dumps(errors[0]['index'], indent=2)}")
    print(f"    indexed {len(batch) - len(errors)}/{len(batch)} chunks")


# ── Main ─────────────────────────────────────────────────────────────────────

def seed():
    docs_path = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DOCS_PATH")

    if not docs_path:
        print("No docs path provided.")
        print("Usage: python seed_api.py ./node-docs/doc/api")
        print()
        print("To get Node.js docs:")
        print("  git clone --depth 1 --filter=blob:none --sparse https://github.com/nodejs/node.git")
        print("  cd node && git sparse-checkout set doc/api")
        sys.exit(1)

    docs_path = Path(docs_path)
    if not docs_path.exists():
        print(f"Path not found: {docs_path}")
        sys.exit(1)

    print(f"\nSeeding from: {docs_path}")
    print("Ensuring Elasticsearch setup…")
    ensure_indices()
    print()

    files = sorted(docs_path.rglob("*.md"))
    print(f"Found {len(files)} markdown files\n")

    total_chunks = 0
    batch: list[dict] = []

    for file_path in files:
        raw = file_path.read_text(encoding="utf-8")
        module_name = file_path.stem
        mtime = datetime.fromtimestamp(file_path.stat().st_mtime, tz=timezone.utc).isoformat()
        chunks = chunk_markdown(raw)

        print(f"  [{module_name}] {len(chunks)} chunks")

        for chunk in chunks:
            sig = extract_signature(chunk["title"])
            params = extract_params(chunk["content"])
            examples = extract_examples(chunk["content"])

            batch.append({
                "title": sig["signature"] if sig else chunk["title"],
                "content": chunk["content"],
                "endpoint": sig["name"] if sig else chunk["title"],
                "method": module_name,
                "parameters": params,
                "request_body": examples,
                "response_example": "",
                "doc_type": "api-reference",
                "tags": [module_name] + [h for h in chunk["heading_path"] if h != chunk["title"]],
                "source": "nodejs/node",
                "api_group": module_name,
                "last_modified": mtime,
            })

            if len(batch) >= BATCH_SIZE:
                bulk_index(batch)
                total_chunks += len(batch)
                batch = []

    if batch:
        bulk_index(batch)
        total_chunks += len(batch)

    print(f"\nDone. {total_chunks} API doc chunks indexed from {len(files)} files.")


if __name__ == "__main__":
    seed()
