---
part: Architecture
type: spec
status: verified
updated: 2026-11-14
last-verified: 2026-11-14
review-by: 2026-12-14
covers: lazy-agent-service:src/services/AgenticLoopService.ts, lazy-agent-service:src/services/AgenticToolResolver.ts, lazy-agent-service:src/services/LocalToolRouter.ts, lazy-agent-service:src/services/CanonicalProviderBudget.ts, lazy-agent-service:src/core/loop/CoreLoop.ts, lazy-agent-service:src/core/loop/MessageCompactor.ts, lazy-agent-service:src/core/loop/RunawayStreamWatch.ts, lazy-agent-service:src/core/loop/ToolRunner.ts, lazy-agent-service:src/services/TradingToolStream.ts, lazy-agent-service:src/utils/LoopHonestyFields.ts, lazy-agent-service:src/services/harness2/Harness2Service.ts, lazy-agent-service:src/services/harness2/Library.ts, spark-console:console.py
---

# The harness execution loop

Gateway-hosted agent runs go through one loop: `AgenticLoopService` driving `src/core/loop/`
(`CoreLoop.ts`, `ToolRunner.ts`, `MessageCompactor.ts`, `RunawayStreamWatch.ts`, `SpillBuffer.ts`,
`ToolOutputSubstituter.ts`), while trading cycle seats execute their multi-turn tool loop inside
`lazycat-sdk` (`AgentHarness`), streaming directly through `/vllm-shim/<box>/v1/chat/completions`
(ch.02, ch.04). `harness2` adds a self-improving layer on top of `AgenticLoopService`. A turn is:
model call → tool calls → tool results → next model call, until final answer, budget close, or a
guard fires. The loop never fabricates a tool answer: a failed tool returns an error result to the
model, and every completed or terminated run emits explicit loop honesty fields (`S-01`,
`LoopHonestyFields.ts`): `answerSource` (`"model"` | `"partial"` | `"synthetic"`),
`finalizeReason` (`"COMPLETED"`, `"CUT_OFF"` on single length-cut turns without tool calls,
`"CUT_OFF_TWICE"`, `"STEP_LIMIT"`, etc.), `providerAttempts`, and `providerRetries`.

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
| `CanonicalProviderBudget` (`reconcileStreamBudget`) | a wrapped stream throws or aborts before yielding any output or usage telemetry (`emittedBytes === 0`) | releases the entire speculative `reservation` (`inputReserve + outputReserve`) instead of retaining `inputReserve`, so `CoreLoop` `PROVIDER_RETRY` attempts do not trip `TOKEN_BUDGET_FINALIZE` and finalize prematurely as `TOKEN_BUDGET` (`e54d523`); mid-stream failures with `emittedBytes > 0` and no usage telemetry still retain `inputReserve + min(outputReserve, emittedBytes)` |
| `REPEAT_GUARDED_TOOLS` & `READ_ONLY_TOOLS` (`LocalToolRouter`) | an idempotent desk tool (`whiteboard_read`, `peer_comparison`, `data_completeness`, `get_earnings_data`, `get_upcoming_events`, `get_market_data`) is called twice with identical args in one run, or a read-only desk query (`whiteboard_find`, `read_ledger_entry`, `T2` `f10b64d`) hits a transient 5xx | repeat calls reuse the first result (`1003bb2`; `run_tool_chain` repeat is reused rather than failing with `TOOL_STALL`, `260c020`), and `READ_ONLY_TOOLS` classify ledger/whiteboard reads as safe idempotent reads rather than state-mutating writes |
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

**Trading**: cycle seats run their multi-turn loop in `lazycat-sdk` streaming over
`/vllm-shim/<box>/v1/chat/completions` (`b0757c8`, `a8ab691`, `f10b64d`), while gateway `/agent`
runs (`V3_USE_PRISM=1` or interactive trading chat) keep running when the SSE client drops (stop
only via `/agent/stop`), isolate tool resolution through `AgenticToolResolver` (`T3`, ch.05), and
grade outcomes from durable telemetry and loop honesty fields rather than socket liveness.

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

