import logger from "../utils/logger.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

/**
 * PolicyEngine — declarative tool call policy system.
 *
 * Inspired by the Antigravity SDK's `hooks/policy.py`. Provides composable
 * policy primitives (allow, deny, askUser) with argument-level conditional
 * predicates, evaluated using priority-based ordering.
 *
 * Evaluation priority (highest → lowest):
 *   1. Specific Deny   (exact tool name, with matching `when` predicate)
 *   2. Specific Ask    (exact tool name)
 *   3. Specific Allow  (exact tool name)
 *   4. Wildcard Deny   (tool = "*")
 *   5. Wildcard Ask    (tool = "*")
 *   6. Wildcard Allow  (tool = "*")
 *
 * Within each priority group, first match wins (short-circuit).
 *
 * If no policy matches, returns `null` to signal the caller should
 * fall through to the tier system in ToolAuthorization.decideToolCall.
 * A predicate that throws fails closed for DENY and ASK_USER rules.
 *
 * Usage:
 *   const policies = [
 *     deny("execute_shell", { when: (args) => /rm\s+-rf/.test(String(args.command)) }),
 *     allow("execute_shell", { when: (args) => /^git\s/.test(String(args.command)) }),
 *     askUser("execute_shell"),
 *   ];
 *   const result = PolicyEngine.evaluate(policies, "execute_shell", { command: "git status" });
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type PolicyDecision = "APPROVE" | "DENY" | "ASK_USER";

export interface PolicyRule {
  /** Tool name this policy targets, or `"*"` for all tools. */
  tool: string;
  /** The outcome when this policy matches. */
  decision: PolicyDecision;
  /**
   * Optional predicate on the tool call's arguments.
   * If provided, the policy only matches when the predicate returns `true`.
   * If omitted, the policy matches any call to the named tool.
   */
  when?: (args: Record<string, unknown>) => boolean;
  /** Human-readable label for logging and deny reasons. */
  name?: string;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  /** The policy rule that matched. */
  matchedPolicy: PolicyRule;
  /** Human-readable reason string. */
  reason: string;
}

const WILDCARD = "*";

// ────────────────────────────────────────────────────────────
// Priority ordering weights
// ────────────────────────────────────────────────────────────

const DECISION_PRIORITY: Record<PolicyDecision, number> = {
  DENY: 0,
  ASK_USER: 1,
  APPROVE: 2,
};

function getPriority(rule: PolicyRule): number {
  const isWildcard = rule.tool === WILDCARD;
  const base = isWildcard ? 3 : 0; // Wildcard rules are lower priority
  return base + DECISION_PRIORITY[rule.decision];
}

// ────────────────────────────────────────────────────────────
// Builder functions
// ────────────────────────────────────────────────────────────

/** Create an APPROVE policy for a tool. */
export function allow(
  tool: string,
  opts?: { when?: (args: Record<string, unknown>) => boolean; name?: string },
): PolicyRule {
  return {
    tool,
    decision: "APPROVE",
    when: opts?.when,
    name: opts?.name || `allow(${tool})`,
  };
}

/** Create a DENY policy for a tool. */
export function deny(
  tool: string,
  opts?: { when?: (args: Record<string, unknown>) => boolean; name?: string },
): PolicyRule {
  return {
    tool,
    decision: "DENY",
    when: opts?.when,
    name: opts?.name || `deny(${tool})`,
  };
}

/** Create an ASK_USER policy for a tool. */
export function askUser(
  tool: string,
  opts?: { when?: (args: Record<string, unknown>) => boolean; name?: string },
): PolicyRule {
  return {
    tool,
    decision: "ASK_USER",
    when: opts?.when,
    name: opts?.name || `askUser(${tool})`,
  };
}

/** Convenience: allow all tools without any gating. */
export function allowAll(): PolicyRule {
  return allow(WILDCARD, { name: "allowAll()" });
}

/** Convenience: deny all tools by default. */
export function denyAll(): PolicyRule {
  return deny(WILDCARD, { name: "denyAll()" });
}

// ────────────────────────────────────────────────────────────
// Evaluation engine
// ────────────────────────────────────────────────────────────

export default class PolicyEngine {
  /**
   * Evaluate a list of policy rules for a given tool call.
   *
   * Returns the matching `PolicyEvaluation` or `null` if no policy matches
   * (caller should fall through to default behavior).
   */
  static evaluate(
    policies: PolicyRule[],
    toolName: string,
    args: Record<string, unknown>,
  ): PolicyEvaluation | null {
    if (!policies || policies.length === 0) return null;

    // Sort policies by priority (specific deny first, wildcard allow last)
    const sorted = [...policies].sort(
      (firstRule, secondRule) =>
        getPriority(firstRule) - getPriority(secondRule),
    );

    for (const rule of sorted) {
      // Tool name matching: exact or wildcard
      if (rule.tool !== WILDCARD && rule.tool !== toolName) continue;

      // Predicate matching: if `when` is provided, it must return true
      if (rule.when) {
        try {
          if (!rule.when(args)) continue;
        } catch (errorObject) {
          // Fail closed: a DENY or ASK_USER rule whose predicate cannot be
          // evaluated still applies (an unreadable argument must not slip a
          // call past a deny). Only an APPROVE rule is skipped.
          const failsClosed = rule.decision !== "APPROVE";
          logger.warn(
            `[PolicyEngine] Predicate for "${rule.name}" threw: ${getErrorMessage(errorObject)}. ${failsClosed ? "Applying" : "Skipping"} rule.`,
          );
          if (!failsClosed) continue;
        }
      }

      // Match found
      const reason =
        rule.decision === "DENY"
          ? `Denied by policy: ${rule.name || rule.tool}`
          : rule.decision === "ASK_USER"
            ? `Requires approval: ${rule.name || rule.tool}`
            : `Approved by policy: ${rule.name || rule.tool}`;

      logger.info(
        `[PolicyEngine] ${toolName}(${Object.keys(args).join(",")}) → ${rule.decision} [${rule.name}]`,
      );

      return { decision: rule.decision, matchedPolicy: rule, reason };
    }

    // No policy matched — caller falls through to default behavior
    return null;
  }

  /**
   * Check if a tool call is denied by any policy.
   * Convenience wrapper for quick deny checks.
   */
  static isDenied(
    policies: PolicyRule[],
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    const result = PolicyEngine.evaluate(policies, toolName, args);
    return result?.decision === "DENY";
  }

  /**
   * Check if a tool call requires user approval.
   * Returns true for both ASK_USER and unmatched (null) — caller decides
   * what to do with null.
   */
  static requiresApproval(
    policies: PolicyRule[],
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    const result = PolicyEngine.evaluate(policies, toolName, args);
    return result?.decision === "ASK_USER";
  }
}
