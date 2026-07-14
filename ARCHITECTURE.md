# lazy-tool-service Architecture

> Last updated: 2026-06-25

## Overview

`lazy-tool-service` is a **tool execution service** that exposes Python-based
tools over REST and MCP SSE for consumption by AI agents. It is a pure
infrastructure layer — it should **never** contain agent orchestration, trading
cycle management, or cognition/evaluation logic.

## Layers

### TypeScript Layer (`src/`)

| Component | Responsibility |
|-----------|---------------|
| `boot.ts` | Entry point — starts Express + MCP SSE server |
| `src/mcp/` | MCP SSE transport — registers tools from schema, proxies calls to Python |
| `src/routes/` | Express REST routes (`/tools`, `/health`, `/schemas`) |
| `add_schemas.cjs` | Pre-build step that merges tool schemas from Python registry into `tool_schemas.json` |

The TS layer is a **thin proxy**. It receives MCP tool calls or REST requests,
forwards them to the Python tool registry, and streams results back.

### Python Layer (`python/app/`)

| Directory | Responsibility | Allowed? |
|-----------|---------------|----------|
| `tools/` | Tool implementations (trading, portfolio, charting, web, finance, etc.) | ✅ Core |
| `services/` | Supporting services (prism client, vllm client, bot manager, embeddings, scraper, etc.) | ✅ Core |
| `config/` | Configuration, model configs, ticker configs, lenses | ✅ Core |
| `db/` | Database connection, migrations | ✅ Core |
| `schemas/` | Pydantic models for tool I/O | ✅ Core |
| `utils/` | Shared utilities (text, math, formatting) | ✅ Core |
| `plugins/` | Plugin system for tool discovery | ✅ Core |
| `data/` | Data loaders, processors | ✅ Core |
| `collectors/` | Market data collectors (yfinance, finnhub, etc.) | ✅ Core |
| `processors/` | Data processing pipelines | ✅ Core |
| `validation/` | Input validation | ✅ Core |
| `trading/` | Paper trader, portfolio, watchlist, order triggers | ✅ Core (tools need direct access) |
| `pipeline/` | Pipeline analysis, ticker selection, context building | ⚠️ Legacy — tools reference it |
| `graph/` | Correlation engine, sector collector, graph queries | ⚠️ Legacy — data enrichment |
| `constants.py` | Shared constants | ✅ Core |
| `cache.py` | In-memory caching | ✅ Core |
| `log_manager.py` | Minimal logger stub | ✅ Core |

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
                  ┌─────────────────┐
                  │  trading-client │
                  │   (frontend)    │
                  └────────┬────────┘
                           │ HTTP
                  ┌────────▼────────┐
                  │ trading-service │
                  │  (orchestrator) │
                  └────────┬────────┘
                           │ MCP SSE / HTTP
                  ┌────────▼────────┐
                  │lazy-tool-service│
                  │  (tool runner)  │
                  └─────────────────┘
```

- `trading-service` calls `lazy-tool-service` tools via MCP SSE
- `lazy-tool-service` tools read/write the shared PostgreSQL database directly
- `lazy-tool-service` tools call external APIs (prism, finnhub, yfinance, etc.)

## Rules for Future Development

1. **No agent code** — if it has an agent loop, it goes in `trading-service`
2. **No cycle management** — if it manages pipeline state, it goes in `trading-service`
3. **No cognition** — if it involves memory, ontology, or evolution, it goes in `trading-service`
4. **Tools are stateless executors** — they receive a request, execute, return a result
5. **Shared code goes in `lazycat-sdk`** — once built, logging, config, and prism client will come from the SDK

## HTML-Notes Widget System

The service has been extended to manage the widget lifecycle for `HTML-Notes`. This includes:
* **Tool Schema Enforcement**: Custom widget schemas (`plan_widget`, `create_widget`, `update_widget`, `validate_widget_html`, `list_widget_types`) are registered in `tool_schemas.json`.
* **Execution Interception**: These widget tools are intercepted in `ExecuteRoutes.ts` and validated inside `WidgetTemplateRegistry.ts` (doing HTML matching validation and CSS rule scoping) before forwarding layout payloads to `html-notes`.

