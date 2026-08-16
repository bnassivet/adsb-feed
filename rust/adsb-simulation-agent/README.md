# ADS-B Simulation Agent

A2A agent that generates kinematically plausible simulated aircraft trajectories for the desktop tracker's demo mode. Turns a natural-language route request ("police helicopter circling the old port") into timed waypoints that respect real flight-dynamics limits.

Called by [`adsb-agent`](../adsb-agent) over the [A2A protocol](https://a2a-protocol.org/); not part of the Cargo workspace.

## Requirements

- Python 3.12+
- [uv](https://github.com/astral-sh/uv)
- *(optional)* An OpenAI-compatible LLM endpoint for natural-language route hints — LM Studio by default

## Quick start

```bash
uv sync --all-extras

# Start the agent (defaults to port 8300)
uv run python -m adsb_simulation_agent
```

Verify it's up:

```bash
curl http://localhost:8300/health
curl http://localhost:8300/.well-known/agent-card.json
```

> **The LLM is optional.** Without it, route hints are ignored and seeded default plans are used instead. A dead or missing LM Studio degrades the feature; it never breaks a request.

## Configuration

Environment variables with the `ADSB_SIM_AGENT_` prefix (loaded from `.env` if present — copy [`.env.example`](.env.example)). Defaults live in `src/adsb_simulation_agent/config.py`.

| Variable | Default | Description |
|----------|---------|-------------|
| `ADSB_SIM_AGENT_PORT` | `8300` | HTTP port |
| `ADSB_SIM_AGENT_HOST` | `0.0.0.0` | Bind address |
| `ADSB_SIM_AGENT_LLM_BASE_URL` | `http://localhost:1234/v1` | OpenAI-compatible endpoint |
| `ADSB_SIM_AGENT_LLM_API_KEY` | `lm-studio` | API key (any string for local servers) |
| `ADSB_SIM_AGENT_MODEL` | `qwen2.5-7b-instruct` | Model used only to classify route hints |
| `ADSB_SIM_AGENT_TEMPERATURE` | `0.0` | Zero — this is classification, not generation |
| `ADSB_SIM_AGENT_MAX_TOKENS` | `512` | A route plan is a handful of scalars |
| `ADSB_SIM_AGENT_LLM_TIMEOUT_S` | `30` | Per-call LLM timeout |
| `ADSB_SIM_AGENT_MAX_RETRIES` | `2` | Regeneration attempts after a failed plausibility check |

Ports in this project: `8000` = adsb-agent, `8300` = this service, `8787` = Tauri tool server.

## API

| Endpoint | Purpose |
|----------|---------|
| `GET /.well-known/agent-card.json` | A2A agent card (capability discovery) |
| `POST /` | A2A JSON-RPC endpoint |
| `GET /health` | Health check |

### Generating a trajectory

```bash
curl -X POST http://localhost:8300/ \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "SendMessage",
    "params": {
      "message": {
        "messageId": "m1",
        "role": "ROLE_USER",
        "parts": [{"data": {
          "originLat": 45.5,
          "originLng": -73.6,
          "category": "helicopter",
          "routeHint": "circle the old port at 1200 feet"
        }}]
      }
    }
  }'
```

> **The `A2A-Version: 1.0` header is mandatory.** Omitting it is interpreted as protocol 0.3 and the server replies `VERSION_NOT_SUPPORTED`. See [a2a-sdk v1.x notes](#a2a-sdk-v1x-notes).

**Request fields** (snake_case or camelCase both accepted):

| Field | Required | Description |
|-------|----------|-------------|
| `originLat` / `originLng` | **yes** | Receiver location; routes are built around this point |
| `category` | no | `airliner` \| `ga` \| `helicopter` \| `fighter` (default `ga`) |
| `count` | no | Aircraft to generate, 1–20 (default 1) |
| `routeHint` | no | Free text, interpreted by this service |
| `cruiseAltitudeFt` | no | Target altitude; the route is lengthened if needed to reach it |
| `plan` | no | Pre-structured `RoutePlan`, skipping the LLM step |
| `seed` | no | Fixes the RNG for a reproducible scenario |

**Response** — the trajectory is at `result.task.artifacts[0].parts[0].data`:

```json
{
  "aircraft": [{
    "hex_ident": "SIM-7EFA8A",
    "callsign": "HELI001",
    "category": "helicopter",
    "waypoints": [
      {"lat": 45.53, "lng": -73.64, "alt_ft": 1200.0, "speed_kts": 95.0,
       "heading_deg": 57.0, "phase": "loiter", "t_offset_s": 0.0}
    ]
  }],
  "violations": [],
  "summary": "1 aircraft (helicopter), 86 waypoints, 11 min"
}
```

`result.task.status.state` is `TASK_STATE_COMPLETED` on success. **Generation failures arrive as `TASK_STATE_FAILED` inside a successful JSON-RPC response**, not as a JSON-RPC error — clients must check task state.

Use `summary` for anything that enters an LLM's context. A 2-lap helicopter orbit is ~240 waypoints; the full payload is for the frontend only.

## How it works

```
                    parse_intent  (LLM: classify hint -> RoutePlan)
                          |
                     plan_route   (deterministic pattern -> anchor track)
                          |
                   apply_kinematics  (corner rounding, phases, timing)
                          |
                      validate  --(violations)--> plan_route
                          |
                         END
```

**The design rule that matters most: the LLM classifies, Python computes.** The model is asked only for a route pattern (`orbit`, `racetrack`, `transit`, `approach`, `maneuver`) plus four scalars. It is never asked for coordinates, and any it volunteers are discarded. That is what makes this reliable on a 7B local model.

### Flight dynamics

Three constraints are enforced structurally rather than checked afterwards:

1. **Turn rate implies a minimum pattern size.** A 3°/s limit at 450 kts means an airliner cannot turn inside ~2.4 NM, so patterns are enlarged per category before geometry is built. A requested radius is a *request*, not a guarantee.
2. **Corner rounding enforces the turn rate.** Polyline vertices are replaced with true circular arcs of radius `v/ω`; flying them at `v` yields exactly `ω`.
3. **Altitude comes from available time.** Descending 5000 ft at 700 fpm needs ~7 min; a 6 NM final at 100 kts lasts ~4. Altitude is capped to what the route affords — or the route is stretched to fit an explicitly requested altitude.

Per-category envelopes (speeds, climb/descent rates, turn rates, cruise bands) live in `src/adsb_simulation_agent/kinematics.py`.

## Development

```bash
uv sync --all-extras

uv run pytest                    # ~409 tests
uv run pytest tests/test_trajectory.py -q
uv run ruff check . && uv run ruff format --check .
```

All changes follow TDD (Red → Green → Refactor), per repo convention.

### CI gate

```bash
uv run pytest && uv run ruff check . && uv run ruff format --check .
```

## a2a-sdk v1.x notes

This service targets `a2a-sdk` **1.1+**, which broke compatibility with pre-1.0 examples found online:

- `A2AStarletteApplication` was **removed** — use `create_agent_card_routes()` + `create_jsonrpc_routes()`.
- Types are **Protobuf**, not Pydantic (`TaskState.TASK_STATE_COMPLETED`; no `TextPart`/`DataPart`).
- `AgentCard.url` → `supported_interfaces=[AgentInterface(...)]`.
- `DefaultRequestHandler` now requires `agent_card`.
- Well-known path is `/.well-known/agent-card.json` (was `agent.json`).
- JSON-RPC methods are PascalCase: `SendMessage`, not `message/send`.
- Clients **must** send `A2A-Version: 1.0`.

See [`CLAUDE.md`](CLAUDE.md) for the full list.

## Layout

```
src/adsb_simulation_agent/
├── models.py       # RoutePlan (intent), Waypoint/TrajectoryResponse (geometry)
├── kinematics.py   # Per-category envelopes + geodesy
├── geometry.py     # Pattern synthesis -> anchor track
├── trajectory.py   # Corner rounding, phases, speeds, timing
├── validate.py     # Plausibility checks (drives the retry edge)
├── intent.py       # Route hint -> RoutePlan via LLM
├── graph.py        # LangGraph + generate()
├── agent_card.py   # A2A capability description
├── executor.py     # A2A protocol boundary
└── server.py       # Starlette app
```
