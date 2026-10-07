# Harness research plan: OpenHands (All-Hands-AI)

**Source:** [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) (MIT, ~90k stars, very active), [runtime architecture docs](https://docs.openhands.dev/openhands/usage/architecture/runtime), [stuck detector docs](https://docs.openhands.dev/sdk/guides/agent-stuck-detector), [software-agent-sdk](https://github.com/OpenHands/software-agent-sdk).

## What it is

`AgentController` mediates between a policy (Agent) and a sandboxed Runtime. The agent emits typed **Actions**; the runtime returns **Observations**; both append to an **EventStream** — an append-only typed event log that is simultaneously the LLM context source, the persistence layer, and the audit record. `AgentDelegateAction` spawns child agents whose final result arrives as a single observation. A `StuckDetector` watches for loops.

## Mechanisms to extract → detailed plan for lazy-agent-service

1. **Event-sourced session state (the spine).**
   - Build: per-run append-only JSONL event log in `src/platform/` (new `EventLog.ts`): typed events `ToolCallRequested / ToolCallGuarded / ToolObservation / ModelSpan / CompactionApplied / DelegationFinished`. `RunStore`/`RunExecutionEngine` already emit `RunEvent`s — route them into the log instead of ad-hoc persistence. Derive `ReplayManifest` *from* the log; session resume = replay.
   - Acceptance: kill a run mid-way, resume from the log, and the assembled context is byte-identical (same `ContextReceipt` hash) to the pre-kill state.

2. **Stuck detector — port the five named patterns almost 1:1.**
   - Build: `src/platform/verify/StuckDetector.ts` fed from the event log; semantic comparison (tool name + normalized content, ignoring ids/timestamps). Patterns: 4+ repeated action-observation cycles, 3+ action-error cycles, 3+ monologue messages, 6+ alternating ping-pong, repeated context-window errors. On detection: inject an observation naming the pattern and demanding a different approach; second detection → end run with `stuck` status.
   - Acceptance: synthetic event streams for each of the five patterns trip the detector; a legitimate retry sequence does not.

3. **Delegation as an event, not machinery.**
   - Build: `DelegateAction` event type → runs a child `runAgenticLoop` (already exists at `OrchestratorService.ts:1614`) inside the parent's `TraceContext`; child's final message becomes one `DelegationFinished` observation in the parent log. Child gets its own event log + tool allowlist. This is the missing piece behind `traceDelegation`.
   - Acceptance: parent run with two delegate events shows child spans nested in the parent trace, and the parent context contains only the final observations.

4. **Typed action/observation boundary at the sandbox edge.**
   - Build: for host-touching tools (file writes, shell), route through the existing `LocalToolRouter` but require an explicit `SideEffect` classification + `ApprovalGate` for destructive actions (already present) — the OpenHands lesson is the *boundary* (actions cross a REST/service edge; the loop never execs directly). Formalize: `RunExecutionEngine` refuses direct dispatch of `side_effect in {write, destructive}` tools that bypass the guard.
   - Acceptance: a test attempting to register an unclassified write tool fails at boot.

## Do not copy

- The full V0 framework (controller+state+eventstream+runtime+GUI) — take the event log, not the stack.
- Per-agent Python policy classes — one loop + config (our harness registry + profiles already do this).
- Docker-per-conversation by default — overkill for our scoped service tools; keep for hostile workloads only.
