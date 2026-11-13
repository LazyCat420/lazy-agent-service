/**
 * Loop honesty fields (LF-06 / LF-07, slice S-01).
 *
 * A leaf module on purpose: it is imported by both the SSE utilities and the
 * agentic loop service, so it must stay free of runtime dependencies —
 * only the SseEvent type (type-only import) is allowed here.
 */
import type { SseEvent } from "../types/SseTypes.ts";

/** Truth-telling fields the agent loop computes but used to drop on the floor. */
export interface LoopHonestyFields {
  /** "synthetic" = loop-built digest, "partial" = cut-off/incomplete model text. */
  answerSource: "model" | "synthetic" | "partial";
  /** Why the loop finalized; "COMPLETED" when it finished with nothing to report. */
  finalizeReason: string;
  /** Total provider calls made for the run, retries included (>= 1). */
  providerAttempts: number;
  /** Provider calls that were retries, main-turn and final-pass (>= 0). */
  providerRetries: number;
}

/**
 * Map the values the loop already computed (CoreLoopResult) onto response
 * fields. `finalizeReason` passes through unchanged — including any
 * `repeated_tool_call:<name>` value — and becomes "COMPLETED" when the loop
 * never had to finalize. `providerAttempts` is the loop's model-call counter
 * (every provider attempt, retry loops included), floored at 1;
 * `providerRetries` is the loop's retry counter, floored at 0.
 */
export function deriveLoopHonestyFields(result: {
  answerSource?: SseEvent["answerSource"];
  finalizeReason?: string;
  modelCalls?: number;
  providerRetries?: number;
}): LoopHonestyFields {
  return {
    answerSource:
      result.answerSource === "synthetic" || result.answerSource === "partial"
        ? result.answerSource
        : "model",
    finalizeReason: result.finalizeReason ?? "COMPLETED",
    providerAttempts: Math.max(1, Math.trunc(result.modelCalls ?? 1)),
    providerRetries: Math.max(0, Math.trunc(result.providerRetries ?? 0)),
  };
}

/** Decorate the final `done` SSE event with the loop honesty fields; other events pass through. */
export function withLoopHonestyFields<T extends { type: string }>(
  event: T,
  meta: LoopHonestyFields,
): T & LoopHonestyFields {
  return event.type === "done" ? { ...event, ...meta } : (event as T & LoopHonestyFields);
}
