---
part: Plans
status: in-progress
updated: 2026-10-19
review-by: 2026-11-01
---

# NEXT-SESSION backlog: core-loop refactor (from 2026-10-17)

Scope to agree with the user. Plan: `40-core-loop-onion-refactor-plan-2026-10-17.md` (rev 2; pi was dropped, LAS-native CoreLoop).

1. **Phase E rescope (needs a user decision).** Evidence 2026-10-17:
   - E1 "only bing returns results" is by design. Per `agents/scraper-service/OPERATIONS.md` "Search engines: no DuckDuckGo (2026-10-06)", the free engines bot-block the house IP, SearXNG is pinned to bing + wikipedia, and general search goes through LAS `/execute/web_search` (Exa, SearXNG fallback). Proposal: drop E1.
   - E2/E3: scraper-service ships trading-service's `app/scraper` (OPERATIONS.md "Which commit is running?"), so those fixes land in trading-service, which can't be deployed over a live cycle. Proposal: do them in trading-service in a session that owns it.
   - LAS-side alternative for E2's user-visible problem (JS pages unreadable): `global.web.read_page` falls back to `WebExtractService` (scraper-service `/scrape`, engine auto = http then Chromium) on HTTP 401/403 or `EMPTY_CONTENT`. Small and LAS-only.
2. **read_page `EMPTY_CONTENT` threshold** (< 200 chars of text) also rejects genuinely tiny pages. Revisit if the eval shows false refusals.
3. Verify html-notes news path claims (E15) before C4.
4. prism `/agent` probe had 4 infra failures (500 "terminated"/"fetch failed", 180 s timeouts). Rod's repo: report to Rod, don't fix.
5. vLLM thinking-off (`chat_template_kwargs.enable_thinking:false`) doesn't reach GLM's template (the trace saw reasoning tokens with thinking off). The shim's `enable_thinking→thinking` mirror targets DeepSeek-style templates. Unverified.
6. ~~Remaining `await reader.cancel()` crash-pattern sites: `decision-fabric/SemIfProvider.ts:69`, `TinyModelsProvider.ts:33`.~~ Closed 2026-10-19: both files are gone. The shadow decision fabric (`src/decision-fabric/`, `POST /v1/runs/:runId/decisions`, `RuntimeClient.decide`, profile `decision_policy`, `RunRecord.decision_receipts`, wire `decision_request`/`decision_result`) was removed because its backend, Jetson TinyModels on :8002, was retired (SemIF dead since 2026-10-08). It was shadow telemetry only; no other repo consumed it. `deploy.sh` no longer writes `TINYMODELS_SHADOW_ENABLED`/`DECISION_PROVIDER`.
7. Delete `.scratch/harness-research/` (pi/omp/Hermes clones) when no longer referenced.
8. **Phase D Option B landed 2026-10-18 (`e952da6`, `b47f790`).** `AgentRouteAdapter` (`src/core/loop/AgentRouteAdapter.ts`) and `AgenticLoopService` (`src/services/AgenticLoopService.ts`) now route `POST /agent` onto `CoreLoop` (`runCoreLoopForAgent`) by default for `project === "vllm-trading-bot"` (and whenever `LAS_AGENT_LOOP=coreloop`), with an instant rollback switch (`LAS_AGENT_LOOP=legacy`). Legacy harnesses (`ReActHarness`, ToT/GoT, plan mode) remain available as fallback until non-trading `/chat` routes are migrated.
9. **B8 compaction in CoreLoop — RESOLVED 2026-10-18 (`e952da6`).** Implemented `src/core/loop/MessageCompactor.ts` (`compactMessages` + `verifyToolPairAtomicity`) and wired it into `RunsAdapter.ts` and `AgentRouteAdapter.ts` `beforeModelCall` hooks. Tool-call/result groups (`[assistant(toolCalls), ...matching tool results]`) are evicted atomically, and orphan `role:"tool"` messages are stripped.
10. **A4 step 3 resolved under CoreLoop (2026-10-17):** an unknown tool name becomes a `TOOL_NOT_FOUND` observation listing the available tools, with a "Did you mean" suggestion (`ToolRunner.ts:62-121`; tests `ToolRunner.test.ts:79-87`).
11. **CoreLoop `thinking.delta` — RESOLVED 2026-10-18 (`e952da6`).** `RunsAdapter` and `AgentRouteAdapter` now preserve `thinking` and `reasoning_content` across active assistant tool-call turns (`H1`), strip historical reasoning via `stripHistoricalReasoning`, and forward `thinking.delta` events.
12. **C2/C3 premise corrections (needs a user decision; checked 2026-10-17).**
    - C2 Obsidian half: `ObsidianCompletionJobs` is a durable proxy for one model step ("Vault tools remain on the Obsidian client"); LAS has no Obsidian loop to move onto CoreLoop. Nothing to do there.
    - C2 ChatRoutes FC half (`ChatRoutes.ts` ~1229, runs only when `functionCallingEnabled` is set without the agentic loop): no caller found that uses it. music-player `chat.py:135` and trading office-client `OmniChat.jsx:440` both also set `agenticLoopEnabled`, so they hit `AgenticLoopService`.
    - C3: the plugin already has the shared-runtime path (`main.js` `useSharedRuntime` getter needs `runtimeBridgeUrl`; the settings text says "Requires a trusted bridge that authenticates this vault session"). Turning it on needs that bridge deployed and a live Obsidian check. Deleting `run_agent` before then would remove the plugin's only working path. Decide: build/deploy the bridge, or keep the plugin loop (its tool-call bug was already fixed in `6a034d8`).
