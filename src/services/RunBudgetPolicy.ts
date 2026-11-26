import type { CreateRunRequest } from "../types/run.ts";
import type { AgentProfile } from "./ProfileRegistry.ts";

/**
 * The per-call output cap for a run.
 *
 * A profile may declare `model_constraints.max_output_tokens` as a hard
 * per-call ceiling (e.g. 2560 for the trading strategy chat). When it does,
 * it wins over any client-supplied `budget.max_tokens`, because that field is
 * also the canonical run budget — an old client still sending 49152 must not
 * raise the per-call cap above the profile's declared limit. Profiles without
 * the field keep the legacy request-first precedence.
 */
export function resolveRunMaxTokens(request: CreateRunRequest, profile: AgentProfile): number {
  return (
    profile.model_constraints?.max_output_tokens ??
    request.budget?.max_tokens ??
    request.budget?.maxTokens ??
    profile.budget_limits.max_tokens
  );
}

/**
 * How much of the run deadline is held back for the final answer pass.
 *
 * Default (requestedReserveMs = 0) reproduces the legacy
 * `min(90_000, 30% of deadline)`. A profile may request a larger reserve
 * (`budget_limits.final_reserve_ms`), which then takes 60% of the deadline
 * as its ceiling instead of 30%, and is floored at 90s.
 */
export function resolveFinalReserveMs(deadlineMs: number, requestedReserveMs: number): number {
  if (deadlineMs <= 0) return 0;
  const fraction = requestedReserveMs > 0 ? 0.6 : 0.3;
  return Math.min(Math.max(90_000, requestedReserveMs), Math.floor(deadlineMs * fraction));
}
