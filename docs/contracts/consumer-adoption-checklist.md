# Consumer Adoption Checklist & Parity Gates (v1.0.0)

> **Document ID:** `consumer-adoption-checklist`  
> **Status:** Canonical Platform Standard  
> **Owner:** Dev 1 (Runtime & Contracts Workstream)  
> **Target Consumers:** `trading-service`, `HTML-Notes`, `lazycat-sdk`  

---

## 1. Universal Consumer Invariants

Before any consumer service is certified for cutover to the shared runtime, it must pass these five non-negotiable checks:

- [ ] **Invariant 1: No Direct Provider Calls Outside SDK**  
  Zero `fetch()` or `requests.post()` calls directly to vLLM, Ollama, LMStudio, OpenAI, or Anthropic endpoints from application code. All model interactions must route through `lazycat-sdk`.
- [ ] **Invariant 2: No Direct Tool Execution Outside Policy Boundary**  
  Application code must not invoke MCP tools or CLI utilities directly without passing through the runtime policy gate or signed capability context (`TOOL_CONTEXT_ARG`).
- [ ] **Invariant 3: No Local Generation of Global Run / Trace IDs**  
  Consumers must accept the runtime-assigned `run_id` and pass `x-trace-id` / `x-idempotency-key` via headers rather than minting disparate local identifiers.
- [ ] **Invariant 4: Structured Terminal Receipts Mandatory**  
  Terminal responses must parse and store the canonical `RunResult` containing `context_receipt` and `evidence_records`, rather than returning raw unverified text strings.
- [ ] **Invariant 5: Zero Sibling File-Path Contract Dependencies**  
  No code or test may inspect sibling checkout paths (e.g. `../lazy-agent-service/tool_schemas.json`). Schemas must be imported from versioned packages or fetched via runtime endpoints.

---

## 2. Consumer-Specific Migration Checklists

### 2.1 `trading-service` Migration (`Dev 2`)

- [ ] **Slice 1: Junior Analyst Parity Gate**
  - [ ] Replace local fallback stub in `app/agents/sdk_adapter.py` with typed `lazycat_sdk.Client`.
  - [ ] Run shadow comparisons on 20 historical cycle replays: assert output shape, tool policy decisions, token accounting, and latency match legacy `agent_runner.py`.
  - [ ] Verify `arithmetic-audit-verifier` executes as a `ResultValidatorPlugin`.
- [ ] **Slice 2: Specialist Inference Integration**
  - [ ] Move quant and macro specialist routing into `WorkerPlugin` implementations under `agent-plugin-spi-v1`.
  - [ ] Inherit deadline propagation: ensure cycle abort terminates all specialist tasks immediately.
- [ ] **Slice 3: Legacy Path Deprecation & Deletion**
  - [ ] Deprecate `app/agents/sdk_adapter.py` fallback mode.
  - [ ] Remove duplicate agent step loops in `app/v3/agent_runner.py` once 100% of cycle traffic passes green parity gates.
  - [ ] Log legacy deletion milestone commit.

### 2.2 `HTML-Notes` Migration (`Dev 3`)

- [ ] **Slice 1: Contract Decoupling**
  - [ ] Eliminate sibling path read in `tests/test_tool_schema_enum.py` (line 27: `parent / "lazy-agent-service" / "tool_schemas.json"`).
  - [ ] Consume tool definitions from `lazy-agent-service/dist/schemas/tool-contract-v1.json` or runtime API.
- [ ] **Slice 2: Research Protocol Decomposition**
  - [ ] Map `ResearchCoordinator` in `app/services/research/coordinator.py` to `CreateRunRequest` with profile `html-notes-researcher-v1`.
  - [ ] Migrate `NewsWorker`, `PeerSectorWorker`, `PriceWorker`, and `SkepticWorker` to implement the `WorkerPlugin` SPI.
  - [ ] Replace custom research budget tracking in `app/services/research/budget.py` with runtime `RunBudget` enforcement.
  - [ ] Unify `app/services/research/ledger.py` with runtime `ContextReceipt` and `RunEvidenceStore`.
- [ ] **Slice 3: SSE Rendering Translation**
  - [ ] In `app/routes/message.py`, translate runtime `RunEvent` stream (`message.delta`, `tool.completed`, `run.completed`) into client-facing canvas widget events.

### 2.3 `lazycat-sdk` Migration (`Dev 2`)

- [ ] **Export Canonical Typed Client**:
  - [ ] Export `Client`, `RunRequest`, `RunProfile`, `RunResult`, `RunEvent` from `lazycat/__init__.py`.
  - [ ] Wire `Client.run_agent()` to call `lazy-agent-service` `/v1/runs`.
  - [ ] Support async SSE streaming generator `Client.stream_agent()` yielding typed `RunEvent` objects.
- [ ] **Deprecate SDK Internal Agent Loop**:
  - [ ] Mark `lazycat/agent.py` `AgentLoop` as deprecated.
  - [ ] Retain tool argument decoder (`decode_tool_arguments`), SSE parser, and resilience/retry classifiers as shared utilities.

---

## 3. Parity Validation Gates

No consumer is permitted to cut over in production without passing all 8 validation gates:

| Gate ID | Name | Criteria | Verification Method |
|---|---|---|---|
| `GATE-01` | Contract Verification | Client, SDK, and runtime agree on 100% of fields in `agent-runtime-contract-v1.md`. | Automated Vitest + Pytest contract test suite. |
| `GATE-02` | Golden Fixtures | Identical inputs produce identical event sequence and status structures across 10 golden test cases. | Replay runner with JSON diff assertion. |
| `GATE-03` | Tool Policy Boundary | Unauthorized tool calls are rejected with `TOOL_PERMISSION_DENIED` and cannot broaden permissions. | Security injection tests with mock disallowed tools. |
| `GATE-04` | Failure Injection | Graceful recovery on provider timeout (504), malformed JSON, and worker crash. | Chaos injection mock server. |
| `GATE-05` | Trace Continuity | Single trace ID spans consumer ingress → runtime → SDK → tool execution → receipt. | Telemetry span verification query. |
| `GATE-06` | Usage Accounting | Token prompt/completion, tool call counts, and execution latency accurately recorded (no 0 token runs). | Receipt usage assertions. |
| `GATE-07` | Cancellation Gate | Aborting client connection terminates active LLM and tool execution within 500ms. | Vitest / Pytest async cancellation test. |
| `GATE-08` | Deployment Smoke | Container spins up and loads profiles without disk dependency on sibling source checkouts. | Docker Compose clean boot test. |
