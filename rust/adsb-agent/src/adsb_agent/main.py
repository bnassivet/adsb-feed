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

from .config import settings
from .llm import stream_llm_response
from .tracing import make_span, set_session_tag
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

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s %(levelname)-8s %(name)s %(filename)s:%(lineno)d - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("adsb_agent")

# Silence noisy third-party DEBUG output (boto3/botocore emit very verbose wire
# logs for MinIO/S3 artifact uploads). Keep WARNING+ so real problems surface.
for _noisy in (
    "boto3", "botocore", "s3transfer", "urllib3",
    # httpcore/httpx/openai emit very verbose per-request wire logs at DEBUG,
    # including a benign `receive_response_body.failed exception=GeneratorExit()`
    # when a streamed response is closed at end-of-run.
    "httpcore", "httpx", "openai",
):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

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


class RequestLoggingMiddleware:
    """Pure-ASGI request/response logger.

    Deliberately implemented as raw ASGI rather than Starlette's
    ``BaseHTTPMiddleware``: the latter wraps every response in an anyio task
    group via ``call_next``, which cancels long-lived SSE agent streams
    mid-run ("Cancelled via cancel scope ... by call_next") once a multi-hop
    turn runs longer than the surrounding scope expects. Raw ASGI forwards the
    ``send`` channel straight through, so streaming responses are never wrapped
    and never cancelled.

    Behaviour matches the previous middleware: it logs request method/URL/
    selected headers/body, and the response status; for non-SSE responses it
    also logs the (pretty-printed) body, while SSE responses log metadata only.
    """

    _HEADERS_OF_INTEREST = ("accept", "content-type", "origin", "user-agent")

    def __init__(self, app):
        self.app = app

    @staticmethod
    def _pretty(body: bytes, limit: int) -> str:
        if not body:
            return "(empty)"
        try:
            return json.dumps(json.loads(body), indent=2, default=str)
        except Exception:
            return body.decode(errors="replace")[:limit]

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        path = scope.get("path", "")
        headers = {k.decode(): v.decode() for k, v in scope.get("headers", [])}

        # Drain the request body so we can log it, then replay it to the app.
        # All requests here are small JSON or empty — safe to buffer fully.
        buffered: list[dict] = []
        while True:
            message = await receive()
            buffered.append(message)
            if message["type"] != "http.request" or not message.get("more_body", False):
                break
        body = b"".join(
            m.get("body", b"") for m in buffered if m["type"] == "http.request"
        )

        logger.debug(
            "\n========== REQUEST ==========\n"
            "%s %s\n"
            "Headers: %s\n"
            "Body:\n%s\n"
            "=============================",
            method,
            scope.get("path", ""),
            json.dumps({k: v for k, v in headers.items() if k.lower() in self._HEADERS_OF_INTEREST}),
            self._pretty(body, 1000),
        )

        replay = iter(buffered)

        async def replay_receive():
            try:
                return next(replay)
            except StopIteration:
                return await receive()

        state = {"streaming": False, "status": 0, "ct": "", "body": bytearray(), "logged": False}

        async def send_wrapper(message):
            mtype = message["type"]
            if mtype == "http.response.start":
                state["status"] = message["status"]
                rheaders = {k.decode(): v.decode() for k, v in message.get("headers", [])}
                state["ct"] = rheaders.get("content-type", "")
                state["streaming"] = "event-stream" in state["ct"]
                if state["streaming"]:
                    logger.debug(
                        "\n========== RESPONSE =========\n"
                        "%s %s -> %d\nContent-Type: %s\n"
                        "Body: (SSE stream — events logged individually below)\n"
                        "=============================",
                        method, path, state["status"], state["ct"],
                    )
            elif mtype == "http.response.body" and not state["streaming"]:
                state["body"].extend(message.get("body", b""))
                if not message.get("more_body", False) and not state["logged"]:
                    state["logged"] = True
                    logger.debug(
                        "\n========== RESPONSE =========\n"
                        "%s %s -> %d\nContent-Type: %s\nBody:\n%s\n"
                        "=============================",
                        method, path, state["status"],
                        state["ct"] or "unknown",
                        self._pretty(bytes(state["body"]), 2000),
                    )
            await send(message)

        await self.app(scope, replay_receive, send_wrapper)


