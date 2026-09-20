import type { ContextReceipt } from "../platform/contracts/manifest.ts";

export type RunState =
  | "admitted"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_tool"
  | "waiting_for_worker"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

export type ToolEffect = "read" | "write" | "destructive";

export type ToolExecution = "shared" | "local";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  effect: ToolEffect;
  execution?: ToolExecution;
  timeout_ms?: number;
  authorization_receipt?: Record<string, unknown>;
  required_scope?: {
    app_id: string;
    session_id?: string;
    [key: string]: unknown;
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  result: unknown;
  is_error: boolean;
  error?: StructuredError;
}

export type ContractVersion = "1.0.0" | "1.1.0" | "1.2.0";

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
  /** Set by the HTTP boundary, never accepted from the body. */
  identity?: { project: string; username: string };
  contract_version?: string;
  contractVersion?: string;
  profile_id?: string;
  profileId?: string;
  profile_version?: string;
  app_id?: string;
  appId?: string;
  session_id?: string;
  sessionId?: string;
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
  | "approval.required"
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
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  tool_calls_count: number;
  retry_count: number;
  duration_ms: number;

  // Backwards compatibility aliases
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  toolCalls?: number;
}

export interface EvidenceRecord {
  evidence_id: string;
  source: string;
  provenance_hash?: string;
  redacted?: boolean;
  data?: unknown;
  [key: string]: unknown;
}

export interface RunResult {
  contract_version?: string;
  run_id: string;
  id?: string; // Legacy alias
  status: RunState | "queued" | "in_progress";
  profile_id?: string;
  profile_version?: string;
  messages: any[];
  usage?: RunUsage;
  context_receipt?: ContextReceipt;
  evidence_records?: EvidenceRecord[];
  error?: StructuredError;
}

export interface RunRecord {
  approvals?: Record<string, import("../services/RunApprovals.ts").RunApproval>;
  decision_receipts?: import("../decision-fabric/contracts.ts").DecisionReceipt[];
  session_id?: string;
  events?: RunEvent[];
  identity?: { project: string; username: string };
  pending_tools?: Record<string, { event: any; result_digest?: string; observation?: unknown }>;
  contract_version?: string;
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
