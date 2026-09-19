import { z } from "zod";
import type { CreateRunRequest } from "../types/run.ts";
const limit = z.number().int().nonnegative();
const budget = z.object({ max_tokens: limit.optional(), maxTokens: limit.optional(), max_tool_calls: limit.optional(), maxToolCalls: limit.optional(), max_retries: limit.optional(), maxRetries: limit.optional(), max_duration_ms: limit.optional(), maxDurationMs: limit.optional() }).strict();
const tool = z.union([z.string(), z.object({ name: z.string() }).passthrough()]);
export const RunRequestSchema = z.object({
  contract_version: z.string().optional(), contractVersion: z.string().optional(),
  profile_id: z.string().optional(), profileId: z.string().optional(), profile_version: z.string().optional(), profileVersion: z.string().optional(),
  app_id: z.string().optional(), appId: z.string().optional(), session_id: z.string().optional(), sessionId: z.string().optional(),
  input: z.union([z.string(), z.array(z.object({ role: z.enum(["system", "user", "assistant", "tool"]), content: z.string() }).passthrough())]),
  model: z.string().optional(), budget: budget.optional(), tools: z.array(tool).optional(), stream: z.boolean().optional(),
  idempotency_key: z.string().optional(), idempotencyKey: z.string().optional(), deadline_ms: limit.optional(),
  runtime_overrides: z.object({ model: z.string().optional(), provider: z.string().optional(), sampling_temperature: z.number().optional(), budget: budget.optional(), tools: z.array(tool).optional(), context: z.record(z.string(), z.unknown()).optional(), local_tool_schemas: z.array(z.object({ name: z.string(), description: z.string(), parameters: z.object({ type: z.literal("object") }).passthrough() }).passthrough()).optional() }).strict().optional(),
}).strict();

export function normalizeRunRequest(request: CreateRunRequest): CreateRunRequest {
  const { signal, identity, ...wire } = request;
  const parsed = RunRequestSchema.parse(wire);
  const normalize = (value: Record<string, any>, pairs: [string, string][]) => {
    for (const [canonical, alias] of pairs) {
      if (value[canonical] !== undefined && value[alias] !== undefined && value[canonical] !== value[alias]) throw new Error(`Conflicting aliases: ${canonical}, ${alias}`);
      if (value[alias] !== undefined) value[canonical] = value[alias];
      delete value[alias];
    }
    return value;
  };
  normalize(parsed, [["profile_version", "profileVersion"], ["profile_id", "profileId"], ["contract_version", "contractVersion"], ["app_id", "appId"], ["session_id", "sessionId"], ["idempotency_key", "idempotencyKey"]]);
  const pairs: [string, string][] = [["max_tokens", "maxTokens"], ["max_tool_calls", "maxToolCalls"], ["max_retries", "maxRetries"], ["max_duration_ms", "maxDurationMs"]];
  const effective = { ...normalize(parsed.runtime_overrides?.budget || {}, pairs), ...normalize(parsed.budget || {}, pairs) };
  if (parsed.deadline_ms !== undefined) effective.max_duration_ms = parsed.deadline_ms;
  return { ...parsed, input: parsed.input!, signal, identity, model: parsed.model ?? parsed.runtime_overrides?.model, budget: effective,
    runtime_overrides: { ...parsed.runtime_overrides, model: parsed.model ?? parsed.runtime_overrides?.model, budget: effective, tools: parsed.tools ?? parsed.runtime_overrides?.tools } };
}
