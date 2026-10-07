/**
 * StuckDetector — OpenHands-style loop/stall detection over the agent's
 * append-only event history.
 *
 * Events are recorded once per observation (tool result or model monologue
 * turn). `detect()` inspects the trailing event runs for five patterns:
 *
 *   (a) action_observation_loop — 4+ repetitions of the same action followed
 *       by an equivalent (semantically identical) observation.
 *   (b) action_error_loop      — 3+ repetitions of the same action that all
 *       end in an error.
 *   (c) monologue_loop         — 3+ consecutive model monologue turns.
 *   (d) alternating_loop       — 6+ events strictly alternating between two
 *       distinct actions (A,B,A,B,A,B).
 *   (e) context_window_error   — 3+ repeated context-window overflow errors.
 *
 * Semantic comparison normalizes content by stripping ids, timestamps and
 * whitespace so that a legitimate retry with a genuinely different result
 * does not trip the detector.
 */

export interface StuckEvent {
  toolName: string;
  normalizedContent: string;
  isError: boolean;
  isModelMonologue: boolean;
}

export type StuckPatternType =
  | "action_observation_loop"
  | "action_error_loop"
  | "monologue_loop"
  | "alternating_loop"
  | "context_window_error";

export interface StuckPattern {
  pattern: StuckPatternType;
  description: string;
  occurrences: number;
}

export const STUCK_THRESHOLDS = {
  ACTION_OBSERVATION_REPEATS: 4,
  ACTION_ERROR_REPEATS: 3,
  MONOLOGUE_MESSAGES: 3,
  ALTERNATING_PAIRS: 6,
  CONTEXT_WINDOW_ERRORS: 3,
} as const;

/** Matches UUIDs, hex ids, numeric ids, and ISO/epoch timestamps. */
const ID_LIKE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{16,}\b|\b\d{10,}\b|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\b\d+(?:\.\d+)?(?:ms|s)\b/g;

const CONTEXT_WINDOW_SIGNATURES = [
  "context_length_exceeded",
  "context length exceeded",
  "context window",
  "maximum context length",
  "max_tokens plus the messages",
  "input length exceeds",
  "prompt is too long",
  "too many input tokens",
  "request too large",
];

/**
 * Normalize free-form content for semantic comparison: strip ids,
 * timestamps and whitespace, lowercase the remainder.
 */
export function normalizeContent(raw: string): string {
  return raw
    .replace(ID_LIKE, "<id>")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function isContextWindowErrorContent(normalized: string): boolean {
  return CONTEXT_WINDOW_SIGNATURES.some((sig) =>
    normalized.includes(normalizeContent(sig)),
  );
}

/** Signature of an action: which tool with which (normalized) arguments. */
function actionKey(event: StuckEvent): string {
  return `${event.toolName}:${event.normalizedContent}`;
}

/**
 * Classify a raw tool result as an error, mirroring the shapes produced by
 * ToolOrchestratorService (`{success:false}`, `{error}`, `{is_error:true}`).
 */
export function isErrorResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  if ("success" in result) return result.success === false;
  if ("is_error" in result) return result.is_error === true;
  if ("error" in result) return Boolean(result.error);
  return false;
}

export class StuckDetector {
  private events: StuckEvent[] = [];
  private consecutiveDetections = 0;

  /** Append an observation event to the history. */
  record(event: StuckEvent): void {
    this.events.push(event);
  }

  /**
   * Inspect the event history for the first matching stuck pattern.
   * Consecutive calls that both detect a pattern increment the streak
   * (used by the harness to escalate from warning to termination);
   * a clean call resets it.
   */
  detect(): StuckPattern | null {
    const pattern = this.computePattern();
    if (pattern) {
      this.consecutiveDetections++;
    } else {
      this.consecutiveDetections = 0;
    }
    return pattern;
  }

