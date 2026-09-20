import { z } from "zod";
export const QuestionSchema = z.object({
  type: z.literal("choice"), instructions: z.string().min(1).max(2048),
  criteria: z.record(z.string().min(1).max(128), z.string().max(512)).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 16 && "insufficient_evidence" in v),
  requiredAbstainOption: z.literal(true),
}).strict();
export const DecisionRequestSchema = z.object({
  requestId: z.string().uuid(), runId: z.string().min(1),
  capability: z.literal("semantic.choice.v1"), questionId: z.enum(["agent.next_readonly_action.v1", "agent.evidence_sufficiency.v1"]),
  policyVersion: z.literal("shadow.v1"), dataClassification: z.literal("public"),
  state: z.string().max(32768).refine(v => Buffer.byteLength(v, "utf8") <= 32768),
  questions: z.record(z.string().min(1).max(128), QuestionSchema).refine(v => Object.keys(v).length >= 1 && Object.keys(v).length <= 8),
  constraints: z.object({ maxLatencyMs: z.number().int().min(1).max(2000), shadowOnly: z.literal(true), noSideEffects: z.literal(true), maxAttempts: z.literal(1) }).strict(),
}).strict();
export type TypedDecisionRequest = z.infer<typeof DecisionRequestSchema>;
export const CapabilityManifestSchema = z.object({
  contract_version: z.literal("decision-provider.v1"), service_version: z.string().min(1), deployment_id: z.string().min(1), availability: z.literal("ready"),
  capabilities: z.array(z.object({
    id: z.string(), status: z.enum(["candidate_shadow", "advisory_shadow"]),
    route: z.string().regex(/^\/v1\/[a-zA-Z0-9/_-]+$/),
    max_state_bytes: z.number().int().positive().max(32768), max_questions: z.number().int().positive().max(8), max_choices_per_question: z.number().int().positive().max(16),
    supports_abstain: z.literal(true), probabilities_calibrated: z.boolean(),
  }).passthrough()),
}).passthrough();
export const DecisionResultSchema = z.object({
  requestId: z.string().uuid(),
  provider: z.object({ id: z.literal("tinymodels"), version: z.string().min(1), modelId: z.string().min(1), artifactId: z.string().optional(), deploymentId: z.string().min(1), deploymentState: z.enum(["candidate_shadow", "advisory_shadow"]) }).strict(),
  results: z.record(z.string(), z.object({ type: z.literal("choice"), value: z.string(), probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(), rawConfidence: z.number().min(0).max(1).optional(), calibratedConfidence: z.number().min(0).max(1).nullable().optional(), calibrationState: z.enum(["uncalibrated", "calibrated", "not_available"]), abstained: z.boolean() }).strict()),
  evidence: z.object({ inputHash: z.string().regex(/^sha256-[a-f0-9]{64}$/), outputHash: z.string().regex(/^sha256-[a-f0-9]{64}$/), processUnloaded: z.boolean(), latencyMs: z.number().nonnegative() }).strict(),
}).strict();
export type TypedDecisionResult = z.infer<typeof DecisionResultSchema>;
export interface DecisionReceipt {
  receipt_id: string; request_id: string; run_id: string; agent_profile: string; policy_version: string;
  input_hash: string; output_hash?: string; created_at: string; latency_ms: number;
  policy_outcome: "shadow_only"; authorizes_actions: false; fallback_reason?: string;
  fallback: "primary_llm" | "none"; signal?: TypedDecisionResult;
}
export interface DecisionProvider {
  readonly id: string;
  getCapabilities(signal: AbortSignal): Promise<z.infer<typeof CapabilityManifestSchema>>;
  decide(request: TypedDecisionRequest, signal: AbortSignal): Promise<TypedDecisionResult>;
}
