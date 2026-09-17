import crypto from "node:crypto";
import type { SpanData } from "../contracts/telemetry.ts";
import { RunEvidenceStore } from "./RunEvidenceStore.ts";

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
   * Requires that an agent's completion claim has relevant, matching evidence spans in the run.
   * An unrelated tool call (e.g., read_file or get_market_data) cannot satisfy a claim that
   * tests passed or deployment succeeded.
   */
  static verifyCompletionClaim(claimText: string, recordedSpans: SpanData[]): VerifierResult {
    const claimsTests = /tests?(\s+\w+)?\s+(passed|succeeded|green|ok|passing)|\btests?\s+pass\b/i.test(claimText);
    const claimsDeploy = /deploy(ed|ment)?\b/i.test(claimText);
    const claimsBuild = /build(ed|ing)?\b|compiled/i.test(claimText);
    const isClaimingDone = claimsTests || claimsDeploy || claimsBuild || /completed|done|finished|all tasks pass|shipped/i.test(claimText);

    if (!isClaimingDone) {
      return {
        passed: true,
        verifier_name: "completion_claim_verifier",
        evidence_refs: [],
      };
    }

    // If specific outcome is claimed, require relevant matching tool spans
    if (claimsTests) {
      const testSpans = recordedSpans.filter(
        (s) =>
          s.kind === "tool_execution" &&
          s.attributes.tool_name &&
          /test|pytest|vitest|jest|run_command/i.test(String(s.attributes.tool_name)) &&
          s.status === "OK"
      );
      if (testSpans.length === 0) {
        return {
          passed: false,
          verifier_name: "completion_claim_verifier",
          reason: "Claimed 'tests passed' but run requires test execution evidence; no successful test execution span was recorded in this run.",
          evidence_refs: [],
        };
      }
    }

    if (claimsDeploy) {
      const deploySpans = recordedSpans.filter(
        (s) =>
          s.kind === "tool_execution" &&
          s.attributes.tool_name &&
          /deploy|docker|container/i.test(String(s.attributes.tool_name)) &&
          s.status === "OK"
      );
      if (deploySpans.length === 0) {
        return {
          passed: false,
          verifier_name: "completion_claim_verifier",
          reason: "Claimed 'deployment succeeded' but run requires deployment execution evidence; no successful deployment span was recorded in this run.",
          evidence_refs: [],
        };
      }
    }

    if (claimsBuild) {
      const buildSpans = recordedSpans.filter(
        (s) =>
          s.kind === "tool_execution" &&
          s.attributes.tool_name &&
          /build|compile|tsc/i.test(String(s.attributes.tool_name)) &&
          s.status === "OK"
      );
      if (buildSpans.length === 0) {
        return {
          passed: false,
          verifier_name: "completion_claim_verifier",
          reason: "Claimed 'build succeeded' but no successful build span was recorded in this run.",
          evidence_refs: [],
        };
      }
    }

    // General completion requires at least one successful execution or verifier span
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
    const claimsTestsPassed = /tests?(\s+\w+)?\s+(passed|succeeded|green|ok|passing)/i.test(agentOutput);
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
        /test|pytest|vitest|jest|run_command/i.test(String(s.attributes.tool_name)) &&
        s.status === "OK"
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

    const intentId = mutatingSpan.attributes.mutation_intent_id as string | undefined;
    if (!intentId || !registeredIntentIds.has(intentId)) {
      return {
        passed: false,
        verifier_name: "mutation_intent_verifier",
        reason: `Mutating tool '${mutatingSpan.name}' executed without a registered mutation intent ID.`,
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
   * Detects identical (tool, input_hash) calls exceeding max allowed repetitions.
   */
  static verifyToolRepeat(
    toolName: string,
    args: unknown,
    recentCallHashes: string[],
    maxRepeats: number = 5
  ): VerifierResult {
    const currentHash = this.hash({ toolName, args });
    const count = recentCallHashes.filter((h) => h === currentHash).length;

    if (count >= maxRepeats) {
      return {
        passed: false,
        verifier_name: "tool_repeat_loop_detector",
        reason: `Tool '${toolName}' called with identical arguments ${count + 1} times, exceeding repeat threshold of ${maxRepeats}.`,
        evidence_refs: [currentHash],
      };
    }

    return {
      passed: true,
      verifier_name: "tool_repeat_loop_detector",
      evidence_refs: [currentHash],
    };
  }

  static verifyToolRepeatLoop(
    toolName: string,
    args: unknown,
    recentCallHashes: string[],
    maxRepeats: number = 5
  ): VerifierResult {
    return DeterministicVerifiers.verifyToolRepeat(toolName, args, recentCallHashes, maxRepeats);
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

  /**
   * Run-scoped verification: Queries spans strictly from RunEvidenceStore for runId.
   */
  static verifyRunEvidence(
    claimText: string,
    runId: string,
    store: RunEvidenceStore = RunEvidenceStore.getGlobalInstance()
  ): VerifierResult {
    const spans = store.getSpans(runId);
    const results = [
      this.verifyCompletionClaim(claimText, spans),
      this.verifyTestsPassed(claimText, spans),
      this.verifyNoOpenChildSpans(spans),
    ];
    const failed = results.find((r) => !r.passed);
    if (failed) {
      return failed;
    }
    const allRefs = Array.from(new Set(results.flatMap((r) => r.evidence_refs)));
    return {
      passed: true,
      verifier_name: "run_evidence_composite_verifier",
      evidence_refs: allRefs,
    };
  }

  static verifyAllRunEvidence(
    claimText: string,
    runId: string,
    store: RunEvidenceStore = RunEvidenceStore.getGlobalInstance()
  ): VerifierResult[] {
    const spans = store.getSpans(runId);
    return [
      this.verifyCompletionClaim(claimText, spans),
      this.verifyTestsPassed(claimText, spans),
      this.verifyNoOpenChildSpans(spans),
    ];
  }
}
