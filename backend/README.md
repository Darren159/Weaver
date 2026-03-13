# Weaver API

FastAPI backend that indexes Google Drive documents and GitHub markdown files into Elasticsearch, then exposes hybrid semantic search and Claude 3.7 RAG chat over the indexed content.

---

## Architecture

```
Frontend / Postman
       │
       ▼
FastAPI  (port 8000)
  ├── /auth/*          ← Google OAuth 2.0
  ├── /folders/list    ← Drive folder preview (no download)
  ├── /ingest/drive    ← Drive PDFs + Google Docs → drive-docs
  ├── /ingest/github   ← GitHub .md files → github-docs
  ├── /api/search      ← RRF hybrid search (BM25 + ELSER)
  ├── /api/complete    ← Claude 3.7 code completion (SSE)
  └── /api/chat        ← Claude 3.7 RAG chat (SSE)
           │
           ├── Google Drive API v3  (list, download, export)
           ├── GitHub Contents API  (recursive .md listing)
           └── Elasticsearch Cloud
                    ├── drive-docs   (PDFs + Google Docs chunks)
                    └── github-docs  (Markdown chunks)
```

### File structure

```
backend/
├── main.py               ← FastAPI entry point
├── config.py             ← Pydantic settings (reads .env)
├── elastic.py            ← ES client, index mappings, ensure_indices()
├── auth/
│   ├── google_oauth.py   ← OAuth2 + PKCE helpers
│   ├── token_store.py    ← JSON file token persistence
│   └── router.py         ← /auth/* routes
├── drive/
│   ├── service.py        ← list_files(), download_file() — in-memory
│   └── router.py         ← /folders/list + shared auth helpers
├── ingest/
│   ├── chunkers.py       ← chunk_pdf_bytes(), chunk_text() — no disk writes
│   └── router.py         ← /ingest/drive, /ingest/github
└── search/
    └── router.py         ← /api/search, /api/complete, /api/chat
```

---

## Elasticsearch Indices

| Index | Content | Source |
|---|---|---|
| `drive-docs` | PDF pages + Google Doc text, chunked | `POST /ingest/drive` |
| `github-docs` | Markdown files, chunked by heading | `POST /ingest/github` |

Both indices use `semantic_text` on the `content` field (ELSER sparse embeddings). Search queries both indices simultaneously via RRF (Reciprocal Rank Fusion).

**Document schema:**

| Field | Type | Description |
|---|---|---|
| `title` | text | Section heading or file name |
| `content` | semantic_text | Chunk text — ELSER embeddings applied automatically |
| `doc_type` | keyword | `drive-pdf`, `drive-doc`, `github-markdown` |
| `tags` | keyword | Source URL, top-level heading, section heading |
| `source` | keyword | e.g. `github/nodejs/node` or `google-drive/<folder_id>` |
| `last_modified` | date | Ingest timestamp |
| `chunk_index` | integer | Position of chunk within the source document |

---

## Prerequisites

1. **Elasticsearch Cloud** deployment with:
   - ELSER model deployed (used automatically via `semantic_text`)
   - An Anthropic Claude 3.7 inference endpoint at `.anthropic-claude-3.7-sonnet-chat_completion`

2. **Google Cloud project** with:
   - Google Drive API enabled
   - OAuth 2.0 Client ID (Web application type)
   - `http://localhost:8000/auth/google/callback` as an authorised redirect URI

3. **Docker and Docker Compose**

4. A `.env` file in this directory (copy from `env(example)`):

```env
ES_NODE=https://your-deployment.es.region.aws.elastic.cloud:443
ES_API_KEY=your-elastic-api-key

GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
OAUTH_REDIRECT_URI=http://localhost:8000/auth/google/callback

SECRET_KEY=change-me-in-production
```

---

## Running

```bash
# First run or after dependency changes
docker compose up --build

# Subsequent runs
docker compose up
```

API available at `http://localhost:8000`.
Interactive docs: `http://localhost:8000/docs`

---

## All API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Liveness check |
| `GET` | `/auth/google` | — | Redirect to Google consent screen |
| `POST` | `/auth/google/start` | — | OAuth with custom credentials |
| `GET` | `/auth/google/callback` | — | Exchange code, return `user_id` |
| `DELETE` | `/auth/google` | Bearer | Revoke stored credentials |
| `GET` | `/folders/list` | Bearer | List Drive files without downloading |
| `POST` | `/ingest/drive` | Bearer | Index Drive folder into `drive-docs` |
| `POST` | `/ingest/github` | — | Index GitHub repo/folder into `github-docs` |
| `POST` | `/api/search` | — | Hybrid semantic + BM25 search |
| `POST` | `/api/complete` | — | Streaming code completion via Claude 3.7 |
| `POST` | `/api/chat` | — | Streaming RAG chat via Claude 3.7 |

