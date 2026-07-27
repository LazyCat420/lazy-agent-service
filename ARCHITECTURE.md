# lazy-agent-service Architecture

> Last updated: 2026-07-27

## Names — read this first

This service has two names and they are both correct. The repo was renamed
`lazy-tool-service` → `lazy-agent-service` on 2026-07-15, but the **deployed
identity deliberately did not follow**:

| Layer | Name | Why |
|-------|------|-----|
| GitHub repo / local folder / `package.json` | `lazy-agent-service` | renamed |
| Docker image + `container_name` | `lazy-tool-service` | `deploy.sh` `IMAGE_NAME` |
| MCP registration in prism (`PrismRegistrationService.ts:45`) | `lazy-tool-service` | **protocol identifier** |
| MCP `serverInfo.name` (`McpAdapter.ts:38`) | `lazy-tool-service` | **protocol identifier** |
| Prism attribution project (`PrismAttribution.ts:16`) | `lazy-tool-service` | scoping key |
| Telemetry `service_source` | `lazy-tool-service` | renaming splits historical rows |

**Do not rename the MCP registration.** The tool prefix
`mcp__lazy-tool-service__*` *derives* from it; there are ~195 references to that
prefix across the ecosystem (vs ~7 to the agent-service form), including the
live persona's tool list. `src/routes/PlatformRoutes.ts` accepts both prefixes
for reads, but `trading-client/app/routers/tools.py` strips only one of them in
raw SQL, so a rename would silently break attribution there.

There is **one container**, not two. If you see a `sun/lazy-tool-service/`
directory, it is litter — docker auto-creates it as root when a compose bind
mount resolves against a missing path.

## Overview

This service wears **three hats** on one port (host `5591` → container `7778`):

1. **MCP tool server** — `/mcp/sse`, `/mcp/messages`, `/execute/*`. Self-registers
   into prism (`:7777`) at boot via `PrismRegistrationService`, inside
   `server.listen()` so prism's dial-back cannot race it.
2. **prism-proxy guardrail** — `/prism-proxy/*` forwards to `REAL_PRISM_URL`
   (`:7777`) while enforcing a per-conversation `sessionAllowedTools` whitelist and
   rewriting non-leading system messages for Qwen. `trading-service`'s `PRISM_URL`
   points *here*, so its LLM traffic transits this process.
3. **Agent harness** — a fork of prism-service: `/agent`, `AgenticLoopService`,
   personas, and the platform dashboard at `/dashboard`. Opt-in for callers
   (HTML-Notes toggles between this and canonical prism per request).

It must **never** contain trading cycle management or cognition/evaluation logic.

## Layers

### TypeScript Layer (`src/`) — the whole service

| Component | Responsibility |
|-----------|---------------|
| `boot.ts` | Entry point — starts Express + MCP SSE server |
| `src/mcp/` | MCP SSE transport — registers tools from schema, proxies calls to Python |
| `src/routes/` | Express REST routes (`/tools`, `/health`, `/schemas`) |
| `tool_schemas/` | Per-app/per-domain source folders for tool schemas (`<owner_app>/<domain>.json`). Edit these, not the flat file. |
| `tool_schemas.json` | Build artifact — flat array generated from `tool_schemas/` by `trading-service/scripts/build_tool_schemas.py` (run by deploy.sh; `update_tool_schemas.py` refreshes the sources from prism + native registry). |

The TS layer is the entire service. Tool calls arrive over MCP or REST and are
dispatched by `src/services/LocalToolRouter.ts`:

| Tool prefix | Destination |
|-------------|-------------|
| `html_notes_*`, `canvas_*` | HTML-Notes over HTTP |
| `strain_*` | treesearch-service |
| `music_player_*` | music-player (`:8002`) |
| everything else | `trading-service` `/api/v1/agent-tools/execute` |

### There is no Python layer (removed 2026-07-27)

This repo used to carry a `python/` tree — a deploy-time mirror of
`trading-service/app`, its `scripts/`, and `lazycat-sdk/lazycat`, ~12 MB and 549
tracked files. **It never ran.** `Dockerfile` stage 2 copies only `node_modules`,
`dist`, `package.json`, `tool_schemas.json` and `public` onto a bare
`node:22-slim`, so the image has no interpreter; the subprocess bridge that would
have used it (`spawn execute_tool.py`) was removed long before, and every
python-backed tool goes over HTTP to trading-service instead.

