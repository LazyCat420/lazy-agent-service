import { calculateTextCost } from "../../../utils/CostCalculator.ts";
import { getPricing, TYPES } from "../../../config.ts";
import {
  SERVER_SENT_EVENT_TYPES,
  STATUS_MESSAGES,
} from "@rodrigo-barraza/utilities-library/taxonomy";
import logger from "../../../utils/logger.ts";
import ConversationBudgetRegistry, {
  type ConversationBudget,
} from "../../ConversationBudgetRegistry.ts";
import BudgetPauseRegistry, { BUDGET_PAUSE_TIMEOUT_MS } from "../../BudgetPauseRegistry.ts";

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
 * configured `maxCostDollars` threshold is exceeded (or, for the
 * conversation cap, after a bounded pause nobody raised).
 */

/** How the enforcer waits at the conversation cap. */
export interface CostBudgetPauseOptions {
  /** Abort of the turn: ends a pause. */
  signal?: AbortSignal | null;
  /** Bound on a pause before the turn ends as an exhausted one. Default BUDGET_PAUSE_TIMEOUT_MS. */
  pauseTimeoutMs?: number;
}

interface CapCheck {
  /** The event that ends the turn if nobody raises the cap. */
  exceeded: Record<string, unknown>;
  /** Raising the conversation cap can clear it (the request's own cap is not the binding one). */
  conversationCapped: boolean;
  detail: string;
}

/** Measure the turn against the per-request and conversation caps. */
function measure(
  state: AgenticLoopState,
  resolvedModel: string,
  maxCostDollars: number | undefined,
  conversationBudget: ConversationBudget | null,
): CapCheck | null {
  const maxTotalTokens = conversationBudget?.maxTotalTokens;
  if (maxTotalTokens && maxTotalTokens > 0) {
    const usedTokens =
      (state.overallUsage.inputTokens || 0) + (state.overallUsage.outputTokens || 0);
    if (usedTokens >= maxTotalTokens) {
      return {
        exceeded: {
          type: SERVER_SENT_EVENT_TYPES.STATUS,
          message: STATUS_MESSAGES.COST_LIMIT_REACHED,
          usedTokens,
          maxTotalTokens,
          iteration: state.iterations,
        },
        conversationCapped: true,
        detail: `${usedTokens} >= ${maxTotalTokens} tokens`,
      };
    }
  }

  // The cap set over HTTP for this conversation (ported from prism-service
  // routes/ConversationBudgetRoute.ts) tightens the per-request cap; the
  // lower of the two wins.
  const conversationCap = conversationBudget?.maxCostDollars;
  const caps = [maxCostDollars, conversationCap].filter(
    (cap): cap is number => typeof cap === "number" && cap > 0,
  );
  if (caps.length === 0) return null;
  const effectiveCostCap = Math.min(...caps);

  const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
  const currentUsage = { ...state.overallUsage, requests: state.iterations };
  const estimatedCost = calculateTextCost(currentUsage, pricing);
  if (estimatedCost === null || estimatedCost < effectiveCostCap) return null;

  return {
    exceeded: {
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.COST_LIMIT_REACHED,
      estimatedCost,
      maxCostDollars: effectiveCostCap,
      iteration: state.iterations,
    },
    conversationCapped:
      typeof conversationCap === "number" &&
      conversationCap > 0 &&
      conversationCap === effectiveCostCap,
    detail: `$${estimatedCost.toFixed(4)} >= $${effectiveCostCap.toFixed(4)} budget`,
  };
}

/**
 * Check whether the cumulative session cost / tokens exceed the configured
 * budget. When the conversation's own cap is the one reached, the turn
 * PAUSES (`budget_paused`) and waits for the cap to be raised over
 * PUT/PATCH /conversations/:id/budget; a raise that clears the cap resumes
 * the same turn (`budget_resumed`). DELETE, abort or the pause timeout end
 * it. Pause is ported from prism-service
 * src/services/harnesses/lifecycle/BudgetPauseGate.ts.
 *
 * @returns `true` if the limit has been exceeded and the loop should break
 */
export async function checkCostBudget(
  state: AgenticLoopState,
  resolvedModel: string,
  maxCostDollars: number | undefined,
  emit: EmitFunction,
  conversationId?: string | null,
  pause: CostBudgetPauseOptions = {},
): Promise<boolean> {
  const timeoutMs = pause.pauseTimeoutMs ?? BUDGET_PAUSE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let paused = false;

  for (;;) {
    const conversationBudget = await ConversationBudgetRegistry.get(conversationId);
    const check = measure(state, resolvedModel, maxCostDollars, conversationBudget);
    if (!check) {
      if (paused) {
        emit({ type: "budget_resumed", conversationId, iteration: state.iterations });
      }
      return false;
    }

    const remaining = deadline - Date.now();
    if (!check.conversationCapped || !conversationId || remaining <= 0 || pause.signal?.aborted) {
      return endTurn(check, state, emit, paused);
    }

    if (!paused) {
      paused = true;
      emit({
        ...check.exceeded,
        type: "budget_paused",
        conversationId,
      });
      logger.warn(
        `[CostBudgetEnforcer] ${conversationId} paused on iteration ${state.iterations}: ${check.detail}. Waiting for the cap to be raised.`,
      );
    }
    const outcome = await BudgetPauseRegistry.wait(conversationId, remaining, pause.signal);
    if (outcome !== "raised") return endTurn(check, state, emit, true, outcome);
  }
}

function endTurn(
  check: CapCheck,
  state: AgenticLoopState,
  emit: EmitFunction,
  wasPaused: boolean,
  outcome?: string,
): boolean {
  emit(check.exceeded as Parameters<EmitFunction>[0]);
  logger.warn(
    `[CostBudgetEnforcer] Cost limit exceeded on iteration ${state.iterations}: ${check.detail}` +
      `${wasPaused ? ` (pause ended: ${outcome ?? "timeout"})` : ""}. Triggering exhaustion recovery.`,
  );
  return true;
}
