---
part: Plans
status: in-progress
updated: 2026-10-07
review-by: 2026-10-21
---

# What prism's harness does that ours does not yet

**Goal (user, 2026-10-06):** before any repo moves off prism (chapter 05), this
service must do everything prism's agent harness did — "like the rolling
windows" — so the move improves this service and keeps the trading cycle
working. This chapter is the inventory that drives that work. Each item is ported
one at a time, with a test, and checked off here when it lands.

How it was built (2026-10-06): a read-only comparison of prism-service
(`09af76e6`, 2026-09-26, its current master) against this repo, plus our own
spot checks. Claims marked *verified* were re-read in the code by the session
that wrote this chapter; the rest come from the comparison pass and cite files.
The behavioural evidence (the same trading work through both loops) comes from
trading-service `scripts/harness/parity_check.py` and is recorded in chapter 05.

## How far apart the two are

- **This service copied prism on 2026-06-28** (`e272628`, matching prism
  `bbe0c914`). One day later `9113901` cut it down to a thin proxy, deleting
  the MCP client and the whole local tool set (internal tool registry,
  discover/enable, ask-user, plan mode, todo, skills, reminders, worktrees).
- **Prism has had 753 commits since**, 259 of them on the agent loop and
  harness, 39 on context and compaction.
- **Our compaction stack is unchanged since the copy** (byte-identical
  `MicroCompactionService`, `AutoCompactionTrigger`, `ContextPressureManager`,
  `CompactionPrompt`, `utils/ContextWindowManager`).

## The rolling window (context management), side by side

**Prism, per loop iteration:**

1. Knows the real context window: the model's `maxInputTokens`, else vLLM's
   `max_model_len` read from `/v1/models` (`utils/ContextLengthDiscovery.ts`),
   else 128k.
2. Estimates the next request from the provider's last reported input plus the
   growth since, calibrated against real usage (`compact/ContextBudgets.ts`),
   counting messages, system prompt and tool schemas.
3. Derives both thresholds from one budget so it always summarizes before it
   truncates.
4. Protects the **last 4 model calls** (not user turns: a long agent run has one
   user turn) up to 20k tool-output tokens (`compact/RecencyProtection.ts`).
5. Shrinks in order: defer while results are unread; move old large tool
   results losslessly to Mongo behind an `offload_id`
   (`ToolResultOffloadService`, readable with `retrieve_offloaded_content`);
   LLM-summarize everything older than the recency window, judge the summary,
   persist the boundary; as a last resort cap old results, compress old turns,
   slide the window — never touching the protected calls. Originals are kept
   verbatim (`TurnTranscript`, `MessageLineage`).
6. Clamps the output budget to what is left (`ContextBudgetTracker`), refuses a
   call that cannot get 4,096 output tokens (`ContextExhaustionGuard`, runs a
   summary pass instead), and halves `maxTokens` and retries on a context
   overflow rejection.
7. Bounds every tool result at 8,000 characters / 10 list items behind a preview.

**Ours today (verified for points 1 and 2):**

1. Protection counts **user turns**. A trading run sends one or two user
   messages, so the protected range starts at the first message and nothing is
   ever shrunk; `enforce()` reports "truncated" and returns the input unchanged.
2. No context window for vLLM models: `getModelByName` reads a static catalog
   with no vLLM entries, so the output clamp returns early, the 4,096 guard never
   fires, and every threshold assumes 128k. No discovery, no overflow retry.
3. The estimate counts messages only (no system prompt, no tool schemas, fixed
   256-token margin, no calibration).
4. LLM compaction runs only if Settings→Memory names an extraction model; its
   breaker is process-wide; on a single-turn run a summary can make the prompt
   bigger.
5. Results: trading results are cut at 50,000 characters, objects are sliced
   mid-JSON at 8,000, strings pass whole. No offload store, ledger or deferral.

**What a long trading run would see on ours:** every result stays verbatim on
every request, the prompt grows linearly until prompt + `maxTokens` passes the
box's `max_model_len`, vLLM answers 400, and the turn ends with an error and no
artifact. A stalled stream hangs until trading's 1,800 s agent timeout (no body
timeout or idle watchdog on our provider client).

## Port list for the trading path (P0), in order

Each is one landed change with a test. Order = risk to the trading cycle.

