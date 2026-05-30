"""FastAPI AG-UI agent service for ADS-B Aircraft Tracker.

Streams LLM responses as AG-UI Server-Sent Events. Tool calls are forwarded
to the CopilotKit frontend which executes them via Tauri invoke.
"""

from __future__ import annotations

import asyncio
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
from fastapi.responses import JSONResponse, StreamingResponse

from .llm import stream_llm_response
from .models import (
    AgUiErrorResponse,
    AgUiRequest,
    HealthResponse,
    RuntimeInfoResponse,
    SSE_RESPONSES,
    VOICE_SSE_RESPONSES,
    VoiceBackendsResponse,
    VoiceErrorResponse,
    VoiceStartRequest,
    VoiceStartResponse,
    VoiceStopResponse,
    VoiceStatusResponse,
)
from .voice.voxtral import VoxtralBackend
from .voice.lfm2_audio import LFM2AudioBackend

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger("adsb_agent")

# --- Voice backends ---
_voice_backends: dict[str, VoxtralBackend | LFM2AudioBackend] = {}
_active_voice_backend: VoxtralBackend | LFM2AudioBackend | None = None

# Signalled during lifespan teardown so SSE generators exit cleanly before
# uvicorn waits for connections to close.
_shutdown_event: asyncio.Event | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize voice backends at startup, clean up on shutdown."""
    global _shutdown_event
    _shutdown_event = asyncio.Event()
    _voice_backends["voxtral"] = VoxtralBackend()
    _voice_backends["lfm2-audio"] = LFM2AudioBackend()
    logger.info("Voice backends initialized: %s", list(_voice_backends.keys()))
    yield
    # Signal SSE generators to exit before backend teardown so connections
    # close before uvicorn starts waiting for them.
    _shutdown_event.set()
    await asyncio.sleep(0)  # yield to event loop so generators see the event
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


app = FastAPI(
    title="ADS-B AG-UI Agent",
    version="0.1.0",
    description=(
        "LLM-powered aircraft-tracker assistant. "
        "Streams AG-UI Server-Sent Events; integrates with CopilotKit REST and single-endpoint transports."
    ),
    contact={"name": "ADS-B Project"},
    lifespan=lifespan,
)

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
        def _shutting_down() -> bool:
            return _shutdown_event is not None and _shutdown_event.is_set()

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
                tools=input_data.tools,
                context=input_data.context,
            ):
                if _shutting_down() or await request.is_disconnected():
                    logger.info("AG-UI stream: client disconnected or server shutting down")
                    return
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
        if not errored and not _shutting_down():
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


@app.post(
    "/ag-ui/agent/{agent_id}/run",
    tags=["ag-ui"],
    response_class=StreamingResponse,
    responses=SSE_RESPONSES,
    summary="CopilotKit REST transport — stream agent run",
)
async def agent_run(agent_id: str, input_data: RunAgentInput, request: Request):
    """CopilotKit REST transport — POST /ag-ui/agent/{agent_id}/run."""
    return await _run_agent(input_data, request)


@app.post(
    "/ag-ui/chat",
    tags=["ag-ui"],
    response_class=StreamingResponse,
    responses=SSE_RESPONSES,
    summary="Direct AG-UI SSE endpoint",
)
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


@app.get(
    "/ag-ui/info",
    tags=["ag-ui"],
    response_model=RuntimeInfoResponse,
    summary="CopilotKit runtime discovery",
)
async def runtime_info() -> RuntimeInfoResponse:
    """CopilotKit runtime discovery — REST transport."""
    return RuntimeInfoResponse(**_RUNTIME_INFO)


@app.get(
    "/info",
    tags=["ag-ui"],
    response_model=RuntimeInfoResponse,
    summary="CopilotKit runtime discovery (root fallback)",
)
async def runtime_info_root() -> RuntimeInfoResponse:
    """CopilotKit runtime discovery — fallback at root."""
    return RuntimeInfoResponse(**_RUNTIME_INFO)


@app.post(
    "/ag-ui",
    tags=["ag-ui"],
    summary="CopilotKit single-endpoint transport",
    responses={200: {"description": "SSE stream (agent/run) or JSON object (info)"}},
)
async def runtime_single_endpoint(body: AgUiRequest, request: Request):
    """CopilotKit single-endpoint transport — handles method dispatch."""
    if body.method in ("info", "agent/connect"):
        return _RUNTIME_INFO

    if body.method == "agent/run":
        input_data = RunAgentInput(**body.body)
        return await _run_agent(input_data, request)

    return AgUiErrorResponse(error=f"Unknown method: {body.method}")


@app.get(
    "/health",
    tags=["health"],
    response_model=HealthResponse,
    summary="Health check",
)
async def health() -> HealthResponse:
    """Health check endpoint."""
    return HealthResponse(status="healthy", service="adsb-agent")


# ---------------------------------------------------------------------------
# Voice endpoints
# ---------------------------------------------------------------------------


@app.get(
    "/voice/backends",
    tags=["voice"],
    response_model=VoiceBackendsResponse,
    summary="List available voice backends",
)
async def list_voice_backends() -> VoiceBackendsResponse:
    """List available voice backends with their status."""
    result = {}
    for name, backend in _voice_backends.items():
        info = await backend.get_info()
        result[name] = {
            "name": info.name,
            "description": info.description,
            "status": info.status,
            "supports_end_to_end": info.supports_end_to_end,
            "model_size": info.model_size,
        }
    return VoiceBackendsResponse(backends=result)


@app.post(
    "/voice/start",
    tags=["voice"],
    response_model=VoiceStartResponse,
    responses={400: {"model": VoiceErrorResponse}},
    summary="Start voice capture",
)
async def start_voice(body: VoiceStartRequest) -> VoiceStartResponse | VoiceErrorResponse:
    """Start voice capture with selected backend."""
    global _active_voice_backend

    if _active_voice_backend is not None:
        await _active_voice_backend.stop_listening()

    backend = _voice_backends[body.backend]
    try:
        await backend.start_listening()
        _active_voice_backend = backend
        return VoiceStartResponse(status="listening", backend=body.backend)
    except (RuntimeError, OSError) as e:
        return JSONResponse(content={"error": str(e)})
    except Exception as e:
        logger.error("Unexpected error starting voice backend %s: %s", body.backend, e, exc_info=True)
        return JSONResponse(content={"error": f"Voice backend error: {e}"})


@app.post(
    "/voice/stop",
    tags=["voice"],
    response_model=VoiceStopResponse,
    summary="Stop voice capture",
)
async def stop_voice() -> VoiceStopResponse:
    """Stop voice capture."""
    global _active_voice_backend
    if _active_voice_backend is None:
        return VoiceStopResponse(status="not_listening")

    # Grab and clear immediately so concurrent requests get "not_listening"
    backend = _active_voice_backend
    _active_voice_backend = None

    await backend.stop_listening()
    transcript = getattr(backend, "_last_transcript", None)

    if transcript:
        logger.info("[voice/stop] Final transcript: %r", transcript)
    return VoiceStopResponse(status="stopped", backend=backend.name, transcript=transcript)


@app.get(
    "/voice/status",
    tags=["voice"],
    response_model=VoiceStatusResponse,
    summary="Current voice subsystem status",
)
async def voice_status() -> VoiceStatusResponse:
    """Get current voice status."""
    active_name = _active_voice_backend.name if _active_voice_backend else None
    active_status = (await _active_voice_backend.get_status()).value if _active_voice_backend else None

    return VoiceStatusResponse(
        active_backend=active_name,
        status=active_status,
        backends={
            name: (await b.get_status()).value for name, b in _voice_backends.items()
        },
    )


@app.get(
    "/voice/transcript",
    tags=["voice"],
    response_class=StreamingResponse,
    responses=VOICE_SSE_RESPONSES,
    summary="SSE stream of transcript chunks from active voice backend",
)
async def voice_transcript_stream(request: Request):
    """SSE stream of transcript chunks from the active voice backend.

    Each event is JSON: { "text": "...", "is_final": true/false }
    """
    if _active_voice_backend is None:
        async def _no_backend_error():
            yield 'data: {"error": "No active voice backend"}\n\n'
        return StreamingResponse(
            _no_backend_error(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
        )

    async def event_generator():
        full_transcript = []
        async for chunk in _active_voice_backend.get_transcript_stream():
            if (_shutdown_event is not None and _shutdown_event.is_set()) \
                    or await request.is_disconnected():
                logger.info("Voice transcript stream: exiting (shutdown or disconnect)")
                break
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
