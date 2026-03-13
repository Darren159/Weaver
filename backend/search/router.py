import json
import boto3
from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.requests import Request

from backend.config import settings
from backend.elastic import get_client, ALL_INDICES
from backend.model_config import ModelState

router = APIRouter(prefix="/api", tags=["search"])

from backend.elastic import get_client, ALL_INDICES, DRIVE_INDEX, GITHUB_INDEX

_ALLOWED_INDICES = {DRIVE_INDEX, GITHUB_INDEX, ALL_INDICES}

router = APIRouter(prefix="/api", tags=["search"])

LLM_INFERENCE_ID = ".anthropic-claude-3.7-sonnet-chat_completion"

VALID_INDICES = {DRIVE_INDEX, GITHUB_INDEX}


def _resolve_index(body: dict) -> str:
    requested_index = str(body.get("index", "")).strip()
    if not requested_index:
        return ALL_INDICES
    if requested_index not in VALID_INDICES:
        raise ValueError(f"Unsupported index '{requested_index}'")
    return requested_index


# ── Search ────────────────────────────────────────────────────────────────────

@router.post("/search")
async def search(request: Request):
    body = await request.json()
    query = body.get("query", "").strip()
    size = body.get("size", 5)
    index = body.get("index", ALL_INDICES)

    if index not in _ALLOWED_INDICES:
        return JSONResponse({"error": f"invalid index '{index}'"}, status_code=400)

    if not query:
        return JSONResponse({"error": "query is required"}, status_code=400)

    try:
        index = _resolve_index(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    try:
        result = get_client().search(
            index=index,
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
    index = body.get("index", ALL_INDICES)

    if index not in _ALLOWED_INDICES:
        return JSONResponse({"error": f"invalid index '{index}'"}, status_code=400)

    if not prefix or not query:
        return {"completion": ""}

    try:
        index = _resolve_index(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    try:
        search_result = get_client().search(
            index=index,
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

        rag_context = "\n---\n".join(
            f"[{s.get('title', '')}]\n{s.get('content', '')[:400]}"
            for hit in search_result["hits"]["hits"]
            for s in [hit["_source"]]
        )

        is_doc = language.lower() == "google-docs"

        if is_doc:
            system_prompt = (
                "You are a professional business writing assistant. "
                "The user is composing a document and you must complete their text naturally. "
                "Use specific details — names, roles, emails, funding amounts, technical interests — "
                "from the provided context to write precise, substantive prose. "
                "Continue directly from where the text cuts off. Do not repeat the preceding text. "
                "Write 2-4 sentences. No markdown, no preamble, no explanation."
            )
            user_content = (
                f"Relevant partner/knowledge-base context:\n{rag_context}\n\n"
                f"Document text before cursor:\n{prefix[-1200:]}\n\n"
                f"Document text after cursor:\n{suffix[:300]}\n\n"
                "Continue the text at the cursor position:"
            )
        else:
            system_prompt = (
                "You are a code completion assistant. Given the user's code context "
                "and relevant knowledge-base excerpts, provide ONLY the code that should "
                "come next. Do not include explanations, markdown, or code fences. "
                "Just output the raw code completion (1-5 lines max)."
            )
            user_content = (
                f"Language: {language}\n\n"
                f"Relevant context:\n{rag_context}\n\n"
                f"Code before cursor:\n{prefix[-800:]}\n\n"
                f"Code after cursor:\n{suffix[:200]}\n\n"
                "Complete the code at the cursor position:"
            )

        system_content = (
            "You are a code completion assistant. Given the user's code context "
            "and relevant API documentation, provide ONLY the code that should "
            "come next. Do not include explanations, markdown, or code fences. "
            "Just output the raw code completion (1-5 lines max)."
        )
        if language == "google-docs":
            system_content = (
                "You are an intelligent writing assistant inside Google Docs. "
                "Complete the document context provided by the user. "
                "You may format your response using standard Markdown tables, "
                "and for flowcharts, graphs, or charts use ```mermaid fenced code blocks."
            )

        llm_messages = [
            {
                "role": "system",
                "content": system_content,
            },
            {
                "role": "user",
                "content": (
                    f"Language: {language}\n\n"
                    f"Relevant Context/API documentation:\n{api_context}\n\n"
                    f"Text before cursor:\n{prefix[-800:]}\n\n"
                    f"Text after cursor:\n{suffix[:200]}\n\n"
                    "Provide the completion at the cursor position:"
                ),
            },
        ]
        url = f"{settings.es_node.rstrip('/')}/_inference/chat_completion/{LLM_INFERENCE_ID}/_stream"
        llm_body = {
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_content},
            ],
        }

        def token_stream():
            try:
                client = boto3.client("bedrock-runtime", region_name="us-east-1")
                system_texts = [{"text": m["content"]} for m in llm_messages if m["role"] == "system"]
                bedrock_messages = [
                    {"role": m["role"], "content": [{"text": m["content"]}]}
                    for m in llm_messages if m["role"] in ("user", "assistant")
                ]

                response = client.converse_stream(
                    modelId=ModelState.active_model_id,
                    messages=bedrock_messages,
                    system=system_texts
                )

                stream = response.get("stream")
                if stream:
                    for event in stream:
                        if "contentBlockDelta" in event:
                            delta = event["contentBlockDelta"]["delta"]
                            if "text" in delta:
                                yield f"data: {json.dumps({'token': delta['text']})}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as e:
                print(f"[complete] Bedrock stream error: {e}")
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

    try:
        index = _resolve_index(body)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    last_user = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"), ""
    )
    query = last_user[:200].strip()

    rag_context = ""
    if query:
        try:
            search_result = get_client().search(
                index=index,
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
                parts.append(f"[{s.get('title', '')}]\n{snippet}")
            rag_context = "\n---\n".join(parts)
        except Exception as e:
            print(f"[chat] RAG search error: {e}")

    system_parts = [
        "You are a helpful coding assistant integrated into a VS Code editor. "
        "Answer the user's question clearly and concisely. "
        "When you suggest code modifications, always wrap them in a fenced code block "
        "with the language identifier. For example:\n```python\n...\n```\n"
        "The user can click 'Apply' on any code block to apply it directly to their file. "
        "You have the capability to generate rich content. If presenting tabular data, use standard "
        "Markdown tables. If drawing a chart, graph, or flowchart, use Mermaid.js syntax inside a "
        "```mermaid fencing block.",
    ]
    if file_name:
        system_parts.append(f"The user is currently editing: {file_name}")
    if file_context:
        system_parts.append(f"Current file contents (for context):\n```\n{file_context[:3000]}\n```")
    if rag_context:
        system_parts.append(f"Relevant knowledge-base context:\n{rag_context}")

    llm_messages = [{"role": "system", "content": "\n\n".join(system_parts)}] + messages

    def token_stream():
        try:
            client = boto3.client("bedrock-runtime", region_name="us-east-1")
            system_texts = [{"text": m["content"]} for m in llm_messages if m["role"] == "system"]
            bedrock_messages = [
                {"role": m["role"], "content": [{"text": m["content"]}]}
                for m in llm_messages if m["role"] in ("user", "assistant")
            ]

            response = client.converse_stream(
                modelId=ModelState.active_model_id,
                messages=bedrock_messages,
                system=system_texts
            )

            stream = response.get("stream")
            if stream:
                for event in stream:
                    if "contentBlockDelta" in event:
                        delta = event["contentBlockDelta"]["delta"]
                        if "text" in delta:
                            yield f"data: {json.dumps({'token': delta['text']})}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            print(f"[chat] Bedrock stream error: {e}")
            yield "data: [DONE]\n\n"

    return StreamingResponse(token_stream(), media_type="text/event-stream")
