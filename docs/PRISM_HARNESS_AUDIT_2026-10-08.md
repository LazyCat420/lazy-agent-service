# Prism harness audit → adoption plan for lazy-agent-service (2026-10-08)

Read-only audit of `prism-service` (Rodrigo's repo, not modified) against our fork's harness in
`src/platform/` + `src/services/AgenticLoopService.ts`. Evidence: code-level audits of
`AgenticLoopService.ts`, `tool-orchestrator/ToolOrchestratorService.ts`, `orchestrator/`,
`system-prompt/`, `providers/ModelProfiles.ts`, `MemoryService.ts`, plus docs
(`harness_modernization_2026-09.md`, `harness_next_2026-09.md`, `goals.md`, `hooks.md`).

## What prism's harness has that ours lacks

| # | Prism feature | Ours today | Value for us |
|---|---|---|---|
| 1 | **Tool-result offloading** — large results stored, model gets leading lines + `retrieve_offloaded_content` pointer | `compactToolResultsForPressure` caps at 50k chars, hard truncation | Trading/news payloads are the norm; truncation loses identity fields (see PRISM_2026-09-27 §2) |
| 2 | **Approval gates + taint checks + `unattended` runs** — ApprovalRegistry, arg-taint minimum (24 chars), immediate denial for unattended runs | No approval infrastructure at all | Unattended trading runs would hang on asks; explicit deny-beats-hang semantics |
| 3 | **ModelProfiles + lightweight budget** — per-model sampling/tool budgets, ≤14B models get ≤12 tools, no sub-agent tools, stripped system prompt | Static catalog in config, everything assumes 128k, no output clamp | Our nemotron/small-model passes would waste less context and fail less on oversized catalogs |
| 4 | **Goals system with independent verifier gate** (docs/goals.md) | VerificationContract exists but no persistent per-conversation goals with budget/pause | Trading cycles already have goals; aligns harness with that |
| 5 | **Hooks framework** (docs/hooks.md) — PreToolUse→rules→mode→ask layering, http/prompt/mcp_tool/command handlers | Ad-hoc guards only | Lets us move the prism-proxy guardrails into the harness instead of rewriting messages |
| 6 | **Turn input mailbox + non-blocking questions + parent-continues-after-delegation** (harness_next) | Blocking delegation | Junior analysts idle 30 min waiting on parent turns — this is the direct fix |
| 7 | **Event sequence ids + cursor replay** | SSE events without replayable cursor | Dashboards/resume |
| 8 | **Coordinator: parallel workers in isolated git worktrees** | Absent | Only relevant if we host coding agents; defer |
| 9 | **Benchmarks with confidence intervals** | Only throwaway bench scripts | Low priority; replay manifests partly cover |

## What we already have that prism doesn't

Keep and don't regress: 4-layer context assembly with budget receipts + hashes, LifecycleMemory
(OBSERVED→VERIFIED→ACTIVE→REJECTED provenance), deterministic verifiers + replay manifests,
contract-versioned run/profile JSON (`contracts/*-v1.2.json`). Prism has none of these as formal
contracts — this is our differentiator, cite it in any future port.

## Plan (ordered, each independently landable in its own `wt-` worktree)

1. **Offload store + `retrieve_offloaded_content`** (highest ROI)
   - New `src/platform/offload/`: offload tool results > 7,600 chars (prism-compatible cap so the
     proxy's measurements match), keep leading whole lines/shortened lists, expose
     `retrieve_offloaded_content` as a first-class tool for all personas.
   - Acceptance: replay of the 2026-09-28 finnhub-news/whiteboard cases keeps identity fields and
     stays under cap; no `finish_reason`-less streams.
2. **Unattended-run semantics** — `unattended: true` plumbing: any approval ask becomes an
   immediate denial surfaced as a tool result. Small, self-contained; prevents 30-minute hangs.
3. **ModelProfiles port** — port `ModelProfiles.ts` + lightweight budget into
   `src/platform/models/`; wire context-window discovery from `/v1/models` for vLLM/SGLang so the
   128k assumption dies. This is also prereq for final-turn correctness on small models.
4. **Turn input mailbox / non-blocking questions** — port the harness_next pattern; unblocks the
   junior-analyst idle pattern from the 2026-09-28 audit.
5. **Goals gate** — wrap our VerificationContract behind a persistent conversation-goal object with
   budget + pause, borrowing prism's verifier-gate shape but storing it in our contract format.
6. **Hooks layer** — last; replaces message-rewriting guardrails once 1–3 are stable.

Non-goals: coordinator worktrees, benchmark CI, ACP. Do not rename the MCP registration
(`lazy-tool-service`) for any of this.

## Verification

- Each item: unit tests in `test/` + replay against stored trading turn payloads in
  `trading-service/scripts/benchmarks/turn_wall_replay.py` where applicable.
- Deploy via `deploy.sh` (image `lazy-tool-service`), verify `/health` and one live `/agent` run.
