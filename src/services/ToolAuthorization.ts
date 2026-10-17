import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import PolicyEngine from "./PolicyEngine.ts";
import type { PolicyRule } from "./PolicyEngine.ts";

/**
 * ToolAuthorization — the one function that decides whether a tool call
 * runs. Every caller (the harness gate, the /chat function-calling loop)
 * asks `decideToolCall`; nothing else may turn a call into "run".
 *
 * Fixed precedence (first match wins, see the audit
 * .agents/AUDIT-tool-authorization-2026-10-16.md):
 *   1. not on the run's allow-list          → deny (scope)
 *   2. a DENY policy matches                → deny (policy)   — never overridable
 *   3. a decide hook denied                 → deny (hook)
 *   4. APPROVE policy / read-only tier      → allow
 *      ASK_USER policy / write+danger tier  → ask
 *   5. an ask only: autoApprove             → allow
 *                   profile-admitted run    → allow (the profile runtime confirms)
 *                   a person's answer       → allow / deny (user)
 *                   unattended run          → deny (unattended)
 *                   otherwise               → ask
 *
 * A deny is terminal: no later input (autoApprove, approve-all, a stored or
 * live "allow") can turn it into a run.
 */

/**
 * Tool approval tiers.
 *
 * Tier 1 (AUTO):    read-only tools, run without asking.
 * Tier 2 (WRITE):   write tools, ask unless autoApprove.
 * Tier 3 (DANGER):  destructive / arbitrary execution, ask unless autoApprove.
 */
export const APPROVAL_TIERS = {
  AUTO: 1,
  WRITE: 2,
  DANGER: 3,
} as const;

export type ApprovalTier = (typeof APPROVAL_TIERS)[keyof typeof APPROVAL_TIERS];

/** Default tier assignments for built-in tools. Unknown tools are WRITE. */
const DEFAULT_TIER_MAP: Record<string, ApprovalTier> = {
  // Tier 1 — read-only
  [TOOL_NAMES.READ_FILE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.LIST_DIRECTORY]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_FILE_CONTENTS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.FIND_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_WEB]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.READ_WEB_PAGE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.READ_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_FILE_INFO]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.DIFF_FILES]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_STATUS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_DIFF]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GIT_LOG]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SUMMARIZE_PROJECT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — task management (agent's own scratchpad, not user files)
  [TOOL_NAMES.CREATE_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.LIST_TASKS]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.UPDATE_TASK]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.GET_SUBAGENT_OUTPUT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.WRITE_TODO]: APPROVAL_TIERS.AUTO,

  // Tier 1 — orchestration
  [TOOL_NAMES.CREATE_SUBAGENT]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEND_SUBAGENT_MESSAGE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.STOP_SUBAGENT]: APPROVAL_TIERS.AUTO,

  // Tier 1 — memory management (non-destructive upsert)
  [TOOL_NAMES.SAVE_MEMORY]: APPROVAL_TIERS.AUTO,

  // Tier 1 — control flow (no side effects)
  // ask_user only asks the user; gating it behind an approval would be circular.
  ask_user: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SLEEP]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.ENTER_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.EXIT_PLAN_MODE]: APPROVAL_TIERS.AUTO,
  [TOOL_NAMES.SEARCH_TOOLS]: APPROVAL_TIERS.AUTO,

  // Tier 2 — scheduling / notebook (creates persistent state)
  [TOOL_NAMES.CREATE_CRON]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.REMOTE_TRIGGER]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.CREATE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.LIST_CRON_JOBS]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.TRIGGER_CRON_JOB]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EDIT_NOTEBOOK]: APPROVAL_TIERS.WRITE,

  // Tier 1 — skill management (read-only discovery)
  [TOOL_NAMES.LIST_SKILLS]: APPROVAL_TIERS.AUTO,

  // Tier 1 — structured output (data formatting only)
  [TOOL_NAMES.EMIT_STRUCTURED_OUTPUT]: APPROVAL_TIERS.AUTO,

  // Tier 2 — skill mutations + execution
  [TOOL_NAMES.CREATE_SKILL]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EXECUTE_SKILL]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_SKILL]: APPROVAL_TIERS.WRITE,

  // Tier 2 — team deletion (stops sub-agents)
  [TOOL_NAMES.DELETE_SUBAGENTS]: APPROVAL_TIERS.WRITE,

  // Tier 2 — worktree isolation (creates/merges git branches)
  [TOOL_NAMES.ENTER_WORKTREE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.EXIT_WORKTREE]: APPROVAL_TIERS.WRITE,

  // Tier 2 — write operations
  [TOOL_NAMES.WRITE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.REPLACE_IN_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.PATCH_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.MOVE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.DELETE_FILE]: APPROVAL_TIERS.WRITE,
  [TOOL_NAMES.CONTROL_BROWSER]: APPROVAL_TIERS.WRITE,

  // Tier 3 — destructive / arbitrary execution
  [TOOL_NAMES.EXECUTE_SHELL]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_PYTHON]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_JAVASCRIPT]: APPROVAL_TIERS.DANGER,
  [TOOL_NAMES.EXECUTE_COMMAND]: APPROVAL_TIERS.DANGER,
};

const TIER_LABELS: Record<ApprovalTier, string> = {
  [APPROVAL_TIERS.AUTO]: "auto",
  [APPROVAL_TIERS.WRITE]: "write",
  [APPROVAL_TIERS.DANGER]: "danger",
};

export function toolTier(toolName: string): ApprovalTier {
  return DEFAULT_TIER_MAP[toolName] ?? APPROVAL_TIERS.WRITE;
}

