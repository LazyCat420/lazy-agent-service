/**
 * The MCP namespace this service's tools answer to.
 *
 * **Why this is a module and not a string literal at each call site.** The
 * strip was open-coded in `LocalToolRouter` and `ToolOrchestratorService`
 * separately, so a rename that touched one left the other answering
 * "Unknown tool" for the new spelling — the failure reads as a missing
 * capability, not as a half-finished rename.
 *
 * **Who actually mints the prefix.** Not this service. `/mcp` advertises BARE
 * tool names — verified 2026-08-07, `tools/list` returns
 * `music_player_suggest_artists`, not a namespaced form — and prism prepends
 * `mcp__<registered-server-name>__` from `MCP_SERVER_NAME` in
 * `PrismRegistrationService`. So the emitted spelling follows the PRISM
 * REGISTRATION; changing a constant here changes only what is accepted.
 *
 * That asymmetry is the whole migration strategy: acceptance ships first and
 * costs nothing, so the registration rename can never land ahead of the
 * routing that serves it. ~187 references across 11 repos still use the legacy
 * spelling, and several are persona tool lists already registered in prism's
 * Mongo — a flag-day would strand live agents holding names that resolve to
 * nothing mid-conversation.
 *
 * Deleting the legacy entry is the LAST step, valid only once
 * `grep -r "mcp__lazy-tool-service__" ~/github/projects/sun` is empty.
 *
 * Deliberately dependency-free: it is imported from both sides of the
 * `personas/index -> personas/utils -> ToolOrchestratorService ->
 * AgentPersonaRegistry -> personas/index` cycle, and anything it imported
 * would join that cycle.
 */

/** Emitted by prism today. Kept first so it wins on the longest-match scan. */
export const CANONICAL_MCP_PREFIX = "mcp__lazy-agent-service__";

/** Every spelling that must resolve. Order is irrelevant — they cannot share
 *  a common prefix — but the canonical one leads for readability. */
export const ACCEPTED_MCP_PREFIXES = [
  CANONICAL_MCP_PREFIX,
  "mcp__lazy-tool-service__",
] as const;

/** Strip whichever namespace a caller used. Bare names pass through unchanged,
 *  so this is safe to call on a name that was never namespaced. */
export function stripMcpPrefix(toolName: string): string {
  for (const prefix of ACCEPTED_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}
