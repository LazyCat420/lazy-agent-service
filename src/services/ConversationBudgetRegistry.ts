/**
 * ConversationBudgetRegistry — per-conversation cost / token ceilings set
 * over HTTP (PUT /conversations/:id/budget) and read live by
 * CostBudgetEnforcer after every model pass, so a cap set mid-turn applies
 * to that turn. In-memory: a cap does not survive a process restart.
 *
 * Adapted from prism-service ConversationBudgetRoute (which raises the cap
 * of a paused turn); this service has no budget pause, so the cap is a
 * plain ceiling the running loop stops at.
 */

export interface ConversationBudget {
  /** Stop the turn once its estimated cost reaches this many dollars. */
  maxCostDollars?: number;
  /** Stop the turn once input + output tokens reach this count. */
  maxTotalTokens?: number;
}

const budgets = new Map<string, ConversationBudget>();

const ConversationBudgetRegistry = {
  get(conversationId: string | null | undefined): ConversationBudget | null {
    if (!conversationId) return null;
    const budget = budgets.get(conversationId);
    return budget ? { ...budget } : null;
  },

  /** Replace the conversation's budget. An empty budget clears it. */
  set(conversationId: string, budget: ConversationBudget): ConversationBudget | null {
    if (budget.maxCostDollars === undefined && budget.maxTotalTokens === undefined) {
      budgets.delete(conversationId);
      return null;
    }
    budgets.set(conversationId, { ...budget });
    return { ...budget };
  },

  clear(conversationId: string): boolean {
    return budgets.delete(conversationId);
  },

  /** Test isolation. */
  reset(): void {
    budgets.clear();
  },
};

export default ConversationBudgetRegistry;