### Experience-library scope (TCK-1020)

`Library` (`src/services/harness2/Library.ts`) is constructed as
`new Library(domain, root?, { mode?, runScope? })`. With no scope the directory is
`<root>/<slug(domain)>` — one shared library per domain, the default, because lessons are meant
to accumulate across runs. A scope narrows it:

| Request field (`/harness2/run`) | Library directory | Use |
|---|---|---|
| neither | `<root>/<domain>` | normal accumulation |
| `isolateLibrary: true` | `<root>/<domain>/<mode>` (`mode` defaults to `parallel`) | keep `parallel` and other modes from teaching each other |
| `libraryScope: "<id>"` | `<root>/<domain>[/<mode>]/<id>` | a benchmark or A/B run that must start clean and leave the shared library untouched |

`Library.forRun(domain, { root, mode, runId })` builds the run-scoped form in code. Scope names
that would collide with the library's own layout (`harnesses`, `runs`, `INDEX.md`) throw.
Every lesson `add()` writes records `- mode:` and `- run:` lines in `EXPERIENCE.md` (defaulting
from the scope; `Harness2Service` passes the request's mode and `libraryScope`), and
`contextText({ exclude, mode, runId })` filters on those lines, so a shared library can still be
read per mode or per run without moving files. Proof: the `per-run and per-mode library scope
(TCK-1020)` block in `Harness2Library.test.ts`; decision record ch.10 ADR-14.

## The other control loops on the platform

The tool loop above is the only *agent* loop, but two sibling services run their own control
loops, and their timing explains behaviour seen from here.

**spark-console reconciler** (`reconciler()` in `console.py`, a daemon thread). After a 15 s boot
settle it runs `reconcile_at_boot()` (bring the LLM up if its toggle is on; adopt a deployment
that is already running) inside a `try`, so a boot failure can never kill the loop. Then every
30 s, under the operation lock:

1. `reconcile_remote_llms_locked()` — keep the Dell boxes' standalone models in their desired
   state (ch.04).
2. **Auto-resume** — restart a render-suspended LLM once the contending ComfyUI queues have been
   idle for 300 s (ch.04 render-permit).
3. **Drift adoption** — an engine answering while the phase says otherwise is adopted as
   `running`; a `running` phase whose containers vanished is recorded as a `CONTAINER_CRASH`
   incident (`autoheal_audit`, `GET /api/audit/crashes`) and restarted, at most 3 times in
   15 minutes (`can_autoheal_restart()`), after which the phase is left at `error` for a human.

**scraper-service `auto` engine** (`app/scraper/engines/auto_engine.py`), per URL: phase 0 checks
`UNSCRAPABLE_DOMAINS` (`seekingalpha.com`, `reuters.com`, `streetinsider.com`, `chartmill.com`,
`thestreet.com`) and `failure_cache.check(url)` (7-day dead/empty TTL in schema-v2
`failure_cache.db` → answer without a fetch), phase 0b checks `should_skip_domain(domain)`
(`good_count == 0`, `thin_streak >= 5`, last thin within 24 h), then plain HTTP (shared
cross-worker `rate_limiter.db`, RFC-9110 `Retry-After` `auto (waiting)` on `429`/`503`). A live
HTTP `404`/`410` without block-page content records `dead_link` and returns `auto (failed)` on the
first network hit, whereas subsequent cache hits return `auto (skipped)` and increment
`skip_reasons` (`auto.skipped == sum(skip_reasons.values())` in shared `scraper_metrics.db`).
Blocked, UA-sniffed `404` block pages, or short (`< 900` chars) HTTP results escalate to
Playwright unless `browser_is_hopeless(domain)` (`browser_successes == 0` and
`browser_tries >= 5` within 24 h) short-circuits browser escalation.
