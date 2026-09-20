import { z } from "zod";
import { RunRequestSchema } from "../services/RunAdmission.ts";
import { DecisionRequestSchema, DecisionResultSchema } from "../decision-fabric/contracts.ts";

/** Neutral wire contract shared by HTTP clients and the runtime boundary. */
export const RUNTIME_WIRE_CONTRACT_VERSION = "runtime-wire.v1.0.0" as const;

export const RunStateSchema = z.enum([
  "admitted", "running", "waiting_for_tool", "waiting_for_worker", "waiting_for_approval",
  "completed", "failed", "cancelled", "timed_out",
]);

export const RunEventTypeSchema = z.enum([
  "run.admitted", "run.started", "run.created", "message.delta", "message.completed",
  "tool.invoked", "tool.called", "tool.completed", "tool.result", "tool.failed",
  "approval.required", "approval.resolved", "worker.dispatched", "worker.completed",
  "run.completed", "run.failed", "run.cancelled",
]);

export const RunUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().nullable(),
  completion_tokens: z.number().int().nonnegative().nullable(),
  total_tokens: z.number().int().nonnegative().nullable(),
  tool_calls_count: z.number().int().nonnegative(),
  retry_count: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
}).passthrough();

export const ToolResultCommandSchema = z.object({
  result: z.unknown(),
  is_error: z.boolean(),
  authorization_receipt: z.record(z.string(), z.unknown()),
}).strict();

export const ApprovalResolutionCommandSchema = z.object({ approved: z.boolean() }).strict();

export const ApprovalSchema = z.object({
  id: z.string().min(1), tool_call_id: z.string().min(1), tool_name: z.string().min(1),
  arguments_hash: z.string().min(1), app_id: z.string().min(1), session_id: z.string().min(1),
  expires_at: z.string().datetime(),
}).strict();

export const RunEventSchema = z.object({
  id: z.string().min(1), run_id: z.string().min(1), runId: z.string().optional(), type: RunEventTypeSchema,
  timestamp: z.string().datetime(), data: z.record(z.string(), z.unknown()),
}).strict();

export const RunResultSchema = z.object({
  contract_version: z.string().optional(), run_id: z.string().min(1), id: z.string().optional(),
  status: RunStateSchema, profile_id: z.string().optional(), profile_version: z.string().optional(),
  messages: z.array(z.record(z.string(), z.unknown())), usage: RunUsageSchema.optional(),
  context_receipt: z.record(z.string(), z.unknown()).optional(),
  evidence_records: z.array(z.record(z.string(), z.unknown())).optional(),
  error: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const RuntimeWireSchema = z.object({
  contract_version: z.literal(RUNTIME_WIRE_CONTRACT_VERSION),
  run_request: RunRequestSchema,
  decision_request: DecisionRequestSchema,
  decision_result: DecisionResultSchema,
  run_event: RunEventSchema,
  run_result: RunResultSchema,
  tool_result_command: ToolResultCommandSchema,
  approval_resolution_command: ApprovalResolutionCommandSchema,
  approval: ApprovalSchema,
}).strict();

export type RuntimeRunRequest = z.infer<typeof RunRequestSchema>;
export type RuntimeDecisionRequest = z.infer<typeof DecisionRequestSchema>;
export type RuntimeDecisionResult = z.infer<typeof DecisionResultSchema>;
export type RuntimeRunEvent = z.infer<typeof RunEventSchema>;
export type RuntimeRunResult = z.infer<typeof RunResultSchema>;
export type RuntimeToolResultCommand = z.infer<typeof ToolResultCommandSchema>;
export type RuntimeApprovalResolutionCommand = z.infer<typeof ApprovalResolutionCommandSchema>;
export type RuntimeApproval = z.infer<typeof ApprovalSchema>;
