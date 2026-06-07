# Agentic UI — FastAPI Agent + CopilotKit + AG-UI (Local-First)

## Status: In Progress (Phase 1)

## Overview

Natural language interaction (text chat + voice) for the ADS-B desktop app via an embedded AI agent. Fully local stack: LM Studio (local LLM) + FastAPI (AG-UI agent) + CopilotKit (frontend chat UI). No cloud dependencies.

## Architecture

```
LM Studio (localhost:1234) ← OpenAI-compatible API
        ↑
FastAPI Agent (localhost:8000) ← AG-UI SSE protocol
        ↑
Tauri Desktop App (CopilotKit frontend)
  ├── useCopilotAction handlers → Tauri invoke → DuckDB
  └── AIChatPanel (floating/docked, dark theme)
```

## Phases

1. **FastAPI AG-UI Agent Service** — Python service, LM Studio streaming, tool definitions
2. **CopilotKit Frontend** — Chat panel, frontend tools, app state readables
3. **Generative UI** — Inline aircraft cards, charts, tables in chat
4. **Voice Input** — Dual backend: Voxtral STT (pipeline) vs LFM2.5-Audio (end-to-end), UI-selectable
5. **Convenience** — Auto-start sidecar, settings UI, SQLite conversation memory

## Key Decisions

- **Local-first**: LM Studio for LLM, no cloud API keys needed
- **FastAPI over embedded Rust**: Simpler, Python has first-class AG-UI/OpenAI SDKs
- **Frontend tools**: DuckDB queries execute in Tauri process via CopilotKit useCopilotAction
- **Voice dual backend**: Voxtral.c (STT sidecar, MPS) and LFM2.5-Audio (end-to-end, llama.cpp/MLX)
- **SQLite for conversation memory**: Separate from DuckDB aircraft data

See full plan: `.claude/plans/groovy-painting-penguin.md`
