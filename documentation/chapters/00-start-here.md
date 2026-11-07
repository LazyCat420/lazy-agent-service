---
part: Overview
type: reference
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:documentation/tickets.jsonl, lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:package.json, lazy-agent-service:src/boot/server.ts
---

# Start here: how this documentation works

This is the technical design document (TDD) for **lazy-agent-service**: the workspace's unified
agent harness, MCP tool server and local-LLM router, deployed on the NAS as
`lazy-agent-service` at **port `:5591`** (registry ID `lazy-tool-service`). One document, a fixed
13-section table of contents. Nothing here is dated "for today's batch"; git history is the
record of changes, these chapters are the current truth.

## The 13 sections and what each answers

| Section | Question it answers | Read it when |
|---|---|---|
| 00 Start here | How this document works, ports, commands, repo map | First, and before adding anything |
| 01 Context and goals | What the service is for, what it is not | You need the boundaries |
| 02 Architecture and endpoints | Which routes exist, MCP wiring, SDK integration | You are tracing a request |
| 03 Harness² execution loop | The multi-turn tool loop, compaction, guards, durable runs | A run did something unexpected |
| 04 Models and routing | Which model runs on which box, fallbacks, budgets | An agent answered wrongly or slowly |
| 05 Tools and schema registry | The 78-tool catalog, the single generator, schema edits | A tool is missing or wrong |
| 06 Embeddings and RAG | The shared EmbeddingGemma 2 service, indexing, retrieval | A memory/search result looks wrong |
| 07 Telemetry and metrics | Traces, per-tool latency/error metrics, audit logs | You need evidence of what ran |
| 08 Operations and runbooks | Deploy, regenerate schemas, re-register, diagnose | Something is stuck or you deploy |
| 09 Verification and gates | What is proven by which command, quality ratchets | You need to know if a claim is tested |
| 10 Decisions | The settled architectural choices and their consequences | You are about to change something settled |
| 11 Tickets | Every open and closed problem, generated from the ledger | You are picking up work |
| 12 Security and dependencies | MCP stdio guard, SSRF/path guards, keys, dependency policy | You touch a boundary or a dependency |

## Service ports and quick commands

| Thing | Value |
|---|---|
| HTTP + SSE API | `http://10.0.0.16:5591` (NAS; compose name `lazy-agent-service`) |
| Health | `GET :5591/health` (never traced, docker healthcheck every 30 s) |
| OTLP export | `http://10.0.0.16:4318` → Tempo `:3200` → Grafana `:3300` |
| Embeddings backend | `http://10.0.0.30:8001/v1` (Jetson `embeddinggemma-2`) |
| Jetson chat (`nemotron35`) | `http://10.0.0.30:8000/v1` (`max_num_seqs = 2`) |

```bash
python3 scripts/export_tool_schemas.py            # regenerate tool_schemas.json from shards
python3 scripts/export_tool_schemas.py --check    # exit 1 if stale (CI gate)
npm test                                          # vitest run --exclude "**/.worktrees/**"
npm run deploy                                    # bash deploy.sh — rebuild + NAS redeploy
```

Every test, build or server run on `main` goes through
`testrun --wait 30m --max-time <limit> -- <command>`; never run one inside `.worktrees/`.

## Repo map

| Path | What lives there |
|---|---|
| `src/boot/server.ts` | Express bootstrap; every route mount and the endpoint registry |
| `src/routes/` | One file per mounted router (`AgentRoutes`, `Harness2Routes`, `McpServersRoutes`, …) |
| `src/core/loop/` | The core loop: `CoreLoop.ts`, `ToolRunner.ts`, `MessageCompactor.ts`, `RunawayStreamWatch.ts` |
| `src/services/` | `AgenticLoopService.ts`, `ToolOrchestratorService.ts`, `LocalToolRouter.ts`, `DynamicModelResolver.ts`, `WebSearchService.ts`, `WebExtractService.ts`, `EmbeddingGemma2Client.ts`, `TradingToolStream.ts`, `harness2/`, `wallgarden/` |
| `src/telemetry/otel.ts` | OpenTelemetry loader, imported before the app |
| `tool_schemas/<owner_app>/*.json` | The canonical tool-schema shards (source of truth, 78 tools) |
| `scripts/export_tool_schemas.py` | The single generator (see ch.05, ch.10 ADR-02) |
| `scripts/quality/` | `crap.mjs`, `dry.mjs`, `arch.mjs`, `deadcode.mjs` gates (see ch.09) |
| `documentation/` | This TDD: `chapters/`, `execution_graph.json`, `data_flow_graph.json`, `tickets.jsonl` |
| `docs/contracts/` | Exported contract specs served as-is by `ContractRoutes` — do not move |

## The rules that keep this from rotting

1. **Work goes in the ledger, not in a new chapter.** A bug, a gap or a "we should later"
   becomes a ticket in `documentation/tickets.jsonl`. The chapter count is capped at 13;
   date-stamped filenames are rejected.
2. **A section is rewritten in place.** When the service changes, you edit that section.
3. **A closed ticket needs proof.** `closed` is rejected without `verified_by` naming the
   command that proved it and the date it ran.
4. **Closed tickets stay in the file** as searchable history.
5. **A section declares what it covers.** `covers:` lists repo-prefixed code paths; a section
   whose covered code changed after `last-verified` is not trusted until re-read.
6. **Old chapters are archived, never deleted.** Everything pre-V2 lives under
   `documentation/archive/` and in git history.

## Trading-cycle parts documented elsewhere

The trading cycle's TDD lives in `finance/trading/trading-client/documentation/`. The parts of
this service that participate in the cycle (the `/agent` route, the tool bridge, the scrape
budget guard, refusal messages) are described there, and cycle-side problems are tickets there
with `owner: lazy-agent-service`. This repo's chapters cover the platform itself; do not add a
trading-cycle chapter here.
