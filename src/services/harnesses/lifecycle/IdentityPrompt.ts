/**
 * Which system prompt a run sends: the caller's own, else the persona's.
 *
 * The beforePrompt hook assembles a persona prompt (identity, tool policy,
 * guidelines) for every agent. A caller that sends its own `systemPrompt` —
 * trading's cycle agents put their whole role prompt there and keep it out of
 * the messages array — must keep it: replacing it ran them as a different
 * agent (found 2026-10-07 while moving trading off prism). Prism keeps the
 * caller's prompt the same way (ReActHarness / branchingCommon,
 * `if (!options.systemPrompt)`); our tree- and graph-of-thought strategies
 * already did. The assembled prompt is still recorded in conversationMeta.
 */
export function applyAssembledSystemPrompt(
  options: { systemPrompt?: string },
  assembledPrompt: string,
): void {
  if (!options.systemPrompt) {
    options.systemPrompt = assembledPrompt;
  }
}
