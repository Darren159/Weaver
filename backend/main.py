import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.auth.router import router as auth_router
from backend.drive.router import router as drive_router
from backend.search.router import router as search_router
from backend.ingest.router import router as ingest_router
from backend.agents.router import router as agents_router
from backend.elastic import ensure_indices

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

app = FastAPI(
    title="Weaver API",
    description=(
        "Google Drive + GitHub ingest (drive-docs / github-docs indices), "
        "hybrid semantic search, LLM code completion, and RAG chat. "
        "Authenticate via GET /auth/google before using Drive or ingest endpoints."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(drive_router)
app.include_router(search_router)
app.include_router(ingest_router)
app.include_router(agents_router)


@app.get("/health", tags=["meta"])
def health():
    return {"status": "ok"}


@app.on_event("startup")
def startup():
    logging.getLogger(__name__).info("Setting up Elasticsearch indices…")
    try:
        ensure_indices()
    except Exception as e:
        logging.getLogger(__name__).warning("ES setup skipped (will retry on first request): %s", e)
