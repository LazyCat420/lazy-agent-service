---
part: Plans
status: in-progress
updated: 2026-10-07
review-by: 2026-10-20
---

# Every repo on our own agent harness

**Goal (user decision, 2026-10-06):** every repo we own runs its agents through
**this service's** agentic harness instead of prism-service's. Prism stays only
for logging: our harness keeps writing the shared `prism.requests` collection,
so prism-client and every audit reader keep working unchanged. Rod's own
projects keep using prism; prism-service itself is never edited.

## Why this is mostly switching, not building

This service is a fork of prism, and the pieces already exist here:

- **Native routes** `/agent`, `/chat`, `/custom-agents` and `/embed` are mounted in
  [src/index.ts](src/index.ts). `/agent` and `/chat` run our own loop
  (`AgenticLoopService` → `ReActHarness`).
- **The agent registry is shared.** [src/services/CustomAgentService.ts](src/services/CustomAgentService.ts)
  reads `prism.custom_agents`, the same collection prism-service writes. Our
  `GET /custom-agents` already lists all 34 agents, trading's V3 agents included,
  so nothing needs migrating.
- **Tool approval and deny policies** live in `AutoApprovalEngine`, `PolicyEngine` and
  `ApprovalGate`.
- **Request logging** is global middleware and writes `prism.requests`.

Every repo currently reaches prism through this service's `/prism-proxy`
(which just forwards to prism's `:7777`) or calls `:7777` directly. Moving a repo
means pointing its harness URL at our native routes, then proving parity.

## Measured 2026-10-06

- **Native `/agent` runs a trading call, but not a faithful one** (corrected
  2026-10-07). The 2026-10-06 Junior Analyst call ran the persona, the vLLM shim
  and memory injection, and refused `lazy_web_search` — which was read as tool
  enforcement working. It was not: `lazy_web_search` is on the junior's
  whitelist. The native route never mints the signed trading tool context (only
  `/prism-proxy` calls `prepareToolContext`), and `ToolDispatch.dispatchTool`
  refuses every `vllm-trading-bot` call without it. The same run reached the
  model with **no system prompt**: `ReActHarness` swaps the caller's
  `systemPrompt` for the persona's and `providers/vllm.ts` never sends
  `options.systemPrompt`. Both are items 0–1 of the port list in chapter 06.
- **Replays from `prism.requests` are not faithful.** Prism strips `systemPrompt`,
  `enabledTools` and `autoApprove` from the request copies it stores. Without
  `autoApprove`, `ApprovalGate` waits `APPROVAL_TIMEOUT_MS = 120_000` for a human
  on every tool call, which explains the exact 120 s gaps in that replay.
  **Parity tests must drive trading's real caller, never log copies.**
- **Logging gap, fixed in `d8a3c10`.** Our rows wrote `timestamp` but not prism's
  `createdAt` (plus `toolApiNameCount`). Every time-based reader (trading's
  Monitor and audits, prism-client) would have silently skipped harness calls.
  Both insert paths now write `createdAt` equal to `timestamp`, pinned by
  `src/services/__tests__/RequestLoggerPrismParity.test.ts`. That test goes red
  against the old logger and green against the fix. **Deployed and verified
  live 2026-10-06 22:33 PDT**, between trading cycles: a harness `/chat` call
  wrote a row with `createdAt` equal to `timestamp`. Deploy this service only
  when no trading cycle is running, because a restart breaks in-flight cycles
  that route tools and models through it.
- **Baseline worth beating:** prism's own success rate on the last 300 trading
  agent calls was 197/300.

## Parity, measured (2026-10-07)

Same input, both loops, trading's own client code (trading-service
`scripts/harness/parity_check.py`; record in trading-client ch.21).

| Boundary-probe contract | prism | ours, before (`c893bc6`) | ours, after (`f4d6e86`) |
|---|---|---|---|
| oversized tool result cut to fit | PASS | not exercised (no tool call) | PASS |
| copied-text gate | PASS | PASS | PASS |
| forced final turn directed | PASS | not exercised | PASS (tagged notice, `dfa1c84`) |
| cut stream fails | PASS (0–1 s) | FAIL (answered) | PASS (3–45 s) |
| hung tool ended by trading's watchdog | PASS | not exercised | PASS |
| SSE vocabulary | PASS | PASS | PASS |

**All six contracts hold on our loop as on prism's** (07:50 UTC).

Real V3 prompts replayed through `base_agent.run_agent`, both loops pinned to the
same box, two replays each: artifacts ours 5/6, prism 6/6. The miss was one empty
GLM reply after a single model call — prism retries empty outputs in-loop, ours
does not yet (ch.06 item 8). Tool-call counts swing on both loops; a first
single-sample "ours makes twice the calls" did not survive the repeat.

## Plan and status

1. [x] Agent registry reachable from our harness (shared `prism.custom_agents`).
2. [~] Native `/agent` runs a real trading agent — without its system prompt or
   its trading tools (see *Measured*; fixed under step 5).
3. [x] Harness log rows match prism's shape (`createdAt`) — landed `d8a3c10`, deployed and verified live.
4. [x] **Faithful parity script** — built and run 2026-10-07: trading-service
   `scripts/harness/parity_check.py` (`f3804206`). The same input goes to
   `…:5591/prism-proxy` and `…:5591` through trading's own client code, for
   three kinds of work: the boundary probe's contract scenarios; real V3 prompts
   that `agent_runner` recorded as `prompt.assembled` traces, replayed through
   `base_agent.run_agent` (the cycle's code path — `call_prism_agent` serves
   only the briefings, news and the consolidator); and the flash briefing's
   `call_prism_agent`. Runs use synthetic `probe-parity-` cycles, and the
   trading bridge now refuses cycle-escaping write tools for any synthetic
   cycle (`2ebf40ea`). Results: *Parity, measured* below; the full record is
   trading-client documentation ch.21.
5. [ ] Close every gap: the P0 port list in chapter 06 (trading boundary on
   native `/agent`, system prompt, trading tools, DENY-before-full-auto,
   context window, stream resilience, rolling window, result bounding,
   malformed arguments, forced final turn, memory extraction). One item at a
   time, each with a test, each re-measured with the parity script.
6. [ ] Flip trading's harness URL (`PRISM_URL`) with a per-agent flag, default off.
   Then one agent → all agents → desk chat → embeddings, watching real cycles.
7. [ ] Move the other repos the same way, one at a time: trading-client,
   lazycat-sdk, html-notes, music-player, SmartGardenDashBoard,
   LLMSortObsidian, office-client, scraper-service, youtube-wallgarden,
   vault-service config.
8. [ ] Stop forwarding our own traffic through `/prism-proxy`. Keep this
   service's prism registration for Rod's projects that still use prism.
