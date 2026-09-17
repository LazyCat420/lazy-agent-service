import crypto from "node:crypto";
import type { ReplayManifest, ContextReceipt, CachedToolResult } from "../contracts/manifest.ts";
import type { SpanData } from "../contracts/telemetry.ts";

export class ReplayManifestBuilder {
  private manifest: ReplayManifest;

  constructor(options: {
    runId: string;
    traceId: string;
    harnessVersion: string;
    model: string;
    agentRole: string;
    environment?: string;
    contextReceipt: ContextReceipt;
    samplingParameters?: Record<string, unknown>;
  }) {
    this.manifest = {
      manifest_version: "1.0",
      run_id: options.runId,
      trace_id: options.traceId,
      harness_version: options.harnessVersion,
      model: options.model,
      agent_role: options.agentRole,
      environment: options.environment || "production",
      context_receipt: options.contextReceipt,
      sampling_parameters: options.samplingParameters,
      ordered_tool_events: [],
      cached_tool_results: [],
      state_snapshots: [],
      artifact_references: [],
      stop_reason: "running",
      verifier_outcomes: [],
    };
  }

  private static hash(data: unknown): string {
    return crypto
      .createHash("sha256")
      .update(typeof data === "string" ? data : JSON.stringify(data ?? {}))
      .digest("hex");
  }

  addToolEvent(event: {
    turn: number;
    callId: string;
    toolName: string;
    arguments: Record<string, unknown>;
    result: unknown;
    status: "success" | "error" | "refused";
    durationMs: number;
    sideEffect?: "READ_ONLY" | "MUTATING";
  }): this {
    const argsHash = ReplayManifestBuilder.hash(event.arguments);
    const resultHash = ReplayManifestBuilder.hash(event.result);

    this.manifest.ordered_tool_events.push({
      turn: event.turn,
      call_id: event.callId,
      tool_name: event.toolName,
      arguments: event.arguments,
      arguments_hash: argsHash,
      result_hash: resultHash,
      status: event.status,
      duration_ms: event.durationMs,
      side_effect: event.sideEffect || "READ_ONLY",
    });

    this.manifest.cached_tool_results.push({
      tool_name: event.toolName,
      arguments_hash: argsHash,
      result_hash: resultHash,
      is_error: event.status === "error",
      result_payload: event.result,
    });

    return this;
  }

  addStateSnapshot(turn: number, snapshot: Record<string, unknown>): this {
    this.manifest.state_snapshots.push({
      turn,
      state_hash: ReplayManifestBuilder.hash(snapshot),
      snapshot,
    });
    return this;
  }

  addVerifierOutcome(outcome: {
    verifier_name: string;
    passed: boolean;
    evidence_refs: string[];
    details?: string;
  }): this {
    this.manifest.verifier_outcomes.push(outcome);
    return this;
  }

  setStopReason(reason: string): this {
    this.manifest.stop_reason = reason;
    return this;
  }

  build(): ReplayManifest {
    return { ...this.manifest };
  }

  /**
   * Validates if a replay execution is deterministic against this manifest.
   */
  static validateDeterministicMatch(manifest: ReplayManifest, newSpans: SpanData[]): boolean {
    const originalToolEvents = manifest.ordered_tool_events;
    const newToolSpans = newSpans.filter((s) => s.kind === "tool_execution");

    if (originalToolEvents.length !== newToolSpans.length) {
      return false;
    }

    for (let i = 0; i < originalToolEvents.length; i++) {
      const orig = originalToolEvents[i];
      const actual = newToolSpans[i];
      if (orig.tool_name !== actual.attributes.tool_name) return false;
      if (orig.arguments_hash !== actual.attributes.input_hash) return false;
    }

    return true;
  }
}
