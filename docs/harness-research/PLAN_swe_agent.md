# Harness research plan: SWE-agent (Princeton NLP)

**Source:** [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) (MIT, active), ACI paper [arXiv:2405.15793](https://arxiv.org/abs/2405.15793), [ACI background doc](https://github.com/SWE-agent/SWE-agent/blob/main/docs/background/aci.md), [config reference](https://swe-agent.com/0.7/config/config/).

## What it is

Agent ↔ containerized shell (`SWEEnv`): every action is one bash line or a special command; the environment returns stdout + a state summary. The entire agent is one YAML config: prompt templates, demonstrations (replayed `.traj` trajectories), command files, a `state_command` (shell snippet emitting JSON state), a parser (`ThoughtActionParser`), and a `history_processor`. Its central finding: **interface design alone moves benchmark scores double digits**.

## Mechanisms to extract → detailed plan for lazy-agent-service

1. **Guarded editing: lint before apply.**
   - Build: in `RunExecutionEngine.processToolCall`, add a `WriteGuard` step for file-mutating tools: after the tool returns, run a syntax check (tree-sitter for ts/py/rs; `tsc --noEmit` for this repo's TS) and if invalid, roll back and return the lint error as the observation with a retry hint. Wire into the existing side-effect classification (write tools only).
   - Acceptance: a test writes invalid TS through the guarded tool; the file is unchanged and the observation carries the lint error.

2. **Purpose-built file viewer/editor, not raw `cat`.**
   - Build: extend the file tools to a 100-line windowed read with `goto/scroll/search` args and line-numbered output; default `read` returns the window, not the file. Context economy via `ContextBudget.evidence` layer.
   - Acceptance: reading a 5k-line file costs ≤ the window budget in the receipt hash.

3. **Succinct search output.**
   - Build: search tools return file paths only (+match count); snippets on explicit request. Resist pretty verbose results — the paper measured richer output hurting performance.
   - Acceptance: search tool output ≤ 1 line per matching file.

4. **Never-silent observations.**
   - Build: in `RunExecutionEngine`, if a tool result's content is empty, substitute `"The tool ran successfully and produced no output."` Cheap, high value — silence is ambiguous to LLMs.
   - Acceptance: unit test on empty-result normalization.

5. **`state_command`-style ambient state.**
   - Build: a `session_state` JSON (cwd, open files, active profile, recent errors) refreshed after each action and injected into the `dynamicTail` layer of `ContextAssembly` — the model sees situational state without spending a tool call. Mirrors our `ContextReceipt` pattern (hash it).
   - Acceptance: state appears in the assembled context and its hash changes when state changes.

6. **Trajectory replay as few-shot demos.**
   - Build: we already have `ReplayManifest`. Add: import a prior run's manifest as a `demonstration` block in the prompt prefix for a profile (trading-service's harness parity replay does exactly this with recorded cycles — reuse that shape).
   - Acceptance: a profile with a demonstration produces the expected tool sequence on a mock model.

## Do not copy

- `DISCUSSION/COMMAND` free-text protocol and one-command-per-turn — tuned to older models; native tool-calling replaces it.
- Single-YAML monolith coupling prompts+parser+commands+history — keep our split (harness classes + profile config).
- `Last5Observations` history truncation — prefer summarization compaction (see OpenHands/DeepSeek plans).
