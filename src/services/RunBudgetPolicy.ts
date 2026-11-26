import type { CreateRunRequest } from "../types/run.ts";
import type { AgentProfile } from "./ProfileRegistry.ts";

/**
 * The per-call output cap for a run.
 *
 * A profile may declare `model_constraints.max_output_tokens` as a hard
 * per-call ceiling (e.g. 2560 for the trading strategy chat). When it does,
 * the smaller of the profile cap and the client request wins: a legacy client
 * still sending 49152 is capped at 2560, while a client asking for fewer
 * tokens (including 0, which keeps the pre-loop TOKEN_BUDGET_EXHAUSTED guard)
 * keeps its smaller number. Profiles without the field keep the legacy
 * request-first precedence.
 */
export function resolveRunMaxTokens(request: CreateRunRequest, profile: AgentProfile): number {
  const requested =
    request.budget?.max_tokens ?? request.budget?.maxTokens ?? profile.budget_limits.max_tokens;
  const cap = profile.model_constraints?.max_output_tokens;
  return cap === undefined ? requested : Math.min(cap, requested);
}

/**
 * The canonical run budget (the whole run's token pool).
 *
 * Only a funded profile — one that reserves a final-pass window via
 * `budget_limits.final_reserve_ms` — owns its run ceiling: a legacy request
 * still sending `max_tokens: 49152` cannot shrink the funded 196608 run.
 * Every other profile (including trading-junior-analyst-v1, music-player-v1
 * and the html-notes-* profiles) keeps the legacy request-first precedence,
 * even when it declares `model_constraints.max_output_tokens` for the
 * per-call cap.
 */
export function resolveCanonicalRunTokens(request: CreateRunRequest, profile: AgentProfile): number {
  if (profile.budget_limits.final_reserve_ms !== undefined) {
    return profile.budget_limits.max_tokens;
  }
  return request.budget?.max_tokens ?? request.budget?.maxTokens ?? profile.budget_limits.max_tokens;
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
