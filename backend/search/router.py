import json
import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.requests import Request

from backend.config import settings
from backend.elastic import get_client, ALL_INDICES

router = APIRouter(prefix="/api", tags=["search"])

LLM_INFERENCE_ID = ".anthropic-claude-3.7-sonnet-chat_completion"


# ── Search ────────────────────────────────────────────────────────────────────

@router.post("/search")
async def search(request: Request):
    body = await request.json()
    query = body.get("query", "").strip()
    size = body.get("size", 5)

    if not query:
        return JSONResponse({"error": "query is required"}, status_code=400)

    try:
        result = get_client().search(
            index=ALL_INDICES,
            retriever={
                "rrf": {
                    "retrievers": [
                        {"standard": {"query": {"multi_match": {
                            "query": query,
                            "fields": ["title^2", "tags^1.5"],
                            "type": "best_fields",
                            "fuzziness": "AUTO",
                        }}}},
                        {"standard": {"query": {"semantic": {
                            "field": "content",
                            "query": query,
                        }}}},
                    ],
                    "rank_window_size": 25,
                }
            },
            size=size,
        )

        hits = result["hits"]["hits"]
        results = [
            {
                "id": hit["_id"],
                "index": hit["_index"],
                "title": hit["_source"].get("title", ""),
                "content": hit["_source"].get("content", ""),
                "score": hit.get("_score", 0),
                "source": hit["_source"].get("source", ""),
                "docType": hit["_source"].get("doc_type", ""),
                "tags": hit["_source"].get("tags", []),
            }
            for hit in hits
        ]

        return {"results": results, "total": result["hits"]["total"]}

    except Exception as e:
        return JSONResponse({"error": "Search failed", "detail": str(e)}, status_code=500)


# ── Complete ──────────────────────────────────────────────────────────────────

@router.post("/complete")
async def complete(request: Request):
    body = await request.json()
    prefix = body.get("prefix", "").strip()
    suffix = body.get("suffix", "")
    language = body.get("language", "")
    query = body.get("query", "").strip()

    if not prefix or not query:
        return {"completion": ""}

    try:
        search_result = get_client().search(
            index=ALL_INDICES,
            retriever={
                "rrf": {
                    "retrievers": [
                        {"standard": {"query": {"multi_match": {
                            "query": query,
                            "fields": ["title^2", "tags^1.5"],
                            "fuzziness": "AUTO",
                        }}}},
                        {"standard": {"query": {"semantic": {
                            "field": "content",
                            "query": query,
                        }}}},
                    ],
                    "rank_window_size": 10,
                }
            },
            size=3,
        )

        api_parts = []
        for hit in search_result["hits"]["hits"]:
            s = hit["_source"]
            parts = [f"{s.get('method', '')} {s.get('endpoint', '')}"]
            if s.get("title"):
                parts.append(f"// {s['title']}")
            if s.get("parameters"):
                parts.append(f"Parameters:\n{s['parameters']}")
            if s.get("request_body"):
                parts.append(f"Example:\n{str(s['request_body'])[:300]}")
            api_parts.append("\n".join(parts))
        api_context = "\n---\n".join(api_parts)

        url = f"{settings.es_node.rstrip('/')}/_inference/chat_completion/{LLM_INFERENCE_ID}/_stream"
        llm_body = {
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are a code completion assistant. Given the user's code context "
                        "and relevant API documentation, provide ONLY the code that should "
                        "come next. Do not include explanations, markdown, or code fences. "
                        "Just output the raw code completion (1-5 lines max)."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Language: {language}\n\n"
                        f"Relevant API documentation:\n{api_context}\n\n"
                        f"Code before cursor:\n{prefix[-800:]}\n\n"
                        f"Code after cursor:\n{suffix[:200]}\n\n"
                        "Complete the code at the cursor position:"
                    ),
                },
            ],
        }

        async def token_stream():
            try:
                async with httpx.AsyncClient(timeout=30.0) as http_client:
                    async with http_client.stream(
                        "POST", url, json=llm_body,
                        headers={
                            "Content-Type": "application/json",
                            "Authorization": f"ApiKey {settings.es_api_key}",
                        },
                    ) as resp:
                        async for line in resp.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            data = line[6:].strip()
                            if data == "[DONE]":
                                yield "data: [DONE]\n\n"
                                return
                            try:
                                parsed = json.loads(data)
                                delta = parsed.get("choices", [{}])[0].get("delta", {}).get("content", "")
                                if delta:
                                    yield f"data: {json.dumps({'token': delta})}\n\n"
                            except json.JSONDecodeError:
                                pass
            except Exception as e:
                print(f"[complete] stream error: {e}")
                yield "data: [DONE]\n\n"

        return StreamingResponse(token_stream(), media_type="text/event-stream")

    except Exception as e:
        return JSONResponse({"error": "Completion failed", "detail": str(e)}, status_code=500)


