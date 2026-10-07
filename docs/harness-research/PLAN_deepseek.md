# Harness research plan: DeepSeek (API conventions + `deepseek-harness`)

**Source:** [api-docs.deepseek.com](https://api-docs.deepseek.com/) (function calling, tool calls, `strict` mode), official agent harness [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) ("Everything is a Plugin", TypeScript, MIT, developer preview; built on the Cordis kernel), thinking-mode tool calling (V3.2+).

## What it is

Two layers: (1) API conventions — OpenAI- and Anthropic-compatible endpoints, server-side schema validation in `strict` mode, mid-conversation injection of model-generated tool calls + results; (2) `dsh` — a plugin microkernel where filesystem, bash, subagents, session persistence, compaction, and LSP are all plugins over a typed event taxonomy, with per-session cwd, a plan tool, and permission policies.

## Mechanisms to extract → detailed plan for lazy-agent-service

1. **Strict-schema tool registry.**
   - Build: enforce at `ToolOrchestratorService` schema load: every tool schema must be a strict JSON Schema (all properties required, `additionalProperties: false`, bounded formats). Reject non-conforming schemas at boot with the offending tool name — server-side validation eliminates the parse/repair class of bugs before the model even sees the schema.
   - Acceptance: boot fails with a clear error on a loose schema; a strict schema passes and reaches the wire unchanged.

2. **Mid-conversation tool-call injection (synthetic history).**
   - Build: extend `ContextAssembly` to accept seeded `assistant(tool_calls)` + `tool` message pairs — for session resume and subagent-summary replay. Keep them inside the `evidence` layer so `ContextReceipt` hashing covers provenance.
   - Acceptance: resume test — seed a resumed session with prior tool results and the model continues without re-calling completed tools.

3. **Compaction-pressure + overflow-recovery modules.**
   - Build: two named responsibilities in the loop: (a) `CompactionPressure` — after each tool observation, if assembled context exceeds 60% of budget, compact tool results older than N turns to summaries (full results for recent turns: the tool-result retention policy); (b) `OverflowRecovery` — on a context-window error from the provider, compact once and retry the turn instead of failing the run.
   - Acceptance: a long synthetic run compacts mid-flight and completes; an injected overflow error recovers in one retry.

4. **`thinking` / `reasoning_effort` passthrough.**
   - Build: carry a per-profile `reasoning_effort` field through `AgenticToolResolver` → provider call instead of stripping reasoning; expose in the profile YAML.
   - Acceptance: a run on a thinking-capable model records the effort setting in the model span.

5. **Typed event taxonomy + plugins (pattern only).**
   - Build: adopt the *shape* — one event bus with typed events, capabilities as modules (see PLAN_openhands.md §1 for the event log; PLAN_oh_my_pi.md §2 for hooks) — without the Cordis kernel dependency.

## Do not copy

- The Cordis kernel wholesale (plugin lifecycle/scopes machinery is a large conceptual dependency for a small service).
- Pinning anything to `dsh` — explicit developer preview, "THERE WILL BE COMPATIBILITY-BREAKING CHANGES".
