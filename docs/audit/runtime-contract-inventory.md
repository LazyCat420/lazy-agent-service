# Dev 1 Audit: Shared Runtime & Canonical Contract Inventory

> **Document Type:** Audit Report & Baseline Inventory (Workstream: Dev 1 — Runtime & Contracts)  
> **Repository:** `lazy-agent-service`  
> **Date:** 2026-09-19  
> **Author:** Dev 1 (Runtime & Contracts Workstream)  
> **Status:** Phase 0 Baseline Freeze & Phase 1/2 Inventory Complete  

---

## 1. Phase 0 — Baseline Freeze

### 1.1 Immutable Baseline SHAs & Deployment State

| Repository | Primary Branch | Immutable Baseline SHA | Current Deployment Target | Verification Source |
|---|---|---|---|---|
| `lazy-agent-service` | `main` | `261819f5e054b899dca7428f8504d40f263940e8` | Synology NAS Container (`:8080`) | `git rev-parse HEAD` |
| `lazycat-sdk` | `main` | `22c3b9885a93c1c05c29646fc18dca265e319f94` | Python Package (`0.3.12`) | `git rev-parse HEAD` |
| `trading-service` | `master` | `51feb60b41fb0e4e7a39e7f5173619574ea7d779` | Synology NAS Container (`:3031`) | `git rev-parse HEAD` |
| `HTML-Notes` | `main` | `892018d956d09cd9dbc99edecb3043535628e48b` | Synology NAS Container (`:8035`) | `git rev-parse HEAD` |

### 1.2 Audit Governance & Issue Taxonomy

All audit tasks, pull requests, and contract discrepancies must use these unified board labels:
- `platform-contract`: Cross-repo public interface, schema definitions, and protocol envelopes.
- `sdk-core`: `lazycat-sdk` transport, provider resolution, SSE streaming normalization, and decoding.
- `runtime-core`: `lazy-agent-service` lifecycle, admission, execution state machine, and budget enforcers.
- `migration-trading`: `trading-service` migration off local harness/runner onto runtime contracts.
- `migration-html-notes`: `HTML-Notes` research protocol decoupling and adapter integration.
- `duplicate-behavior`: Parallel or redundant implementations across multiple repositories.
- `parity-test`: Shadow run comparisons and behavioral parity gates.
- `blocker`: Critical architectural defects preventing contract adherence.

---

## 2. Phase 1 — Shared Runtime Inventory (`lazy-agent-service`)

We evaluated the 11 core runtime dimensions of `lazy-agent-service` against active code.

### 2.1 Capability Inventory Table

