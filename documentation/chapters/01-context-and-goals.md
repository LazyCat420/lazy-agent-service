---
part: Overview
type: spec
status: verified
updated: 2026-11-07
last-verified: 2026-11-07
review-by: 2026-12-07
covers: lazy-agent-service:src/index.ts, lazy-agent-service:src/services/AgenticLoopService.ts, lazy-agent-service:src/services/ToolOrchestratorService.ts, lazy-agent-service:tool_schemas.json, scraper-service:OPERATIONS.md, spark-console:gateway.py, tts-service:main.py
---

# Context and goals

## What this service is

`lazy-agent-service` is the **workspace's unified agent runtime**. Since the prism exit
(`ee61164` "refactor: retire prism-service; lazy-agent-service is the only gateway",
2026-10-31) every LazyCat420 repo runs its agents here — nothing forwards to prism's
`:7777` any more. It is three services in one process on NAS port `:5591`:

1. **An agentic harness.** The multi-turn tool-calling loop (`AgenticLoopService` →
   `src/core/loop/`) with context compaction, stall/loop guards, SSE streaming, and durable
   completions for Obsidian vault chat and trading runs. The self-improving **harness2**
   loop (`src/services/harness2/`, `POST /harness2/run`) proposes, probes and composes
   harness trees and keeps an experience library per domain.
2. **An MCP tool server + registry.** `tool_schemas.json` — **78 tools** across
   `trading` (market data, screener, execution, whiteboard, watch desk, parameter
   governance, research scheduling), `html-notes` (21 + 5), `shared` (web search/extract,
   news, quality) and `treesearch` (cannabis research, 8) — is served over `/mcp-servers`
   MCP transports and routed locally by `ToolOrchestratorService` / `LocalToolRouter`.
3. **A local-LLM router.** `DynamicModelResolver` admits requests to the vLLM cluster
   (DGX Spark DeepSeek/GLM, Dell Qwen, Jetson Nemotron) with health-based fallback;
   `wallgarden/JetsonGate` protects the 2-slot Jetson; the shared `/embed` endpoint fronts
   `EmbeddingGemma2` on the Jetson for every repo in the house.

## Who calls it

| Caller | Entry point | Why |
|---|---|---|
| trading-service (v3 desks) | `POST /agent`, `/chat`, `/embed` | agent runs, tool calls through the bridge, embeddings |
| lazycat-sdk | `/agent`, `/config`, `/chat`, `/embed` | native harness URL since the prism exit |
| html-notes, music-player | `/chat`, `/agent`, tool routing | local `html_notes_*`, `canvas_*`, `music_player_*` tools |
| LLMSortObsidian plugin | `PUT/GET /obsidian-completions/:id` | durable model completions that survive Obsidian closing |
| youtube-wallgarden | `/api/wallgarden/*` | topic/curation LLM calls behind the Jetson gate |
| trading-client / audits | `GET :5591` + the shared request-log collection | per-request evidence |

## What it is NOT

- **Not an order executor.** Orders, policy gates and the paper ledger live in
  trading-service; this harness only runs the tool loop and never fabricates a tool answer.
- **Not a model host.** Models run on external vLLM boxes (ch.04); this service only routes.
- **Not the trading cycle's TDD.** The cycle spans four repos and is documented in
  `trading-client/documentation/`; see ch.00.
- **Not a general-purpose web proxy.** `scrape_url`/`web_search` are tool-loop facilities with
  budgets and guards (ch.05, ch.12), not an open fetch API.

## Goals in order of priority

1. **Correct tool loops.** Every tool call is authorized (`decideToolCall`), schema-validated,
   repeat-guarded, and either executed or refused with an actionable error. A failed run ends
   failed; it never invents results.
2. **One gateway, no forks.** All repos use this harness; parity work against prism was
   closed out (ch.10 ADR-01) and prism-service is retired.
3. **One catalog.** A single generator owns `tool_schemas.json` (ch.05); the three repo copies
   stay byte-identical.
4. **Bounded resources.** The Jetson's 2 inference slots, Exa's keyless rate limit, the
   shared embedding queue and per-run tool/scrape budgets are all guarded centrally.
