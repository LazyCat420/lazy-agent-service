# The empty-output death spiral (2026-08-26)

Request `7f0929e2` (cycle-v3-1787786020, KSS, CUSTOM_V3_JUNIOR_ANALYST on
DeepSeek V4 Flash / Gold Spark): 4 straight iterations at outputTokens=1 (a
lone EOS), then the phase died. Not rare: prism logged **248 "Empty output
recovery" events in the preceding 48h**.

## Failure chain (verified by code inspection + live replay)

1. **Timeout tie.** `get_finnhub_news` and `lazy_web_search` are SLOW_TOOLS;
   the bridge deadline was 60,000 ms — exactly prism's MCP client deadline
   (SDK default, never overridden on its agentic path). Prism's clock starts
   first, so it always won: the tool surfaced as protocol error `-32001`
   instead of a structured result. ToolCallGuard's 15 s acquire wait made the
   worst case 75 s vs 60. McpAdapter's CallTool handler had no deadline at all
   and emits no progress notifications (so `resetTimeoutOnProgress` never
   fires).
2. **Unanswerable guidance.** Prism wraps a failed tool in
   `<tool-retry-guidance>` asking which *argument* caused the failure — a
   timeout has no such answer.
3. **Degenerate suffix.** Each empty pass appends a `role:"system"`
   `<empty-output-recovery>` message and no assistant turn. Prism demotes
   non-leading system messages only for models matching `qwen3.6`, so DeepSeek
   received up to 5 consecutive raw `system` messages — and answered EOS.

## Proof the suffix is the mechanism

Replayed a faithful reduction of the KSS iteration-4 payload directly against
Gold Spark `:8000` (temperature 0.7, thinking off, 3 trials per arm):

| arm | content length | finish |
|---|---|---|
| original tail (retry-guidance + 3× recovery, all `system`) | **0, 0, 0** | stop |
| shim-rewritten tail (collapsed + demoted) | 69, 2172, 79 | stop/length |

The original arm reproduces the production signature exactly; the rewritten
arm answers every time.

## The fix (this repo, prism is read-only upstream)

- **`McpAdapter.raceToolDeadline`** — every MCP tool call now races
  `MCP_TOOL_DEADLINE_MS` (55 s, env-overridable) and on expiry returns a
  normal `isError` tool result whose text is model-facing: "This is not an
  argument problem — do not retry the same call… emit your final artifact."
  It answers *before* prism's 60 s, so `-32001` cannot happen for slow tools.
  <!-- check: grep -q "MCP_TOOL_DEADLINE_MS" config.ts -->
- **`SLOW_TOOL_TIMEOUT_MS` 60 s → 40 s** so the bridge (plus the 15 s guard
  wait) fits inside the adapter deadline. Budget invariant pinned by
  `src/services/__tests__/McpDeadline.test.ts`:
  `SLOW_TOOL_TIMEOUT_MS + ACQUIRE_TIMEOUT_MS ≤ MCP_TOOL_DEADLINE_MS < 60_000`.
- **`VllmShimService.rewriteMessages`** — on every `/v1/chat/completions`
  through the shim: collapse consecutive duplicate `<empty-output-recovery>`
  messages, demote non-leading `system` → `user` (all models; idempotent where
  prism already did it). Kill switch `VLLM_SHIM_REWRITE_MESSAGES=false`.
  Tests: `src/services/__tests__/VllmShimRewriteMessages.test.ts` (fixture is
  the actual KSS tail; all new tests were run against pre-fix code and failed).

Shipped in `4283e1f`. Companion caller-side fixes (truthful abort reasons,
paging on dead desks, junior-prompt escape hatch) are in trading-service
`64fffb0` — see trading-service `docs/EMPTY_OUTPUT_SPIRAL_2026-08-26.md`.

## Post-deploy success criteria

- prism "Empty output recovery" lines ≈ 0 (baseline 248/48 h).
- `[McpAdapter] TOOL_TIMEOUT` lines replace `-32001` results.
- `[VllmShim] rewriteMessages` lines ≈ 0 — with the deadline fix working, the
  degenerate tail should rarely form at all; the shim rewrite is the backstop.

## Open items

- The MCP server still emits no progress notifications; tools that
  legitimately need > 55 s (none known today) would need them to escape
  prism's fixed 60 s.
- The timed-out underlying execution is not cancelled (same abandoned-work
  semantics as before; ToolCallGuard coalescing absorbs repeats).
- The Qwen rewrite in `openai-compat.ts` (client→prism direction) and this
  shim rewrite (prism→vLLM direction) are separate transforms by design; if a
  third seam ever appears, consolidate.
