import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionRequestSchema, type TypedDecisionRequest } from "../../src/decision-fabric/contracts.ts";
import { SemIfProvider } from "../../src/decision-fabric/SemIfProvider.ts";
import { decisionHash } from "../../src/decision-fabric/TinyModelsProvider.ts";

const request = (): TypedDecisionRequest => ({ requestId: crypto.randomUUID(), runId: "decision-run", capability: "semantic.choice.v1", questionId: "agent.evidence_sufficiency.v1", policyVersion: "shadow.v1", dataClassification: "public", state: "Public source excerpt", questions: { evidence: { type: "choice", instructions: "Is source text present?", criteria: { present: "Source text", insufficient_evidence: "No source text" }, requiredAbstainOption: true } }, constraints: { maxLatencyMs: 750, maxAttempts: 1, shadowOnly: true, noSideEffects: true } });
const tasksManifest = () => ({ service: "jetson-feature-platform", version: "1.0.0", schema_version: "1", tasks: [{ task: "semantic_routing", route: "/v1/features/semantic-route", models: ["semif_nemotron"], request_schema: "SemanticRouteRequest", response_schema: "SemanticRouteResult", max_batch_size: 1 }] });
const semifResponse = (selected: string | null, abstained: boolean, scores = [{ id: "A", score: 0.7 }, { id: "B", score: 0.3 }]) => ({ result: { selected_option: selected, abstained, abstention_reason: abstained ? "below_threshold" : null, scores, conditional_scores_note: "not calibrated", model_revision: "nemotron-external-logprobs-v1", decision_type: "advisory_selection" } });

const capturedBodies: Array<Record<string, unknown>> = [];
/** Two-call stub: first fetch returns the manifest, later fetches return `inferenceResponse`. */
const stubTwoCallFetch = (inferenceResponse: unknown, manifest: unknown = tasksManifest()) => {
  capturedBodies.length = 0;
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, options?: { body?: unknown }) => {
    if (typeof options?.body === "string") capturedBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify(call++ === 0 ? manifest : inferenceResponse));
  }));
};

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const provider = () => new SemIfProvider("http://example.com", async () => crypto.randomBytes(24).toString("hex"));

describe("SemIfProvider", () => {
  it("synthesizes capabilities from the live tasks manifest and maps a selection back to the criterion id", async () => {
    const r = request(); const calls: string[] = [];
    capturedBodies.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, options?: { body?: unknown }) => { calls.push(String(url)); if (typeof options?.body === "string") capturedBodies.push(JSON.parse(options.body)); return new Response(JSON.stringify(calls.length === 1 ? tasksManifest() : semifResponse("A", false))); }));
    const result = await provider().decide(r, AbortSignal.timeout(750));
    expect(calls).toEqual(["http://example.com/v1/capabilities", "http://example.com/v1/features/semantic-route"]);
    expect(result.provider.modelId).toBe("semif_nemotron");
    expect(result.results.evidence.value).toBe("present");
    expect(result.results.evidence.abstained).toBe(false);
    expect(result.results.evidence.calibrationState).toBe("uncalibrated");
    expect(result.evidence.inputHash).toBe(decisionHash(r));
    expect(result.evidence.outputHash).toBe(decisionHash(result.results));
    const routeBody = capturedBodies[capturedBodies.length - 1];
    const options = Array.isArray(routeBody.allowed_options) ? routeBody.allowed_options as Array<Record<string, unknown>> : [];
    expect(options.map(o => o.id)).toEqual(["A", "B"]);
    expect(String(options[0]?.description).includes("present:")).toBe(true);
    expect(String(options[1]?.description).includes("insufficient_evidence:")).toBe(true);
  });

  it("maps SemIf abstention to the required insufficient_evidence abstain contract", async () => {
    stubTwoCallFetch(semifResponse(null, true));
    const result = await provider().decide(request(), AbortSignal.timeout(750));
    expect(result.results.evidence.value).toBe("insufficient_evidence");
    expect(result.results.evidence.abstained).toBe(true);
    expect(result.results.evidence.rawConfidence).toBe(0.7);
  });

  it("refuses a selection outside the supplied criteria", async () => {
    stubTwoCallFetch(semifResponse("Z", false));
    await expect(provider().decide(request(), AbortSignal.timeout(750))).rejects.toThrow("PROVIDER_RESULT_INVALID");
  });

  it("refuses a manifest without the semantic_routing task before any inference call", async () => {
    const manifest = { ...tasksManifest(), tasks: [{ task: "entity_extraction", route: "/v1/features/entities", request_schema: "EntityExtractionRequest", response_schema: "EntityExtractionResult", max_batch_size: 50 }] };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(manifest)));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider().decide(request(), AbortSignal.timeout(750))).rejects.toThrow("PROVIDER_ROUTE_UNSUPPORTED");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("refuses an unexpected service version when TINYMODELS_EXPECTED_VERSION is pinned", async () => {
    vi.stubEnv("TINYMODELS_EXPECTED_VERSION", "9.9.9");
    const fetcher = vi.fn(async () => new Response(JSON.stringify(tasksManifest())));
    vi.stubGlobal("fetch", fetcher);
    await expect(provider().decide(request(), AbortSignal.timeout(750))).rejects.toThrow("PROVIDER_DEPLOYMENT_MISMATCH");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("adapts arbitrary criteria sets to distinct single-token surrogates", async () => {
    const r = request();
    stubTwoCallFetch(semifResponse("C", false, [{ id: "A", score: 0.2 }, { id: "B", score: 0.1 }, { id: "C", score: 0.4 }, { id: "D", score: 0.1 }, { id: "E", score: 0.1 }, { id: "F", score: 0.1 }, { id: "G", score: 0.0 }]));
    r.questions.evidence.criteria = Object.fromEntries([...Array(6).keys()].map(i => [`opt_${i}`, `option ${i}`]).concat([["insufficient_evidence", "cannot decide"]]));
    const result = await provider().decide(r, AbortSignal.timeout(750));
    const routeBody = capturedBodies[capturedBodies.length - 1];
    const options = Array.isArray(routeBody.allowed_options) ? routeBody.allowed_options as Array<Record<string, unknown>> : [];
    expect(options.map(o => o.id)).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
    expect(result.results.evidence.value).toBe("opt_2");
    expect(result.results.evidence.rawConfidence).toBe(0.4);
  });

  it("keeps the admission schema strict", () => {
    expect(() => DecisionRequestSchema.parse({ ...request(), questions: { q: { ...request().questions.evidence, criteria: { only: "x" } } } })).toThrow();
  });
});
