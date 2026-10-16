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

- [x] **0. The trading boundary on native `/agent`.** *Landed `13698be`, live 2026-10-07 06:49 UTC (`8f63cba`): both routes call `prepareTradingAgentRequest`; native `/agent` answers 422 where the boundary refuses. Measured: the shim now records the native arm's payloads and the hung-tool contract holds on our loop.* Today it exists only on
  `/prism-proxy` + `/vllm-shim`: the signed tool context
  (`prepareToolContext`), the learning boundary marker
  (`prepareTradingRequest`), the per-conversation tool whitelist, `unattended`.
  *Verified:* `prepareToolContext` has one caller, `PrismProxyService.ts:125`,
  and `ToolDispatch.dispatchTool` refuses any `vllm-trading-bot` / `v3_*`
  call without that signed context — so every trading tool call on our loop is
  `PERMISSION_DENIED`. Chapter 05's "refused an unauthorized tool
  (`lazy_web_search`)" was this, not enforcement: `lazy_web_search` is on the
  junior analyst's whitelist.
- [x] **1. System prompt delivery.** *Landed `18a031f` (live in `8f63cba`): `prependIdentitySystemMessage` in vLLM, LM Studio, Ollama, llama.cpp and OpenAI; a caller's prompt wins over the persona's (`applyAssembledSystemPrompt`). Side effect: every native persona on these providers now gets its identity prompt, which it never had here.* *Verified:* `ReActHarness.ts:276`
  replaces `options.systemPrompt` with the persona's assembled prompt, and
  `providers/vllm.ts` never sends `options.systemPrompt` at all. Trading's cycle
  path sends its prompt only as `systemPrompt` (`inline_system_prompt=False`),
  so a native trading run on vLLM reaches the model with **no system prompt**.
  Prism keeps the caller's prompt and prepends it for vLLM
  (`prependIdentitySystemMessage`).
- [x] **2. Trading tools offered and dispatched natively.** *Landed `13698be` (live in `8f63cba`): a trading request gets the trading catalog as `mcp__lazy-agent-service__*`, filtered by its `enabledTools`; calls run through `ToolDispatch`. Measured: the junior, fundamental and quant replays all called trading tools with no refusal and produced artifacts. Still open: a conversation id `/prism-proxy` registered with an empty tool list refuses native calls (only matters while one SDK process uses both routes).* The native catalog
  (`ToolOrchestratorService.getMCPToolSchemas`) serves widget, html_notes,
  canvas, `lazy_web_search` and `strain_*` only, and native calls go through
  `routeLocalTool`, skipping `dispatchTool`'s authorization. Also: the proxy's
  `registerSession` stores `enabledTools || []` (empty for trading), which
  makes `isToolAllowed` refuse every native call on a conversation id the proxy
  has seen.
- [x] **3. DENY before full-auto, and the core-tools decision.** *Landed `a564866`: policies are read before the `fullAuto` short-circuit (`AutoApprovalEngine.check`, a DENY is final in every mode; full auto answers a policy ASK_USER with yes, prism `explainCall` order), and `AgenticToolResolver` keeps `execute_python` / `emit_structured_output` / `think` available even for `coreToolsLocked: false` personas (an explicit `blockedTools` entry still wins) — a trading run cannot produce its artifact without `emit_structured_output`. Tests: `DenyBeforeFullAuto`, `CognitiveToolsAlwaysAvailable`.* `autoApprove`
  short-circuits `ApprovalGate` and `AutoApprovalEngine.check` returns for
  full-auto before policies are read, so trading's DENY policies
  (`execute_command`, `execute_javascript`, `execute_skill`, `write_file`,
  `query_datastore`, `search_web`) do not apply on ours. Prism force-adds the
  core agentic tools (`coreToolsLocked ?? true`); ours honours the SDK's
  `coreToolsLocked:false`, so trading agents lose `execute_python`,
  `emit_structured_output` and `think` here — decide which behaviour we want.
- [x] **4. Context-length discovery + calibrated budget + overflow halving.**
  *Landed on `wt-harness-a`: the vLLM provider asks `/v1/models` (then
  `/model_info`) for `max_model_len` on the first iteration
  (`providers/vllm.ts discoverContextWindow`); `BaseAgenticHarness.resolveContextWindow`
  reads the catalog or the discovered `_loadedContextLength`; the output clamp
  now counts the system prompt and tool schemas and calibrates against the
  last reported input (`compact/ContextBudgets.ts`,
  `harnesses/ContextBudgetTracker.ts`); a context-overflow rejection halves
  `maxTokens` and retries (`utils/ProviderStreamResilience.ts`,
  `reducedMaxTokensForOverflow`).)* Every
  context guard is inert on vLLM without them.
