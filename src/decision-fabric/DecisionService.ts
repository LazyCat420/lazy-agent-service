import crypto from "node:crypto";
import { DecisionRequestSchema, type DecisionProvider, type DecisionReceipt } from "./contracts.ts";
import { TinyModelsProvider, decisionHash } from "./TinyModelsProvider.ts";
import { SemIfProvider } from "./SemIfProvider.ts";
import { RunStore } from "../services/RunStore.ts";
import { ProfileRegistry } from "../services/ProfileRegistry.ts";

/** Shadow signal source: SemIf by default; DECISION_PROVIDER=tinymodels restores the legacy route. */
const defaultProvider = (): DecisionProvider => process.env.DECISION_PROVIDER === "tinymodels" ? new TinyModelsProvider() : new SemIfProvider();

/** Signals are recorded in shadow; they cannot edit context, authorize tools, or execute actions. */
export class DecisionService {
  private static pending = new Map<string, Promise<DecisionReceipt>>();
  static async decide(input: unknown, signal?: AbortSignal, provider: DecisionProvider = defaultProvider()): Promise<DecisionReceipt> {
    const request = DecisionRequestSchema.parse(input);
    const hash = decisionHash(request);
    const key = `${request.runId}:${request.requestId}`;
    const existing = this.pending.get(key);
    if (existing) { const receipt = await existing; if (receipt.input_hash !== hash) throw new Error("DECISION_REPLAY_CONFLICT"); return receipt; }
    const operation = (async () => {
      const run = await RunStore.getRun(request.runId);
      if (!run) throw new Error("RUN_NOT_FOUND");
      const recorded = run.decision_receipts?.find(r => r.request_id === request.requestId);
      if (recorded) { if (recorded.input_hash !== hash) throw new Error("DECISION_REPLAY_CONFLICT"); return recorded; }
      const profile = await ProfileRegistry.loadProfile(run.profile_id, run.profile_version);
      const policy = profile?.decision_policy;
      const receipt: DecisionReceipt = { receipt_id: `decision-${crypto.randomUUID()}`, request_id: request.requestId, run_id: run.run_id, agent_profile: run.profile_id, policy_version: request.policyVersion, input_hash: hash, created_at: new Date().toISOString(), latency_ms: 0, policy_outcome: "shadow_only", authorizes_actions: false, fallback: "primary_llm" };
      const start = Date.now();
      if (!policy?.capabilities.includes(request.capability) || !policy.data_classifications.includes(request.dataClassification)) receipt.fallback_reason = "PROFILE_CAPABILITY_DISABLED";
      else if (process.env.TINYMODELS_SHADOW_ENABLED !== "true") receipt.fallback_reason = "PROVIDER_DISABLED";
      else if (!["running", "waiting_for_tool"].includes(run.status)) receipt.fallback_reason = "RUN_NOT_ACTIVE";
      else {
        const bounded = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.min(request.constraints.maxLatencyMs, policy.max_latency_ms))]);
        try {
          receipt.signal = await provider.decide(request, bounded);
          receipt.output_hash = decisionHash(receipt.signal.results);
          receipt.fallback = "none";
        } catch (error: any) {
          receipt.fallback_reason = bounded.aborted ? "PROVIDER_CANCELLED_OR_TIMEOUT" : typeof error.code === "string" && /^PROVIDER_[A-Z0-9_]+$/.test(error.code) ? error.code : "PROVIDER_UNAVAILABLE";
        }
      }
      receipt.latency_ms = Date.now() - start;
      await RunStore.mutateRun(run.run_id, current => ({ decision_receipts: [...(current.decision_receipts || []), receipt] }));
      return receipt;
    })();
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }
}