# ── Chat ──────────────────────────────────────────────────────────────────────

@router.post("/chat")
async def chat(request: Request):
    """
    Multi-turn RAG chat. Searches both indices for context then streams
    a response via ES inference (Claude 3.7).
    Body: { messages: [{role, content}], fileContext?: string, fileName?: string }
    """
    body = await request.json()
    messages: list = body.get("messages", [])
    file_context: str = body.get("fileContext", "")
    file_name: str = body.get("fileName", "")

    if not messages:
        return JSONResponse({"error": "messages is required"}, status_code=400)

    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
    )
    query = last_user[:200].strip()

    rag_context = ""
    if query:
        try:
            search_result = get_client().search(
                index=ALL_INDICES,
                retriever={
                    "rrf": {
                        "retrievers": [
                            {"standard": {"query": {"multi_match": {
                                "query": query,
                                "fields": ["title^2", "tags^1.5"],
                                "fuzziness": "AUTO",
                            }}}},
                            {"standard": {"query": {"semantic": {
                                "field": "content",
                                "query": query,
                            }}}},
                        ],
                        "rank_window_size": 10,
                    }
                },
                size=3,
            )
            parts = []
            for hit in search_result["hits"]["hits"]:
                s = hit["_source"]
                snippet = s.get("content", "")[:400]
                parts.append(
                    f"[{s.get('title', '')}]\n{s.get('method', '')} {s.get('endpoint', '')}\n{snippet}"
                )
            rag_context = "\n---\n".join(parts)
        except Exception as e:
            print(f"[chat] RAG search error: {e}")

    system_parts = [
        "You are a helpful coding assistant integrated into a VS Code editor. "
        "Answer the user's question clearly and concisely. "
        "When you suggest code modifications, always wrap them in a fenced code block "
        "with the language identifier. For example:\n```python\n...\n```\n"
        "The user can click 'Apply' on any code block to apply it directly to their file.",
    ]
    if file_name:
        system_parts.append(f"The user is currently editing: {file_name}")
    if file_context:
        system_parts.append(f"Current file contents (for context):\n```\n{file_context[:3000]}\n```")
    if rag_context:
        system_parts.append(f"Relevant knowledge-base context:\n{rag_context}")

    llm_messages = [{"role": "system", "content": "\n\n".join(system_parts)}] + messages
    url = f"{settings.es_node.rstrip('/')}/_inference/chat_completion/{LLM_INFERENCE_ID}/_stream"

    async def token_stream():
        try:
            async with httpx.AsyncClient(timeout=60.0) as http_client:
                async with http_client.stream(
                    "POST", url, json={"messages": llm_messages},
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"ApiKey {settings.es_api_key}",
                    },
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        data = line[6:].strip()
                        if data == "[DONE]":
                            yield "data: [DONE]\n\n"
                            return
                        try:
                            parsed = json.loads(data)
                            delta = parsed.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if delta:
                                yield f"data: {json.dumps({'token': delta})}\n\n"
                        except json.JSONDecodeError:
                            pass
        except Exception as e:
            print(f"[chat] stream error: {e}")
            yield "data: [DONE]\n\n"

    return StreamingResponse(token_stream(), media_type="text/event-stream")