- [x] **5. Provider stream resilience** *(landed `6098253` + `a27e603` + `36fda45`: `parseSSEStream` fails a stream with no finish_reason with prism's 502, and `streamWithRetries` retries only when zero chunks reached the consumer — a cut stream after output is a terminal failure in <2 s (locked by `StreamRetryTiming.test.ts`, 4.5 s of retries on the reverted source) — and our own shim's 503 + Retry-After saturation shed is now retried (`fetchOpenAICompat` carries `status` + `headers`, prism `providers/openai-compat.ts`) with the Retry-After honoured up to the 60 s cap. 300 s idle abort in `withIdleTimeout`.)* (`utils/ProviderStreamResilience.ts`):
- [x] **6. The single-turn rolling window.** *(Landed on `wt-harness-a`:
  recency by model calls — `compact/RecencyProtection.ts`, the last 4 model
  calls / 20k tool-output tokens, not user turns — drives every shrink in
  `ContextWindowManager`; its budget comes from `ContextBudgets` in the same
  units as the clamp and compaction trigger; the per-conversation breaker,
  the shrink check with a no-shrink cooldown and the compaction fallback
  model (aux compression chain, `dd69148`) are in `CompactionService`; and
  verbatim originals are kept — `compact/MessageLineage.ts` registers every
  shrunk view copy and `harnesses/lifecycle/TurnTranscript.ts` records the
  turn's messages by their pristine originals before any shrink, so
  persistence (`collectTurnMessages`) never captures a truncated view.)*
