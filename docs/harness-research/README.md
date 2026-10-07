# Agentic harness research — pattern extraction for lazy-agent-service

Compiled 2026-10-07. Each `PLAN_*.md` documents one harness's mechanisms and a
detailed build plan for this service. Web research verified every URL live.

## Reports

| Harness | Report | Highest-value extraction |
|---|---|---|
| Oh My Pi (omp) | [PLAN_oh_my_pi.md](PLAN_oh_my_pi.md) | Rule/provider layering, hooks, skills, compaction-with-plan, delegation contract |
| Hermes (Nous) | [PLAN_hermes.md](PLAN_hermes.md) | In-band XML tool-calling for tool-less models, scratch_pad discipline |
| SWE-agent | [PLAN_swe_agent.md](PLAN_swe_agent.md) | Lint-guarded edits, windowed file viewer, never-silent observations, ambient state |
| OpenHands | [PLAN_openhands.md](PLAN_openhands.md) | Event-sourced session log, stuck detector, delegation-as-event |
| DeepSeek (dsh) | [PLAN_deepseek.md](PLAN_deepseek.md) | Strict tool schemas, synthetic-history injection, compaction pressure/overflow recovery |
| Claude Code | [PLAN_claude_code.md](PLAN_claude_code.md) | Pre-tool-use hooks, permission modes with hard floors, markdown subagents, memory-vs-skills economics |

## Cross-harness synthesis (recommended spine)

1. **Event log as the backbone** (OpenHands): every action/observation is a typed
   event; context derives from the log; resume = replay; subagents are nested logs.
2. **Strict-schema tools + layered permission pipeline** (DeepSeek + Claude Code
   + SWE-agent): strict JSON Schemas at boot → deny/ask rules → PreToolUse-style
   hook middleware → (optional) sandbox. Lint-guard writes. Always emit an
   observation, even on silence.
3. **Loop breaker** (OpenHands): the five named stuck patterns, semantic compare.
4. **Prompt economics** (Claude Code + omp): always-on memory vs lazy skills;
   path-scoped rules; tiny tool descriptions.
5. **Model flexibility** (Hermes + DeepSeek): native tool-calling AND in-prompt
   XML path; reasoning_effort passthrough; repair-on-parse-failure.

## Where each lands in this service

- `ToolCallGuard` / `RunExecutionEngine.processToolCall` → hooks, strict schemas, write-lint, never-silent.
- `ContextAssembly` / `ContextBudget` → path-scoped rules, synthetic-history seeding, compaction pressure.
- New `src/platform/EventLog.ts` → event-sourced runs, resume, stuck detector.
- New `Delegate` tool + `subagents/` → markdown subagents, description dispatch.
- `OrchestratorService` delegation (`:1614`) → existing seam for the above.

## Suggested order (each independently shippable)

1. Never-silent observations + strict-schema boot validation (small, zero risk).
2. Write-lint guard + path-scoped rules (medium).
3. Event log + resume + stuck detector (core investment).
4. Hooks unifying ToolCallGuard; permission-mode state machine.
5. Skills + memory split; Delegate tool; prompted-tool-calling adapter.
6. Compaction-with-plan; reasoning_effort passthrough.
