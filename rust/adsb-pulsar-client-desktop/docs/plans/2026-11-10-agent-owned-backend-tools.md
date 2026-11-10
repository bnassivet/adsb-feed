# Agent-owned backend tools (AG-UI conformance)

## Problem

Every chat run carries the desktop's whole tool surface in `RunAgentInput.tools`.
Part of that surface is tools the desktop never executes: the server-executed
data tools (`getStorageStats`, `getAircraftSummary`, `getFlightSummary`,
`getTrajectory`, `getEventsOfInterest`, `getCurrentDateTime`,
`generateSimulatedTrajectory`). They were declared in `useCopilotTools.ts` only
because `graph.py::partition_tool_names` made a server tool callable *iff* the
frontend had sent its schema. Their frontend handlers and renders were dead
code, because server tools run inside the graph loop and never stream to the
client.

The same gate silently disabled `getTimeDistribution` and `getHourlyHeatmap`.
Both are in `SERVER_TOOL_NAMES` and served by `adsb-data-server`, but no
frontend ever declared them.

## What AG-UI says

Sources: docs.ag-ui.com concepts/tools, agents, middleware and capabilities,
plus `@ag-ui/core` 1.0.4.

- "Client-defined tools are passed in `RunAgentInput.tools`." They travel per
  run, by design.
- "`RunAgentInput.tools` is only for these client-provided tools. It is not
  intended to contain every tool available to the backend agent… advertise
  them through agent capabilities instead of sending their schemas from the
  client."
- `ToolsCapabilities.items` holds "the tools this agent provides on its own
  (full JSON Schema definitions)". `clientProvided: true` declares that the
  agent also accepts client tools.

## Rejected: syncing client tools once (digest/registry)

The first idea was to upload the tool manifest on connect and send only a
digest per run (`forwardedProps.toolsDigest`, `PUT /ag-ui/tools`, 409 to
resync). It is wire-compatible, because middleware may rewrite the input, but
the protocol has **no** mechanism for registering client tools. It would be a
private extension, and runs would stop being self-describing (traces, replay,
any other AG-UI client).

Two CopilotKit findings from the same review, kept for a future upgrade:
1.55.3 is installed, 1.85.0 is the latest release and 2.0.0-rc.37 is on
`next`.

- `selfManagedAgents` now logs an *Enterprise Intelligence tier* licence
  warning.
- `useAgent({ agentId, threadId })` **throws** in 1.85 unless `runtimeAgentId`
  is passed as well. `AIChatContent.tsx` uses that form today.

## Design

- `adsb-agent/src/adsb_agent/server_tools.py` is the single source of truth.
  It holds `SERVER_TOOLS` (AG-UI `Tool` objects) and the `SERVER_TOOL_NAMES`
  derived from them.
  - `effective_tools(client_tools)` returns the server tools plus the client
    tools minus server names. The server definition wins, so an older desktop
    that still sends a server-named tool causes no duplicate.
- `partition_tool_names`: the server set is always `SERVER_TOOL_NAMES`. The
  client set is whatever the client sent, minus server names.
- `render_system_prompt` and `build_agent_graph` both use `effective_tools`.
- `tools.TOOLS` (the dev / LangGraph Studio fallback) becomes
  `SERVER_TOOLS` + the client tool copies, so the descriptions have one source.
- `/info` (`/ag-ui/info`, `/info` and the single-endpoint `info`) advertises
  `agents.adsb_agent.capabilities.tools = {supported, items: SERVER_TOOLS,
  clientProvided: true, parallelCalls: false}`. CopilotKit 1.85 reads this
  into `agent.getCapabilities()`, and 1.55 ignores it.
- The desktop stops registering the 7 server tools. A test pins that no server
  tool name is ever registered as a frontend tool.

### Schemas now match the Rust API

The two tools that become reachable needed their schemas fixed. The old dev
fallback schemas would have failed `serde` deserialization in
`adsb-data-server`:

- `getTimeDistribution`: `startMs`, `endMs` and `numBuckets` are **required**
  (`TimeDistributionQuery` has no defaults for them). `metric` is optional and
  defaults to `Positions`.
- `getHourlyHeatmap`: `startMs` and `endMs` are required.

Descriptions of the list-returning tools no longer promise the
`{ total, showing, data, note }` envelope. Only the deleted frontend handlers
produced it, and the server path, which is the one actually used, returns
plain arrays.

## Not changed

- Client tools still travel on every run, as the protocol intends.
- LLM token usage is unchanged, because the model still receives every schema.
- `context` is still sent on every run, because it changes every turn.
