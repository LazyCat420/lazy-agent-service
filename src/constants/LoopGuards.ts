/**
 * In-loop recovery limits, ported from prism-service constants.ts (HARNESS):
 * how often the loop retries a model pass that produced nothing at all.
 * Measured 2026-10-07: one empty GLM reply ended a V3 replay on our loop;
 * prism retries empty outputs in-loop (ch.06 item 8).
 */

/** Empty-output recovery attempts before the turn ends. */
export const MAX_EMPTY_OUTPUT_RETRIES = 4;

/** Temperature added per empty-output retry (capped at 1.5). */
export const EMPTY_OUTPUT_TEMPERATURE_BUMP = 0.2;

/** prism's tag for its empty-output recovery nudge (SystemMessageTags.EMPTY_OUTPUT). */
export const EMPTY_OUTPUT_TAG = "empty-output-recovery";

/** The tagged nudge pushed before an empty-output retry. */
export function emptyOutputRecoveryNotice(): string {
  return `<${EMPTY_OUTPUT_TAG}>\n\nYour previous response was empty. Please provide output.\n\n</${EMPTY_OUTPUT_TAG}>`;
}
