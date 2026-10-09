// ─────────────────────────────────────────────────────────────
//  GoalGate — the independent verifier gate (prism pattern)
//
//  A goal is achieved only when the verifier results pass AND the
//  goal's criteria are met. Pure function, no IO.
// ─────────────────────────────────────────────────────────────

import type { Goal } from "./GoalStore.ts";
import type { VerifierResult } from "../verify/DeterministicVerifiers.ts";

/** Minimal shape of a tool event the gate may inspect. */
export interface GoalToolEvent {
  tool: string;
  success?: boolean;
  observation?: string;
}

export interface GoalGateInput {
  verifierResults: VerifierResult[];
  toolEvents: GoalToolEvent[];
}

export type GoalGateVerdict = "on_track" | "achieved" | "off_track" | "budget_exhausted";

export interface GoalGateOutcome {
  verdict: GoalGateVerdict;
  /** Corrective/stop directive injected into the next turn. */
  directive?: string;
}

/** Case-insensitive substring match against all evidence text available to the gate. */
function criterionMet(criterion: string, input: GoalGateInput): boolean {
  const needle = criterion.toLowerCase();
  const haystacks: string[] = [];
  for (const result of input.verifierResults) {
    haystacks.push(result.verifier_name, result.reason ?? "");
    for (const ref of result.evidence_refs) haystacks.push(ref);
  }
  for (const event of input.toolEvents) {
    haystacks.push(event.tool, event.observation ?? "");
  }
  return haystacks.some((text) => text.toLowerCase().includes(needle));
}

/**
 * Evaluate a goal against verifier results and tool events.
 *
 * Verdict matrix, in precedence order:
 * - `budget_exhausted` — spent >= cap (cap > 0); produces a stop directive.
 * - `achieved` — at least one verifier result, all passed, and every
 *   criterion matched in verifier evidence or tool observations.
 * - `off_track` — verifier results exist but failed, or criteria are
 *   unmatched; produces a corrective directive for the next turn.
 * - `on_track` — nothing to judge yet (no verifier results, no criteria).
 */
export function evaluateGoal(goal: Goal, input: GoalGateInput): GoalGateOutcome {
  if (goal.budget.cap > 0 && goal.budget.spent >= goal.budget.cap) {
    return {
      verdict: "budget_exhausted",
      directive:
        `Budget for goal "${goal.text}" is exhausted ` +
        `(${goal.budget.spent}/${goal.budget.cap}). Stop working on this goal ` +
        `and report what was completed so far.`,
    };
  }

  const allVerifierPassed =
    input.verifierResults.length > 0 && input.verifierResults.every((r) => r.passed);
  const unmet = goal.criteria.filter((c) => !criterionMet(c, input));

  if (allVerifierPassed && unmet.length === 0) {
    return { verdict: "achieved" };
  }

  if (input.verifierResults.length > 0 || goal.criteria.length > 0) {
    const failed = input.verifierResults.filter((r) => !r.passed);
    const parts: string[] = [];
    if (failed.length > 0) {
      parts.push(
        `Verifiers reported failure: ${failed.map((f) => f.verifier_name).join(", ")}.`,
      );
    }
    if (unmet.length > 0) {
      parts.push(`Unmet criteria: ${unmet.join("; ")}.`);
    }
    return {
      verdict: "off_track",
      directive:
        `Goal "${goal.text}" is not yet achieved. ${parts.join(" ")} ` +
        `Address these gaps before claiming the goal is done.`,
    };
  }

  return { verdict: "on_track" };
}