- [x] **7. Tool-result bounding** *(trading path landed `1ae5dfe`; the rest landed on `wt-harness-a`: `expandMessagesForFunctionCall` bounds every non-trading result — strings and standalone tool messages included — with prism's 8k / 10-items semantics through `fitForPrism`, and the `serialized.slice(0, maxChars) + "…}"` mid-JSON slice is gone: cuts are valid JSON or line-aligned previews. No retrieve pointer, as the chapter prescribes.)*
- [x] **8. Malformed tool arguments, empty outputs and loop guards** *(landed `a564866`: the provider flags unparseable tool-call argument JSON (`argsParseError`/`rawArgs`, prism `providers/openai-compat.ts`) and `ToolExecutor` returns `MALFORMED_TOOL_CALL_JSON` instead of running the tool with `{}` — the source of most "'data' is required and must be an object" failures from `emit_structured_output`; genuinely empty passes are retried in-loop with a temperature bump and a tagged `<empty-output-recovery>` nudge, `MAX_EMPTY_OUTPUT_RETRIES` 4 × +0.2 temp, prism constants; before/after: 5 of the 11 new assertions fail on the reverted sources, all 24 pass after. Not ported: `SemanticStallDetector` / `DeviationRuleEngine` — our warn-at-3/stop-at-5 repetition guard stays)* *(measured 2026-10-07: 1 of 6 box-pinned replays on our loop ended as an empty GLM reply after one model call; prism retries empty outputs in-loop)*: `MALFORMED_TOOL_CALL_JSON`
  instead of silently running the tool with `{}` (`utils/openai-compat.ts:778`
  — the source of most "'data' is required and must be an object" failures from
  `emit_structured_output`), empty-output retries, prism's stall/deviation
  detectors (`SemanticStallDetector`, `DeviationRuleEngine`,
  `RepetitionDetector`; ours warns at 3 identical iterations and stops at 5).
- [x] **9. Forced final turn parity:** *(directive part landed `dfa1c84` + `f4d6e86`; the rest landed `a564866`: the exhaustion pass keeps the same tool block and calls with `toolChoice: "none"` — `vllm.ts` now honours it instead of always sending `auto` — so the summary pass is prompt-cache stable, and when the recovery pass itself comes back empty a synthetic fallback summary (`buildSyntheticFallbackSummary`, prism `ExhaustionRecovery.ts`) is built from the tool history. Tests: `ExhaustionFallback`, plus `ForcedFinalTurn` and `TradingToolProtocol` for the directive.)* keep the tool block, honour
  `toolChoice: "none"` in our `vllm.ts` (we always send `auto`), tagged
  notices, a synthetic fallback summary.
- [x] **10. Memory-extraction watermark + `X-Vllm-Priority`:** *(landed `a564866`: `services/memory/ExtractionWatermark.ts` — a simplified port of prism's store — keys a watermark per conversation; `MemoryExtractor.extractAndStore` reads only the messages after the last extracted one (content-hash identities + anchor disambiguation, rawContent covered) and makes no call at all when the new span carries nothing the user wrote; the extraction call runs under `runWithRequestPriority("background")` and the vLLM provider sends `X-Vllm-Priority: 10` on background calls when `PROVIDER_VLLM_PRIORITY_SCHEDULING=true`. Tests: `ExtractionWatermark`, `VllmPriorityHeader`.)* today every
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

### MCP client — ported (`/mcp-servers`)

- [x] **MCP client + `/mcp-servers` routes** *(branch `wt-mcp-servers`; callers measured on prism: html-notes `GET /mcp-servers` + `POST /:id/connect`, vllm-trading-bot the same.)*
  `src/services/MCPClientService.ts` (restored from `9113901^`, stdio / SSE /
  streamable-HTTP via the MCP SDK) and `src/routes/McpServersRoutes.ts`
  (list / create / update / delete / connect / disconnect), mounted in
  `src/index.ts` next to the other routes. Added from prism's route: 404 on a
  malformed id, project+username scoping on every lookup (a server id from
  another scope is a 404), 409 on a duplicate name. Enabled servers are
  reconnected on boot (`connectAllFromDB`, after `listen`).
  - **Catalog:** `ToolOrchestratorService.getMCPToolSchemas()` returns the local
    `mcp__lazy-agent-service__*` catalog **plus** the tools of connected servers
    as `mcp__<server>__<tool>`; they disappear on disconnect.
  - **Dispatch:** `ToolOrchestratorService.executeMCPTool` (the `/agent` loop)
    and `LocalToolRouter.routeLocalTool` (so `ToolDispatch.dispatchTool`, i.e.
    `/execute` and the MCP SSE server) send a connected server's tool to
    `MCPClientService.callTool`. Server names that would shadow this service's
    own prefixes (`lazy-agent-service`, `lazy-tool-service`, `lazy-tools`) are
    refused at connect.
  - **Not ported:** `McpOAuthRoutes` and the `/:id/oauth` endpoints — an OAuth
    server would hook in at `MCPClientService.connect` (a transport
    `authProvider` + an `authorizationRequired` reply from `POST /:id/connect`,
    as prism's `McpOAuth.ts` does) and a router beside `/mcp-servers`; also not
    ported: prism's tool-fingerprint quarantine / `tools/approve`, `/prompts`,
    `/resources`, profile scoping (`profileId` / `shared`), output caps,
    elicitation.
  - Tests: `src/services/__tests__/McpServersPort.test.ts` (real SDK MCP server
    over streamable HTTP; only the Mongo collection is an in-memory stand-in).

Ported 2026-10-16 (branch `wt-ask-user-budget`), the HTTP side of three of
those items, all driven by real harness-turn tests
(`routes/__tests__/AskUserApprovalBudgetRoutes.test.ts`):

- **Approval decision** — `routes/ApprovalDecisionRoute.ts` (from prism
  `ApprovalDecisionRoute`), mounted at `POST /agent/approve` and
  `POST /conversation/approve` over the existing `ApprovalRegistry` /
  `ApprovalGate`. Strict `decision: "allow"|"deny"` (or boolean `approved`; a
  missing value is 400, not a yes), `toolCallId` 404 / ambiguous 400,
  `scope`. Durable follow-up (2026-10-16, branch `wt-durable-approvals`,
  tests `routes/__tests__/DurableApprovals.test.ts`): tool approvals are
  stored in Mongo `pending_decisions` (`services/PendingApprovalStore.ts`,
  from prism `PendingDecisionStore`, tool approvals only; TTL on `expiresAt`,
  index in `index.ts`). `ApprovalGate` writes the records before the card is
  emitted, so a pending approval survives a restart; a decision is a
  conditional write — a second one on the same call is **409**, and a decision
  with no live turn is stored and answered `delivered: false`. `editedArgs`
  (allow only; validated against the tool schema by `utils/ToolArgsValidator`,
  400 if invalid or on a deny) replaces the call's arguments before it runs.
  A deny `reason` (trimmed, 500 chars) reaches the model in the `USER_REJECTED`
  tool result. Still not ported: plan approvals, questions and budget pauses
  are not durable, and nothing re-drives a turn after a restart (the stored
  decision is not yet picked up by a new turn).
- **Ask-user** — the `ask_user` tool did not exist here (nothing ever filed a
  pending question), so the blocking path was ported
  (`harnesses/lifecycle/AskUserTool.ts`, from prism `AskUserQuestionTool`):
  it emits `user_question`, parks the turn in `pendingQuestions`, and resumes
  with the answer. `routes/QuestionAnswerHandler.ts` adds `questionId`
  targeting (404 unknown card, 409 second answer). Not ported: non-blocking
  cards and durability.
- **Conversation budget** — `routes/ConversationBudgetRoute.ts`
  (`GET|PUT|PATCH|DELETE /conversations/:id/budget`) over a new in-memory
  `ConversationBudgetRegistry`; `CostBudgetEnforcer` takes the lower of the
  request's `maxCostDollars` and the conversation's cap (plus an optional
  `maxTotalTokens`), re-read after every model pass. Prism's route instead
  raises the cap of a *budget-paused* turn; budget pause is still open, so
  this service stops the turn (exhaustion recovery) rather than pausing it.

## Prism-product features (P2) — not planned

ACP, the benchmark arena, push notifications, profiles, stats pages, the Bender
persona and locales, voices, artifacts, Discord headers and emojis, file garbage
collection. Port only on request.
