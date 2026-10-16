import { calculateTextCost } from "../../../utils/CostCalculator.ts";
import { getPricing, TYPES } from "../../../config.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import ConversationBudgetRegistry from "../../ConversationBudgetRegistry.ts";

import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { EmitFunction } from "../types.ts";

/**
 * CostBudgetEnforcer — per-session cost ceiling for agentic loops.
 *
 * Based on VeRO (ICML 2026) and "Engineering Pitfalls in AI Coding
 * Tools" (arXiv 2603.20847): without a cost ceiling, pathological
 * sessions (reasoning loops, infinite tool retries) can burn through
 * hundreds of dollars before the iteration limit is reached.
 *
 * This module checks the cumulative estimated cost after each iteration
 * and signals the harness to break into exhaustion recovery when the
 * configured `maxCostDollars` threshold is exceeded.
 *
 * Returns `true` when the budget has been exceeded and the loop
 * should terminate.
 */

/**
 * Check whether the cumulative session cost exceeds the configured budget.
 *
 * @returns `true` if the cost limit has been exceeded and the loop should break
 */
export function checkCostBudget(
  state: AgenticLoopState,
  resolvedModel: string,
  maxCostDollars: number | undefined,
  emit: EmitFunction,
  conversationId?: string | null,
): boolean {
  // The cap set over HTTP for this conversation (ported from prism-service
  // routes/ConversationBudgetRoute.ts) tightens the per-request cap; the
  // lower of the two wins.
  const conversationBudget = ConversationBudgetRegistry.get(conversationId);
  const caps = [maxCostDollars, conversationBudget?.maxCostDollars].filter(
    (cap): cap is number => typeof cap === "number" && cap > 0,
  );
  const effectiveCostCap = caps.length > 0 ? Math.min(...caps) : undefined;
  const maxTotalTokens = conversationBudget?.maxTotalTokens;

  if (maxTotalTokens && maxTotalTokens > 0) {
    const usedTokens =
      (state.overallUsage.inputTokens || 0) + (state.overallUsage.outputTokens || 0);
    if (usedTokens >= maxTotalTokens) {
      emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COST_LIMIT_REACHED,
        usedTokens,
        maxTotalTokens,
        iteration: state.iterations,
      });
      logger.warn(
        `[CostBudgetEnforcer] Token limit exceeded on iteration ${state.iterations}: ` +
          `${usedTokens} >= ${maxTotalTokens}. Triggering exhaustion recovery.`,
      );
      return true;
    }
  }

  if (!effectiveCostCap) return false;

  const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
  const currentUsage = { ...state.overallUsage, requests: state.iterations };
  const estimatedCost = calculateTextCost(currentUsage, pricing);

  if (estimatedCost === null) return false;
  if (estimatedCost < effectiveCostCap) return false;

  emit({
    type: SERVER_SENT_EVENT_TYPES.STATUS,
    message: STATUS_MESSAGES.COST_LIMIT_REACHED,
    estimatedCost,
    maxCostDollars: effectiveCostCap,
    iteration: state.iterations,
  });

  logger.warn(
    `[CostBudgetEnforcer] Cost limit exceeded on iteration ${state.iterations}: ` +
      `$${estimatedCost.toFixed(4)} >= $${effectiveCostCap.toFixed(4)} budget. Triggering exhaustion recovery.`,
  );

  return true;
}
