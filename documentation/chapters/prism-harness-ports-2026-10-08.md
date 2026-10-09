---
part: Features
status: shipped
updated: 2026-10-09
---

# Prism harness ports (2026-10-08)

Landed `8e4a7a8..2660324` on `main`. Ports five prism-service harness features into
lazy-agent-service. Audit and full rationale: `docs/PRISM_HARNESS_AUDIT_2026-10-08.md`.
Prism itself was not modified (read-only reference).

> **Classified 2026-10-09 (docs review): `shipped`.** The chapter had no front
> matter, so it was invisible to the staleness review. Ruled from **call sites,
> not from this chapter's prose** — all five ports exist *and* are reached from
> the loop: `applyModelProfile`, `TurnMailbox` and `evaluateGoal` are all
> referenced from `src/services/AgenticLoopService.ts`,
> `retrieve_offloaded_content` from `src/services/harnesses/lifecycle/ToolExecutor.ts`,
> `options.unattended` from `src/services/harnesses/lifecycle/ApprovalGate.ts:43`,
> and `context.questionRegistry?.sweepExpired()` from
> `src/services/harnesses/PromptedToolCallingHarness.ts:268`. `2660324` is an
> ancestor of `main` and `docs/PRISM_HARNESS_AUDIT_2026-10-08.md` is present.
> Not `verified`: nothing was confirmed in a running service this pass. The
> deferred items in "Not ported" stay live in `06-prism-feature-parity.md`
> (`in-progress`, `review-by: 2026-10-21`), so this chapter does not need to
> age.
>
> **One thing for whoever next opens ch.06:** its "General capability (P1)"
> list still names **goals, mid-turn input, model profiles, budget pause** as
> outstanding. All four are what this chapter landed — `src/platform/goals/`,
> `src/platform/questions/TurnMailbox`, `src/platform/models/`, and
> `resolveBudgetAction` in `src/platform/approval/UnattendedPolicy.ts`. That
> list has not been ticked off since 2026-10-08.

## 1. Tool-result offloading

`src/platform/offload/` — `OffloadPolicy.apply(result, {toolName, runId})` cuts results over
7,600 chars (prism-compatible budget): whole leading lines kept (text), longest strings then
lists shortened (JSON), identity keys preserved, top-level arrays over 10 items pre-empted
(events/products/trends/articles/earnings/predictions/commodities). The full payload is stored
in `OffloadStore` (content-derived `tr_` ids, LRU 200 entries, `data/offload_store/`) and
retrievable by the model via the new `retrieve_offloaded_content` internal tool (registered
alongside `skill_read`/`take_note`; 24k-char response cap, byte_range support). Applied as a
post-pass in `executeToolBatch` — idempotent, stub-aware.

## 2. Unattended runs

`src/platform/approval/` — `options.unattended: true` makes every approval ask an immediate
denial the model reads as a tool result (no more 30-minute hangs on trading/scheduled runs).
`resolveBudgetAction` mirrors prism's unattended/auto-approve matrix; `ApprovalRegistry`
registers/waiters/retireOrphaned. Wired in `ApprovalGate.checkAndWaitForApproval`.

## 3. Model profiles

`src/platform/models/` — `applyModelProfile(modelName, options, {toolNames, contextWindow})`:
per-family sanitization of rejected sampling params, effort clamping, tool_choice modes, and
the lightweight preset (models declaring <=14B params: max 12 tools incl. discovery, no
sub-agent/async tools, stripped prompt flag, 8192 output clamp). `discoverContextWindow`
probes `/v1/models` + `/model_info` (5s timeout, graceful fallback). Wired after tool
resolution in `runAgenticLoop`.

## 4. Turn-input mailbox + non-blocking questions

`src/platform/questions/` — `TurnMailbox` (per-run FIFO, bounded 50, `formatTurnNotice`
renders one `<turn-input>` block) opened per run in `runAgenticLoop` and drained at each
iteration boundary of `PromptedToolCallingHarness`; inputs surface next turn instead of
blocking. `NonBlockingQuestionRegistry` answers questions via the mailbox with a 10-minute
expiry that synthesizes a "no answer, proceed with best judgment" notice. Access via
`AgenticLoopService.turnMailbox` / `.questionRegistry`. Note: this fork has no blocking
ask_user executor; the registry is ready for tools/routes to adopt.

## 5. Conversation goal gate

`src/platform/goals/` — `GoalStore` (JSON-file `data/goal_store/`, atomic writes,
active/paused/achieved/abandoned + budget) and `evaluateGoal` (verdicts: achieved when
verifiers pass AND criteria keywords met; budget_exhausted → pause; off_track → corrective
directive). Evaluated at the loop exit next to `enforceVerificationContract`; directives are
appended as `<goal-directive>` system messages for the next turn.

## Verification

- `tsc --noEmit` clean; full vitest suite 1,246/1,246 (106 files), incl. 84 new platform tests.
- Worktree `wt-prism-harness` merged `--ff-only`, worktree removed, branch deleted, pushed to
  `origin/main`.

## Not ported (deferred)

Event seq-ids + cursor replay, hooks layer, ProjectInstructionsService, memory
quarantine/corroboration, coordinator worktrees, benchmark CI — see the audit doc.
