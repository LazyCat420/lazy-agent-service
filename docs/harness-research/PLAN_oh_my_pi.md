# Harness research plan: Oh My Pi (omp)

**Purpose:** extract the mechanisms that make the omp harness effective and specify how each maps into `lazy-agent-service`. Sources: live omp install docs (`omp://skills.md`, `omp://hooks.md`, `omp://compaction.md`, `omp://rulebook-matching-pipeline.md`, `omp://context-files.md`, `omp://magic-keywords.md`) plus the local Claude-style hook suite (`~/.claude/hooks/`) that complements it.

## 1. Rule / policy layering (highest-value extraction)

**How omp does it:** rules are discovered from 8 ranked providers (native `.omp/` @100, plugins @90, agents @70, cursor/windsurf/cline/github adapters @50-30, builtin defaults @1), deduped by name, then bucketed three ways: TTSR (condition/ast-triggered, injected only when the condition matches the pending tool call), always-apply (full text into system prompt), and rulebook (name+globs+description injected as a `<domain-rules>` index that the model can consult). `rule://<name>` URIs resolve against the active snapshot.

**Why it matters:** the harness can carry hundreds of policies without blowing the prompt, because per-tool-call conditions decide what is actually in context at each dispatch.

**Plan for lazy-agent-service:**
- Add a `RuleProvider` interface (ranked) over: built-in defaults, repo `AGENTS.md`-style files, app-owned contract rules, and per-profile rules (`profiles/`).
- Bucket rules the same way; render TTSR conditions against the pending `ToolCall` in `ToolCallGuard` (already the chokepoint) instead of the prompt.
- Acceptance: a rule scoped to `tool:edit` appears only on edit-tool calls; always-apply rules appear in the prefix layer; unit test with three provider ranks.

## 2. Hooks (pre/post tool interception)

**How omp does it:** TS/JS hook factories in `.omp/hooks/pre/*` register on an event bus; `tool_call` pre-hooks can block, override input, or redact output (last-wins); `session_*` events cover compaction/cancellation. First `block: true` short-circuits.

**Why it matters:** enforcement (secret scans, destructive-command guards, budget checks) becomes data, not forked code.

**Plan:** lazy-agent-service already has `ToolCallGuard` + guards pipeline — add a *user-configurable* hook surface on top: hook = ordered list of modules exporting `async onPreToolCall(ctx)` / `onPostToolCall(ctx)`; first `block` wins; guard order is declared. Keep the existing built-in guards as hooks so there is one mechanism, not two. Acceptance: a hook that denies a named tool in a profile; a hook that rewrites arguments.

## 3. Skills (file-backed capability packs)

**How omp does it:** `skills/<name>/SKILL.md` with name+description frontmatter; three-pass discovery (capability providers, custom dirs, auto-learn); `skill://<name>` resolves files inside the pack; skills are loaded *on match* ("Matching skill → MUST read skill:// first") so tokens are spent only when relevant.

**Plan:** port the layout verbatim — `skills/<name>/SKILL.md` with frontmatter, discovered at boot, *descriptions* (not bodies) in the system prompt, body fetched on demand via an internal `skill://` tool. This fits the existing 4-layer context assembly: skill descriptions live in `projectScope`, bodies load into `dynamicTail`. Acceptance: a skill that is never in context unless a matching request arrives.

## 4. Compaction with an explicit plan

**How omp does it:** six compaction triggers (manual, overflow, incomplete-output, threshold, idle, notes-backed), ordered methods (`remote`, `snapcompact`, `handoff`, `shake`, `soft`), pre-compaction pruning that protects recent tool outputs, and a persisted `CompactionEntry` with `firstKeptEntryId` so history can be replayed. Critically, the compaction prompt *is* a plan: request + rules, landed work, running jobs, owed items.

**Plan:** lazy-agent-service has `ContextBudget` clamping but no summarizing compaction. Add: threshold trigger on the assembled context (e.g. 50% of window), a compaction step that writes a structured plan summary (request/rules, state, running jobs, owed items), persisted next to the run so replay (`ReplayManifest`) still works. Acceptance: a run that crosses the threshold yields a compaction entry and a replayable manifest.

## 5. Verification-as-workflow

**How omp does it:** the system prompt enforces "never yield non-trivial work without deliverable proof" with per-surface proof rules (experiment → run output; UI → visual; bug → reproduction; permanent API → updated tests), and `report_issue`/artifact URIs make evidence addressable.

**Plan:** encode as an always-apply rule + a `VerificationContract` type on the run: before a run finishes, the harness requires the final message to reference at least one evidence URI (artifact, test result, screenshot). Soft-fail with a warning first; hard-fail behind a profile flag. Acceptance: a run ending without evidence is flagged in the trace.

## 6. Background job / delegation contract

**How omp does it:** typed agents (scout/sonic/task/reviewer) with explicit "no validation mid-flight" and "cross-task contracts up front" rules; DAG waves of handles with `wait()` barriers; workpools for streams; auto-delivery of settled jobs; a hub for peer messaging; the "two agents must not build the same thing" overlap board.

**Plan:** lazy-agent-service has `traceDelegation` but no delegation primitive. Add a `Delegate` tool: typed agent names, self-contained task briefs (target/change/acceptance), result artifacts addressable via `agent://<id>`, and a workpool with bounded concurrency. Skip the overlap board initially (single-service scope). Acceptance: a run delegates two independent sub-tasks and barriers on both.

## 7. Context-file shadowing + magic keywords

**How omp does it:** nearest-non-empty `AGENTS.md` wins, `@imports` resolve, injection order is ancestor-first; magic keywords (`ultrathink`, `orchestrate`) inject hidden, user-attributed instructions.

**Plan:** adopt shadowing + imports in context assembly (`projectScope` layer); skip magic keywords for now (surprise factor; revisit with an explicit profile flag).

## What NOT to copy

- The 8-provider rule zoo's adapters for foreign tools (cursor/windsurf/cline) — YAGNI until needed.
- Magic-keyword injection — hidden user-attributed instruction channels are a trust smell.
- `snapcompact` bitmap frames — model-specific and complex; start with structured-summary compaction.

## Order of work

1. RuleProvider + bucketing (touches ToolCallGuard, ContextAssembly).
2. Hook surface unifying ToolCallGuard.
3. Skills layout + on-demand loading.
4. Compaction-with-plan.
5. VerificationContract.
6. Delegate tool + workpool.
