import crypto from "node:crypto";
import { CapabilityManifestSchema, DecisionResultSchema, type DecisionProvider, type TypedDecisionRequest, type TypedDecisionResult } from "./contracts.ts";
export const decisionHash = (value: unknown) => `sha256-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const refusal = (code: string) => Object.assign(new Error(code), { code });

/** Credentials are attached after admission; no loads, training, retries, or promotions. */
export class TinyModelsProvider implements DecisionProvider {
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
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 262144) throw refusal("PROVIDER_RESPONSE_TOO_LARGE"); chunks.push(value); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  async getCapabilities(signal: AbortSignal) {
    const parsed = CapabilityManifestSchema.safeParse(await this.request("/v1/capabilities", signal));
    if (!parsed.success) throw refusal("PROVIDER_CONTRACT_UNSUPPORTED");
    const manifest = parsed.data;
    if ((process.env.TINYMODELS_EXPECTED_VERSION && process.env.TINYMODELS_EXPECTED_VERSION !== manifest.service_version) || (process.env.TINYMODELS_EXPECTED_DEPLOYMENT && process.env.TINYMODELS_EXPECTED_DEPLOYMENT !== manifest.deployment_id)) throw refusal("PROVIDER_DEPLOYMENT_MISMATCH");
    return manifest;
  }
  async decide(request: TypedDecisionRequest, signal: AbortSignal): Promise<TypedDecisionResult> {
    const manifest = await this.getCapabilities(signal);
    const cap = manifest.capabilities.find(c => c.id === request.capability);
    if (!cap) throw refusal("PROVIDER_CAPABILITY_UNAVAILABLE");
    if (cap.route !== "/v1/system1/decide") throw refusal("PROVIDER_ROUTE_UNSUPPORTED");
    if (Buffer.byteLength(request.state) > cap.max_state_bytes || Object.keys(request.questions).length > cap.max_questions || Object.values(request.questions).some(q => Object.keys(q.criteria).length > cap.max_choices_per_question)) throw refusal("PROVIDER_INPUT_LIMIT");
    const parsed = DecisionResultSchema.safeParse(await this.request(cap.route, signal, request));
    if (!parsed.success) throw refusal("PROVIDER_RESULT_INVALID");
    const result = parsed.data;
    if (result.requestId !== request.requestId || result.provider.version !== manifest.service_version || result.provider.deploymentId !== manifest.deployment_id || result.evidence.inputHash !== decisionHash(request) || result.evidence.outputHash !== decisionHash(result.results)) throw refusal("PROVIDER_PROVENANCE_MISMATCH");
    if (Object.keys(result.results).length !== Object.keys(request.questions).length) throw refusal("PROVIDER_RESULT_INVALID");
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = result.results[id];
      if (!answer || !(answer.value in question.criteria) || (answer.value === "insufficient_evidence") !== answer.abstained || (!cap.probabilities_calibrated && (answer.calibrationState === "calibrated" || answer.calibratedConfidence != null))) throw refusal("PROVIDER_RESULT_INVALID");
    }
    return result;
  }
}
