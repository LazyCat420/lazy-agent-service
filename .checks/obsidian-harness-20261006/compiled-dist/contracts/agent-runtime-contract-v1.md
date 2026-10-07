# Agent Runtime Contract Specification (v1.0.0)

> **Document ID:** `agent-runtime-contract-v1`  
> **Status:** Canonical Platform Standard  
> **Owner:** Dev 1 (Runtime & Contracts Workstream)  
> **Target Service:** `lazy-agent-service`  
> **Target SDK:** `lazycat-sdk`  
> **Consumers:** `trading-service`, `HTML-Notes`, future agent microservices  

---

## 1. Overview & Architectural Boundaries

This contract establishes the **canonical public protocol** for executing agents within the ecosystem.

```text
Consumer Service (Trading / HTML-Notes)
       │ (HTTP / SSE with typed lazycat_sdk.Client)
       ▼
Shared Agent Runtime (lazy-agent-service)
  ├─ Admission Gate & Idempotency Cache
  ├─ Deterministic Execution State Machine
  ├─ 4-Layer Context Assembly & Budget Enforcer
  ├─ Canonical Tool Policy Gate
  ├─ Active Run Registry (Cancellation & Deadline Propagation)
  └─ Deterministic Terminal Receipt & Evidence Store
       │
       ▼
Shared Transport SDK (lazycat-sdk)
  ├─ Provider Resolution & Model Connection
  ├─ Wire Stream & Chunk Normalization
  └─ Tool Call Argument Parsing & Validation
```

---

## 2. Deterministic Run Lifecycle & State Machine

Every agent execution follows this immutable state transition graph:

```text
                     ┌──────────────────┐
                     │    (INGRESS)     │
                     └────────┬─────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │     ADMITTED     │
                     └────────┬─────────┘
                              │ Validated Profile & Budget
                              ▼
                     ┌──────────────────┐
        ┌───────────►│     RUNNING      │◄───────────┐
        │            └────────┬─────────┘            │
        │                     │                      │
        │ Tool/Worker Yield   │                      │ Tool/Worker Resumed
        │                     ▼                      │
        │            ┌──────────────────┐            │
        └────────────┤ WAITING_FOR_TOOL │────────────┘
                     │   / WAITING_WORK │
                     └────────┬─────────┘
                              │
     ┌────────────────────────┼────────────────────────┬────────────────────────┐
     │ Success                │ Fatal Error            │ Abort Signal           │ Deadline Hit
     ▼                        ▼                        ▼                        ▼
┌──────────────┐      ┌──────────────┐         ┌───────────────┐        ┌───────────────┐
│  COMPLETED   │      │    FAILED    │         │   CANCELLED   │        │   TIMED_OUT   │
└──────────────┘      └──────────────┘         └───────────────┘        └───────────────┘
```

### State Definitions
1. **`ADMITTED`**: Run request has been validated against profile schema, assigned a canonical UUIDv7 `run_id`, idempotency key registered, and execution scheduled.
2. **`RUNNING`**: Execution active within runtime loop; LLM prompt evaluated or response streamed.
3. **`WAITING_FOR_TOOL`**: Engine suspended pending asynchronous tool completion or human-in-the-loop approval.
4. **`WAITING_FOR_WORKER`**: Engine suspended awaiting fan-out worker or child subagent completion.
5. **`COMPLETED`**: Terminal success. Output validated against schema, receipts sealed, evidence flushed.
6. **`FAILED`**: Terminal failure. Non-retryable error, unrecoverable exception, or retries exhausted.
7. **`CANCELLED`**: Terminal cancellation triggered by client `AbortSignal` or explicit cancellation API.
8. **`TIMED_OUT`**: Terminal deadline expiration. Hard ceiling elapsed before reaching terminal outcome.

---

## 3. Wire Protocol & REST/SSE Endpoints

### 3.1 Start Run: `POST /v1/runs`

