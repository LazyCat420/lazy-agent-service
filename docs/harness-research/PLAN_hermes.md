# Harness research plan: Hermes (Nous Research) function-calling harness

**Source:** [NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling) (MIT; `functioncall.py`, `prompter.py`, `prompt_assets/sys_prompt.yml`), Hermes 3 card + tech report ([arXiv:2408.11857](https://arxiv.org/abs/2408.11857)). Reference implementation, not a product — the value is the format and prompt discipline.

## What it is

ChatML-native tool loop with no server-side tool-calling: tool definitions go in the system prompt inside `<tools>` XML; the model emits `<tool_call>{"name":...,"arguments":...}</tool_call>`; the harness parses, executes, and re-feeds results in a `tool` role. Recursion capped by depth + a 10-iteration prompt cap, with a running-analysis-summary discipline.

## Mechanisms to extract → detailed plan for lazy-agent-service

1. **In-band XML tool-call path for tool-less models.**
   - Build: a `PromptedToolCallingAdapter` in `src/harnesses/` implementing the same `run()` contract as `BaseAgenticHarness`. Assemble the system prompt from YAML-ish blocks (`Role / Objective / Tools / Schema / Instructions`) injected via `ContextAssembly.projectScope`; parse `<tool_call>` with a lenient JSON repair (strip whitespace, retry-parse, on failure re-prompt once with the parse error — the repo's issue #30 failure mode).
   - Acceptance: a mock model emitting valid then malformed XML completes a 3-tool run with one repair; no native tool-call API involved.

2. **Structured `<scratch_pad>` before each call.**
   - Build: add the Goal/Actions/Observation/Reflection + "are the params known yet?" check to the identity prompt layer (`IdentityPrompt` lifecycle stage in `ReActHarness`). Zero loop code; measure hallucinated-argument rate before/after via existing `HarnessInstrumenter` spans.
   - Acceptance: A/B trace comparison shows reduced invalid-argument tool errors on the junior-analyst profile.

3. **One-call-per-turn + running summary.**
   - Build: enforce via prompt rule, and *verify* in the loop: if the model emits multiple calls on a prompted-tool turn, execute the first and return an observation telling it to issue the next. Keep the running-summary instruction in the Finalizer prompt.
   - Acceptance: unit test with a multi-call response; loop stays consistent.

4. **`code_interpreter` escape hatch.**
   - Build: when a prompted-tool model calls `code_interpreter`, route to the existing sandboxed execution path (trading-service synthetic-cycle rules apply: refuse under synthetic cycles unless cycle-scoped). Do NOT exec on host (Hermes' known weakness).
   - Acceptance: refusal observed under a `cycle-guard-*` id.

## Do not copy

- Direct `exec` of model code, no permissions, no output limits — pair every mechanism above with our `ToolCallGuard` pipeline.
- The brittle ElementTree-only parser — wrap with JSON repair + one re-prompt.