The tree is now gitignored. **Do not reinstate it** without also adding Python to
the Dockerfile — a mirror that ships nowhere silently drifts and makes this repo
read as a duplicate of trading-service.

### What Does NOT Belong Here

The following categories of code must live in `trading-service`:

| Category | Where It Lives | Why |
|----------|---------------|-----|
| **Agent orchestration** (`agents/`) | `trading-service/app/agents/` | Agent loop, base agent, tool whitelists — orchestration logic |
| **Cycle management** (`cycle/`) | `trading-service/app/cycle/` | V2 pipeline phases, state management, lifecycle control |
| **Cognition** (`cognition/`) | `trading-service/app/cognition/` | Memory, ontology, evolution, debate — trading intelligence |
| **Autoresearch** (`autoresearch/`) | `trading-service/app/autoresearch/` | Eval engine, auditors — trading evaluation |
| **Monitoring** (`monitoring/`) | `trading-service/app/monitoring/` | LLM tracker, dashboard, profiler — observability |
| **Recovery** (`recovery/`) | `trading-service/app/recovery/` | Failure types, recovery engine — orchestration recovery |
| **Worker** (`worker/`) | `trading-service/app/worker/` | Background worker config — orchestration infrastructure |
| **Pipeline service** | `trading-service/app/services/pipeline_service.py` | V2 orchestrator service class |
| **cycle_main.py** | `trading-service/cycle_main.py` | Cycle entrypoint |

## Communication

```
   ┌─────────────────┐        ┌──────────────┐
   │  trading-client │        │  HTML-Notes  │
   └────────┬────────┘        └──────┬───────┘
            │ HTTP                   │ /agent (either gateway)
   ┌────────▼────────┐               │
   │ trading-service │               │
   │  (orchestrator) │               │
   └────────┬────────┘               │
            │ PRISM_URL =            │
            │ :5591/prism-proxy      │
   ┌────────▼───────────────────────▼────────┐
   │  THIS SERVICE   host :5591 → ctr :7778  │
   │  ├─ /mcp/sse, /execute   tool server    │
   │  ├─ /prism-proxy         guardrail ─────┼──► prism-service :7777
   │  └─ /agent               harness fork   │      (Rod's, canonical)
   └─────────────────────┬───────────────────┘
                         │ HTTP tool dispatch
        trading-service · HTML-Notes · treesearch · music-player
```

- prism (`:7777`) dials **in** to `:5591/mcp/sse` — the MCP registration is what
  makes the 83 tools visible to every prism-hosted agent.
- trading-service's LLM traffic goes **out** through `:5591/prism-proxy` to
  `:7777`, which is where the per-conversation tool whitelist is enforced.
- Tool execution itself is dispatched back out over HTTP; this process holds no
  trading state and talks to no trading database directly.

## Rules for Future Development

1. **No agent code** — if it has an agent loop, it goes in `trading-service`
2. **No cycle management** — if it manages pipeline state, it goes in `trading-service`
3. **No cognition** — if it involves memory, ontology, or evolution, it goes in `trading-service`
4. **Tools are stateless executors** — they receive a request, execute, return a result
5. **Shared Python code goes in `lazycat-sdk`** — and is consumed by the Python
   services that mount it (trading-service, HTML-Notes, scraper-service). This
   repo is Node-only and must not vendor a copy of it.
6. **Never rename the MCP registration** — see the Names table at the top.

## HTML-Notes Widget System

The service has been extended to manage the widget lifecycle for `HTML-Notes`. This includes:
* **Tool Schema Enforcement**: Custom widget schemas (`plan_widget`, `create_widget`, `update_widget`, `validate_widget_html`, `list_widget_types`) are registered in `tool_schemas.json`.
* **Execution Interception**: These widget tools are intercepted in `ExecuteRoutes.ts` and validated inside `WidgetTemplateRegistry.ts` (doing HTML matching validation and CSS rule scoping) before forwarding layout payloads to `html-notes`.

