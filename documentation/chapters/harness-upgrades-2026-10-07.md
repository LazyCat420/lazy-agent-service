# Harness upgrades from the agentic-harness research (2026-10-07)

Source research: [docs/harness-research/](https://github.com/LazyCat420/lazy-agent-service/blob/main/docs/harness-research/README.md) (six harness reports). Implemented in commit `2e9fc09`.

## What changed

| Item | Source harness | Where |
|---|---|---|
| Never-silent tool observations | SWE-agent | `src/services/ToolResult.ts` (`normalizeEmptyToolContent`) |
| Strict-schema tool gate (auto-tighten, drop only unrecoverable) | DeepSeek | `src/services/ToolOrchestratorService.ts` (`tightenToolSchema`, `filterStrictSchemas`) |
| PreToolUse decide-deny hooks + `runStop` event | Claude Code | `src/services/AgentHooks.ts` + `RunExecutionEngine.ts` |
| Permission modes w/ destructive hard floor | Claude Code | `src/services/PermissionModes.ts` (new) |
| Stuck detector (5 loop patterns, warn→end 'stuck') | OpenHands | `src/platform/verify/StuckDetector.ts` (new) |
| Path-scoped rules (`rules/*.md`, `paths:` globs) | omp / Claude Code | `src/platform/rules/RuleLoader.ts` (new) |
| Lazy skills + `skill_read` tool; always-on `memory/*.md` | omp / Claude Code | `src/platform/skills/SkillRegistry.ts` (new), `AgenticLoopService.ts` |
| Compaction pressure (>60% budget) + one-retry overflow recovery | DeepSeek | `AgenticLoopService.ts` (`compactToolResultsForPressure`) |
| `prompted-xml` harness (in-band tool calls, scratch_pad, one repair re-prompt) | Hermes | `src/services/harnesses/PromptedToolCallingHarness.ts` (new) |
| `reasoning_effort` passthrough (profile + runtime_overrides → provider + span) | DeepSeek | `AgenticToolResolver.ts`, `ProfileRegistry.ts`, `run.ts` |
| Markdown subagents + `delegate` tool (nested refused) | Claude Code | `src/services/SubagentRegistry.ts`, `DelegateTool.ts` (new), `subagents/explore.md` |

## Verification

- 96 new vitest tests across 9 files (patterns: parser repair path, permission-mode matrix, stuck-pattern streams, schema tighten vs drop, delegation refusals).
- Full suite: **1075/1075 passed**; `tsc --noEmit` clean.

## How to use

- Add `permissionMode: plan|acceptEdits|bypass` to a profile to change oversight; `destructive` tools always require approval.
- Drop markdown into `rules/`, `skills/`, `memory/`, `subagents/` — all discovered at boot; skills/rules load on demand.
- Set `harness: prompted-xml` (registry id) for models without native tool-calling.
- Set `reasoning_effort` in a profile's `model_constraints` or `runtime_overrides`.
