import type { RunState } from "../types/run.ts";

export const VALID_TRANSITIONS: Record<RunState, RunState[]> = {
  admitted: ["running", "cancelled", "failed", "timed_out"],
  waiting_for_approval: ["running", "waiting_for_tool", "failed", "cancelled", "timed_out"],
  running: [
    "waiting_for_approval",
    "waiting_for_tool",
    "waiting_for_worker",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ],
  waiting_for_tool: ["running", "waiting_for_approval", "failed", "cancelled", "timed_out"],
  waiting_for_worker: ["running", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export class RunStateMachine {
  static isValidTransition(from: RunState, to: RunState): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }

  static assertValidTransition(
    runId: string,
    from: RunState,
    to: RunState,
  ): void {
    if (!this.isValidTransition(from, to)) {
      throw new Error(
        `Invalid state transition for run ${runId}: cannot transition from '${from}' to '${to}'`,
      );
    }
  }

  static isTerminal(state: RunState): boolean {
    return ["completed", "failed", "cancelled", "timed_out"].includes(state);
  }
}
