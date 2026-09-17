/**
 * Telemetry and Trace contracts for shared agent-runtime.
 * Defines Span, Trace, Event, Run schemas, Side-effect classifications, and Memory Lifecycle states.
 */

export type LifecycleState =
  | "OBSERVED"
  | "CANDIDATE"
  | "VERIFIED"
  | "ACTIVE"
  | "REVALIDATE"
  | "SUPERSEDED"
  | "RETIRED"
  | "REJECTED";

export type SideEffectClass = "READ_ONLY" | "MUTATING";

export type SpanStatus = "UNSET" | "OK" | "ERROR";

export interface SpanAttributes {
  project?: string;
  environment?: string;
  agent_role?: string;
  model?: string;
  tool_name?: string;
  attempt?: number;
  error_fingerprint?: string;
  tokens_input?: number;
  tokens_output?: number;
  tokens_cache?: number;
  cost_usd?: number;
  input_hash?: string;
  result_hash?: string;
  state_hash?: string;
  artifact_refs?: string[];
  side_effect?: SideEffectClass;
  mutation_intent_id?: string;
  subagent_run_id?: string;
  [key: string]: unknown;
}

export interface SpanEvent {
  name: string;
  timestamp: string; // ISO 8601
  attributes?: Record<string, unknown>;
}

export interface SpanLink {
  trace_id: string;
  span_id: string;
  relationship?: "parent" | "child" | "delegation" | "retry_of" | "caused_by";
}

export interface SpanData {
  trace_id: string;
  span_id: string;
  parent_span_id?: string | null;
  run_id: string;
  name: string;
  kind: "agent_run" | "model_call" | "tool_guard" | "tool_execution" | "retry" | "subagent" | "delegation" | "delegation_join" | "verifier" | "checkpoint";
  status: SpanStatus;
  status_message?: string;
  start_time: string; // ISO 8601
  end_time?: string;   // ISO 8601
  duration_ms?: number;
  attributes: SpanAttributes;
  events: SpanEvent[];
  links: SpanLink[];
}

export interface AgentRunManifest {
  run_id: string;
  trace_id: string;
  conversation_id?: string | null;
  parent_run_id?: string | null;
  project: string;
  agent_role: string;
  environment: string;
  model: string;
  start_time: string;
  end_time?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "setup_error" | "timeout" | "budget_exceeded";
  stop_reason?: string;
  total_tokens?: number;
  total_cost_usd?: number;
  total_duration_ms?: number;
  tool_call_count: number;
  retry_count: number;
  error_fingerprint?: string;
  context_receipt_hash?: string;
  replay_manifest_id?: string;
}

export interface TelemetryBatch {
  schema_version: string;
  service_source: string;
  exported_at: string;
  spans: SpanData[];
  runs: AgentRunManifest[];
}
