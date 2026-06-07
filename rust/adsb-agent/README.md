# ADS-B AG-UI Agent

FastAPI service that streams LLM responses as AG-UI Server-Sent Events to the desktop app. Supports voice input via two backends: Voxtral (STT only) and LFM2.5-Audio (end-to-end speech understanding).

## Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv)
- A running OpenAI-compatible LLM endpoint (LM Studio by default)

## Quick start

```bash
# Install dependencies (use --all-extras to include voice + dev tooling)
uv sync --all-extras

# Start the agent (defaults to port 8000)
uv run python -m adsb_agent
```

> Bare `uv sync` installs only the base dependencies (chat, no voice). Use
> `uv sync --extra voice` for voice input, or `--all-extras` for everything.

## Configuration

All agent settings are environment variables with the `ADSB_AGENT_` prefix (loaded from
`.env` if present — copy [`.env.example`](.env.example) to `.env` and adjust). Defaults
live in `src/adsb_agent/config.py`.

**LLM:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_AGENT_LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible LLM endpoint |
| `ADSB_AGENT_LLM_API_KEY` | `lm-studio` | API key (any string for local servers) |
| `ADSB_AGENT_MODEL` | `qwen2.5-7b-instruct` | Model name — **must be a capable tool-caller** (see below) |
| `ADSB_AGENT_MAX_TOKENS` | `8192` | Max tokens per response |
| `ADSB_AGENT_TEMPERATURE` | `0.1` | Sampling temperature |

**Tool server & agent loop:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_AGENT_TOOL_SERVER_URL` | `http://127.0.0.1:8787` | Tauri tool server (read-only data plane); must match the desktop app's `ADSB_AGENT_TOOL_SERVER_PORT` |
| `ADSB_AGENT_TOOL_SERVER_TIMEOUT` | `30.0` | Per-call timeout (seconds) for tool-server requests |
| `ADSB_AGENT_AGENT_RECURSION_LIMIT` | `25` | Max LangGraph loop steps (caps tool-call hops) |

**Service:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_AGENT_PORT` | `8000` | Service port |
| `ADSB_AGENT_HOST` | `0.0.0.0` | Bind address |
| `ADSB_AGENT_SSE_HEARTBEAT_SECONDS` | `15.0` | Keep-alive interval for SSE streams during silent LLM steps |

**MLflow tracing (optional):**

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_AGENT_MLFLOW_ENABLED` | `true` | Enable MLflow tracing of agent runs |
| `ADSB_AGENT_MLFLOW_TRACKING_URI` | `http://localhost:5010` | MLflow tracking server URI |
| `ADSB_AGENT_MLFLOW_EXPERIMENT` | `adsb-agent` | MLflow experiment name |

When MLflow uses an S3-compatible artifact store (MinIO), also set the standard AWS/MLflow
vars (no `ADSB_AGENT_` prefix) so `boto3` targets MinIO instead of real AWS S3:

| Variable | Example | Description |
|----------|---------|-------------|
| `MLFLOW_S3_ENDPOINT_URL` | `http://localhost:9000` | MinIO endpoint |
| `AWS_ACCESS_KEY_ID` | `minioadmin` | MinIO access key |
| `AWS_SECRET_ACCESS_KEY` | `minioadmin` | MinIO secret key |
| `AWS_DEFAULT_REGION` | `us-east-1` | Region (any value; required by boto3) |
| `MLFLOW_DISABLE_TELEMETRY` | `true` | Opt out of MLflow telemetry |
| `DO_NOT_TRACK` | `true` | Generic telemetry opt-out |

Start the tracking server with `mlflow server --port 5010`.

### Model requirement

The agent runs a **server-side LangGraph ReAct loop**: it chains read-only data
tools (aircraft/flight summaries, trajectories, stats) internally before
answering, then forwards UI actions to the app. This multi-hop reasoning needs a
model that can plan and call tools reliably — pull **Qwen2.5-7B-Instruct** (or
14B if you have the RAM) in LM Studio/Ollama. The previous 1.2B model cannot
chain tool calls and is only viable as a weak fallback on tiny devices.

The data tools are executed against the desktop app's DuckDB store via a
loopback HTTP **tool server** the Tauri backend starts on `127.0.0.1:8787`
(`ADSB_AGENT_TOOL_SERVER_PORT` on the Rust side). UI/action tools and sensitive
mutations remain client-executed via the AG-UI/CopilotKit round-trip.

