import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";
import logger from "../utils/logger.ts";

/**
 * ConversationBudgetRegistry — per-conversation cost / token ceilings set
 * over HTTP (PUT /conversations/:id/budget) and read live by
 * CostBudgetEnforcer after every model pass, so a cap set mid-turn applies
 * to that turn. Persisted in Mongo (COLLECTIONS.CONVERSATION_BUDGETS) so a
 * cap survives a process restart; with no Mongo connection it falls back to
 * a process-local map.
 *
 * Adapted from prism-service ConversationBudgetRoute.
 */

export interface ConversationBudget {
  /** Stop the turn once its estimated cost reaches this many dollars. */
  maxCostDollars?: number;
  /** Stop the turn once input + output tokens reach this count. */
  maxTotalTokens?: number;
}

/** Used only while Mongo is not connected. */
const fallback = new Map<string, ConversationBudget>();

/** null while Mongo is not connected (getCollection throws then), so callers
 * use the process-local fallback instead of failing the turn. */
function collection() {
  try {
    return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.CONVERSATION_BUDGETS);
  } catch {
    return null;
  }
}

function isEmpty(budget: ConversationBudget): boolean {
  return budget.maxCostDollars === undefined && budget.maxTotalTokens === undefined;
}

const ConversationBudgetRegistry = {
  async get(conversationId: string | null | undefined): Promise<ConversationBudget | null> {
    if (!conversationId) return null;
    const col = collection();
    if (!col) {
      const budget = fallback.get(conversationId);
      return budget ? { ...budget } : null;
    }
    try {
      const doc = (await col.findOne({ conversationId })) as ConversationBudget | null;
      if (!doc) return null;
      const budget: ConversationBudget = {};
      if (doc.maxCostDollars !== undefined) budget.maxCostDollars = doc.maxCostDollars;
      if (doc.maxTotalTokens !== undefined) budget.maxTotalTokens = doc.maxTotalTokens;
      return isEmpty(budget) ? null : budget;
    } catch (error) {
      logger.warn(
        `[ConversationBudgetRegistry] read failed for ${conversationId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  },

  /** Replace the conversation's budget. An empty budget clears it. */
  async set(conversationId: string, budget: ConversationBudget): Promise<ConversationBudget | null> {
    if (isEmpty(budget)) {
      await ConversationBudgetRegistry.clear(conversationId);
      return null;
    }
    const next: ConversationBudget = {};
    if (budget.maxCostDollars !== undefined) next.maxCostDollars = budget.maxCostDollars;
    if (budget.maxTotalTokens !== undefined) next.maxTotalTokens = budget.maxTotalTokens;
    const col = collection();
    if (!col) {
      fallback.set(conversationId, next);
      return { ...next };
    }
    // Replace, not merge: a PUT that omits a field drops it.
    await col.replaceOne(
      { conversationId },
      { conversationId, ...next, updatedAt: new Date() },
      { upsert: true },
    );
    return { ...next };
  },

  async clear(conversationId: string): Promise<boolean> {
    const col = collection();
    if (!col) return fallback.delete(conversationId);
    const result = await col.deleteOne({ conversationId });
    return result.deletedCount > 0;
  },

  /** Test isolation for the no-Mongo fallback. */
  reset(): void {
    fallback.clear();
  },
};

export default ConversationBudgetRegistry;
