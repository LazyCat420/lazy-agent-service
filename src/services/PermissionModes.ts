/**
 * PermissionModes — per-profile permission mode policy, as a pure module so
 * tests can pin the matrix without booting the run engine.
 *
 * Modes (profile `permissionMode`, default "default"):
 *   default     — existing approval flow untouched.
 *   acceptEdits — auto-approve tools classified effect "write", never "destructive".
 *   plan        — block all write/destructive tools with a structured observation
 *                 until `planApproved` is set on the run context.
 *   bypass      — auto-approve everything EXCEPT the hard floor.
 *
 * Hard floor: effect "destructive" always requires the human approval gate in
 * every mode. No mode overrides it.
 */

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

export interface PermissionDecision {
  /** Whether the call may execute without further human action. */
  approved: boolean;
  /** When true, the call must pass through the human approval gate (RunApprovals). */
  requiresApproval: boolean;
  /** Structured denial observation for plan-mode blocks (undefined otherwise). */
  denial?: { error: string; code: string; message: string };
}

export const PLAN_MODE_DENIAL = {
  error: "PLAN_MODE_BLOCKED",
  code: "PLAN_MODE_BLOCKED",
  message: "plan mode: write blocked until an approved plan exists",
};

/**
 * Decide whether a tool with the given effect may run under `mode`.
 * `planApproved` comes from the run context and only matters in plan mode.
 * `approvalSatisfied` means a registered human approval already exists for
 * this specific call (RunApprovals) — the hard floor is met by it.
 */
export function resolvePermission(opts: {
  mode: PermissionMode;
  effect: unknown;
  planApproved?: boolean;
  approvalSatisfied?: boolean;
}): PermissionDecision {
  const { mode, planApproved = false, approvalSatisfied = false } = opts;
  const effect = effectClass(opts.effect);

  // Hard floor: destructive always goes through the human approval gate.
  if (effect === "destructive") {
    return { approved: approvalSatisfied, requiresApproval: true };
  }

  if (mode === "plan") {
    return planApproved
      ? { approved: true, requiresApproval: false }
      : { approved: false, requiresApproval: false, denial: { ...PLAN_MODE_DENIAL } };
  }

  if (mode === "acceptEdits" && effect === "write") {
    return { approved: true, requiresApproval: false };
  }

  if (mode === "bypass") {
    // bypass auto-approves everything except the destructive hard floor above.
    return { approved: true, requiresApproval: false };
  }

  // default: mode adds nothing — the engine's own policy flags
  // (requires_confirmation / destructive) decide, as before this module existed.
  return { approved: approvalSatisfied, requiresApproval: false };
}
