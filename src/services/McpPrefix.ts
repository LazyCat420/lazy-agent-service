/**
 * The MCP namespace this service's tools answer to.
 *
 * **Why this is a module and not a string literal at each call site.** The
 * strip was open-coded in `LocalToolRouter` and `ToolOrchestratorService`
 * separately, so a rename that touched one left the other answering
 * "Unknown tool" for the new spelling — the failure reads as a missing
 * capability, not as a half-finished rename.
 *
 * **Who actually mints the prefix.** Not this service. `/mcp/sse` advertises
 * BARE tool names — re-verified 2026-08-07 against the live server, where
 * `tools/list` returns 86 bare names (`get_market_data`, `whiteboard_write`, …)
 * — and prism prepends `mcp__<registered-server-name>__` from `MCP_SERVER_NAME`
 * in `PrismRegistrationService`. So the emitted spelling follows the PRISM
 * REGISTRATION; changing a constant here changes only what is accepted.
 *
 * (The earlier note here cited `music_player_suggest_artists` as the evidence
 * for "bare". The conclusion is right, the example is not: those schemas were
 * dropped from the catalog on 2026-07-12 in c620151, so that name is absent
 * from `tools/list` — see the dead-branch note in `LocalToolRouter`.)
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

/** Every spelling that must resolve.
 *
 *  All four are required, not just the two current ones. `PlatformRoutes` and
 *  trading-service's `app/services/mcp_prefix.py` both already accepted
 *  `mcp__lazy-tools__` and the bare `mcp_` trailer while this list carried only
 *  two — so a call under either legacy spelling was canonicalised for telemetry
 *  and for the Python bridge, but NOT by `stripMcpPrefix`, which is what
 *  `LocalToolRouter` routes on. The name reached the fall-through branch still
 *  namespaced and came back "Unknown tool": a live spelling that every other
 *  layer understood.
 *
 *  Order matters only in that `mcp_` is a prefix of the other three, so it MUST
 *  stay last; the first match wins and returns. */
export const ACCEPTED_MCP_PREFIXES = [
  CANONICAL_MCP_PREFIX,
  "mcp__lazy-tool-service__",
  "mcp__lazy-tools__",
  "mcp_",
] as const;

/** Strip whichever namespace a caller used. Bare names pass through unchanged,
 *  so this is safe to call on a name that was never namespaced.
 *
 *  Strips exactly once. Stripping in a loop without returning would turn a tool
 *  legitimately named `mcp_*` into a different tool on the second pass. */
export function stripMcpPrefix(toolName: string): string {
  for (const prefix of ACCEPTED_MCP_PREFIXES) {
    if (toolName.startsWith(prefix)) return toolName.slice(prefix.length);
  }
  return toolName;
}
