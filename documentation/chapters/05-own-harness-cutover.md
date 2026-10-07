---
part: Plans
status: in-progress
updated: 2026-10-06
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

- **Native `/agent` works end to end.** A trading Junior Analyst call ran the
  persona, its tool list, the vLLM shim (Nemotron on the Jetson) and memory
  injection. It also **refused an unauthorized tool** (`lazy_web_search`), which
  shows tool enforcement is live.
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
  against the old logger and green against the fix. **Not deployed yet:**
  deploy when no trading cycle is running, because a restart breaks in-flight
  cycles that route tools and models through this service.
- **Baseline worth beating:** prism's own success rate on the last 300 trading
  agent calls was 197/300.

## Plan and status

1. [x] Agent registry reachable from our harness (shared `prism.custom_agents`).
2. [x] Native `/agent` runs a real trading agent with tool enforcement.
3. [x] Harness log rows match prism's shape (`createdAt`) — landed, deploy pending.
4. [ ] **Faithful parity script** in trading-service: call trading's own
   `call_prism_agent` (it builds the system prompt, tool list and
   `autoApprove`) twice per agent, with `prism_client.url` pointed first at
   `…:5591/prism-proxy` and then at `…:5591`. Compare success, latency, tool
   sequence and structured-output validity.
5. [ ] Fix every parity gap found. Known risks: prism force-adds core tools; the
   thinking flags; the `emit_structured_output` wrapper; the 3-strike repeat
   abort; the 4096-token output floor.
6. [ ] Flip trading's harness URL (`PRISM_URL`) with a per-agent flag, default off.
   Then one agent → all agents → desk chat → embeddings, watching real cycles.
7. [ ] Move the other repos the same way, one at a time: trading-client,
   lazycat-sdk, html-notes, music-player, SmartGardenDashBoard,
   LLMSortObsidian, office-client, scraper-service, youtube-wallgarden,
   vault-service config.
8. [ ] Stop forwarding our own traffic through `/prism-proxy`. Keep this
   service's prism registration for Rod's projects that still use prism.
