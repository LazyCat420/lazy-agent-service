---
part: Overview
type: reference
status: verified
updated: 2026-11-13
last-verified: 2026-11-13
review-by: 2026-12-13
covers: lazy-agent-service:documentation/tickets.jsonl, lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:package.json, lazy-agent-service:src/boot/server.ts, lazy-agent-service:src/boot/healthProbe.ts, lazy-agent-service:src/services/vllm/VllmShimService.ts, lazy-agent-service:src/services/AgenticToolResolver.ts, scraper-service:scraper_main.py, spark-console:console.py, tts-service:main.py
---

# Start here: how this documentation works

This is the technical design document (TDD) for the **Agent Platform** — every service under
`agents/`, documented as one hub:

| Service | Port | What it is |
|---|---|---|
| **lazy-agent-service** | `:5591` (NAS) | The unified agent harness, MCP tool server and local-LLM router (registry ID `lazy-tool-service`) |
| **scraper-service** | `:8001` (NAS) | Domain-agnostic scraping: HTTP → Playwright engines, collectors (SEC Edgar, Stooq, SearXNG, RSS, Reddit, YouTube), the learned `failure_cache.db` |
| **spark-console** | `:8800` (Gold Spark head node; NAS gateway `:8801`) | Dashboard and memory arbiter for the DGX Spark cluster: serving modes, ComfyUI render permits, telemetry, token counter |
| **tts-service** | `:8080` in the container, published as `:3032` | Text-to-speech: Piper ONNX neural voices and a from-scratch Klatt/formant synthesiser |

One document, a fixed 13-section table of contents; each chapter covers lazy-agent-service first
and then the sibling services where the chapter's question applies to them. Nothing here is
dated "for today's batch"; git history is the record of changes, these chapters are the current
truth. Each sibling repo keeps only its own operational notes (`scraper-service/OPERATIONS.md`,
`spark-console/README.md`, `tts-service/HANDOFF.md`); the design lives here.

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
| Health | `GET :5591/health` (2 s raced Mongo + enabled vLLM `/v1/models` probe, cached 10 s; never traced, docker healthcheck every 30 s) |
| vLLM Shim | `GET/POST :5591/vllm-shim/<box>/v1/*` (OpenAI-compatible LAN vLLM proxy with `/v1/models` discovery + `404` model-swap auto-heal) |
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

### The sibling services

| Service | Entry | Health | Tests (from the repo root) | Deploy |
|---|---|---|---|---|
| scraper-service | `scraper_main.py:app` (FastAPI, uvicorn) | `GET :8001/health`, `/health/engines`, `/health/feeds`, `/health/search-engines`, `/health/pids` | `python3 -m pytest -q tests` | `./deploy.sh` (stages trading-service's `app/scraper` first) |
| spark-console | `console.py:app` (FastAPI) | `GET :8800/api/status`, `/api/telemetry/health` | `python3 -m pytest -q tests` | `./deploy.sh` |
| tts-service | `main.py:app` (FastAPI) | `GET :3032/health` (container `:8080`) | `python3 -m pytest -q tests/test_synth_engine.py` | `./deploy.sh` |

## Repo map

| Path | What lives there |
|---|---|
| `src/boot/server.ts`, `src/boot/healthProbe.ts` | Express bootstrap, route mounts, endpoint registry, and deep `/health` Mongo + vLLM box probe |
| `src/routes/` | One file per mounted router (`AgentRoutes`, `Harness2Routes`, `McpServersRoutes`, …) |
| `src/core/loop/` | The core loop: `CoreLoop.ts`, `ToolRunner.ts`, `MessageCompactor.ts`, `RunawayStreamWatch.ts` |
| `src/services/` | `AgenticLoopService.ts`, `AgenticToolResolver.ts`, `ToolOrchestratorService.ts`, `LocalToolRouter.ts`, `DynamicModelResolver.ts`, `vllm/VllmShimService.ts`, `WebSearchService.ts`, `WebExtractService.ts`, `EmbeddingGemma2Client.ts`, `TradingToolStream.ts`, `harness2/`, `wallgarden/` |
| `src/utils/LoopHonestyFields.ts` | Canonical `answerSource`, `finalizeReason`, `providerAttempts`, `providerRetries` derivation |
| `src/telemetry/otel.ts` | OpenTelemetry loader, imported before the app |
| `tool_schemas/<owner_app>/*.json` | The canonical tool-schema shards (source of truth, 78 tools) |
| `scripts/export_tool_schemas.py` | The single generator (see ch.05, ch.10 ADR-02) |
| `scripts/quality/` | `crap.mjs`, `dry.mjs`, `arch.mjs`, `deadcode.mjs` gates (see ch.09) |
| `documentation/` | This TDD: `chapters/`, `execution_graph.json`, `data_flow_graph.json`, `tickets.jsonl` |
| `docs/contracts/` | Exported contract specs served as-is by `ContractRoutes` — do not move |

The sibling repos, paths relative to `agents/`:

| Path | What lives there |
|---|---|
| `scraper-service/scraper_main.py` | The FastAPI entrypoint: router mounts, `X-Scraper-Key` guard, `GET /health/pids` probe |
| `scraper-service/app/`, `lazycat/` | Gitignored build copies of `trading-service/app/scraper` and `platform/lazycat-sdk`, staged by `deploy.sh` |
| `scraper-service/OPERATIONS.md` | The 2026-08-20 pid-exhaustion post-mortem, `failure_cache.db`, auth, SEC identity |
| `scraper-service/searxng/settings.yml` | The SearXNG sidecar's engine list (`bing`, `wikipedia`) |
| `spark-console/console.py` | The whole console: serving modes, render permits, telemetry, box power, bench |
| `spark-console/subscription_usage.py`, `request_throughput.py`, `health_monitor.py` | Token counter, throughput and solo ledger, read-only monitoring views |
| `spark-console/*-start.sh`, `*-stop.sh`, `boxes.json` | Per-deployment launchers and the box table |
| `tts-service/main.py` | The FastAPI entrypoint and its four routes |
| `tts-service/app/piper_manager.py`, `app/synth_manager.py`, `app/synth/` | The Piper voice manager and the from-scratch synthesiser |

The ticket ledger covers all four repos: `owner` names the repo, and `node` names its box in
`execution_graph.json` (`scraper_service`, `spark_console`, `tts_service`).

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

The trading cycle's TDD lives in `finance/trading/trading-client/documentation/`. Trading cycle
seats execute their multi-turn tool loop inside `lazycat-sdk` (`AgentHarness`), streaming directly
through this service's `/vllm-shim/<box>/v1/chat/completions` while relying on this service for
dynamic `/v1/models` discovery, `404` model-swap auto-heal, `/agent` gateway runs, the trading
tool bridge, `AgenticToolResolver` trading isolation, and scrape budget guards. Cycle-side
contracts are described there, and cycle-side problems are tickets there with
`owner: lazy-agent-service`. This repo's chapters cover the platform itself; do not add a
trading-cycle chapter here.