5. **Evidence.** Every request and tool call leaves a row or span (ch.07) so "did it run?" is
   answerable without rerunning it.

## Non-negotiables

- The harness never registers a stdio MCP command outside the operator allowlist (ch.12).
- A restart during a trading cycle breaks in-flight desks: deploy only between cycles (ch.08).
- `docs/contracts/` is served as-is by `ContractRoutes` and copied by
  `scripts/export-contracts.mjs`; it is read by other repos and stays in place.

## The platform around it

lazy-agent-service is the hub; three sibling services under `agents/` either feed it or run the
hardware it routes to.

### scraper-service — the web, fetched safely

A domain-agnostic FastAPI scraper on the NAS at `:8001`. It owns no trading logic: it fetches
pages (`POST /scrape`, `/scrape/batch`) through an `auto` engine that tries plain HTTP first and
falls back to headless Playwright, runs collectors (`POST /collect` with `source` = `reddit`,
`reddit-purge`, `youtube`, `news`/`rss`, `searxng`, `edgar`, `stooq`, …) and streams YouTube
transcripts (`GET /stream/{video_id}`). It remembers what it learned about the web in
`failure_cache.db` (dead URLs and per-domain quality), on a named volume.

| Caller | Entry point | Why |
|---|---|---|
| lazy-agent-service | `POST /scrape` (`WebExtractService.ts`), SearXNG fallback (`WebSearchService.ts`) | `scrape_url` / `web_extract` / `web_search` tool calls (ch.05) |
| trading-service | `/scrape`, `/collect` | news, Reddit, SEC and price collection for the trading cycle |

**It is not** the owner of its engine code: `app/scraper` is built from trading-service's source
by `deploy.sh`, so engine changes land in trading-service and are redeployed here. **It must
never** take the NAS down again — the 2026-08-20 pid-exhaustion outage (`OPERATIONS.md`) is
why `init: true`, `SCRAPER_MAX_BROWSERS` and the `GET /health/pids` probe exist (ch.07, ch.08).

### spark-console — the model fleet's control panel

A FastAPI dashboard and memory arbiter on the Gold Spark head node (`10.0.0.141:8800`), with a
gateway on the NAS (`10.0.0.16:8801`, `gateway.py`) that proxies every request to the head while
it is up, serves the last fetched dashboard while it is not, and answers `/api/box/*/wake`
itself so a powered-off box can still be woken. It decides **which LLM is served** on the
2× DGX Spark pair (serving modes, ch.04), arbitrates unified memory between that LLM and ComfyUI
renders (`POST /api/render-permit`), auto-launches the Dell Qwen boxes, powers boxes on and
off, and is the fleet's telemetry source: GPU/memory/temperature/wall-power history, per-model
throughput, and the token counter for Claude, Google Argon and the self-hosted models (ch.07).

| Caller | Entry point | Why |
|---|---|---|
| operator (browser) | `GET /`, `/api/status`, `/api/series`, mode/toggle buttons | watch and steer the cluster |
| ComfyUI `spark_console_guard` hook | `POST /api/render-permit` | ask for memory before a render queues |
| workstation `spark-sub-usage.timer` | `POST /api/subscription-usage` | push Claude/Argon/omp token counts every 30 s |
| lazy-agent-service, omp agents | the model endpoint it brings up (`:8000` on goldspark) | inference (ch.04) |

**It is not** an inference server — it starts and stops the deployments that are — and it is not
an agent harness; the omp session it restarts on a mode switch is a client of the model.

### tts-service — speech out

A FastAPI text-to-speech service on the NAS (container `:8080`, published `:3032`) with two
engines: **Piper** neural ONNX voices (default) and a from-scratch, CPU-only Klatt/formant
synthesiser (`engine: "synth"`). HTML-Notes proxies its `/tts/synthesize` to it, and the trading
office's spoken lines go through that proxy. **It is not** a speech-to-text service and holds
no conversation state.

### Platform goals

1. **No sibling can take the host down.** Bounded browsers and a pid probe on the scraper; one
   deployment at a time on the Sparks; an LRU of two Piper voices in tts-service.
2. **Every service answers "are you healthy?" without side effects** (ch.07).
3. **One ledger, one document** (ch.10 ADR-15): every repo's work is a ticket here.