13. **Model-id transient (`GLM-5.3-Flash-EXL3` → `GLM-5.3-Flash-EXL3-TF`) — RESOLVED 2026-10-18 (`e952da6`).** Added `normalizeLocalModelId` in `src/services/DynamicModelResolver.ts` to normalize `GLM-5.3-Flash-EXL3` (and prefixed variants) to `GLM-5.3-Flash-EXL3-TF`.
14. **Eval tool count for timed-out tools.** The chaos hang tool produced no `tool.*` event before C1h; after C1h deploys, confirm the eval shows `tool.failed` for it.
15. **Flaky deploy gate: `McpGaps.test.ts:437` — RESOLVED 2026-10-18 (`e952da6`).** Added event-driven `McpClientManager.waitForToolListChanged(serverId, timeoutMs)` (`src/mcp/McpClientManager.ts`) and replaced the brittle 100 ms sleep in `src/mcp/__tests__/McpGaps.test.ts` with `await manager.waitForToolListChanged("srv", 5000)`.

## Session close 2026-10-18 (Part 1 — C1 gate)
- C1 gate passed (trading 7/8, html-notes 8/8, chaos 10/10, 0 restarts); main `c66cab5`, deployed `6640a23`.
- **User deferred to next session (2026-10-18):** C2/C3 (item 12), C4 (html-notes news via `/v1/runs`), full Phase D legacy harness deletion (`LAS_RUNS_LOOP=legacy` and `LAS_AGENT_LOOP=legacy` switches stay), Phase E (item 1).

## Session update 2026-10-18 (Part 2 — CoreLoop v2 Upgrades `e952da6` + `b47f790`)
- Landed `H1–H10` comparative harness upgrades (`SpillBuffer.ts`, `RunawayStreamWatch.ts`, `MessageCompactor.ts`, `ToolOutputSubstituter.ts`, `AgentRouteAdapter.ts`, `CoreLoop.ts`, `ToolRunner.ts`, `RunsAdapter.ts`, `types.ts`):
  - `H1` Interleaved reasoning (`thinking` + `reasoning_content`) preserved within active turn and stripped on historical turns (`stripHistoricalReasoning`).
  - `H2` Semantic duplicate tool-call (`computeToolCallFingerprint`) & 3-cycle `A <-> B` oscillation guard (`TOOL_STALL` / `TOOL_OSCILLATION`).
  - `H3` `RunawayStreamWatch` streaming degenerate repetition watchdog + `RUNAWAY_RECOVERY_NUDGE`.
  - `H4` Fission-GRPO structured corrective error feedback (`retry_guidance`).
  - `H5` Two-tier 1 MB FIFO `SpillBuffer` (>16 KB → 8 KB head + 4 KB tail + `spill_id`) + built-in `read_tool_spill` tool.
  - `H6` & `B8` `MessageCompactor` tool-pair-atomic compaction (`verifyToolPairAtomicity`).
  - `H7` Zero-token `{{tool_output:<id_or_name>.path}}` placeholder substitution in tool batch args (`substituteToolBatchPlaceholders`) and final assistant text (`substituteToolOutputTokens`).
  - `H8` `formatToolLoadoutDelta` `<system-reminder>` injection when new tools unlock mid-run.
  - `H9` `getSteeringMessages` & `getFollowUpMessages` hooks in `CoreLoop`.
  - `H10` Bounded parallel tool concurrency (`parallelToolMaxConcurrency = 8`) + `H10b` `beforeFinish` in-loop stop gate (`maxStopGateRetries = 2`).
- Landed `B4` trading learning boundary (`shouldSkipTradingLearning` + `prepareTradingAgentRequest` skipping memory/workflow learning for `vllm-trading-bot`), `B25` final-pass `enable_thinking: false` + 0-token diagnostic in `openai-compat.ts`, Backlog 13 `GLM-5.3-Flash-EXL3-TF` normalization, Backlog 15 event-driven `waitForToolListChanged`, Phase 6 Step 6.3 `global.web.read_page` fallback to `WebExtractService` on HTTP 401/403 or `EMPTY_CONTENT`, `--model` CLI flag in `scripts/eval/run-basic-eval.mjs`, and `Option B` `AgentRouteAdapter` + `AgenticLoopService` routing `POST /agent` onto `CoreLoop` with `LAS_AGENT_LOOP=legacy` rollback switch.
- Verified with 21/21 unit tests in `src/core/loop/__tests__/CoreLoopV2Upgrades.test.ts` and full Vitest suite (`169/169` files).
- Deployed `main@b47f790` to Synology NAS (`http://10.0.0.16:5591`, `GET /health` → `200 OK`):
  - **Live `POST /agent` verification (`project: "vllm-trading-bot"`, `stream: false`, `agent: "CUSTOM_V3_JUNIOR_ANALYST"`):** `HTTP 200`, `CoreLoop` execution and `B4` learning isolation (`[MemoryExtractor] Skipping — project "vllm-trading-bot" is isolated from harness memory extraction (B4)`) confirmed in container logs.
  - **Live GLM eval (`GLM-5.3-Flash-EXL3-TF`, `.scratch/harness-plan/eval-coreloop-v2-glm/`):** **trading 8/8 PASS** (0 WEAK, 0 FAIL), **html-notes 8/8 PASS** (0 WEAK, 0 FAIL), `restart_count: 0`.
  - **Live Nemotron eval (`--model nemotron35`, `.scratch/harness-plan/eval-coreloop-v2-nemotron/`):** **trading 7/8 PASS / 1 WEAK / 0 FAIL**, `restart_count: 0`.
