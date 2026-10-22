/**
 * BudgetPauseRegistry — turns paused at their conversation cost / token cap.
 *
 * A turn that reaches the cap does not end at once: CostBudgetEnforcer parks
 * it here, emits `budget_paused`, and waits for the cap to be raised
 * (PUT/PATCH /conversations/:id/budget → `raised`), the budget to be
 * deleted (`stopped`), the turn to be aborted (`stopped`), or the timeout
 * (`timeout`). Only a turn running in this process can be woken; a pause does
 * not survive a restart (the cap itself does — ConversationBudgetRegistry).
 *
 * ported from prism-service src/services/BudgetPauseRegistry.ts (simplified:
 * in-memory, one pause per conversation, bounded timeout instead of none).
 */
export type BudgetPauseOutcome = "raised" | "stopped" | "timeout";

/** Default bound on how long a turn waits for a raise before it ends. */
export const BUDGET_PAUSE_TIMEOUT_MS = 30 * 60_000;

interface Waiter {
  settle: (outcome: BudgetPauseOutcome) => void;
}

const waiters = new Map<string, Waiter>();

const BudgetPauseRegistry = {
  /** Park a turn on its conversation until a raise, a stop, an abort or the timeout. */
  wait(
    conversationId: string,
    timeoutMs: number,
    signal?: AbortSignal | null,
  ): Promise<BudgetPauseOutcome> {
    return new Promise<BudgetPauseOutcome>((resolve) => {
      // One pause per conversation: a stale waiter is over.
      waiters.get(conversationId)?.settle("stopped");
      const onAbort = () => settle("stopped");
      const settle = (outcome: BudgetPauseOutcome) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (waiters.get(conversationId) === waiter) waiters.delete(conversationId);
        resolve(outcome);
      };
      const waiter: Waiter = { settle };
      waiters.set(conversationId, waiter);
      const timer = setTimeout(() => settle("timeout"), timeoutMs);
      if (signal?.aborted) settle("stopped");
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  },

  isPaused(conversationId: string): boolean {
    return waiters.has(conversationId);
  },

  /** The cap changed: wake the paused turn (it re-checks the new cap). */
  raised(conversationId: string): boolean {
    const waiter = waiters.get(conversationId);
    waiter?.settle("raised");
    return !!waiter;
  },

  /** The budget was deleted: the paused turn ends. */
  stop(conversationId: string): boolean {
    const waiter = waiters.get(conversationId);
    waiter?.settle("stopped");
    return !!waiter;
  },
};

export default BudgetPauseRegistry;
