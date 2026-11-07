---
part: Overview
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/index.ts, lazy-agent-service:src/services/AgenticLoopService.ts, lazy-agent-service:src/services/ToolOrchestratorService.ts, lazy-agent-service:tool_schemas.json
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
