// ─── Token Budget Defaults ──────────────────────────────────
// Single source of truth for every token budget fallback in the
// harness, provider, and context window enforcement layers.
//
// Import from here instead of scattering magic numbers across files.

/** Default max output tokens when no user/model config specifies one. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** Default max input tokens (context window) when no model definition provides one. */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000;

/** Minimum tokens always reserved for model output in context window calculations. */
export const MIN_OUTPUT_RESERVE = 8_192;

/** Token escalation multiplier applied per output truncation recovery attempt. */
export const TOKEN_ESCALATION_MULTIPLIER = 1.5;

/** Maximum number of auto-continuation attempts before giving up on truncation recovery. */
export const MAX_OUTPUT_TRUNCATION_RECOVERIES = 3;

/**
 * Safety margin (in tokens) subtracted when dynamically clamping max_tokens
 * to fit within the model's context window. Accounts for token estimation
 * inaccuracies (the ~4 chars/token heuristic undershoots on code/JSON) and
 * internal provider overhead (chat template tokens, BOS/EOS, tool schema
 * formatting differences between estimated and actual tokenization).
 */
export const OUTPUT_TOKEN_CLAMP_SAFETY_MARGIN = 256;

/**
 * Minimum output tokens to allow after clamping. If the remaining budget
 * after input is below this threshold, the clamp still permits at least
 * this many tokens so the model can produce a meaningful error or
 * partial response rather than silently failing with 0 output.
 */
export const MINIMUM_CLAMPED_OUTPUT_TOKENS = 1_024;

/**
 * Minimum viable output budget for an agentic provider request (ported
 * from prism-service's ContextExhaustionGuard). When context pressure
 * clamps the output budget below this threshold, the model cannot produce
 * a complete tool-call JSON (typically 500–2K tokens) plus reasoning
 * overhead — the request is doomed to mid-tool-call truncation. Instead
 * of sending it, the harness fails fast with a context_exhausted event.
 */
export const MINIMUM_VIABLE_OUTPUT_TOKENS = 4_096;
