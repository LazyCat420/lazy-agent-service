import type { ConversationMessage } from "../../services/harnesses/types.ts";

// ─────────────────────────────────────────────────────────────
//  Verification Contract (omp pattern)
//
//  A run ends successfully only when the final state references at
//  least one evidence item: a non-empty tool observation marked
//  success from a verifier-class tool, OR an explicit `evidence`
//  field set on the run options.
//
//  Soft mode (default): warn + attach `verification: {status:'no-evidence'}`.
//  Strict mode (`requireEvidence: true`): grant ONE extra turn with an
//  injected evidence-demand system prompt, then report `{status:'missing'}`.
// ─────────────────────────────────────────────────────────────

/** A single resolved evidence reference from the final run state. */
export interface EvidenceRef {
  kind: "tool-observation" | "explicit-evidence";
  /** Verifier-class tool name (tool observations only). */
  toolName?: string;
  /** Tool call id, when available. */
  callId?: string | null;
  /** Short excerpt of the observation / explicit evidence. */
  excerpt: string;
}

export type VerificationResult =
  | { status: "verified"; evidence: EvidenceRef[] }
  | { status: "no-evidence"; reason: string; evidence: [] }
  | {
      status: "missing";
      reason: string;
      evidence: [];
      /** True when the strict-mode evidence-demand turn was granted. */
      demandedTurn: boolean;
    };

export interface VerificationRunOptions {
  /** Strict mode: demand one evidence-producing turn before ending. */
  requireEvidence?: boolean;
  /** Explicit evidence supplied by the caller (non-empty string or object). */
  evidence?: unknown;
  [key: string]: unknown;
}

/**
 * Verifier-class tool name pattern: test runners, build/lint/type checks,
 * verification tools, and command executors whose observations can
 * constitute run evidence.
 */
const VERIFIER_TOOL_PATTERN =
  /(^|[^a-z])(test|tests|verify|verification|verifier|lint|check|checks|build|builds|compile|pytest|vitest|jest|tsc|eslint|ruff|mypy|cargo|gradle|maven|validate|assert|diagnos\w*|probe|bash|shell|sh|zsh|exec|execute|command|cmd|terminal|run_command|run_cmd)([^a-z]|$)/i;

/** Whether a tool observation from this tool can count as run evidence. */
export function isVerifierTool(toolName: string): boolean {
  return VERIFIER_TOOL_PATTERN.test(toolName);
}

/** Extract non-empty text from a tool result payload. */
function observationText(result: unknown): string | null {
  if (typeof result === "string") {
    return result.trim().length > 0 ? result : null;
  }
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    if (rec.success !== true) return null;
    const textKeys = ["message", "output", "result", "body", "stdout", "data"];
    let foundKnownTextKey = false;
    for (const key of textKeys) {
      if (!(key in rec)) continue;
      foundKnownTextKey = true;
      const value = rec[key];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    // A recognized text field exists but is blank → empty observation.
    if (foundKnownTextKey) return null;
    // Non-empty structured payload with no text field still counts as an
    // observation, as long as it is marked successful and non-empty.
    if (Object.keys(rec).length > 0) return JSON.stringify(rec);
  }
  return null;
}

/**
 * Collect evidence references from the final message list plus any
 * explicit `evidence` field on the run options.
 */
export function collectEvidence(
  messages: ConversationMessage[],
  options?: VerificationRunOptions | null,
): EvidenceRef[] {
  const refs: EvidenceRef[] = [];

  const explicit = options?.evidence;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    refs.push({ kind: "explicit-evidence", excerpt: explicit.trim() });
  } else if (explicit && typeof explicit === "object") {
    const serialized = JSON.stringify(explicit);
    if (serialized && serialized !== "{}") {
      refs.push({ kind: "explicit-evidence", excerpt: serialized });
    }
  }

  for (const message of messages) {
    if (!message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      if (!isVerifierTool(toolCall.name)) continue;
      const text = observationText(toolCall.result);
      if (text !== null) {
        refs.push({
          kind: "tool-observation",
          toolName: toolCall.name,
          callId: toolCall.id,
          excerpt: text.slice(0, 200),
        });
      }
    }
  }

  return refs;
}

/** System prompt injected for the strict-mode evidence-demand turn. */
export const EVIDENCE_DEMAND_PROMPT = [
  "VERIFICATION REQUIRED — this run is about to end without any recorded evidence.",
  "You have ONE final turn. Run a verifier-class tool (test runner, build, lint, or a command whose non-empty output proves your claim) and ensure at least one successful, non-empty observation is recorded.",
  "If you genuinely cannot produce evidence, state precisely why in this turn — the run will still be recorded as missing evidence.",
].join(" ");

/** Build the injected evidence-demand system message. */
export function buildEvidenceDemandMessage(): ConversationMessage {
  return {
    role: "system",
    content: EVIDENCE_DEMAND_PROMPT,
    _isVerificationInjection: true,
  } as ConversationMessage;
}

export interface VerificationContractInput {
  messages: ConversationMessage[];
  options?: VerificationRunOptions | null;
  /**
   * Strict-mode hook that grants the loop one extra turn. Receives the
   * message list with the evidence-demand system message already appended
   * and returns the post-turn message list. When omitted, the demand
   * message is still injected and the run is reported missing.
   */
  runExtraTurn?: (messages: ConversationMessage[]) => Promise<ConversationMessage[]>;
  /** Soft-mode warning sink (default: no-op). */
  warn?: (message: string) => void;
}

export interface VerificationContractOutcome {
  messages: ConversationMessage[];
  verification: VerificationResult;
}

/**
 * Enforce the verification contract at the loop exit point.
 *
 * - Evidence present → `{status: 'verified'}`.
 * - Soft mode, no evidence → warn + `{status: 'no-evidence'}`.
 * - Strict mode, no evidence → inject one evidence-demand turn
 *   (via `runExtraTurn` when provided), re-check, then
 *   `{status: 'missing'}` if still absent.
 */
export async function enforceVerificationContract(
  input: VerificationContractInput,
): Promise<VerificationContractOutcome> {
  const { messages, options, runExtraTurn, warn } = input;

  const evidence = collectEvidence(messages, options);
  if (evidence.length > 0) {
    return { messages, verification: { status: "verified", evidence } };
  }

  const reason =
    "Run ended without verifier-class tool evidence and no explicit `evidence` option.";

  if (options?.requireEvidence === true) {
    const demandedMessages = [...messages, buildEvidenceDemandMessage()];
    let finalMessages = demandedMessages;
    if (runExtraTurn) {
      try {
        const extra = await runExtraTurn(demandedMessages);
        if (Array.isArray(extra) && extra.length > 0) finalMessages = extra;
      } catch {
        // Extra turn failed — fall through to the missing verdict with
        // the demand message still injected.
      }
    }
    const retryEvidence = collectEvidence(finalMessages, options);
    if (retryEvidence.length > 0) {
      return { messages: finalMessages, verification: { status: "verified", evidence: retryEvidence } };
    }
    return {
      messages: finalMessages,
      verification: {
        status: "missing",
        reason: "Evidence still absent after the strict-mode evidence-demand turn.",
        evidence: [],
        demandedTurn: true,
      },
    };
  }

  warn?.(`[VerificationContract] ${reason} Attaching verification: {status: 'no-evidence'}.`);
  return { messages, verification: { status: "no-evidence", reason, evidence: [] } };
}
