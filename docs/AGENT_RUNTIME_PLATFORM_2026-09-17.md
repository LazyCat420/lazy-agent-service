# Shared Agent-Runtime Platform & Phase 0 Inventory (2026-09-17)

## Phase 0: Memory, Context, Trace, & Injection Inventory

| Path / System | Owner | Writer | Reader | Storage Location | Scope | Prompt Injection & Budget | Provenance Fields | Freshness / Expiry | Test & Status |
|---|---|---|---|---|---|---|---|---|---|
| **Lifecycle Memory** | `lazy-agent-service` | `LifecycleMemory` | `ContextAssembly` | In-memory / MongoDB `agent_memories` | `user`, `project`, `task`, `agent` | Retrieved evidence layer (Max 2500 tokens) | `source_ref`, `source_type`, `observed_at`, `verified_at` | TTL: 7 days default; transitions to `REVALIDATE` | `PlatformArchitecture.test.ts` (Active) |
| **Repository Map** | `lazy-agent-service` | `RepositoryMapService` | `ContextAssembly` | File cache / In-memory | `project`, commit SHA | Scoped project layer (Max 2000 tokens) | Git commit SHA, tree hash | Invalidated on commit SHA change | `PlatformArchitecture.test.ts` (Active) |
| **Context Receipt** | `lazy-agent-service` | `ContextAssembly` | Telemetry exporter | Execution metadata | `task`, `run` | N/A (Emitted post-assembly) | SHA-256 layer hashes, selected memory IDs | Execution duration | `PlatformArchitecture.test.ts` (Active) |
| **Trace Spans** | `lazy-agent-service` | `HarnessInstrumenter` | `TraceExporter` | NAS `telemetry-service` / In-memory ring buffer | `run`, `task`, `trace` | N/A (Telemetry) | `trace_id`, `span_id`, parent span, `run_id` | Ring buffer max 10,000 spans; NAS persistent | `PlatformArchitecture.test.ts` (Active) |
| **Replay Manifest** | `lazy-agent-service` | `ReplayManifestBuilder` | NAS `telemetry-service` | NAS artifacts store / Local disk | `run`, `incident` | N/A (Telemetry/Replay) | Checkpoint hashes, tool event logs | Permanent artifact | `PlatformArchitecture.test.ts` (Active) |

## Phase 1: Boundary & State Machine

- **Ownership Boundary**:
  - `lazy-agent-service`: Exclusively owns general user, project, coding, workflow, and tool memory.
  - `trading-service`: Exclusively owns ticker, market, policy, position, execution, and outcome memory.
  - Zero cross-domain leakage: General memory cannot enter trading prompts; trading ticker memory cannot enter general coding prompts.
- **Memory Lifecycle**:
  `OBSERVED → CANDIDATE → VERIFIED → ACTIVE → REVALIDATE`
  (With terminal states `SUPERSEDED`, `RETIRED`, `REJECTED`).

## Phase 2: Context Assembly Layers & Budget Allocation
- **Layer 0 (Immutable Prefix)**: System persona, safety rules, output schema (Budget: 2,000 tokens).
- **Layer 1 (Scoped Project Layer)**: Approved procedures, selected tool schemas, repository map (Budget: 3,500 tokens).
- **Layer 2 (Retrieved Evidence Layer)**: Verified memories, workflow checkpoints, evidence excerpts (Budget: 2,500 tokens).
- **Layer 3 (Dynamic Tail)**: User task, current state, latest tool outputs (Budget: 4,000 tokens).
- **Total Envelope**: Hard bounded at 12,000 tokens max per prompt assembly.
