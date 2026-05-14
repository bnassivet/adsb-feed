"""FastAPI AG-UI agent service for ADS-B Aircraft Tracker.

Streams LLM responses as AG-UI Server-Sent Events. Tool calls are forwarded
to the CopilotKit frontend which executes them via Tauri invoke.
"""

from __future__ import annotations

import json
import logging
import uuid
from contextlib import asynccontextmanager

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .llm import stream_llm_response
from .voice.voxtral import VoxtralBackend
from .voice.lfm2_audio import LFM2AudioBackend

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("adsb_agent")

# --- Voice backends ---
_voice_backends: dict[str, VoxtralBackend | LFM2AudioBackend] = {}
_active_voice_backend: VoxtralBackend | LFM2AudioBackend | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize voice backends at startup, clean up on shutdown."""
    _voice_backends["voxtral"] = VoxtralBackend()
    _voice_backends["lfm2-audio"] = LFM2AudioBackend()
    logger.info("Voice backends initialized: %s", list(_voice_backends.keys()))
    yield
    # Shutdown: stop any active backend and kill llama-server if running
    global _active_voice_backend
    if _active_voice_backend is not None:
        await _active_voice_backend.stop_listening()
        _active_voice_backend = None
    for backend in _voice_backends.values():
        if hasattr(backend, "shutdown"):
            await backend.shutdown()
    _voice_backends.clear()
    logger.info("Voice backends shut down")

app = FastAPI(title="ADS-B AG-UI Agent", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    """Log every incoming request and outgoing response with payloads."""
    # --- Request ---
    headers_of_interest = {
        k: v for k, v in request.headers.items()
        if k.lower() in ("accept", "content-type", "origin", "user-agent")
    }
    body = b""
    if request.method in ("POST", "PUT", "PATCH"):
        body = await request.body()

    body_str = ""
    if body:
        try:
            parsed = json.loads(body)
            body_str = json.dumps(parsed, indent=2, default=str)
        except Exception:
            body_str = body.decode(errors="replace")[:1000]

    logger.debug(
        "\n========== REQUEST ==========\n"
        "%s %s\n"
        "Headers: %s\n"
        "Body:\n%s\n"
        "=============================",
        request.method,
        request.url,
        json.dumps(headers_of_interest),
        body_str or "(empty)",
    )

    response = await call_next(request)

    # --- Response ---
    # For streaming responses, we can't read the body without consuming it,
    # so we log the metadata only. For JSON responses, capture the body.
    content_type = response.headers.get("content-type", "") if hasattr(response, "headers") else ""
    is_streaming = "event-stream" in content_type or (response.media_type and "event-stream" in response.media_type)

    if is_streaming:
        logger.debug(
            "\n========== RESPONSE =========\n"
            "%s %s -> %d\n"
            "Content-Type: %s\n"
            "Body: (SSE stream — events logged individually below)\n"
            "=============================",
            request.method,
            request.url.path,
            response.status_code,
            response.media_type,
        )
    else:
        # Buffer the response body so we can log it and still return it
        response_body = b""
        async for chunk in response.body_iterator:
            if isinstance(chunk, str):
                response_body += chunk.encode()
            else:
                response_body += chunk

        response_str = response_body.decode(errors="replace")
        try:
            parsed_resp = json.loads(response_str)
            response_str = json.dumps(parsed_resp, indent=2, default=str)
        except Exception:
            pass

        logger.debug(
            "\n========== RESPONSE =========\n"
            "%s %s -> %d\n"
            "Content-Type: %s\n"
            "Body:\n%s\n"
            "=============================",
            request.method,
            request.url.path,
            response.status_code,
            response.media_type or "unknown",
            response_str[:2000],
        )

        # Rebuild the response with the buffered body
        from starlette.responses import Response as StarletteResponse
        return StarletteResponse(
            content=response_body,
            status_code=response.status_code,
            headers=dict(response.headers),
            media_type=response.media_type,
        )

    return response


async def _run_agent(input_data: RunAgentInput, request: Request):
    """Shared handler: streams LLM response as AG-UI SSE events."""
    accept_header = request.headers.get("accept")
    encoder = EventEncoder(accept=accept_header)

    thread_id = input_data.thread_id or str(uuid.uuid4())
    run_id = input_data.run_id or str(uuid.uuid4())

    logger.debug(
        "Agent run: thread=%s run=%s messages=%d",
        thread_id,
        run_id,
        len(input_data.messages),
    )

    async def event_generator():
        # Run started
        event = RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id,
        )
        logger.debug("Event: %s", event.type)
        yield encoder.encode(event)

        errored = False
        try:
            # Stream LLM response as AG-UI events
            async for event in stream_llm_response(
                messages=input_data.messages,
                tools=None,  # Use default tool definitions
            ):
                logger.debug("Event: %s", event.type)
                yield encoder.encode(event)

        except Exception as e:
            errored = True
            logger.error("Agent error: %s", e, exc_info=True)
            yield encoder.encode(
                RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=f"Agent error: {e}",
                )
            )

        # RUN_FINISHED only if no error — AG-UI considers RUN_ERROR terminal
        if not errored:
            event = RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
            )
            logger.debug("Event: %s", event.type)
            yield encoder.encode(event)

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/ag-ui/agent/{agent_id}/run")
async def agent_run(agent_id: str, input_data: RunAgentInput, request: Request):
    """CopilotKit REST transport — POST /ag-ui/agent/{agent_id}/run."""
    return await _run_agent(input_data, request)


@app.post("/ag-ui/chat")
async def agentic_chat(input_data: RunAgentInput, request: Request):
    """Direct AG-UI SSE endpoint (for curl/testing)."""
    return await _run_agent(input_data, request)


_RUNTIME_INFO = {
    "agents": {
        "adsb_agent": {
            "description": "ADS-B Aircraft Tracker assistant — answers questions about aircraft, flights, and database statistics using local LLM.",
        },
    },
}


@app.get("/ag-ui/info")
async def runtime_info():
    """CopilotKit runtime discovery — REST transport."""
    return _RUNTIME_INFO


@app.get("/info")
async def runtime_info_root():
    """CopilotKit runtime discovery — fallback at root."""
    return _RUNTIME_INFO


@app.post("/ag-ui")
async def runtime_single_endpoint(request: Request):
    """CopilotKit single-endpoint transport — handles method dispatch.

    CopilotKit sends all requests to the runtimeUrl as POST with:
      { "method": "info" | "agent/run", "params": {...}, "body": {...} }
    """
    raw = await request.json()
    method = raw.get("method")

    if method == "info":
        return _RUNTIME_INFO

    if method == "agent/run":
        # body contains the RunAgentInput fields
        input_data = RunAgentInput(**raw.get("body", {}))
        return await _run_agent(input_data, request)

    return {"error": f"Unknown method: {method}"}


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "healthy", "service": "adsb-agent"}


# ---------------------------------------------------------------------------
# Voice endpoints
# ---------------------------------------------------------------------------


@app.get("/voice/backends")
async def list_voice_backends():
    """List available voice backends with their status."""
    backends = _voice_backends
    result = {}
    for name, backend in backends.items():
        info = await backend.get_info()
        result[name] = {
            "name": info.name,
            "description": info.description,
            "status": info.status.value,
            "supports_end_to_end": info.supports_end_to_end,
            "model_size": info.model_size,
        }
    return {"backends": result}


@app.post("/voice/start")
async def start_voice(request: Request):
    """Start voice capture with selected backend.

    Body: { "backend": "voxtral" | "lfm2-audio" }
    """
    global _active_voice_backend
    body = await request.json()
    backend_name = body.get("backend", "voxtral")

    backends = _voice_backends
    if backend_name not in backends:
        return {"error": f"Unknown backend: {backend_name}"}

    # Stop any currently active backend
    if _active_voice_backend is not None:
        await _active_voice_backend.stop_listening()

    backend = backends[backend_name]
    try:
        await backend.start_listening()
        _active_voice_backend = backend
        return {"status": "listening", "backend": backend_name}
    except RuntimeError as e:
        return {"error": str(e)}


@app.post("/voice/stop")
async def stop_voice():
    """Stop voice capture."""
    global _active_voice_backend
    if _active_voice_backend is None:
        return {"status": "not_listening"}

    # Grab and clear immediately so concurrent requests get "not_listening"
    backend = _active_voice_backend
    _active_voice_backend = None

    await backend.stop_listening()
    name = backend.name
    transcript = getattr(backend, "_last_transcript", None)

    result = {"status": "stopped", "backend": name}
    if transcript:
        result["transcript"] = transcript
        logger.info("[voice/stop] Final transcript: %r", transcript)
    return result


@app.get("/voice/status")
async def voice_status():
    """Get current voice status."""
    backends = _voice_backends
    active_name = _active_voice_backend.name if _active_voice_backend else None
    active_status = None
    if _active_voice_backend:
        active_status = (await _active_voice_backend.get_status()).value

    return {
        "active_backend": active_name,
        "status": active_status,
        "backends": {
            name: (await b.get_status()).value for name, b in backends.items()
        },
    }


@app.get("/voice/transcript")
async def voice_transcript_stream():
    """SSE stream of transcript chunks from the active voice backend.

    Each event is JSON: { "text": "...", "is_final": true/false }
    """
    if _active_voice_backend is None:
        return {"error": "No active voice backend"}

    async def event_generator():
        full_transcript = []
        async for chunk in _active_voice_backend.get_transcript_stream():
            data = json.dumps({"text": chunk.text, "is_final": chunk.is_final})
            logger.debug("[voice/transcript SSE] %s", data)
            if chunk.is_final:
                full_transcript.append(chunk.text)
            yield f"data: {data}\n\n"
        assembled = " ".join(full_transcript)
        logger.info("[voice/transcript] Full message: %r", assembled)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