- [ ] **0. The trading boundary on native `/agent`.** Today it exists only on
  `/prism-proxy` + `/vllm-shim`: the signed tool context
  (`prepareToolContext`), the learning boundary marker
  (`prepareTradingRequest`), the per-conversation tool whitelist, `unattended`.
  *Verified:* `prepareToolContext` has one caller, `PrismProxyService.ts:125`,
  and `ToolDispatch.dispatchTool` refuses any `vllm-trading-bot` / `v3_*`
  call without that signed context — so every trading tool call on our loop is
  `PERMISSION_DENIED`. Chapter 05's "refused an unauthorized tool
  (`lazy_web_search`)" was this, not enforcement: `lazy_web_search` is on the
  junior analyst's whitelist.
- [ ] **1. System prompt delivery.** *Verified:* `ReActHarness.ts:276`
  replaces `options.systemPrompt` with the persona's assembled prompt, and
  `providers/vllm.ts` never sends `options.systemPrompt` at all. Trading's cycle
  path sends its prompt only as `systemPrompt` (`inline_system_prompt=False`),
  so a native trading run on vLLM reaches the model with **no system prompt**.
  Prism keeps the caller's prompt and prepends it for vLLM
  (`prependIdentitySystemMessage`).
- [ ] **2. Trading tools offered and dispatched natively.** The native catalog
  (`ToolOrchestratorService.getMCPToolSchemas`) serves widget, html_notes,
  canvas, `lazy_web_search` and `strain_*` only, and native calls go through
  `routeLocalTool`, skipping `dispatchTool`'s authorization. Also: the proxy's
  `registerSession` stores `enabledTools || []` (empty for trading), which
  makes `isToolAllowed` refuse every native call on a conversation id the proxy
  has seen.
- [ ] **3. DENY before full-auto, and the core-tools decision.** `autoApprove`
  short-circuits `ApprovalGate` and `AutoApprovalEngine.check` returns for
  full-auto before policies are read, so trading's DENY policies
  (`execute_command`, `execute_javascript`, `execute_skill`, `write_file`,
  `query_datastore`, `search_web`) do not apply on ours. Prism force-adds the
  core agentic tools (`coreToolsLocked ?? true`); ours honours the SDK's
  `coreToolsLocked:false`, so trading agents lose `execute_python`,
  `emit_structured_output` and `think` here — decide which behaviour we want.
- [ ] **4. Context-length discovery + calibrated budget + overflow halving**
  (`ContextLengthDiscovery`, `ContextBudgetTracker`, the 400-retry). Every
  context guard is inert on vLLM without them.
- [ ] **5. Provider stream resilience** (`utils/ProviderStreamResilience.ts`):
  retry 408/429/5xx with zero chunks, 300 s idle abort, a cut stream is a
  failure. Our own shim answers saturation with 503 + Retry-After and our loop
  never retries it.
- [ ] **6. The single-turn rolling window:** recency by model calls, unified
  budgets, verbatim originals, a compaction fallback model, a shrink check, a
  per-conversation breaker.
- [ ] **7. Tool-result bounding** with prism's 8k semantics, using our cut (no
  retrieve pointer: trading roles do not hold that tool); stop the mid-JSON slice.
- [ ] **8. Malformed tool arguments and loop guards:** `MALFORMED_TOOL_CALL_JSON`
  instead of silently running the tool with `{}` (`utils/openai-compat.ts:778`
  — the source of most "'data' is required and must be an object" failures from
  `emit_structured_output`), empty-output retries, prism's stall/deviation
  detectors (`SemanticStallDetector`, `DeviationRuleEngine`,
  `RepetitionDetector`; ours warns at 3 identical iterations and stops at 5).
- [ ] **9. Forced final turn parity:** keep the tool block, honour
  `toolChoice: "none"` in our `vllm.ts` (we always send `auto`), tagged
  notices, a synthetic fallback summary.
- [ ] **10. Memory-extraction watermark + `X-Vllm-Priority`:** today every
  trading run adds a full-transcript extraction call on the same GPU.

## General capability (P1) — after the trading path

Durable turns (checkpoint + re-drive after a restart), configurable hooks,
workspace instructions, prefix-stable tool surface and tool discovery, the MCP
client (deleted in `9113901`), internal tools (ask-user, todo, reminders,
conversation search, tool programs, checkpoints), the permission stack (modes,
rules, per-call decisions, taint check), role-based model routing, model
profiles and self-hosted request features (guided JSON, priority), prompt-cache
telemetry, memory provenance / hybrid retrieval, secret redaction, sub-agent
orchestration and async tasks, conversation graph / rewind / fork, the typed
event protocol, goals, plan-mode gate, mid-turn input, budget pause, approval
previews.

## Prism-product features (P2) — not planned

ACP, the benchmark arena, push notifications, profiles, stats pages, the Bender
persona and locales, voices, artifacts, Discord headers and emojis, file garbage
collection. Port only on request.
