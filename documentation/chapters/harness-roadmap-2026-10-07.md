# Harness roadmap — deferred mechanisms (2026-10-07)

Status: wave 1 + wave 2 landed on `main` and battle-tested (`src/services/harnesses/__tests__/HarnessBattle.test.ts`, 6 scenarios). This chapter tracks what was deliberately deferred in `docs/harness-research/README.md` and the design notes for each, so the next session can pick one up without re-deriving context.

## Landed (summary)

- Never-silent tool results (`normalizeEmptyToolContent` on both the engine path and the harness-internal `ToolExecutor` path).
- Strict schema gate with **tighten-not-drop** (`tightenToolSchema`): `additionalProperties: false` is enforced; `required` is intersected with declared properties; the DeepSeek server-strict all-properties-in-`required` rule is intentionally NOT enforced client-side (the real catalog has optional parameters everywhere).
- Stuck detection: OpenHands five patterns via `StuckDetector`, plus the ReAct repetition terminator — which now ends the run with outcome **`stuck`** (was `exhausted`, a real bug caught by battle scenario S1).
- Verification contract, NoteStore/take_note, session lifecycle hooks (pre/postCompact), running summary, code interpreter, subagent delegation, permission modes.

## Battle-test evidence

`HarnessBattle.test.ts` (run with `bunx vitest run src/services/harnesses/__tests__/HarnessBattle.test.ts --exclude "**/.worktrees/**"`):

- S1 endless loop → outcome `stuck` (exposed the exhausted-vs-stuck bug in `ReActHarness.ts`).
- S2 empty tool result → explicit "produced no output" observation in persisted messages.
- S3 registry self-heal → `prompted-xml` resolves after import-cycle miss; repair-then-success completes.
- S4 verification contract injects an evidence-demand turn.
- S5 all 85 tools in the real `tool_schemas.json` survive `tightenToolSchema` (was: 54+ dropped).
- S6 take_note round-trips to markdown on disk.

## Deferred mechanisms (design notes)

### 1. Event-sourced session log with resume
Append every transition (message, tool call, compaction, hook event) to a per-run log (`SessionState` already exists as the in-memory substrate). Resume = rebuild provider messages from the log tail. Cost: serialization discipline; benefit: crash recovery and time-travel debugging. Start with run-level (not turn-level) resume.

### 2. LLM-summarizing condenser
Current compaction collapses old tool results into one-line summaries (`compactToolResultsForPressure`). The Claude Code / Hermes approach summarizes with the model itself at >80% pressure. Requires: a summarization prompt, a budget for summary size, and idempotence (never summarize the summary twice in one run).

### 3. Formal input/output guardrails + tripwires
SWE-agent style regex/AST tripwires on tool args (e.g. `rm -rf`, secrets in Write). Plugs into `AgentHooks.beforeToolCall` — decide/deny already exists; what's missing is the rule *library* and its config surface.

### 4. Handoff-with-history (subagent context passing)
`DelegateTool` currently passes a prompt. Handoff-with-history (Oh My Pi) passes a bounded slice of parent history + notes. Needs NoteStore integration so a delegate reads the parent's run notes.

### 5. Ranked rule providers / TTSR
`RuleLoader` loads static rules. TTSR (term salience) ranks rules against the current prompt; only top-N injected. Requires an offline index and a scoring hook in ContextAssembly.

### 6. Plugin kernel
Registry of `{name, hooks[], tools[]}` bundles loaded from config, with capability declaration. Only worth it after 2-3 more internal consumers exist.

### 7. Trajectory-replay demos
Record (provider chunk stream, executor results) into a fixture; replay in tests through the real harness. `HarnessBattle.test.ts` hand-rolls the chunk dialect (`{type:"toolCall",...}`); a recorder would make future scenario authoring trivial.

## Verification

- `bunx vitest run src/services/harnesses/__tests__/HarnessBattle.test.ts src/services/__tests__/HarnessUpgrades.test.ts` — 23/23.
- `npx tsc --noEmit` — clean.
- Full suite run under `testrun` at landing time (see session handoff).
