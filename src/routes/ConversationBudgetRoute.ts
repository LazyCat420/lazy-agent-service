import express, { type Request, type Response } from "express";
import ConversationBudgetRegistry, {
  type ConversationBudget,
} from "../services/ConversationBudgetRegistry.ts";
import logger from "../utils/logger.ts";

/**
 * /conversations/:id/budget — read or set the cost / token ceiling of a
 * conversation. The running loop re-reads it after every model pass
 * (CostBudgetEnforcer), so a cap set mid-turn stops that turn.
 * ported from prism-service src/routes/ConversationBudgetRoute.ts (that
 * route raises the cap of a budget-paused turn; this service has no pause,
 * so the route reads and sets the ceiling itself).
 *
 * GET              → 200 { conversationId, budget: {maxCostDollars?, maxTotalTokens?} | null }
 * PUT | PATCH      → body { maxCostDollars?: number>0, maxTotalTokens?: integer>0 }
 *                    PUT replaces the budget, PATCH merges into it.
 *                    400 on a non-positive / non-numeric value or an empty body.
 * DELETE           → clears the budget.
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

router.get("/:id/budget", (req: Request, res: Response) => {
  const conversationId = req.params.id as string;
  res.json({ conversationId, budget: ConversationBudgetRegistry.get(conversationId) });
});

function setBudget(merge: boolean) {
  return (req: Request, res: Response) => {
    const conversationId = req.params.id as string;
    const parsed = parseBudget(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const next = merge
      ? { ...(ConversationBudgetRegistry.get(conversationId) ?? {}), ...parsed }
      : parsed;
    const budget = ConversationBudgetRegistry.set(conversationId, next);
    logger.info(`[ConversationBudget] ${conversationId}: ${JSON.stringify(budget)}`);
    res.json({ conversationId, budget });
  };
}
router.put("/:id/budget", setBudget(false));
router.patch("/:id/budget", setBudget(true));

router.delete("/:id/budget", (req: Request, res: Response) => {
  const conversationId = req.params.id as string;
  ConversationBudgetRegistry.clear(conversationId);
  res.json({ conversationId, budget: null });
});

export default router;