## API

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/ag-ui/agent/{id}/run` | POST | CopilotKit REST transport — SSE stream |
| `/ag-ui/chat` | POST | Direct AG-UI SSE endpoint |
| `/ag-ui/info` | GET | CopilotKit runtime discovery |
| `/info` | GET | Runtime discovery (alias of `/ag-ui/info`) |
| `/ag-ui` | POST | CopilotKit single-endpoint transport |
| `/health` | GET | Health check |
| `/voice/backends` | GET | List voice backends and their status |
| `/voice/start` | POST | Start voice capture |
| `/voice/stop` | POST | Stop capture and return transcript |
| `/voice/status` | GET | Current voice subsystem status |
| `/voice/transcript` | GET | SSE stream of transcript chunks |
| `/docs` | GET | OpenAPI / Swagger UI |

## Voice input

Voice input requires the `voice` extra (`uv sync --extra voice` or `--all-extras`), which
pulls in `sounddevice`, `numpy`, and `llama-cpp-python`.

The agent supports two voice backends. Select one via the mic button in the desktop app (or `ADSB_AGENT_LFM2_MODEL_DIR` / backend choice in POST `/voice/start`).

### LFM2.5-Audio (recommended)

End-to-end speech understanding using LiquidAI's LFM2.5-Audio-1.5B model. Runs entirely local via `llama-liquid-audio-server` (LiquidAI's custom llama.cpp build).

**Setup — macOS Apple Silicon only:**

```bash
# Run the bundled install script (downloads ~1 GB of model files)
bash install_lfm-25-audio-server.sh
```

The script downloads from HuggingFace into `./models/LFM2.5-Audio/`:

| File | Size | Role |
|------|------|------|
| `LFM2.5-Audio-1.5B-Q4_0.gguf` | 696 MB | Main transformer weights |
| `mmproj-LFM2.5-Audio-1.5B-Q4_0.gguf` | 220 MB | Multimodal projector (audio → token space) |
| `vocoder-LFM2.5-Audio-1.5B-Q4_0.gguf` | 109 MB | Vocoder (TTS; required even for ASR-only) |
| `tokenizer-LFM2.5-Audio-1.5B-Q4_0.gguf` | 51 MB | Audio codebook |
| `bin/llama-liquid-audio-macos-arm64/llama-liquid-audio-server` | — | Inference server binary |

After install, remove the macOS quarantine attribute if macOS blocks the binary:

```bash
xattr -dr com.apple.quarantine ./models/LFM2.5-Audio/bin/
```

Then allow the binary in **System Settings → Privacy & Security** if prompted.

**F16 variant** (higher quality, ~3× more RAM):

```bash
ADSB_AGENT_LFM2_QUANT=F16 bash install_lfm-25-audio-server.sh
```

**Environment variables:**

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_AGENT_LFM2_MODEL_DIR` | `./models/LFM2.5-Audio` | Directory containing the 4 GGUF files |
| `ADSB_AGENT_LFM2_QUANT` | `Q4_0` | Quantization (`Q4_0` or `F16`) |
| `ADSB_AGENT_LLAMA_SERVER` | `{MODEL_DIR}/bin/llama-liquid-audio-macos-arm64/llama-liquid-audio-server` | Binary path |
| `ADSB_AGENT_LLAMA_PORT` | `2026` | Port for the inference server |

The agent auto-launches `llama-liquid-audio-server` on the first voice request and keeps it running until shutdown. Typical startup time: 5–15s (model loading).

**How it works:**

1. Click mic → agent starts buffering audio from the microphone
2. Click stop → agent sends the buffered WAV to `POST /v1/chat/completions` with system prompt `"Perform ASR."`
3. The server streams back the transcript
4. Transcript is injected into the chat input

### Voxtral

STT-only backend using Mistral's Voxtral model. Requires the `voxtral` binary (not bundled). When not installed, the backend shows as `not_ready` and falls back gracefully.

## Development

```bash
# Install with dev extras
uv sync --extra dev

# Run tests
uv run pytest tests/ -v

# Lint
uv run ruff check src/ tests/
```

## Architecture notes

- Voice backends implement the `VoiceBackendStatus` / `BackendInfo` protocol in `voice/base.py`
- LFM2 is a **batch** backend: audio buffers during recording, inference runs once on stop. The SSE transcript stream idles (yields nothing) during capture; the final text is returned via `POST /voice/stop`
- The agent streams AG-UI events using `ag-ui-protocol`; the frontend consumes them via CopilotKit