---

## Usage

### Step 1 — Authenticate with Google

Open in your browser (one-time per user):

```
http://localhost:8000/auth/google
```

After approving, you receive a `user_id`. Use it as the Bearer token for all Drive endpoints.

---

### Step 2 — (Optional) Preview a Drive folder

```bash
curl "http://localhost:8000/folders/list?folder_link=https://drive.google.com/drive/folders/FOLDER_ID" \
  -H "Authorization: Bearer YOUR_USER_ID"
```

Response:
```json
[
  {"id": "abc123", "name": "Report.pdf", "mime_type": "application/pdf", "size": 204800},
  {"id": "def456", "name": "Design Doc", "mime_type": "application/vnd.google-apps.document", "size": null}
]
```

---

### Step 3 — Index content

**Drive folder** (PDFs + Google Docs → `drive-docs`):

```bash
curl -X POST http://localhost:8000/ingest/drive \
  -H "Authorization: Bearer YOUR_USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"folder_link": "https://drive.google.com/drive/folders/FOLDER_ID", "recursive": true}'
```

**GitHub repo or folder** (`.md` files → `github-docs`):

```bash
curl -X POST http://localhost:8000/ingest/github \
  -H "Content-Type: application/json" \
  -d '{"url": "https://github.com/nodejs/node/tree/main/doc/api"}'
```

Both return:
```json
{"indexed": 87, "files_processed": 12, "skipped": 2, "errors": []}
```

For private GitHub repos, add `"token": "ghp_your_pat"` to the request body.

---

### Step 4 — Search

```bash
curl -X POST http://localhost:8000/api/search \
  -H "Content-Type: application/json" \
  -d '{"query": "how to use SQLite in Node.js", "size": 5}'
```

Response:
```json
{
  "results": [
    {
      "id": "abc123",
      "index": "github-docs",
      "title": "Type conversion between JavaScript and SQLite",
      "content": "When Node.js writes to or reads from SQLite...",
      "score": 18.54,
      "source": "github/nodejs/node",
      "docType": "github-markdown",
      "tags": ["github/nodejs/node", "SQLite", "Type conversion between JavaScript and SQLite"]
    }
  ],
  "total": {"value": 5227, "relation": "eq"}
}
```

---

### Step 5 — RAG Chat (SSE)

```bash
curl -X POST http://localhost:8000/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "How do I open an in-memory SQLite database in Node.js?"}]
  }'
```

Returns a Server-Sent Events stream:
```
data: {"token": "You"}
data: {"token": " can"}
data: {"token": " use"}
...
data: [DONE]
```

Optional body fields:
- `fileContext` — current open file contents (for VS Code integration)
- `fileName` — current file name

---

## Ingest Details

### What gets indexed

| Source | Supported types | Skipped |
|---|---|---|
| Drive | `application/pdf`, `application/vnd.google-apps.document` | Sheets, Slides, images, etc. |
| GitHub | `.md` files | Everything else |

### Chunking

- **PDFs** — text extracted page by page, then recursively split at `\n\n` → `\n` → `. ` → character level. Chunk size: 1500 chars, overlap: 200.
- **Markdown / Google Docs** — split at `##`/`###` headings first, then recursively split large sections. Min chunk size: 60 chars. Section heading becomes the chunk `title`.

---

## Token management

- Tokens are stored in `./data/tokens.json` (gitignored).
- Access tokens are **automatically refreshed** on every request using the stored refresh token.
- To revoke: `DELETE /auth/google` with `Authorization: Bearer YOUR_USER_ID`

---

## Testing

A Postman collection covering all routes is included:

```
backend/weaver.postman_collection.json
```

Import it into Postman, set the `baseUrl` variable (`http://localhost:8000`), authenticate once to get a `userId`, then run any request.

To verify ELSER embeddings are working after ingesting:

```json
POST github-docs/_search
{
  "size": 3,
  "query": {
    "semantic": { "field": "content", "query": "your test query" }
  }
}
```

Varying scores (e.g. `18.5`, `17.3`, `12.1`) confirm ELSER is running. All-`1.0` scores mean embeddings are not applied.
