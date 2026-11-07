---
part: Architecture
type: spec
status: verified
updated: 2026-11-07
last-verified: 2026-11-07
review-by: 2026-12-07
covers: lazy-agent-service:src/boot/server.ts, lazy-agent-service:src/routes/AgentRoutes.ts, lazy-agent-service:src/routes/Harness2Routes.ts, lazy-agent-service:src/routes/McpServersRoutes.ts, lazy-agent-service:src/services/AgentSessionRegistry.ts, lazy-agent-service:src/services/WebSearchService.ts, lazy-agent-service:src/services/WebExtractService.ts, scraper-service:scraper_main.py, spark-console:console.py, tts-service:main.py
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

## How the four services connect

```
             LAN callers (trading-service, html-notes, SDK, omp, browser)
                 │                     │                         │
                 ▼                     ▼                         ▼
   lazy-agent-service :5591 ──► scraper-service :8001     tts-service :3032
        │   (web_search fallback,        │  (SearXNG sidecar,      (Piper | synth)
        │    scrape_url / web_extract)   │   failure_cache.db)
        ▼
   model endpoints  ◄── started/stopped by ── spark-console :8800 (goldspark)
   (goldspark :8000, dellbox1/2, Jetson)          ▲            ▲
                                                   │            │
                                      ComfyUI render-permit   NAS gateway :8801
```

- **lazy-agent-service → scraper-service.** `SCRAPER_SERVICE_URL` (default
  `http://localhost:8001`) is read by `WebExtractService.ts` (`POST /scrape`) and
  `WebSearchService.ts` (the SearXNG fallback). The `x-scraper-key` header is sent only when
  `SCRAPER_API_KEY` is set (ch.12).
- **spark-console → the models lazy-agent-service routes to.** The serving mode decides which
  model answers on goldspark `:8000`; the Dell boxes and the Jetson serve their own. A mode
  switch changes the served model id under the router's feet, which is why ch.04's routing
  resolves models from the live catalog rather than a fixed name.
- **tts-service** has no dependency on the others; HTML-Notes proxies to it.

## scraper-service endpoints (`scraper_main.py`)

| Route | Guard | What it does |
|---|---|---|
| `POST /scrape` | key | Scrape one URL with `auto` (HTTP → Playwright), `http` or `playwright`; known-dead URLs and skipped domains answer without a fetch |
| `POST /scrape/batch` | key | Several URLs, same engines |
| `POST /collect` | key | Run one collector: `reddit`, `reddit-purge`, `youtube`, `news`/`rss`, `searxng`, `edgar`, `stooq`, … |
| `GET /stream/{video_id}` | key | Direct CDN stream URL for a YouTube video (`?audio=true` for an audio-only track); URLs expire after ~6 h |
| `GET /health` | open | Liveness (HTTP client, browser dependency) plus operational counters — the Docker healthcheck |
| `GET /health/engines` | open | Deep check that launches real browsers (~5 s); by hand only, never as the healthcheck |
| `GET /health/search-engines` | open | SearXNG sidecar engines (`bing`, `wikipedia` only — `searxng/settings.yml`) |
| `GET /health/feeds` | open | Per-RSS-feed `last_success_at`, `consecutive_failures`, `last_error` |
| `GET /health/pids` | open | Host task count against `pid_max`: `ok`/`warn`/`critical`/`unknown`, always 200 |

The routers come from `app/scraper/api/routes/` (built from trading-service); only
`/health/pids` is defined in `scraper_main.py` itself.

## spark-console endpoints (`console.py`)

| Group | Routes | What they do |
|---|---|---|
| Dashboard | `GET /`, `/console`, `/bench`, `/agents` | The single-page UI and its bench/agent views |
| State | `GET /api/status`, `/api/series?tier=`, `/api/renders`, `/api/thumb` | Live boxes, 15-min live history, tiered history (`1h` … `1y`) with the per-model registry, ComfyUI renders |
| Serving | `POST /api/serving-mode/{new_mode}`, `POST /api/toggle/{service}/{onoff}` | Switch deployment; toggle `deepseek`, `comfy_head`, `comfy_worker`, `auto_resume` |
| Memory arbitration | `POST /api/render-permit` | ComfyUI asks before a prompt queues (ch.04) |
| Boxes | `POST /api/box/{box}/wake`, `/api/box/{box}/{action}`, `/api/box/{box}/llm/{onoff}`, `GET /api/box/{box}/llm/log`, `/api/box/{box}/wake-capability` | Wake-on-LAN, power, standalone-box model control |
| Usage | `GET/POST /api/subscription-usage`, `GET /api/usage`, `/api/settings`, `POST /api/usage/reset` | Token counter and settings (ch.07) |
| Telemetry | `GET /api/telemetry/{runs,cycles,incidents,metrics,health}`, `/api/telemetry/traces/{trace_id}`, `/api/audit/crashes`, `/api/agent-metrics` | Run/cycle telemetry, auto-heal incidents |
| Bench | `/api/bench/*`, `/api/sparkbench/*` | Concurrency and prefill benchmarks |
| omp session | `POST /api/omp/workdir`, `/api/omp/mcp-render/{onoff}` | Working folder and render-tool permission for the omp/pi session on the head |

`gateway.py` serves the same UI on the NAS (`:8801`) by proxying to the head (ch.01).

## tts-service endpoints (`main.py`)

| Route | What it does |
|---|---|
| `POST /api/v1/tts/synthesize` | `{text, voice_accent, engine}` → `audio/wav`. `engine` is `piper` (default) or `synth`; for `synth`, an unknown `voice_accent` falls back to `narrator`. Empty text → 400 |
| `GET /api/v1/tts/voices` | Piper voice models on disk plus accent aliases |
| `GET /api/v1/tts/synth-voices` | Synth voice types (`narrator`, `female`, `child`, `giant`, `whisper`, `aged`, `droid`, `sam`) |
| `GET /health` | Liveness and `engines: ["piper", "synth"]` |

Text is sanitised before either engine: characters outside word, whitespace, basic punctuation
and Latin-1 letters are stripped (emoji used to crash ONNX `GatherElements`), and text that
sanitises to nothing is spoken as "Audio unavailable."