/** Which rail said no. */
export type DeniedBy = "scope" | "policy" | "hook" | "user" | "unattended";

interface TierInfo {
  tier: ApprovalTier;
  tierLabel: string;
}

export type ToolAuthorization =
  | (TierInfo & { verdict: "allow"; reason: string })
  | (TierInfo & { verdict: "ask"; reason: string })
  | (TierInfo & { verdict: "deny"; deniedBy: DeniedBy; reason: string });

/** A person's answer to an ask — live over the approval route or durable. */
export interface ApprovalAnswer {
  decision: "allow" | "deny";
  /** The person's bounded denial reason, relayed to the model. */
  reason?: string;
}

export interface AuthorizationInput {
  name: string;
  args: Record<string, unknown>;
  /**
   * The call names a tool this run offered: enabledTools / disabledTools,
   * the agent role's catalog, and MCP quarantine (unapproved fingerprints
   * are never offered) are all applied before this flag is computed.
   */
  isAllowListed: boolean;
  policies: readonly PolicyRule[];
  /** Converts an ask into an allow. Never touches a deny. */
  autoApprove: boolean;
  /** No person can answer: an ask becomes a deny instead of waiting. */
  unattended: boolean;
  /**
   * The run's profile runtime confirms asks itself (/v1/runs local tool
   * policy + RunApprovals): an ask passes to it as an allow.
   */
  asksResolvedByProfile?: boolean;
  /** Reason a decide hook (CriticGate, …) gave for denying this call. */
  hookDenial?: string | null;
  /** The answer to this call's ask, once one exists. */
  answer?: ApprovalAnswer | null;
}

export function decideToolCall(input: AuthorizationInput): ToolAuthorization {
  const tier = toolTier(input.name);
  const tierInfo: TierInfo = { tier, tierLabel: TIER_LABELS[tier] };

  if (!input.isAllowListed) {
    return {
      ...tierInfo,
      verdict: "deny",
      deniedBy: "scope",
      reason: `"${input.name}" is not one of the tools this run offers.`,
    };
  }

  const policy = PolicyEngine.evaluate([...input.policies], input.name, input.args);
  if (policy?.decision === "DENY") {
    return { ...tierInfo, verdict: "deny", deniedBy: "policy", reason: policy.reason };
  }

  if (input.hookDenial != null) {
    return { ...tierInfo, verdict: "deny", deniedBy: "hook", reason: input.hookDenial };
  }

  if (policy?.decision === "APPROVE") {
    return { ...tierInfo, verdict: "allow", reason: policy.reason };
  }
  if (policy?.decision !== "ASK_USER" && tier === APPROVAL_TIERS.AUTO) {
    return { ...tierInfo, verdict: "allow", reason: "read_only" };
  }
  const askReason = policy?.decision === "ASK_USER" ? policy.reason : "requires_approval";

  // Everything below answers an ask; a deny never reaches here.
  if (input.autoApprove) return { ...tierInfo, verdict: "allow", reason: "auto_approve" };
  if (input.asksResolvedByProfile) {
    return { ...tierInfo, verdict: "allow", reason: "profile_admission" };
  }
  if (input.answer) {
    return input.answer.decision === "allow"
      ? { ...tierInfo, verdict: "allow", reason: "user_approved" }
      : {
          ...tierInfo,
          verdict: "deny",
          deniedBy: "user",
          reason: input.answer.reason ?? "user_rejected",
        };
  }
  if (input.unattended) {
    return {
      ...tierInfo,
      verdict: "deny",
      deniedBy: "unattended",
      reason: `${askReason}; this run has no person to approve it`,
    };
  }
  return { ...tierInfo, verdict: "ask", reason: askReason };
}

/**
 * The tool result a denied call ends with — the model's one report of the
 * denial. The call never executes.
 *
 * ported from prism-service src/services/harnesses/lifecycle/TurnHooks.ts
 * (buildDeniedToolResult), plus this service's USER_REJECTED and
 * unattended shapes.
 */
export interface DeniedToolResult {
  success: false;
  error: "PERMISSION_DENIED" | "POLICY_DENIED" | "BLOCKED_BY_SAFETY_HOOK" | "USER_REJECTED" | "APPROVAL_UNAVAILABLE";
  message: string;
}

export function deniedToolResult(
  toolName: string,
  denial: Extract<ToolAuthorization, { verdict: "deny" }>,
): DeniedToolResult {
  switch (denial.deniedBy) {
    case "scope":
      return {
        success: false,
        error: "PERMISSION_DENIED",
        message: `The tool "${toolName}" is not whitelisted for your agent role. You must reason using the data in the 'Pre-Collected Data Report' instead of calling unauthorized tools.`,
      };
    case "policy":
      return {
        success: false,
        error: "POLICY_DENIED",
        message: `Tool execution denied by policy: ${denial.reason}`,
      };
    case "hook":
      return {
        success: false,
        error: "BLOCKED_BY_SAFETY_HOOK",
        message: `Tool execution was denied by a safety hook: ${denial.reason}`,
      };
    case "user":
      return {
        success: false,
        error: "USER_REJECTED",
        message:
          denial.reason && denial.reason !== "user_rejected"
            ? `Tool execution was manually rejected by the user. Reason: ${denial.reason}`
            : "Tool execution was manually rejected by the user.",
      };
    case "unattended":
      return {
        success: false,
        error: "APPROVAL_UNAVAILABLE",
        message: `"${toolName}" needs a person's approval and this run has none, so it was not executed. Continue without it.`,
      };
  }
}
