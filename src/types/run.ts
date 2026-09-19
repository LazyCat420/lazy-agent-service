import type { ContextReceipt } from "../platform/contracts/manifest.ts";

export type RunState =
  | "admitted"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_worker"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface RunBudget {
  max_tokens?: number;
  max_tool_calls?: number;
  max_retries?: number;
  max_duration_ms?: number;

  // Backwards compatibility aliases
  maxTokens?: number;
  maxToolCalls?: number;
  maxRetries?: number;
  maxDurationMs?: number;
}

export interface RuntimeOverrides {
  model?: string;
  sampling_temperature?: number;
  budget?: RunBudget;
  tools?: any[];
  [key: string]: unknown;
}

export interface CreateRunRequest {
  profile_id?: string;
  profileId?: string;
  profile_version?: string;
  input: string | Array<{ role: string; content: string }>;
  model?: string;
  budget?: RunBudget;
  tools?: any[];
  stream?: boolean;
  idempotency_key?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  deadline_ms?: number;
  runtime_overrides?: RuntimeOverrides;
  additional_tools?: any[];
}

export type RunEventType =
  | "run.admitted"
  | "run.started"
  | "message.delta"
  | "message.completed"
  | "tool.invoked"
  | "tool.completed"
  | "tool.failed"
  | "worker.dispatched"
  | "worker.completed"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  // Legacy event aliases for backwards compatibility
  | "run.created"
  | "tool.called"
  | "tool.result";

export interface RunEvent {
  id: string;
  run_id: string;
  runId?: string; // Legacy alias
  type: RunEventType;
  data: any;
  timestamp: string;
}

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  category?: "CLIENT" | "RUNTIME" | "PROVIDER" | "TOOL" | "POLICY" | "RESOURCE";
  details?: Record<string, unknown>;
}

export interface RunUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  tool_calls_count: number;
  retry_count: number;
  duration_ms: number;

  // Backwards compatibility aliases
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  toolCalls?: number;
}

export interface EvidenceRecord {
  evidence_id: string;
  source: string;
  provenance_hash?: string;
  redacted?: boolean;
  [key: string]: unknown;
}

export interface RunResult {
  run_id: string;
  id?: string; // Legacy alias
  status: RunState | "queued" | "in_progress";
  profile_id?: string;
  messages: any[];
  usage?: RunUsage;
  context_receipt?: ContextReceipt;
  evidence_records?: EvidenceRecord[];
  error?: StructuredError;
}

export interface RunRecord {
  run_id: string;
  status: RunState;
  profile_id: string;
  profile_version: string;
  created_at: string;
  started_at?: string;
  completed_at?: string;
  deadline_at?: string;
  current_turn: number;
  idempotency_key?: string;
  trace_id?: string;
  input: any;
  messages: any[];
  usage: RunUsage;
  context_receipt?: ContextReceipt;
  evidence_records: EvidenceRecord[];
  error?: StructuredError;
}
