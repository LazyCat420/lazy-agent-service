# Agent Plugin SPI Specification (v1.0.0)

> **Document ID:** `agent-plugin-spi-v1`  
> **Status:** Canonical Platform Standard  
> **Owner:** Dev 1 (Runtime & Contracts Workstream)  
> **Target Service:** `lazy-agent-service`  
> **Extension Authors:** `trading-service`, `HTML-Notes`, `lazy-tool-service`  

---

## 1. Architectural Philosophy

The **Agent Plugin SPI (Service Provider Interface)** allows product services to inject domain-specific logic—such as specialized research workers, proprietary context sources, financial invariants, and canvas validators—into the execution lifecycle without modifying the core state machine, trace hierarchy, or security boundary of `lazy-agent-service`.

```text
┌────────────────────────────────────────────────────────┐
│             Core Runtime (lazy-agent-service)           │
│                                                        │
│  Admission ──► Trace Root ──► Context Assembly         │
│                                    │                   │
│                                    ├─► [ContextContributor]
│                                    ▼                   │
│                           Agentic Step Loop            │
│                                    │                   │
│                                    ├─► [WorkerPlugin]  │
│                                    ├─► [ToolProvider]  │
│                                    ▼                   │
│                           Verification & Receipt       │
│                                    │                   │
│                                    ├─► [ResultValidator]
│                                    ▼                   │
│                           Terminal Output Sealed       │
└────────────────────────────────────────────────────────┘
```

### Non-Negotiable Invariants
1. **No Envelope Bypass**: Plugins cannot emit unmonitored HTTP traffic or mutate provider responses outside the trace span.
2. **Context & Budget Inheritance**: Every plugin execution inherits the parent run's `run_id`, `trace_id`, `deadline_at`, and remaining token/call budget.
3. **Cancellation Observance**: If the parent run's `AbortSignal` fires, all in-flight plugin actions must abort immediately.
4. **Structured Error Propagation**: Uncaught plugin errors must be mapped to `StructuredError` with appropriate retryability flags.

---

## 2. SPI Interface Definitions

### 2.1 Context Contributor (`ContextContributorPlugin`)
Injects domain data into the 4-layer prompt envelope during prompt assembly.

```typescript
export interface ContextContribution {
  layer: "project_scope" | "retrieved_evidence" | "dynamic_tail";
  content: string;
  source_ref: string;
  provenance_hash: string;
  token_cost_estimate: number;
}

export interface ContextContributorPlugin {
  readonly id: string;
  readonly name: string;
  
  contribute(context: {
    runId: string;
    profileId: string;
    input: unknown;
    allocatedTokens: number;
    signal: AbortSignal;
  }): Promise<ContextContribution | null>;
}
```

### 2.2 Worker Plugin (`WorkerPlugin`)
Enables bounded concurrent worker execution (e.g. HTML-Notes' `NewsWorker`, `SkepticWorker`, or Trading's specialist models) within the parent run.

```typescript
export interface WorkerTaskRequest {
  workerId: string;
  taskId: string;
  parameters: Record<string, unknown>;
  allocatedBudget: {
    maxTokens: number;
    maxDurationMs: number;
  };
}

export interface WorkerTaskResult {
  taskId: string;
  status: "success" | "error" | "cancelled";
  output: unknown;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
  evidenceRefs: string[];
  error?: StructuredError;
}

export interface WorkerPlugin {
  readonly id: string;
  readonly capabilities: string[];
  
  execute(
    task: WorkerTaskRequest,
    context: {
      parentRunId: string;
      traceId: string;
      parentSpanId: string;
      signal: AbortSignal;
      emitEvent: (type: string, data: unknown) => void;
    }
  ): Promise<WorkerTaskResult>;
}
```

### 2.3 Result Validator Plugin (`ResultValidatorPlugin`)
Enforces domain acceptance criteria (e.g. arithmetic sanity checks, canvas widget schema conformity, trading holdout rules) before the run is marked `COMPLETED`.

```typescript
export interface ValidationOutcome {
  validatorId: string;
  passed: boolean;
  score?: number; // 0.0 to 1.0
  rejectionReason?: string;
  retrySuggestion?: string;
  evidenceRefs: string[];
}

export interface ResultValidatorPlugin {
  readonly id: string;
  readonly isBlocking: boolean; // If true, failure forces run to FAILED or triggers correction turn
  
  validate(
    result: {
      runId: string;
      profileId: string;
      proposedOutput: unknown;
      toolCallHistory: unknown[];
      evidenceRecords: unknown[];
    },
    context: {
      signal: AbortSignal;
    }
  ): Promise<ValidationOutcome>;
}
```

### 2.4 Evidence Emitter Plugin (`EvidenceEmitterPlugin`)
Packages domain artifacts into the canonical `ContextReceipt` and `ReplayManifest`.

```typescript
export interface EvidencePayload {
  evidenceType: string;
  title: string;
  sourceUri: string;
  payload: Record<string, unknown>;
  contentHash: string;
  redacted: boolean;
}

export interface EvidenceEmitterPlugin {
  readonly id: string;
  
  collectEvidence(runId: string): Promise<EvidencePayload[]>;
}
```

---

## 3. Worker Fleet Dispatch & Concurrency Model

When an agent profile configures multiple `worker_plugins`:
1. **Concurrency Pool**: The runtime limits active worker coroutines to `profile.budget_limits.max_concurrent_workers` (e.g. 4 for HTML-Notes research).
2. **Telemetry Envelope**: Every worker invocation creates a child trace span linked to `parentSpanId`.
3. **Partial Failure Semantics**:
   - If a worker fails with `retryable: true`, the runtime re-dispatches it within the remaining worker budget.
   - If a non-critical worker fails fatally, the coordinator receives a structured `WorkerTaskResult` with `status: "error"` and continues synthesis rather than crashing the whole run.
