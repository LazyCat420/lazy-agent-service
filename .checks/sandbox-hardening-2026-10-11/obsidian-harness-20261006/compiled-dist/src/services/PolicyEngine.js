import logger from "../utils/logger.js";
import { getErrorMessage } from "../utils/ErrorHelpers.js";
const WILDCARD = "*";
// ────────────────────────────────────────────────────────────
// Priority ordering weights
// ────────────────────────────────────────────────────────────
const DECISION_PRIORITY = {
    DENY: 0,
    ASK_USER: 1,
    APPROVE: 2,
};
function getPriority(rule) {
    const isWildcard = rule.tool === WILDCARD;
    const base = isWildcard ? 3 : 0; // Wildcard rules are lower priority
    return base + DECISION_PRIORITY[rule.decision];
}
// ────────────────────────────────────────────────────────────
// Builder functions
// ────────────────────────────────────────────────────────────
/** Create an APPROVE policy for a tool. */
export function allow(tool, opts) {
    return {
        tool,
        decision: "APPROVE",
        when: opts?.when,
        name: opts?.name || `allow(${tool})`,
    };
}
/** Create a DENY policy for a tool. */
export function deny(tool, opts) {
    return {
        tool,
        decision: "DENY",
        when: opts?.when,
        name: opts?.name || `deny(${tool})`,
    };
}
/** Create an ASK_USER policy for a tool. */
export function askUser(tool, opts) {
    return {
        tool,
        decision: "ASK_USER",
        when: opts?.when,
        name: opts?.name || `askUser(${tool})`,
    };
}
/** Convenience: allow all tools without any gating. */
export function allowAll() {
    return allow(WILDCARD, { name: "allowAll()" });
}
/** Convenience: deny all tools by default. */
export function denyAll() {
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
    static evaluate(policies, toolName, args) {
        if (!policies || policies.length === 0)
            return null;
        // Sort policies by priority (specific deny first, wildcard allow last)
        const sorted = [...policies].sort((firstRule, secondRule) => getPriority(firstRule) - getPriority(secondRule));
        for (const rule of sorted) {
            // Tool name matching: exact or wildcard
            if (rule.tool !== WILDCARD && rule.tool !== toolName)
                continue;
            // Predicate matching: if `when` is provided, it must return true
            if (rule.when) {
                try {
                    if (!rule.when(args))
                        continue;
                }
                catch (errorObject) {
                    logger.warn(`[PolicyEngine] Predicate for "${rule.name}" threw: ${getErrorMessage(errorObject)}. Skipping rule.`);
                    continue;
                }
            }
            // Match found
            const reason = rule.decision === "DENY"
                ? `Denied by policy: ${rule.name || rule.tool}`
                : rule.decision === "ASK_USER"
                    ? `Requires approval: ${rule.name || rule.tool}`
                    : `Approved by policy: ${rule.name || rule.tool}`;
            logger.info(`[PolicyEngine] ${toolName}(${Object.keys(args).join(",")}) → ${rule.decision} [${rule.name}]`);
            return { decision: rule.decision, matchedPolicy: rule, reason };
        }
        // No policy matched — caller falls through to default behavior
        return null;
    }
    /**
     * Check if a tool call is denied by any policy.
     * Convenience wrapper for quick deny checks.
     */
    static isDenied(policies, toolName, args) {
        const result = PolicyEngine.evaluate(policies, toolName, args);
        return result?.decision === "DENY";
    }
    /**
     * Check if a tool call requires user approval.
     * Returns true for both ASK_USER and unmatched (null) — caller decides
     * what to do with null.
     */
    static requiresApproval(policies, toolName, args) {
        const result = PolicyEngine.evaluate(policies, toolName, args);
        return result?.decision === "ASK_USER";
    }
}
//# sourceMappingURL=PolicyEngine.js.map