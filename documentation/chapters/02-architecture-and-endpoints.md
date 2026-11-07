---
part: Architecture
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/boot/server.ts, lazy-agent-service:src/routes/AgentRoutes.ts, lazy-agent-service:src/routes/Harness2Routes.ts, lazy-agent-service:src/routes/McpServersRoutes.ts, lazy-agent-service:src/services/AgentSessionRegistry.ts
---

# Architecture and endpoints

One Express process (`src/index.ts` → `src/boot/server.ts`), listening on `PORT` (NAS `:5591`),
with a single endpoint registry used by the health check and boot log. All mounts live in
`src/boot/server.ts`; identity middleware (`AuthMiddleware`, which copies `x-project` /
`x-username` for scoping) applies after `/admin`, `/files`, `/mcp/oauth` and before everything
else.

## Core HTTP & SSE endpoints

| Endpoint | Method | What it does |
|---|---|---|
| `/health` | GET | Liveness for Docker (30 s checks); never traced (ch.07) |
| `/agent` | POST | The main agent run. Default response is SSE (`Accept: text/event-stream`); `Accept: application/json` returns a single JSON reply. Runs `AgenticLoopService` with persona + tools. |
| `/agent/stop` | POST | Stop a running agent session (tracked in `ActiveGenerationTracker`; decoupled from the SSE connection lifecycle so a dropped mobile client doesn't cancel the run) |
| `/harness2/run` | POST | The v2 harness run endpoint (ch.03): async run jobs with records, request checks and model preflight; rollouts always terminate. Plus `GET /harness2/library/:domain`, `GET/DELETE /harness2/library/:domain/:taskId`. |
| `/chat` | POST (+ static `public/chat`) | First-party chat UI and OpenAI-style chat turns on the same loop |
| `/embed` | POST | Shared EmbeddingGemma 2 embeddings, single text or `texts` batch 1–32 (ch.06) |
| `/v1/embeddings` | POST | OpenAI-shaped wrapper over the same model/queue/spaces |
| `/mcp-servers` | CRUD + POST `/:id/connect` | MCP server registry rows and connect; **stdio rows refused unless the command is on `MCP_STDIO_COMMANDS`** (ch.12). `POST /mcp` is the MCP transport surface (`/mcp/oauth` for OAuth flows). |
| `/custom-agents` | GET/POST/PUT | The shared agent registry (`prism.custom_agents` collection; all trading V3 agents included) |
| `/conversations`, `/memory`, `/workflows` | various | Conversation history, agent memories, workflow recall |
| `/obsidian-completions(/:id)` | PUT/GET | Durable model completions for the LLMSortObsidian plugin; SSE push on GET (ch.03) |
| `/api/wallgarden/*` | POST/GET | youtube-wallgarden LLM jobs behind `JetsonGate` (ch.04) |
| `/config`, `/config/agents` | GET | `textToText.models` provider map consumed by lazycat-sdk |

## SSE vocabulary

Streaming responses emit `delta` content, `delta.reasoning` / `delta.reasoning_content`
(recovered reasoning from `nemotron35` / DeepSeek), `tool_call` events, `job.activeTools`,
and terminal `done`/`error` frames. `RunawayStreamWatch` (`src/core/loop/`) ends streams that
produce nothing or loop; runs keep going when the client disconnects, and the first-party
chat UI re-attaches to the durable record.

## MCP surface and the Prism history

Today: `MCPClientService` connects outbound MCP servers (sse / streamable-http; stdio only via
the allowlist) from the `prism.mcp_servers` collection, exposes this service's 78 tools as an
MCP server itself, and `LocalToolRouter` answers the local families (`html_notes_*`,
`canvas_*`, `strain_*`, `lazy_web_search`) without leaving the process.

**Prism MCP redial & registration (historical).** Until 2026-10-31 prism-service dialed this
service's MCP server once at its own boot, so after every lazy-agent-service deploy the trading
agents lost all MCP tools until someone hand-curl'd `POST /mcp-servers/:id/connect`. A
periodic re-dialer (`PrismMcpRedial.ts`) fixed that: boot dial with retries
(`5000,15000,60000` ms), a 5-minute check loop, dial only when prism reported
`connected: false`, one stale-entry re-dial per hour, unref'd chained timers cleared at
shutdown. On 2026-10-31 prism-service was removed from the stack (`ee61164`): the re-dialer,
`PrismProxyService`, `PrismAttribution` and the `PRISM_MCP_*` compose variables were deleted;
this service no longer registers with prism at all (registration itself was already gone
since 2026-10-16 — `PrismRegistrationService.ts` deleted). Nothing forwards to `:7777`;
only the `LocalToolRouter` repeat guards from that era remain (ch.10 ADR-05).

## lazycat-sdk integration

lazycat-sdk resolves `prism_client.url` to the bare `http://<host>:5591` (never `:7777`;
`harness_base_url()`/`harness_agent_url()` strip any `/prism-proxy` so no production call can
reach the old gateway). `call_agent` routes to native `/agent` through the SDK whenever a
harness URL is set — the old direct-vLLM bypass applies only to callers that never configured
one. Provider/model resolution reads `GET /config?includeLocal=true`; persona registration and
the Canvas persona upsert happen through `CustomAgentsRoutes` / `ClientPersonaSync.ts`.
Endpoint-by-endpoint coverage is pinned by `NativePrismExitRoutes.test.ts`.

## Request lifecycle (one tool-calling turn)

```
caller → AuthMiddleware → AgentRoutes POST /agent
  → AgentSessionRegistry / ActiveGenerationTracker
  → AgenticLoopService → core loop (ch.03)
      → DynamicModelResolver (ch.04) → vLLM box
      → ToolRunner → decideToolCall → ToolOrchestratorService
          → LocalToolRouter | MCP client | trading bridge (ch.05)
  → SSE frames back to caller; request row + spans recorded (ch.07)
```
