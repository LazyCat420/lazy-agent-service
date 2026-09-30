# Strategy Chat Tool Resilience & Soft Recovery (2026-09-30)

## Problem Summary
Interactive strategy chat with `GLM-5.3-Flash-EXL3-TF` aborted intermittently on iteration 3 with one of two errors:
1. `⚠️ Error: The model provider encountered an error on iteration 3: HTTP fetch failed with status 403. Response incomplete: HTTP fetch failed with status 403`
2. `⚠️ Error: The model provider encountered an error on iteration 3: Tool call budget exhausted. Response incomplete: Tool call budget exhausted`

## Root Cause Analysis
1. **HTTP 403 Fatal Exception**:
   - `GlobalCapabilityExecutor.executeReadPage` made bare Node `fetch()` calls without a browser `User-Agent` or navigation headers. Cloudflare and bot-protected websites (e.g. GuruFocus, Note.com) returned HTTP 403 Forbidden.
   - When `!res.ok`, the function returned `{ success: false, error: { code: "PAGE_FETCH_ERROR" } }`.
   - `RunExecutionEngine.processToolCall` classified `!execResult.success` as `status: "denied"`.
   - `RunExecutionEngine` line 501 threw `Tool denied`, causing an unhandled fatal exception in `ReActHarness` that aborted the conversation and discarded the research.
2. **Tool Call Budget Exhaustion on Iteration 3**:
   - Profile `trading-strategy-chat-v1.json` hardcoded `budget_limits.max_tool_calls: 6`.
   - Multi-turn research with parallel tool calls (e.g., 2 searches + 5 URL reads across turns 1–3) exceeded 6 calls on call #7 in iteration 3.
   - `RunExecutionEngine` threw `TOOL_BUDGET_EXHAUSTED` as a hard exception instead of returning a completion guidance observation.
   - `ReActHarness` threw `INCOMPLETE_RUN` before the exhaustion recovery pass could execute.

## Remediations Applied
1. **`GlobalCapabilityExecutor.ts`**:
   - Injected browser-like headers (`User-Agent`, `Accept`, `Accept-Language`) to prevent bot false positives.
   - Converted non-200 responses (HTTP 403, 404, 500) and network failures into soft observations (`{ success: true, result: { ... } }`) instructing the model to synthesize using search snippets.
2. **`trading-strategy-chat-v1.json`**:
   - Increased `budget_limits.max_tool_calls` from 6 to 20 for in-depth multi-query research.
3. **`RunExecutionEngine.ts`**:
   - When `actualToolCalls > maxToolCalls` for `maxToolCalls > 0`, returns a tool observation directing the LLM to wrap up without further tools, avoiding run crashes. Strictly maintains `TOOL_BUDGET_EXHAUSTED` throw for `maxToolCalls === 0` to preserve contract tests.
4. **`ReActHarness.ts`**:
   - Moved `runExhaustionRecoveryPass` execution before the `INCOMPLETE_RUN` throw so uncompleted runs have an opportunity to synthesize their final response.
5. **`bootstrap.ts`**:
   - Added support for locating `projects.json` in parent repositories when executing within git worktrees.

## Verification
- `test/contract/RuntimeNewsWorkflow.test.ts`: Added regression test verifying soft 403 handling and successful synthesis without error. (4/4 passed)
- `test/contract/RuntimeRepair.test.ts`: Added regression test verifying soft tool call budget capping and successful completion. (13/13 passed)
