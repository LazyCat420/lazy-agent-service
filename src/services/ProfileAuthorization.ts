/**
 * ProfileAuthorization — how a /v1/runs profile feeds `decideToolCall`.
 *
 * A profile does not decide on its own. Its whitelist becomes the allow-list,
 * its capability and local tool metadata become policy rules, and its
 * permission mode becomes `autoApprove`; `decideToolCall` applies the one
 * precedence (see .agents/AUDIT-tool-authorization-2026-10-16.md), so a
 * profile denial carries the same codes as every other path
 * (PERMISSION_DENIED, POLICY_DENIED, BLOCKED_BY_SAFETY_HOOK, USER_REJECTED,
 * APPROVAL_UNAVAILABLE).
 *
 * Profile rules for a call:
 *   not whitelisted                         → deny (scope)
 *   local tool without local_tool_policy    → DENY  (no registered effect metadata)
 *   plan mode, no approved plan, write or
 *     destructive local tool                → DENY
 *   destructive or requires_confirmation    → ASK_USER
 *   global capability requires_confirmation → ASK_USER
 *   otherwise                               → APPROVE
 *
 * Permission modes (profile `permissionMode`, default "default") only answer
 * asks: acceptEdits auto-approves "write" tools, bypass every non-destructive
 * tool. Destructive is the hard floor: no mode answers it, only a person
 * (RunApprovals).
 */
import { CapabilityRegistry } from "./CapabilityRegistry.ts";
import type { AgentProfile } from "./ProfileRegistry.ts";
import type { PolicyRule } from "./PolicyEngine.ts";
import {
  decideToolCall,
  type ApprovalAnswer,
  type ToolAuthorization,
} from "./ToolAuthorization.ts";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypass";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypass"];

/** Read a permissionMode from a profile-ish object, tolerating absence. */
export function permissionModeOf(profile: unknown): PermissionMode {
  const raw = (profile as { permissionMode?: unknown } | null)?.permissionMode;
  return MODES.includes(raw as PermissionMode) ? (raw as PermissionMode) : "default";
}

/** Normalize the tool taxonomy effect strings to the three classes we gate on. */
export function effectClass(effect: unknown): "read" | "write" | "destructive" {
  const e = String(effect ?? "").toLowerCase();
  if (e === "destructive") return "destructive";
  if (e === "write" || e === "mutating") return "write";
  return "read";
}

export const PLAN_MODE_DENIAL_REASON = "plan mode: write blocked until an approved plan exists";

/** The profile admits this tool name (whitelist, global capabilities, local tools). */
export function profilePermitsTool(profile: AgentProfile, toolName: string): boolean {
  const permitted = [
    ...(profile.tool_policy.whitelist || []),
    ...(profile.allowed_global_capabilities || []).map((capability) => capability.split("@")[0]),
    ...(profile.allowed_local_tools || []).map((tool) => tool.split("@")[0]),
  ];
  return permitted.some((entry) => entry === toolName || entry.split("@")[0] === toolName);
}

export interface ProfileToolCall {
  profile: AgentProfile;
  name: string;
  args: Record<string, unknown>;
  /** An approved plan exists for this run (plan permission mode). */
  planApproved: boolean;
  /** No person can answer here: an ask becomes APPROVAL_UNAVAILABLE. */
  unattended: boolean;
  hookDenial?: string | null;
  answer?: ApprovalAnswer | null;
}

export function decideProfileToolCall(call: ProfileToolCall): ToolAuthorization {
  const { profile, name } = call;
  const mode = permissionModeOf(profile);
  const policies: PolicyRule[] = [];
  let autoApprove = false;

  if (name.startsWith("global.")) {
    const capability = CapabilityRegistry.getCapability(name);
    policies.push(
      capability?.requires_confirmation
        ? { tool: name, decision: "ASK_USER", name: "capability requires confirmation" }
        : { tool: name, decision: "APPROVE", name: "profile capability" },
    );
  } else {
    const localPolicy = profile.local_tool_policy?.[name];
    if (!localPolicy) {
      policies.push({
        tool: name,
        decision: "DENY",
        name: "local tool has no registered effect metadata (local_tool_policy)",
      });
    } else {
      const effect = effectClass(localPolicy.effect);
      if (mode === "plan" && !call.planApproved && effect !== "read") {
        policies.push({ tool: name, decision: "DENY", name: PLAN_MODE_DENIAL_REASON });
      } else if (effect === "destructive" || localPolicy.requires_confirmation) {
        policies.push({
          tool: name,
          decision: "ASK_USER",
          name: effect === "destructive" ? "destructive local tool" : "local tool requires confirmation",
        });
      } else {
        policies.push({ tool: name, decision: "APPROVE", name: "profile local tool policy" });
      }
      autoApprove =
        effect !== "destructive" &&
        (mode === "bypass" || (mode === "acceptEdits" && effect === "write"));
    }
  }

  return decideToolCall({
    name,
    args: call.args,
    isAllowListed: profilePermitsTool(profile, name),
    policies,
    autoApprove,
    unattended: call.unattended,
    hookDenial: call.hookDenial ?? null,
    answer: call.answer ?? null,
  });
}
