import express, { type Request, type Response } from "express";
import BudgetPauseRegistry from "../services/BudgetPauseRegistry.ts";
import ConversationBudgetRegistry, {
  type ConversationBudget,
} from "../services/ConversationBudgetRegistry.ts";
import logger from "../utils/logger.ts";

/**
 * /conversations/:id/budget — read or set the cost / token ceiling of a
 * conversation. The running loop re-reads it after every model pass
 * (CostBudgetEnforcer), so a cap set mid-turn stops that turn.
 * ported from prism-service src/routes/ConversationBudgetRoute.ts. A turn
 * that reaches the cap PAUSES (`budget_paused`); PUT / PATCH wakes it and it
 * resumes if the new cap clears the spend (else it stays paused), DELETE ends
 * it. Budgets are persisted in Mongo (ConversationBudgetRegistry).
 *
 * GET              → 200 { conversationId, budget: {maxCostDollars?, maxTotalTokens?} | null }
 * PUT | PATCH      → body { maxCostDollars?: number>0, maxTotalTokens?: integer>0 }
 *                    PUT replaces the budget, PATCH merges into it.
 *                    400 on a non-positive / non-numeric value or an empty body.
 *                    `paused` in the response: a turn was waiting and was woken.
 * DELETE           → clears the budget and ends a paused turn.
 */
const router = express.Router();

function parseBudget(body: unknown): ConversationBudget | { error: string } {
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const budget: ConversationBudget = {};
  if (record.maxCostDollars !== undefined) {
    const value = record.maxCostDollars;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return { error: "maxCostDollars must be a positive number of dollars" };
    }
    budget.maxCostDollars = value;
  }
  if (record.maxTotalTokens !== undefined) {
    const value = record.maxTotalTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      return { error: "maxTotalTokens must be a positive integer" };
    }
    budget.maxTotalTokens = value;
  }
  if (budget.maxCostDollars === undefined && budget.maxTotalTokens === undefined) {
    return { error: "Send maxCostDollars and/or maxTotalTokens" };
  }
  return budget;
}

router.get("/:id/budget", async (req: Request, res: Response) => {
  const conversationId = req.params.id as string;
  res.json({
    conversationId,
    budget: await ConversationBudgetRegistry.get(conversationId),
    paused: BudgetPauseRegistry.isPaused(conversationId),
  });
});

function setBudget(merge: boolean) {
  return async (req: Request, res: Response) => {
    const conversationId = req.params.id as string;
    const parsed = parseBudget(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    try {
      const next = merge
        ? { ...((await ConversationBudgetRegistry.get(conversationId)) ?? {}), ...parsed }
        : parsed;
      const budget = await ConversationBudgetRegistry.set(conversationId, next);
      // Wake a paused turn; it re-checks the stored cap and resumes or pauses again.
      const resumed = BudgetPauseRegistry.raised(conversationId);
      logger.info(`[ConversationBudget] ${conversationId}: ${JSON.stringify(budget)} (woke paused turn: ${resumed})`);
      res.json({ conversationId, budget, resumed });
    } catch (error) {
      logger.error(`[ConversationBudget] ${conversationId}: could not save the budget: ${error instanceof Error ? error.message : String(error)}`);
      res.status(500).json({ error: "Could not save the budget" });
    }
  };
}
router.put("/:id/budget", setBudget(false));
router.patch("/:id/budget", setBudget(true));

router.delete("/:id/budget", async (req: Request, res: Response) => {
  const conversationId = req.params.id as string;
  try {
    await ConversationBudgetRegistry.clear(conversationId);
    const stopped = BudgetPauseRegistry.stop(conversationId);
    res.json({ conversationId, budget: null, stopped });
  } catch (error) {
    logger.error(`[ConversationBudget] ${conversationId}: could not clear the budget: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({ error: "Could not clear the budget" });
  }
});

export default router;
