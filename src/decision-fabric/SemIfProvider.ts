import crypto from "node:crypto";
import { z } from "zod";
import { CapabilityManifestSchema, DecisionResultSchema, type DecisionProvider, type TypedDecisionRequest, type TypedDecisionResult } from "./contracts.ts";
import { decisionHash } from "./TinyModelsProvider.ts";
const refusal = (code: string) => Object.assign(new Error(code), { code });
const ABSTAIN = "insufficient_evidence";

/** Live feature-platform manifest shape (/v1/capabilities): task table, not decision-provider.v1. */
const FeatureTasksManifestSchema = z.object({
  service: z.string().min(1),
  version: z.string().min(1),
  tasks: z.array(z.object({
    task: z.string().min(1),
    route: z.string().regex(/^\/v1\/[a-zA-Z0-9/_-]+$/),
    request_schema: z.string().min(1),
    response_schema: z.string().min(1),
    max_batch_size: z.number().int().positive(),
  }).passthrough()).min(1),
}).passthrough();

/** SemIf route response (POST /v1/features/semantic-route). */
const SemanticRouteResultSchema = z.object({
  result: z.object({
    selected_option: z.string().nullable(),
    abstained: z.boolean(),
    abstention_reason: z.string().nullable(),
    scores: z.array(z.object({ id: z.string().min(1), score: z.number().min(0).max(1) })).min(2),
    decision_type: z.string().min(1),
  }).passthrough(),
}).passthrough();

/**
 * SemIf semantic routing as the decision-fabric signal source.
 *
 * SemIf scores first-token label probabilities on Nemotron (Jetson :8000) and
 * abstains below the confidence threshold; every refusal — abstain, timeout,
 * NEMOTRON_NOT_IDLE_AND_HEALTHY, HTTP error — fails closed into the harness's
 * primary-LLM (GLM) fallback via the standard PROVIDER_* error contract.
 * Option ids are mapped to single-token surrogates (A, B, …) because the
 * logprob gate requires every option's first token to be present.
 * Shadow-only: the synthesized manifest keeps receipts non-authorizing.
 */