app.add_middleware(RequestLoggingMiddleware)


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

    def _shutting_down() -> bool:
        return _shutdown_event is not None and _shutdown_event.is_set()

    # Encoded AG-UI frames flow producer → consumer through this queue. A single
    # LLM step on a local model can run for minutes while emitting nothing (prompt
    # processing, or a tool call with no text). Without bytes on the wire the
    # client/proxy idle-timeout aborts the SSE connection mid-run, which surfaced
    # as a GeneratorExit cancelling the in-flight LLM read. The consumer emits a
    # heartbeat comment during these silent gaps to keep the connection alive.
    queue: asyncio.Queue = asyncio.Queue()
    _SENTINEL = object()

    async def _produce() -> None:
        # Root span lives INSIDE this task so MLflow's contextvar-based span
        # context wraps the graph run (LangChain autolog spans nest correctly).
        with make_span("chat_turn", span_type="CHAIN") as span:
            set_session_tag(thread_id, run_id=run_id)
            if span is not None:
                span.set_inputs({
                    "thread_id": thread_id,
                    "run_id": run_id,
                    "messages": [
                        {"role": m.role, "content": getattr(m, "content", None)}
                        for m in input_data.messages
                    ],
                })

            assistant_text_parts: list[str] = []
            tool_call_names: list[str] = []
            errored = False

            await queue.put(encoder.encode(RunStartedEvent(
                type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id,
            )))

            try:
                async for event in stream_llm_response(
                    messages=input_data.messages,
                    tools=input_data.tools,
                    context=input_data.context,
                ):
                    if event.type == EventType.TEXT_MESSAGE_CONTENT:
                        assistant_text_parts.append(getattr(event, "delta", "") or "")
                        logger.debug(f"{event}")
                    elif event.type == EventType.TOOL_CALL_START:
                        name = getattr(event, "tool_call_name", None)
                        if name:
                            tool_call_names.append(name)
                    logger.debug("Event: %s", event.type)
                    if event.type in (EventType.TEXT_MESSAGE_END):
                        logger.debug(f"{event}")
                    await queue.put(encoder.encode(event))
            except Exception as e:
                errored = True
                logger.error("Agent error: %s", e, exc_info=True)
                await queue.put(encoder.encode(RunErrorEvent(
                    type=EventType.RUN_ERROR, message=f"Agent error: {e}",
                )))

            if not errored and not _shutting_down():
                await queue.put(encoder.encode(RunFinishedEvent(
                    type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id,
                )))

            if span is not None:
                span.set_outputs({
                    "text": "".join(assistant_text_parts),
                    "tool_calls": tool_call_names,
                    "errored": errored,
                })
        await queue.put(_SENTINEL)

    async def event_generator():
        producer = asyncio.create_task(_produce())
        try:
            while True:
                try:
                    item = await asyncio.wait_for(
                        queue.get(), timeout=settings.sse_heartbeat_seconds
                    )
                except asyncio.TimeoutError:
                    # SSE comment line — ignored by clients, keeps the pipe warm.
                    yield ": keep-alive\n\n"
                    continue
                if item is _SENTINEL:
                    break
                yield item
        finally:
            # Client disconnect → GeneratorExit here → cancel the producer so the
            # in-flight LLM/tool calls are torn down cleanly.
            if not producer.done():
                producer.cancel()
                try:
                    await producer
                except (asyncio.CancelledError, Exception):
                    pass

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
    # Chat session id forwarded from the panel — used to tag the MLflow trace
    # produced when this capture is transcribed, so voice and chat traces
    # share an MLflow session.
    backend.session_id = body.session_id
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