| ID | Runtime Dimension | Source Path & Symbol | Behavior Summary | Active Caller(s) | Test Coverage | Current Status | Classification |
|---|---|---|---|---|---|---|---|
| `CAP-RUN-001` | **Run Request Validation & Profile Lookup** | `src/routes/RunRoutes.ts:14-20`, `src/services/ProfileRegistry.ts:23-28` | Parses `CreateRunRequest`, extracts `profileId`, checks mock dictionary for persona & default model. | External `/v1/runs` HTTP ingress | `test/contract/RunContract.test.ts` (stub) | **Implemented but bypassable** | `extract` |
| `CAP-RUN-002` | **Run Identity, Idempotency & Trace Hierarchy** | `src/platform/trace/HarnessInstrumenter.ts:59-72`, `src/routes/RunRoutes.ts:21` | Generates UUID for `runId`, binds to trace/span hierarchy via `HarnessInstrumenter`. No idempotency storage. | `RunRoutes.ts`, `AgenticLoopService.ts:59` | `src/platform/__tests__/HarnessTracePropagation.test.ts` | **Implemented but bypassable** | `extract` |
| `CAP-RUN-003` | **Context Construction & Budget Semantics** | `src/platform/context/ContextAssembly.ts:1-120`, `src/platform/context/ContextBudget.ts:1-85` | 4-layer context assembly (prefix, project scope, retrieved evidence, dynamic tail) capped at 12k tokens. | `AgenticLoopService.ts`, bypassed in `RunExecutionEngine.ts:32` | `src/platform/__tests__/PlatformArchitecture.test.ts` | **Implemented and authoritative** | `extract` |
| `CAP-TOOLS-001` | **Tool Catalog Resolution & Policy Checks** | `src/services/AgenticToolResolver.ts:1-150`, `src/routes/ExecuteRoutes.ts:58-105` | Resolves enabled tools from options/persona, checks signed capability tokens & whitelist. | `AgenticLoopService.ts`, `/execute/:toolName` | `src/services/__tests__/ToolCallGuard.test.ts` | **Implemented and authoritative** | `wrap` |
| `CAP-PROV-001` | **Model & Provider Selection** | `src/utils/ModelResolution.ts:1-80`, `src/services/RunExecutionEngine.ts:37` | Maps model names to local providers (vllm-shim, lmstudio, ollama). Engine hardcodes `vllm-shim`. | `RunExecutionEngine.ts`, `VllmModelSyncService.ts` | `src/services/__tests__/VllmModelSyncService.test.ts` | **Implemented but bypassable** | `extract` |
| `CAP-STREAM-001` | **Streaming & Event Protocol** | `src/routes/RunRoutes.ts:28-52`, `src/types/run.ts:17-35` | Emits SSE `RunEvent` stream (`run.created`, `run.started`, `run.completed`). | `POST /v1/runs` | None (stub test) | **Defined by contract only** | `extract` |
| `CAP-RUN-004` | **Retry, Timeout, Cancellation & Failure Classification** | `src/services/harnesses/lifecycle/ToolRetryInterceptor.ts`, `src/routes/RunRoutes.ts:87-96` | Retries transient tool errors; `POST /:runId/cancel` returns mock json without propagating AbortSignal. | `ReActHarness.ts`, `/v1/runs/:runId/cancel` | `src/services/__tests__/ToolRetryInterceptor.test.ts` | **Defined by contract only** | `extract` |
| `CAP-EVIDENCE-001`| **Evidence Persistence, Redaction & Receipts** | `src/platform/verify/RunEvidenceStore.ts:12-77`, `src/platform/contracts/manifest.ts:12-72` | Bounded per-run span store (500 spans max); builds `ContextReceipt` and `ReplayManifest`. | `DeterministicVerifiers.ts`, omitted in `RunExecutionEngine.ts:50` | `src/platform/__tests__/PlatformArchitecture.test.ts` | **Implemented and authoritative** | `extract` |
| `CAP-STATE-001` | **State Persistence & Crash Recovery** | `src/services/ToolContext.ts:1-120`, `src/wrappers/MongoWrapper.ts` | Saves tool and conversational state in MongoDB per conversation. No resume for halted runs. | `AgenticLoopService.ts:74` | Active characterization tests | **Duplicated in a consumer** | `extract` |
| `CAP-METRICS-001`| **Per-Run Metrics & Usage Accounting** | `src/platform/contracts/telemetry.ts:1-60`, `src/services/RunExecutionEngine.ts:54-59` | Telemetry exporter captures spans; `RunResult` currently zeroes out prompt/completion tokens. | `TraceExporter.ts`, `HarnessInstrumenter.ts` | `src/platform/__tests__/HarnessTracePropagation.test.ts` | **Implemented but bypassable** | `extract` |
| `CAP-ORCH-001` | **Multi-Worker Orchestration** | `src/services/orchestrator/TopologyRouter.ts`, `src/services/orchestrator/routers/` | Subagent routers (CriticLoop, Sequential, Tournament). Missing in `/v1/runs` execution engine. | `OrchestratorRoutes.ts` | Active router tests | **Missing** | `extract` |

---

## 3. Phase 2 — Capability Overlap Matrix (Dev 1 Rows)

