import crypto from "node:crypto";
import type { SpanData } from "../contracts/telemetry.ts";

export interface VerifierResult {
  passed: boolean;
  verifier_name: string;
  reason?: string;
  evidence_refs: string[];
}

export class DeterministicVerifiers {
  private static hash(data: unknown): string {
    return crypto
      .createHash("sha256")
      .update(typeof data === "string" ? data : JSON.stringify(data ?? {}))
      .digest("hex");
  }

  /**
   * Verifier 1: Completion Claim Verifier.
   * Requires that an agent's completion claim has at least one matching evidence span in the run.
   */
  static verifyCompletionClaim(claimText: string, recordedSpans: SpanData[]): VerifierResult {
    const isClaimingDone = /completed|done|finished|all tasks pass/i.test(claimText);
    if (!isClaimingDone) {
      return {
        passed: true,
        verifier_name: "completion_claim_verifier",
        evidence_refs: [],
      };
    }

    // Must have at least one successful tool or verifier span
    const evidenceSpans = recordedSpans.filter(
      (s) => (s.kind === "tool_execution" || s.kind === "verifier") && s.status === "OK"
    );

    if (evidenceSpans.length === 0) {
      return {
        passed: false,
        verifier_name: "completion_claim_verifier",
        reason: "Completion claimed but zero successful execution or verification spans recorded in this run.",
        evidence_refs: [],
      };
    }

    return {
      passed: true,
      verifier_name: "completion_claim_verifier",
      evidence_refs: evidenceSpans.map((s) => s.span_id),
    };
  }

  /**
   * Verifier 2: Test Pass Verifier.
   * "Tests passed" claims require a successful test span plus a non-empty result artifact/hash.
   */
  static verifyTestsPassed(agentOutput: string, recordedSpans: SpanData[]): VerifierResult {
    const claimsTestsPassed = /tests?\s+(passed|succeeded|green)/i.test(agentOutput);
    if (!claimsTestsPassed) {
      return {
        passed: true,
        verifier_name: "test_pass_verifier",
        evidence_refs: [],
      };
    }

    const testSpans = recordedSpans.filter(
      (s) =>
        s.kind === "tool_execution" &&
        s.attributes.tool_name &&
        /test|pytest|vitest|jest|run_command/i.test(s.attributes.tool_name) &&
        s.status === "OK" &&
        !!s.attributes.result_hash
    );

    if (testSpans.length === 0) {
      return {
        passed: false,
        verifier_name: "test_pass_verifier",
        reason: "Agent asserted 'tests passed' without a verifiable successful test execution span.",
        evidence_refs: [],
      };
    }

    return {
      passed: true,
      verifier_name: "test_pass_verifier",
      evidence_refs: testSpans.map((s) => s.span_id),
    };
  }

  /**
   * Verifier 3: Mutation Intent / WAL Verifier.
   * Mutating actions require prior recorded intent.
   */
  static verifyMutationIntent(
    mutatingSpan: SpanData,
    registeredIntentIds: Set<string>
  ): VerifierResult {
    if (mutatingSpan.attributes.side_effect !== "MUTATING") {
      return {
        passed: true,
        verifier_name: "mutation_intent_verifier",
        evidence_refs: [mutatingSpan.span_id],
      };
    }

    const intentId = mutatingSpan.attributes.mutation_intent_id;
    if (!intentId || !registeredIntentIds.has(intentId)) {
      return {
        passed: false,
        verifier_name: "mutation_intent_verifier",
        reason: `Mutating action '${mutatingSpan.attributes.tool_name}' executed without prior registered intent/WAL record.`,
        evidence_refs: [mutatingSpan.span_id],
      };
    }

    return {
      passed: true,
      verifier_name: "mutation_intent_verifier",
      evidence_refs: [mutatingSpan.span_id, intentId],
    };
  }

  /**
   * Verifier 4: Tool Repeat Loop Detector.
   * Detects and stops repeated calls with identical tool and arguments.
   */
  static verifyToolRepeatLoop(
    toolName: string,
    args: unknown,
    recentCallHashes: string[],
    maxRepeats: number = 5
  ): VerifierResult {
    const currentHash = this.hash({ toolName, args });
    const identicalCount = recentCallHashes.filter((h) => h === currentHash).length;

    if (identicalCount >= maxRepeats) {
      return {
        passed: false,
        verifier_name: "tool_repeat_loop_detector",
        reason: `Tool '${toolName}' was called ${identicalCount + 1} times with identical arguments, exceeding repeat threshold (${maxRepeats}).`,
        evidence_refs: [currentHash],
      };
    }

    return {
      passed: true,
      verifier_name: "tool_repeat_loop_detector",
      evidence_refs: [currentHash],
    };
  }

  /**
   * Verifier 5: Retry Error Fingerprint Loop Detector.
   * Stops execution if consecutive failures share the same error fingerprint.
   */
  static verifyRetryLoop(
    errorFingerprints: string[],
    maxRepeatedErrors: number = 3
  ): VerifierResult {
    if (errorFingerprints.length < maxRepeatedErrors) {
      return {
        passed: true,
        verifier_name: "retry_loop_detector",
        evidence_refs: errorFingerprints,
      };
    }

    const recent = errorFingerprints.slice(-maxRepeatedErrors);
    const first = recent[0];
    const allSame = recent.every((fp) => fp === first);

    if (allSame && first) {
      return {
        passed: false,
        verifier_name: "retry_loop_detector",
        reason: `Identical failure fingerprint '${first}' occurred ${maxRepeatedErrors} consecutive times without recovery.`,
        evidence_refs: recent,
      };
    }

    return {
      passed: true,
      verifier_name: "retry_loop_detector",
      evidence_refs: recent,
    };
  }

  /**
   * Verifier 6: Budget Stop Verifier.
   * Stops token/cost overrun.
   */
  static verifyBudgetLimit(
    tokensUsed: number,
    costUsd: number,
    limits: { maxTokens?: number; maxCostUsd?: number }
  ): VerifierResult {
    if (limits.maxTokens && tokensUsed > limits.maxTokens) {
      return {
        passed: false,
        verifier_name: "budget_limit_verifier",
        reason: `Token consumption ${tokensUsed} breached allocated budget ${limits.maxTokens}.`,
        evidence_refs: [`tokens:${tokensUsed}`],
      };
    }

    if (limits.maxCostUsd && costUsd > limits.maxCostUsd) {
      return {
        passed: false,
        verifier_name: "budget_limit_verifier",
        reason: `Cost $${costUsd.toFixed(4)} breached allocated budget $${limits.maxCostUsd.toFixed(4)}.`,
        evidence_refs: [`cost:${costUsd}`],
      };
    }

    return {
      passed: true,
      verifier_name: "budget_limit_verifier",
      evidence_refs: [`tokens:${tokensUsed}`, `cost:${costUsd}`],
    };
  }

  /**
   * Verifier 7: Open Child Spans Gate.
   * Prevents false completion while child/delegation spans are still running.
   */
  static verifyNoOpenChildSpans(recordedSpans: SpanData[]): VerifierResult {
    const unclosed = recordedSpans.filter((s) => !s.end_time || s.status === "UNSET");
    if (unclosed.length > 0) {
      return {
        passed: false,
        verifier_name: "open_child_spans_gate",
        reason: `Cannot complete run: ${unclosed.length} child span(s) are still active or unclosed.`,
        evidence_refs: unclosed.map((s) => s.span_id),
      };
    }

    return {
      passed: true,
      verifier_name: "open_child_spans_gate",
      evidence_refs: [],
    };
  }
}
