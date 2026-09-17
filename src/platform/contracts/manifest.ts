/**
 * Replay Manifest and Context Receipt contracts for deterministic reproduction and auditing.
 */

export interface LayerBudgetSummary {
  allocated_chars: number;
  used_chars: number;
  truncated: boolean;
  item_count: number;
}

export interface ContextReceipt {
  receipt_id: string; // SHA-256 of combined layer hashes
  agent_role: string;
  project: string;
  task_delivery: "exact" | "truncated" | "fallback";
  created_at: string;
  layers: {
    prefix: LayerBudgetSummary & { hash: string };
    project_scope: LayerBudgetSummary & { hash: string; tool_ids: string[]; repo_sha?: string };
    retrieved_evidence: LayerBudgetSummary & { hash: string; memory_ids: string[]; artifact_refs: string[] };
    dynamic_tail: LayerBudgetSummary & { hash: string };
  };
  total_chars: number;
  excluded_items: Array<{ id?: string; reason: string; layer: string }>;
}

export interface CachedToolResult {
  tool_name: string;
  arguments_hash: string;
  result_hash: string;
  is_error: boolean;
  result_payload: unknown;
}

export interface ReplayManifest {
  manifest_version: string;
  run_id: string;
  trace_id: string;
  harness_version: string;
  model: string;
  agent_role: string;
  environment: string;
  context_receipt: ContextReceipt;
  sampling_parameters?: Record<string, unknown>;
  ordered_tool_events: Array<{
    turn: number;
    call_id: string;
    tool_name: string;
    arguments: Record<string, unknown>;
    arguments_hash: string;
    result_hash: string;
    status: "success" | "error" | "refused";
    duration_ms: number;
    side_effect: "READ_ONLY" | "MUTATING";
  }>;
  cached_tool_results: CachedToolResult[];
  state_snapshots: Array<{
    turn: number;
    state_hash: string;
    snapshot: Record<string, unknown>;
  }>;
  artifact_references: string[];
  stop_reason: string;
  verifier_outcomes: Array<{
    verifier_name: string;
    passed: boolean;
    evidence_refs: string[];
    details?: string;
  }>;
}