#### Headers
- `Content-Type: application/json`
- `x-idempotency-key`: String (optional, UUID recommended; guarantees single execution within 1h TTL)
- `x-trace-id`: String (optional; correlation ID propagated from consumer)
- `x-deadline-ms`: Number (optional; maximum wall-clock run duration in ms)
- `x-agent-role`: String (optional; caller agent identity for attribution)

#### Request Payload (`CreateRunRequest`)
```json
{
  "$schema": "https://specs.lazycat.local/v1/run-request.schema.json",
  "profile_id": "trading-analyst-v1",
  "profile_version": "1.2.0",
  "input": [
    {
      "role": "user",
      "content": "Evaluate Q3 semiconductor balance sheet data."
    }
  ],
  "runtime_overrides": {
    "model": "qwen-coder-32b",
    "sampling_temperature": 0.2,
    "budget": {
      "max_tokens": 8192,
      "max_tool_calls": 10,
      "max_retries": 3,
      "max_duration_ms": 60000
    }
  },
  "additional_tools": [
    {
      "name": "fetch_financial_statement",
      "description": "Fetches 10-Q statements"
    }
  ],
  "stream": true
}
```

### 3.2 SSE Event Envelope (`RunEvent`)
When `stream: true`, the runtime responds with `text/event-stream`. Each chunk adheres strictly to:

```text
event: <RunEventType>
data: {"id": "evt-01...", "run_id": "run-01...", "type": "...", "timestamp": "...", "data": {...}}
```

#### Event Type Taxonomy
- `run.admitted`: Run received and assigned `run_id`.
- `run.started`: Context assembled and LLM iteration 1 begun.
- `message.delta`: Token chunk from provider LLM (normalized text / reasoning tags).
- `message.completed`: Full assistant turn complete with parsed tool calls.
- `tool.invoked`: Policy gate validated; tool execution started with call ID.
- `tool.completed`: Tool returned successfully with content hash and latency.
- `tool.failed`: Tool failed (retryable or fatal).
- `worker.dispatched`: Worker plugin invoked (parallel branch).
- `worker.completed`: Worker plugin finished.
- `run.completed`: Terminal receipt sealed, usage computed, final messages included.
- `run.failed`: Terminal failure with structured error payload.
- `run.cancelled`: Terminal cancellation confirmed.

### 3.3 Terminal Result (`RunResult`)
```json
{
  "run_id": "run-0191eb70-8f92-7f2a-8d6a-9828dca73891",
  "status": "completed",
  "profile_id": "trading-analyst-v1",
  "messages": [
    {
      "role": "assistant",
      "content": "Semiconductor liquidity ratios remain above historical baseline."
    }
  ],
  "usage": {
    "prompt_tokens": 1840,
    "completion_tokens": 420,
    "total_tokens": 2260,
    "tool_calls_count": 2,
    "retry_count": 0,
    "duration_ms": 3210
  },
  "context_receipt": {
    "receipt_id": "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "total_chars": 7320,
    "layer_hashes": {
      "prefix": "sha256-a1b2...",
      "project_scope": "sha256-c3d4...",
      "retrieved_evidence": "sha256-e5f6...",
      "dynamic_tail": "sha256-g7h8..."
    }
  },
  "evidence_records": [
    {
      "evidence_id": "ev-01...",
      "source": "mcp__lazy-tool-service__fetch_statement",
      "provenance_hash": "sha256-9a8b...",
      "redacted": false
    }
  ],
  "error": null
}
```

### 3.4 Inspect Run: `GET /v1/runs/:runId`
Returns the active state or cached terminal `RunResult`. If run is still active:
```json
{
  "run_id": "run-0191eb70-8f92-7f2a-8d6a-9828dca73891",
  "status": "running",
  "current_turn": 3,
  "started_at": "2026-09-19T10:00:00.000Z",
  "deadline_at": "2026-09-19T10:01:00.000Z"
}
```

