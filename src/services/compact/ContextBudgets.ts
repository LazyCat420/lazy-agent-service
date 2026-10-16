// ported from prism-service src/services/compact/ContextBudgets.ts
import {
  OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER,
  OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
  MINIMUM_VIABLE_OUTPUT_TOKENS,
} from "../../constants/TokenBudgetDefaults.ts";

// ────────────────────────────────────────────────────────────
// ContextBudgets — the ONE effective-window function
// ────────────────────────────────────────────────────────────
// Every context-size decision in a loop reads its budget from here:
// AutoCompactionTrigger (when to summarize) and ContextWindowManager
// (when lossy truncation is the only way left to fit). Before this
// module the two computed their budgets independently, and for any
// window ≥ 128K the truncation budget sat BELOW the compaction
// threshold — a 200K model with 64K max output truncated at ~107K and
// never reached its 167K compaction threshold, so lossy truncation
// did compaction's job on every long conversation.
//
// Invariant: autoCompactThreshold ≤ truncationBudget, so
// summarization always gets the first chance.
// ────────────────────────────────────────────────────────────

/** Output reserved for a summary when computing the effective window. */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/** Buffer below the effective window at which LLM compaction triggers. */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

export interface ContextBudgets {
  contextWindow: number;
  maxOutputTokens: number;
  /** Window minus the output reserved for a summary. */
  effectiveWindow: number;
  /** Total request input at which LLM compaction triggers. */
  autoCompactThreshold: number;
  /**
   * Total request input above which lossy truncation may run: the largest
   * input the output clamp can still serve with a viable response, never
   * below the compaction threshold.
   */
  truncationBudget: number;
}

export function computeContextBudgets(
  contextWindow: number,
  maxOutputTokens: number,
): ContextBudgets {
  const effectiveWindow =
    contextWindow - Math.min(maxOutputTokens, MAX_OUTPUT_TOKENS_FOR_SUMMARY);
  const autoCompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
  // The output clamp (ContextBudgetTracker) keeps input × (1 + safety) +
  // headroom + output ≤ window; past this input it cannot leave the
  // minimum viable output and the exhaustion guard fires instead.
  const clampableInputLimit = Math.floor(
    (contextWindow -
      OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS -
      MINIMUM_VIABLE_OUTPUT_TOKENS) /
      (1 + OUTPUT_TOKEN_CLAMP_SAFETY_MULTIPLIER),
  );
  const truncationBudget = Math.max(
    Math.min(effectiveWindow, clampableInputLimit),
    autoCompactThreshold,
  );
  return {
    contextWindow,
    maxOutputTokens,
    effectiveWindow,
    autoCompactThreshold,
    truncationBudget,
  };
}

/**
 * The provider-reported size of the last request, paired with the chars/4
 * size of the messages that request carried — so the next estimate can add
 * only what changed since, in the same units the growth is measured in.
 */
export interface ProviderInputBaseline {
  /** Provider-reported input tokens INCLUDING cache reads and writes. */
  inputTokens: number;
  /** chars/4 estimate of the messages sent with that request. */
  messageTokens: number;
}

export interface RequestInputEstimate {
  tokens: number;
  source: "reported" | "estimated";
}

/** Real-to-chars/4 ratios outside this band are treated as measurement noise. */
const MINIMUM_CALIBRATION_RATIO = 0.5;
const MAXIMUM_CALIBRATION_RATIO = 2;

function clampCalibrationRatio(ratio: number): number {
  return Math.min(
    MAXIMUM_CALIBRATION_RATIO,
    Math.max(MINIMUM_CALIBRATION_RATIO, ratio),
  );
}

export interface RequestEstimateInputs {
  /** chars/4 system prompt + tool schema tokens. */
  overheadTokens: number;
  /** The latest model call of this loop (reported input + the messages it carried). */
  baseline?: ProviderInputBaseline | null;
  /**
   * real ÷ chars/4 measured on an earlier turn of the same conversation
   * (its persisted contextBudget) — calibrates the estimate before this
   * turn's first report.
   */
  calibrationRatio?: number | null;
}

/**
 * real ÷ chars/4 for the call behind `baseline` — how far the heuristic is
 * off for THIS conversation's content (dense JSON, PDFs, code, schemas).
 */
function baselineRatio(
  baseline: ProviderInputBaseline,
  overheadTokens: number,
): number {
  const estimated = baseline.messageTokens + overheadTokens;
  return estimated > 0
    ? clampCalibrationRatio(baseline.inputTokens / estimated)
    : 1;
}

function fallbackRatio(calibrationRatio?: number | null): number {
  return typeof calibrationRatio === "number" &&
    Number.isFinite(calibrationRatio) &&
    calibrationRatio > 0
    ? clampCalibrationRatio(calibrationRatio)
    : 1;
}

/**
 * Estimate the input tokens the NEXT request will carry.
 *
 * With a baseline (the previous model call of this loop reported its real
 * input): reported tokens + the chars/4 growth of the message array since,
 * scaled by that same call's real÷estimate ratio. The report already
 * contains the system prompt, tool schemas and cached prefix, counted by
 * the real tokenizer — chars/4 is off by 30% either way depending on the
 * content.
 *
 * Without one (the first call of a turn): chars/4 of the messages plus the
 * system prompt and tool schemas (`overheadTokens`), scaled by the ratio an
 * earlier turn of this conversation measured, when known.
 */
export function estimateRequestInputTokens({
  messageTokens,
  overheadTokens,
  baseline,
  calibrationRatio,
}: RequestEstimateInputs & { messageTokens: number }): RequestInputEstimate {
  if (baseline && baseline.inputTokens > 0) {
    return {
      tokens: Math.max(
        0,
        Math.round(
          baseline.inputTokens +
            (messageTokens - baseline.messageTokens) *
              baselineRatio(baseline, overheadTokens),
        ),
      ),
      source: "reported",
    };
  }
  return {
    tokens: Math.round(
      (messageTokens + overheadTokens) * fallbackRatio(calibrationRatio),
    ),
    source: "estimated",
  };
}

/**
 * The inverse: the largest chars/4 message size whose request estimate
 * stays within `requestBudget`. ContextWindowManager measures only the
 * messages; this puts its budget in the same units as the trigger, so the
 * truncation budget and the compaction threshold cannot cross through a
 * unit mismatch.
 */
export function messageTokenBudget(
  requestBudget: number,
  { overheadTokens, baseline, calibrationRatio }: RequestEstimateInputs,
): number {
  if (baseline && baseline.inputTokens > 0) {
    return Math.floor(
      baseline.messageTokens +
        (requestBudget - baseline.inputTokens) /
          baselineRatio(baseline, overheadTokens),
    );
  }
  return Math.floor(
    requestBudget / fallbackRatio(calibrationRatio) - overheadTokens,
  );
}
