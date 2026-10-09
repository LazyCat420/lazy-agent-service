/**
 * UnattendedPolicy — pure decision helpers for runs with no person present.
 *
 * Ported from prism-service's AgenticLoopService (resolveBudgetAction) and its
 * unattended-run semantics: any approval ask or user question in an
 * unattended run becomes an immediate denial the model reads as a tool
 * result — never a hang (PRISM_2026-09-27_ADAPTATION.md §1).
 */

export type UnattendedOptions = {
  unattended: boolean;
  autoApprove?: boolean;
};

export type Ask = {
  /** Tool being asked about, e.g. "mcp__scrape_url". */
  tool: string;
};

export type BudgetAction = "pause" | "stop";

export type AskDecision = {
  kind: "deny" | "approve" | "defer";
  message: string;
};

/**
 * What a turn does at its cost cap: what the request asked
 * (`onBudgetReached`), else pause — unless the run said nobody will answer
 * an ask (autoApprove: the Discord bot; unattended: scheduled runs and
 * timers). Those stop at the cap, as every turn did before budgets paused.
 */
export function resolveBudgetAction(
  opts: UnattendedOptions,
  config: { onBudgetReached?: "pause" | "stop" } = {},
): BudgetAction {
  if (config.onBudgetReached === "pause" || config.onBudgetReached === "stop") {
    return config.onBudgetReached;
  }
  return opts.autoApprove === true || opts.unattended === true ? "stop" : "pause";
}

/**
 * Decide an approval ask without blocking. Unattended runs never defer:
 * the denial is delivered to the model as the tool result so it can continue
 * without that call.
 */
export function decideApprovalAsk(opts: UnattendedOptions, ask: Ask): AskDecision {
  if (opts.unattended && opts.autoApprove !== true) {
    return {
      kind: "deny",
      message:
        `Unattended run: approval for ${ask.tool} cannot be granted; ` +
        "continue without this call or use an alternative.",
    };
  }
  if (opts.autoApprove === true) {
    return {
      kind: "approve",
      message: `Auto-approved by conversation policy: ${ask.tool}.`,
    };
  }
  return { kind: "defer", message: "" };
}
