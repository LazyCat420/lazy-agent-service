import { calculateTextCost } from "../../../utils/CostCalculator.js";
import { getPricing, TYPES } from "../../../config.js";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES, } from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.js";
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
export function checkCostBudget(state, resolvedModel, maxCostDollars, emit) {
    if (!maxCostDollars || maxCostDollars <= 0)
        return false;
    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
    const currentUsage = { ...state.overallUsage, requests: state.iterations };
    const estimatedCost = calculateTextCost(currentUsage, pricing);
    if (estimatedCost === null)
        return false;
    if (estimatedCost < maxCostDollars)
        return false;
    emit({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: STATUS_MESSAGES.COST_LIMIT_REACHED,
        estimatedCost,
        maxCostDollars,
        iteration: state.iterations,
    });
    logger.warn(`[CostBudgetEnforcer] Cost limit exceeded on iteration ${state.iterations}: ` +
        `$${estimatedCost.toFixed(4)} >= $${maxCostDollars.toFixed(4)} budget. Triggering exhaustion recovery.`);
    return true;
}
//# sourceMappingURL=CostBudgetEnforcer.js.map