### 3.5 Cancel Run: `POST /v1/runs/:runId/cancel`
Triggers immediate cancellation of active execution via `AbortController`.
- Cancels provider streaming connection.
- Aborts executing tool subprocesses or HTTP requests.
- Returns `{ "ok": true, "run_id": "run-01...", "status": "cancelling" }`.

---

## 4. Error Taxonomy & Failure Classification

Errors returned by `/v1/runs` and emitted in `run.failed` must use `StructuredError`:

```typescript
export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  category: "CLIENT" | "RUNTIME" | "PROVIDER" | "TOOL" | "POLICY" | "RESOURCE";
  details?: Record<string, unknown>;
}
```

### Canonical Error Codes
| Error Code | HTTP Status | Category | Retryable | Description |
|---|---|---|---|---|
| `PROFILE_NOT_FOUND` | 404 | CLIENT | False | Specified `profile_id` does not exist in registry. |
| `INVALID_RUN_REQUEST` | 400 | CLIENT | False | Schema validation failed on input parameters. |
| `IDEMPOTENCY_CONFLICT` | 409 | CLIENT | True | Concurrent run active under identical idempotency key. |
| `TOOL_PERMISSION_DENIED` | 403 | POLICY | False | Agent attempted to call tool disallowed by profile whitelist. |
| `BUDGET_EXCEEDED` | 422 | RESOURCE | False | Token limit, tool call count, or duration ceiling exceeded. |
| `DEADLINE_EXCEEDED` | 504 | RESOURCE | False | Run wall-clock duration exceeded `x-deadline-ms`. |
| `PROVIDER_UNAVAILABLE` | 503 | PROVIDER | True | Upstream LLM provider returned 5xx or connection refused. |
| `PROVIDER_MALFORMED_OUTPUT`| 502 | PROVIDER | True | Provider output could not be parsed as valid message or tool payload. |
| `RUN_CANCELLED` | 499 | CLIENT | False | Run explicitly terminated via AbortSignal or cancel API. |
| `TOOL_EXECUTION_FAILED` | 500 | TOOL | False | Tool raised unhandled exception and retries were exhausted. |

---

## 5. Idempotency Semantics

1. When `x-idempotency-key` is supplied:
   - The runtime records the key in an in-memory/MongoDB key map with status `RUNNING`.
   - If a duplicate request arrives while the initial run is `RUNNING`, the runtime responds with HTTP 409 `IDEMPOTENCY_CONFLICT` containing the existing `run_id`.
   - When the run transitions to a terminal state (`COMPLETED` or `FAILED`), the final `RunResult` is cached against the idempotency key for 1 hour.
   - Subsequent requests with the same key within 1 hour immediately return the cached `RunResult` without re-executing.
2. If `x-idempotency-key` is omitted, the runtime generates a fresh `run_id` and executes immediately.

---

## 6. Deadline & Cancellation Propagation

1. **Ingress**: When `x-deadline-ms` is received, the runtime computes `deadline_at = Date.now() + deadline_ms`.
2. **Internal Timer**: A hard timer is set. If reached before terminal state, `AbortController.abort()` fires with reason `DEADLINE_EXCEEDED`.
3. **Propagation**:
   - `lazy-agent-service` passes `signal: abortController.signal` into `lazycat-sdk` HTTP transport.
   - Any spawned worker or tool execution receives the signal.
   - On abort, streaming connections close immediately, avoiding stranded GPU compute.

---

## 7. Versioning & Compatibility Rules

1. **Version Format**: Semantic versioning `MAJOR.MINOR.PATCH` (current: `1.0.0`).
2. **Additive Changes**: Adding optional request fields or new `RunEvent` types is non-breaking (minor bump).
3. **Breaking Changes**: Changing existing event schemas, removing fields, or altering state machine transitions requires a major bump (`v2`) and parallel route support (`/v2/runs`).
4. **Contract Artifact Distribution**: This contract must be exported as JSON Schema (`run-contract-v1.json`) and committed to `lazy-agent-service`, where consumers validate against it.