  /** How many consecutive detect() calls have returned a pattern. */
  getStreak(): number {
    return this.consecutiveDetections;
  }

  /** All recorded events (for diagnostics). */
  getEvents(): readonly StuckEvent[] {
    return this.events;
  }

  private computePattern(): StuckPattern | null {
    const events = this.events;
    if (events.length === 0) return null;

    // (e) Repeated context-window errors (anywhere in history).
    const ctxErrorCount = events.filter(
      (e) => e.isError && isContextWindowErrorContent(e.normalizedContent),
    ).length;
    if (ctxErrorCount >= STUCK_THRESHOLDS.CONTEXT_WINDOW_ERRORS) {
      return {
        pattern: "context_window_error",
        description: `Repeated context-window errors (${ctxErrorCount} occurrences).`,
        occurrences: ctxErrorCount,
      };
    }

    // (b) Trailing run of the same action ending in errors.
    const errorRun = this.trailingRun(
      (e, first) =>
        !e.isModelMonologue &&
        e.isError === first.isError &&
        actionKey(e) === actionKey(first),
    );
    if (
      errorRun.count >= STUCK_THRESHOLDS.ACTION_ERROR_REPEATS &&
      errorRun.run[0]?.isError
    ) {
      return {
        pattern: "action_error_loop",
        description: `Action '${errorRun.run[0].toolName}' failed identically ${errorRun.count} times.`,
        occurrences: errorRun.count,
      };
    }

    // (a) Trailing run of the same action with successful observations.
    if (errorRun.count >= STUCK_THRESHOLDS.ACTION_OBSERVATION_REPEATS) {
      return {
        pattern: "action_observation_loop",
        description: `Action '${errorRun.run[0].toolName}' repeated ${errorRun.count} times with equivalent observations.`,
        occurrences: errorRun.count,
      };
    }

    // (c) Trailing run of monologue turns.
    const monologueRun = this.trailingRun(
      (e, first) => e.isModelMonologue === first.isModelMonologue,
    );
    if (
      monologueRun.run[0]?.isModelMonologue &&
      monologueRun.count >= STUCK_THRESHOLDS.MONOLOGUE_MESSAGES
    ) {
      return {
        pattern: "monologue_loop",
        description: `Model produced ${monologueRun.count} consecutive monologue turns without acting.`,
        occurrences: monologueRun.count,
      };
    }

    // (d) Trailing alternating pair A,B,A,B,... of at least 6 events.
    const alternating = this.trailingAlternatingRun();
    if (alternating.count >= STUCK_THRESHOLDS.ALTERNATING_PAIRS) {
      return {
        pattern: "alternating_loop",
        description: `Actions '${alternating.a}' and '${alternating.b}' have alternated ${alternating.count} times.`,
        occurrences: alternating.count,
      };
    }

    return null;
  }

  /** Length and members of the maximal trailing run matching the first event. */
  private trailingRun(
    matches: (event: StuckEvent, first: StuckEvent) => boolean,
  ): { count: number; run: StuckEvent[] } {
    const events = this.events;
    const first = events[events.length - 1];
    const run: StuckEvent[] = [first];
    for (let i = events.length - 2; i >= 0; i--) {
      if (!matches(events[i], first)) break;
      run.unshift(events[i]);
    }
    return { count: run.length, run };
  }

  /** Maximal trailing run strictly alternating between two distinct actions. */
  private trailingAlternatingRun(): {
    count: number;
    a: string;
    b: string;
  } {
    const events = this.events;
    if (events.length < 2) return { count: 0, a: "", b: "" };
    const a = actionKey(events[events.length - 1]);
    const b = actionKey(events[events.length - 2]);
    if (a === b) return { count: 0, a: "", b: "" };
    let count = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const key = actionKey(events[i]);
      const expected = (events.length - 1 - i) % 2 === 0 ? a : b;
      if (key !== expected) break;
      count++;
    }
    return { count, a, b };
  }
}
