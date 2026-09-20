import crypto from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DecisionRequestSchema, type TypedDecisionRequest } from "../../src/decision-fabric/contracts.ts";
import { TinyModelsProvider, decisionHash } from "../../src/decision-fabric/TinyModelsProvider.ts";
import { DecisionService } from "../../src/decision-fabric/DecisionService.ts";
import { RunStore } from "../../src/services/RunStore.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
const request = (): TypedDecisionRequest => ({ requestId: crypto.randomUUID(), runId: "decision-run", capability: "semantic.choice.v1", questionId: "agent.evidence_sufficiency.v1", policyVersion: "shadow.v1", dataClassification: "public", state: "Public source excerpt", questions: { evidence: { type: "choice", instructions: "Is source text present?", criteria: { present: "Source text", insufficient_evidence: "No source text" }, requiredAbstainOption: true } }, constraints: { maxLatencyMs: 750, maxAttempts: 1, shadowOnly: true, noSideEffects: true } });
const manifest = () => ({ contract_version: "decision-provider.v1", service_version: "git:fixture", deployment_id: "isolated-fixture", availability: "ready", capabilities: [{ id: "semantic.choice.v1", status: "candidate_shadow", route: "/v1/system1/decide", max_state_bytes: 32768, max_questions: 8, max_choices_per_question: 16, supports_abstain: true, probabilities_calibrated: false }] });
const result = (r: TypedDecisionRequest) => {
  const results = { evidence: { type: "choice", value: "present", calibrationState: "uncalibrated", abstained: false } };
  return { requestId: r.requestId, provider: { id: "tinymodels", version: "git:fixture", modelId: "fixture-specialist", deploymentId: "isolated-fixture", deploymentState: "candidate_shadow" }, results, evidence: { inputHash: decisionHash(r), outputHash: decisionHash(results), processUnloaded: true, latencyMs: 1 } };
};
beforeEach(async () => { await ProfileRegistry.loadProfilesFromDisk(); RunStore.clearAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it("discovers exact capabilities before one bounded inference and checks provenance", async () => {
  const r = request(); const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url, options) => { calls.push(String(url)); expect(options.signal).toBeDefined(); return new Response(JSON.stringify(calls.length === 1 ? manifest() : result(r))); }));
  const provider = new TinyModelsProvider("http://example.com", async () => crypto.randomBytes(24).toString("hex"));
  expect((await provider.decide(r, AbortSignal.timeout(750))).provider.modelId).toBe("fixture-specialist");
  expect(calls).toEqual(["http://example.com/v1/capabilities", "http://example.com/v1/system1/decide"]);
});
it.each(["old-contract", "wrong-deployment", "training-route"])("refuses %s without attempting inference", async kind => {
  const m = manifest(); if (kind === "wrong-deployment") vi.stubEnv("TINYMODELS_EXPECTED_DEPLOYMENT", "different");
  if (kind === "training-route") m.capabilities[0].route = "/v1/training/jobs";
  const fetcher = vi.fn(async () => new Response(JSON.stringify(kind === "old-contract" ? { tasks: [] } : m))); vi.stubGlobal("fetch", fetcher);
  await expect(new TinyModelsProvider("http://example.com", async () => crypto.randomBytes(24).toString("hex")).decide(request(), AbortSignal.timeout(750))).rejects.toThrow(/PROVIDER_/);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not accept a model choice outside the supplied options", async () => {
  const r = request(), response = result(r); response.results.evidence.value = "execute_trade"; response.evidence.outputHash = decisionHash(response.results);
  let count = 0; vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(++count === 1 ? manifest() : response))));
  await expect(new TinyModelsProvider("http://example.com", async () => crypto.randomBytes(24).toString("hex")).decide(r, AbortSignal.timeout(750))).rejects.toThrow("PROVIDER_RESULT_INVALID");
});
it("rejects unbounded, sensitive, mutating, and retrying requests at admission", () => {
  for (const patch of [{ state: "x".repeat(32769) }, { dataClassification: "private" }, { constraints: { ...request().constraints, noSideEffects: false } }, { constraints: { ...request().constraints, maxAttempts: 2 } }]) expect(() => DecisionRequestSchema.parse({ ...request(), ...patch })).toThrow();
});
it("persists a frozen fallback receipt and does not re-call a selected model on replay", async () => {
  vi.stubEnv("TINYMODELS_SHADOW_ENABLED", "true");
  await RunStore.createRun({ run_id: "decision-run", status: "running", profile_id: "trading-strategy-chat-v1", profile_version: "1.2.0", created_at: new Date().toISOString(), current_turn: 0, input: "public research", messages: [], usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null, tool_calls_count: 0, retry_count: 0, duration_ms: 0 }, evidence_records: [] });
  const provider: any = { id: "tinymodels", decide: vi.fn().mockRejectedValue(Object.assign(new Error("not exposed"), { code: "PROVIDER_HTTP_503" })) };
  const r = request(); const receipt = await DecisionService.decide(r, undefined, provider);
  expect(receipt.fallback_reason).toBe("PROVIDER_HTTP_503"); expect(receipt.authorizes_actions).toBe(false);
  expect(await DecisionService.decide(r, undefined, provider)).toEqual(receipt); expect(provider.decide).toHaveBeenCalledTimes(1);
  await expect(DecisionService.decide({ ...r, state: "changed context" }, undefined, provider)).rejects.toThrow("DECISION_REPLAY_CONFLICT");
});