export class SemIfProvider implements DecisionProvider {
  readonly id = "tinymodels";
  constructor(private baseUrl = process.env.TINYMODELS_URL || "http://10.0.0.30:8002", private credential?: () => Promise<string>) {}
  private async getCredential(signal: AbortSignal): Promise<string> {
    if (this.credential) return this.credential();
    if (process.env.VAULT_SERVICE_URL && process.env.VAULT_SERVICE_TOKEN) {
      const response = await fetch(`${process.env.VAULT_SERVICE_URL.replace(/\/$/, "")}/secrets?keys=JETSON_FEATURES_API_KEY`, { signal, redirect: "error", headers: { Authorization: `Bearer ${process.env.VAULT_SERVICE_TOKEN}` } });
      if (!response.ok) throw refusal("PROVIDER_CREDENTIAL_UNAVAILABLE");
      const value = (await response.json() as Record<string, unknown>).JETSON_FEATURES_API_KEY;
      if (typeof value !== "string" || !value) throw refusal("PROVIDER_CREDENTIAL_UNAVAILABLE");
      return value;
    }
    const value = process.env.TINYMODELS_API_TOKEN || process.env.JETSON_FEATURES_API_KEY;
    if (!value) throw refusal("PROVIDER_CREDENTIAL_UNAVAILABLE");
    return value;
  }
  private async request(route: string, signal: AbortSignal, payload?: unknown): Promise<unknown> {
    const credential = await this.getCredential(signal);
    const response = await fetch(this.baseUrl.replace(/\/$/, "") + route, { signal, redirect: "error", method: payload === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (!response.ok) { await response.body?.cancel(); throw refusal(`PROVIDER_HTTP_${response.status}`); }
    const reader = response.body?.getReader();
    if (!reader) throw refusal("PROVIDER_EMPTY_RESPONSE");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; if ((size += value.length) > 262144) throw refusal("PROVIDER_RESPONSE_TOO_LARGE"); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  async getCapabilities(signal: AbortSignal) {
    const parsed = FeatureTasksManifestSchema.safeParse(await this.request("/v1/capabilities", signal));
    if (!parsed.success) throw refusal("PROVIDER_CONTRACT_UNSUPPORTED");
    const manifest = parsed.data;
    const task = manifest.tasks.find(t => t.task === "semantic_routing");
    if (!task || task.route !== "/v1/features/semantic-route" || task.request_schema !== "SemanticRouteRequest") throw refusal("PROVIDER_ROUTE_UNSUPPORTED");
    // Synthesize the decision-provider.v1 manifest the harness contract expects.
    const synthesized = CapabilityManifestSchema.parse({
      contract_version: "decision-provider.v1", service_version: manifest.version,
      deployment_id: `feature-platform-v${manifest.version}`, availability: "ready",
      capabilities: [{ id: "semantic.choice.v1", status: "advisory_shadow", route: task.route, max_state_bytes: 32768, max_questions: 8, max_choices_per_question: 16, supports_abstain: true, probabilities_calibrated: false }],
    });
    if (process.env.TINYMODELS_EXPECTED_VERSION && process.env.TINYMODELS_EXPECTED_VERSION !== synthesized.service_version) throw refusal("PROVIDER_DEPLOYMENT_MISMATCH");
    return synthesized;
  }
  async decide(request: TypedDecisionRequest, signal: AbortSignal): Promise<TypedDecisionResult> {
    const manifest = await this.getCapabilities(signal);
    const cap = manifest.capabilities.find(c => c.id === request.capability);
    if (!cap) throw refusal("PROVIDER_CAPABILITY_UNAVAILABLE");
    if (Buffer.byteLength(request.state) > cap.max_state_bytes || Object.keys(request.questions).length > cap.max_questions) throw refusal("PROVIDER_INPUT_LIMIT");
    const threshold = Math.min(Math.max(Number(process.env.SEMIF_ABSTENTION_THRESHOLD) || 0.4, 0), 1);
    const start = Date.now();
    const results: TypedDecisionResult["results"] = {};
    await Promise.all(Object.entries(request.questions).map(async ([id, question]) => {
      const ids = Object.keys(question.criteria);
      if (ids.length < 2 || ids.length > cap.max_choices_per_question) throw refusal("PROVIDER_INPUT_LIMIT");
      // Single-token surrogate ids: SemIf's logprob gate must see every option's first token.
      // The contract-mandated insufficient_evidence criterion is sent as a regular option;
      // selecting it is normalized to an explicit abstention below.
      const surrogate: Record<string, string> = {};
      ids.forEach((k, i) => { surrogate[k] = String.fromCharCode(65 + i); });
      const back = (letter: string) => ids[letter.charCodeAt(0) - 65];
      const payload = { question: question.instructions, context: request.state, abstention_threshold: threshold,
        allowed_options: ids.map(k => ({ id: surrogate[k], description: `${k}: ${question.criteria[k]}` })) };
      const parsed = SemanticRouteResultSchema.safeParse(await this.request(cap.route, signal, payload));
      if (!parsed.success) throw refusal("PROVIDER_RESULT_INVALID");
      const outcome = parsed.data.result;
      const scores: Record<string, number> = {};
      for (const s of outcome.scores) scores[back(s.id) ?? s.id] = s.score;
      // An unknown surrogate letter is malformed upstream output, not an abstention.
      if (outcome.selected_option && !outcome.abstained && outcome.selected_option !== ABSTAIN && !Object.values(surrogate).includes(outcome.selected_option)) throw refusal("PROVIDER_RESULT_INVALID");
      const pickedId = outcome.abstained || !outcome.selected_option || outcome.selected_option === ABSTAIN || !Object.values(surrogate).includes(outcome.selected_option) ? ABSTAIN : back(outcome.selected_option);
      results[id] = { type: "choice", value: pickedId, probabilities: scores,
        rawConfidence: pickedId === ABSTAIN ? Math.max(0, ...outcome.scores.map(s => s.score)) : scores[pickedId],
        calibratedConfidence: null, calibrationState: "uncalibrated", abstained: pickedId === ABSTAIN };
    }));
    const typed: TypedDecisionResult = { requestId: request.requestId,
      provider: { id: "tinymodels", version: manifest.service_version, modelId: "semif_nemotron", deploymentId: manifest.deployment_id, deploymentState: "advisory_shadow" },
      results, evidence: { inputHash: decisionHash(request), outputHash: decisionHash(results), processUnloaded: true, latencyMs: Date.now() - start } };
    const validated = DecisionResultSchema.safeParse(typed);
    if (!validated.success) throw refusal("PROVIDER_RESULT_INVALID");
    return validated.data;
  }
}
