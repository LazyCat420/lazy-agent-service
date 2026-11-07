---
part: Architecture
type: spec
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/services/AgenticLoopService.ts, lazy-agent-service:src/core/loop/CoreLoop.ts, lazy-agent-service:src/core/loop/MessageCompactor.ts, lazy-agent-service:src/core/loop/RunawayStreamWatch.ts, lazy-agent-service:src/core/loop/ToolRunner.ts, lazy-agent-service:src/services/TradingToolStream.ts, lazy-agent-service:src/services/harness2/Harness2Service.ts
---

# The harness execution loop

Everything that runs an agent goes through one loop: `AgenticLoopService` driving
`src/core/loop/` (`CoreLoop.ts`, `ToolRunner.ts`, `MessageCompactor.ts`,
`RunawayStreamWatch.ts`, `SpillBuffer.ts`, `ToolOutputSubstituter.ts`). `harness2` adds a
self-improving layer on top. A turn is: model call → tool calls → tool results → next model
call, until final answer, budget close, or a guard fires. The loop never fabricates a tool
answer: a failed tool returns an error result to the model.

## Multi-turn tool calling

1. Assemble: persona system prompt, memories/skills/workflows (retrieved via embeddings,
   ch.06), the tool catalog for this caller (ch.05).
2. Call the model via `DynamicModelResolver` (ch.04). OpenAI-compatible recovery handles
   malformed tool calls: Qwen coder-format text tool calls in streamed content
   (`5cb9ecf`), and the `<parameter=NAME>` function-opener variant (`55d55ed`); recovered
   arguments are rebound with `bindRecoveredToolArgs` (`TradingToolStream.ts`).
3. Validate every tool call against its schema. A type rejection names the received type and
   a 40-char safe preview (`6b46ec2`, `ec4072b`). Hallucinated names resolve to canonical
   tools through `HALLUCINATED_TOOL_ALIASES` + `resolveToolName()` in `ToolRunner.ts`
   (e.g. `query_market_screener → screener_query`).
4. Authorize (`decideToolCall`, one decision everywhere), then dispatch through
   `ToolOrchestratorService` (ch.05).
5. Repeat until the model answers without tool calls, the run budget closes, or a guard fires.

## Context compaction

`AgenticLoopService` triggers pressure compaction at a configurable fraction of the context
budget (default **0.6**): `compactToolResultsForPressure` replaces older tool results with
one-line placeholders (`{compacted: true}`), and when it fires, plan-style summary compaction
(`compactWithPlanSummary`, the omp pattern) injects a mechanically derived
`[plan summary]` block so the model can still cite what it saw. Overflow recovery retries
after compaction instead of failing the run.

## Stall, loop and budget guards

| Guard | Fires when | Behaviour |
|---|---|---|
| `RunawayStreamWatch` | a stream produces nothing / loops | ends the stream; retry timing is measured with `performance.now` (`c4b18a9`) |
| `REPEAT_GUARDED_TOOLS` (`LocalToolRouter`) | an idempotent desk tool (`whiteboard_read`, `peer_comparison`, `data_completeness`, `get_earnings_data`, `get_upcoming_events`, `get_market_data`) is called twice with identical args in one run | the first result is reused, not re-executed (`1003bb2`); a `run_tool_chain` repeat is reused, not a `TOOL_STALL` failure (`260c020`) |
| Trading tool budget | a trading run exhausts its tool budget | closed-budget tools and `scrape_url` stop being offered (`e7003c8`), the run finalizes when no tool remains after budget close (`fb2ea8a`); the budget counts resolved `{error,is_error}` payloads and bridge timeouts (`e5611e9`) |
| Scrape budget | per-run `scrape_url` limit | enforced per run (`02b24a4`); known-dead URLs are refused without spending budget, malformed URLs get one search-first hint (`7c279f5`, `f32f98f`) |
| Approval | an unapproved tool call | `ApprovalGate.authorizeToolCalls` waits on the shared `decideToolCall` decision; `AutoApprovalEngine` was removed 2026-10-16 |

## Durable completions

**Obsidian** (`/obsidian-completions`, ch.02): a client-generated UUID + payload is accepted
with HTTP 202 **before** transport starts; inference runs bounded and non-streaming (hard
timeout 600 s, `OBSIDIAN_COMPLETION_TIMEOUT_MS`) even with the client gone; identical
re-PUT returns the job, a changed payload is rejected; results persist atomically (temp file
+ rename) under `runtime-data/obsidian-completions/`. A restart marks running jobs failed with
an interruption note — never replays. `GET /obsidian-completions/:id` supports SSE push and
reports live `delta.reasoning` / `activeTools` while running (`9276e3f`).

**Trading**: trading desk runs route through `/agent`; the loop keeps running when the SSE
client drops (stop only via `/agent/stop`), and outcomes are graded from the durable telemetry
rows, not the connection.

## Streaming callbacks — `TradingToolStream.ts`

`TradingToolStream` is the streaming bridge between the loop and trading callers: it tags
tool args/responses with the run token (`bindToolResponse`, `bindRecoveredToolArgs`), so
tool events a caller receives can be matched to the calls it authorized, and recovered
arguments are never silently trusted. Trading runs receive refusal messages verbatim
(cross-contamination blocks, budget closures) rather than retry loops.

## harness2 — the self-improving layer

`src/services/harness2/` (port `8e242aa` at Google's reference `1cfe254`) proposes harness
trees, probes them in rollouts that run **through this same loop**, composes the winners, and
stores lessons in a per-domain experience library (`runtime-data/harness2/`, bind-mounted, so
it survives deploys). The 2026-10-22 audit's Phase-1 fixes are the current contract:
only successful selections write lessons (`94883af`), the proposer has an explicit contract
and empty/improver-cut replies are never recorded as "keep base" decisions, and re-run tasks
do not read their own earlier answers (`a3993ea`), and `/harness2/run` is an async job with
records, request checks and a model preflight (`2ad3f48`). Two catalog bugs were found by the
benchmark: a cached-schema growth of ~3k chars per call (`42e7a48`) and first-second-after-boot
runs seeing only orchestrator tools (`f8c7737`). Measured effect and open questions (Phase 2,
Q1–Q5) are recorded in the archive and the ledger, not duplicated here.
