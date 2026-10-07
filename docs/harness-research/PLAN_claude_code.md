# Harness research plan: Claude Code (Anthropic)

**Source:** public docs (verified): [hooks](https://code.claude.com/docs/en/hooks), [subagents](https://code.claude.com/docs/en/sub-agents), [skills](https://code.claude.com/docs/en/skills), [permission modes](https://code.claude.com/docs/en/permission-modes), [memory](https://code.claude.com/docs/en/memory). Closed source; docs are the spec.

## What it is

One agentic loop per session around a lifecycle hook system, a permission-mode state machine (default / acceptEdits / plan / auto / dontAsk / bypassPermissions) with never-auto-approve floors, markdown-defined subagents (own context, allowlist, permission mode), lazy-loaded SKILL.md skills, and layered CLAUDE.md memory with path-scoped rules.

## Mechanisms to extract → detailed plan for lazy-agent-service

1. **Pre-tool-use hooks that can block (the best safety seam).**
   - Build: `HookMiddleware` in `src/services/`: async `onPreToolCall(ctx) → {decision: "allow"|"deny"|"ask", reason}`; no decision → normal `ToolCallGuard` flow (same fall-through contract as Claude Code). Start with exactly three events: `PreToolUse`, `PostToolUse`, `RunStop`; add more only when a consumer appears (their 40-event sprawl is a product artifact).
   - Acceptance: a hook denying a named tool returns a structured denial observation; a hook that returns nothing leaves the guard flow untouched.

2. **Permission modes with hard floors.**
   - Build: per-profile `permissionMode: default|acceptEdits|plan|bypass` state machine wrapping `RunApprovals`/`ApprovalGate` (both exist). Floors that no mode auto-approves: destructive file ops outside the run scope and anything the `SideEffect` classifier marks `destructive`. `plan` mode: all writes blocked until an approved plan artifact exists.
   - Acceptance: matrix test — each mode × (read, write, destructive) tool; `destructive` never auto-runs in any mode.

3. **Subagents as markdown + frontmatter, description-dispatched.**
   - Build: `subagents/<name>.md` with frontmatter (name/description/tools/model/permissionMode); descriptions (small) in the system prompt; a `Delegate` tool dispatches by description match; the subagent runs `runAgenticLoop` with its own allowlist and its final message returns as one observation. Warn when total description size > 15k chars.
   - Acceptance: two subagents with disjoint tool lists; each receives only its list; parent context holds only final observations.

4. **Two-tier prompt economics: memory vs skills.**
   - Build: always-on memory (profile `memory/` files, loaded every run into `projectScope`) vs lazy skills (`skills/<name>/SKILL.md`, on-demand — see PLAN_oh_my_pi.md §3). Add path-scoped rules: `rules/*.md` with `paths:` globs load only when a tool call touches matching paths (solves monorepo prompt bloat; maps to the rule provider buckets in PLAN_oh_my_pi.md §1).
   - Acceptance: a path-scoped rule appears in context only for matching-file tool calls; memory files appear always.

5. **`@path` import approval (prompt-injection defense).**
   - Build: memory imports referencing paths outside the service's workspace require an approval prompt (`RunApprovals`) before inclusion.
   - Acceptance: an out-of-tree `@import` pauses the run with an approval question; denial excludes the file.

## Do not copy

- The mass-market config surface (managed settings, plugins, marketplaces, synced skills).
- ~40 hook event types — three to start.
- Cloud sync machinery.