| Capability ID | Capability Name | Current Authority | Trading Copy (`trading-service`) | HTML-Notes Copy (`HTML-Notes`) | SDK Copy (`lazycat-sdk`) | Architectural Decision | Migration Owner |
|---|---|---|---|---|---|---|---|
| `CAP-RUN-001` | Run Identity & Idempotency | `RunRoutes.ts` (partial UUID) | In-cycle `cycle_id` / `run_id` in `cycle_main.py` | Local session ID in `app/main.py` | None | **Globalize to Runtime**: Canonical UUIDv7 + `idempotency_key` cache in `lazy-agent-service`. | Dev 1 |
| `CAP-RUN-002` | Run State Machine & Lifecycle | `AgenticLoopState.ts` | State machine in `app/v3/agent_runner.py` | `ResearchCoordinator` state in `coordinator.py` | `AgentLoop` in `agent.py` | **Globalize to Runtime**: Deterministic 6-state machine (`ADMITTED → RUNNING → WAITING_FOR_TOOL/WORKER → COMPLETED | FAILED | CANCELLED | TIMED_OUT`). | Dev 1 |
| `CAP-RUN-003` | Deadline & Cancellation | None (mock in `RunRoutes.ts:90`) | Hardcoded cycle timeout & signal handler | Thread cancellation in research coordinator | Async timeout wrapper in `llm.py` | **Globalize to Runtime**: Central `AbortController` registry with deadline propagation across SDK & tools. | Dev 1 |
| `CAP-TOOLS-001` | Tool Schema & Policy Enforcement | `ToolSchemaService.ts`, `ExecuteRoutes.ts` | `tool_whitelists.py`, `tool_selector.py` | `tools_schema.py`, sibling test checkout | `tool_registry.py`, `tool_executor` | **Globalize to Runtime**: Versioned `tool-contract-v1.json` package; runtime enforces allow/deny gates. | Dev 1 |
| `CAP-STREAM-001`| Streaming Event Normalization | `RunRoutes.ts` (ad-hoc SSE) | None (REST / polling) | SSE generator in `app/routes/message.py` | SSE iterator in `lazycat/sse.py` | **Define Seam**: `lazycat-sdk` normalizes wire tokens; `lazy-agent-service` emits canonical `RunEvent` envelope. | Dev 1 + Dev 2 |
| `CAP-EVIDENCE-001`| Evidence, Receipts & Lineage | `RunEvidenceStore.ts`, `manifest.ts` | `board_evidence.py`, `dossier_sync.py` | `ledger.py` (research entries) | Trace metadata in response wrapper | **Globalize Envelope**: Common `ContextReceipt` & `ReplayManifest` in runtime; domain data as plugin attachments. | Dev 1 + Dev 3 |
| `CAP-ORCH-001` | Worker Orchestration SPI | `TopologyRouter.ts` (chat subagents) | Specialist fan-out in `orchestrator.py` | `coordinator.py` + 5 research workers | None | **Globalize SPI**: Generic `WorkerPlugin` SPI in runtime with bounded concurrency and shared token budget. | Dev 1 |
| `CAP-DEPLOY-001`| Deployment Configuration & Profiles | `ProfileRegistry.ts` (mock) | Dockerfile + hardcoded agent definitions | Dockerfile + JSON app actions | `pyproject.toml` | **Globalize Manifest**: Declarative `AgentProfile` manifest loaded by runtime at boot; no runtime code rebuilds. | Dev 1 |

---

## 4. Architectural Findings & Key Risks

1. **The Bypassable Gateway Anti-Pattern**:  
   `lazy-agent-service` contains battle-tested context assembly (`ContextAssembly.ts`), evidence recording (`RunEvidenceStore.ts`), and trace telemetry (`HarnessInstrumenter.ts`), but `RunExecutionEngine.ts` completely bypassed them in the initial cut. Real application traffic cannot enter without hitting a second local harness until this seam is unified.
2. **Sibling Repository Path Coupling**:  
   `HTML-Notes` tests depend on resolving `../lazy-agent-service/tool_schemas.json` from the filesystem. This breaks continuous integration across distinct worktrees and isolated containers. The runtime must distribute versioned schema artifacts.
3. **Redundant Agent Loops Across All 4 Repositories**:  
   Four distinct agent loops exist concurrently (`RunExecutionEngine.ts` in agent-service, `agent.py` in SDK, `agent_runner.py` in trading-service, `orchestrator.py` in HTML-Notes). To break this cycle, `lazycat-sdk` must become a pure transport/client library, while `lazy-agent-service` becomes the authoritative runtime.

---

## 5. Dev 1 Action Plan

1. **Publish Canonical Contracts**:
   - `docs/contracts/agent-runtime-contract-v1.md`
   - `docs/contracts/agent-profile-spec-v1.md`
   - `docs/contracts/agent-plugin-spi-v1.md`
   - `docs/contracts/consumer-adoption-checklist.md`
2. **Upgrade Contract Test Suite**:
   - Upgrade `test/contract/RunContract.test.ts` into a fully executable Vitest suite validating run isolation, budget limits, cancellation, idempotency, and profile enforcement.
