# Canonical Contract Ownership & Architecture Standard (v1.1.0)

> **Status:** Authoritative Standard  
> **Date Adopted:** 2026-09-19  
> **Authority:** `lazy-agent-service` (Dev 1 Workstream)  
> **Supersedes:** `app/schemas/tool-contract-v1.json` (HTML-Notes duplicate), `tools_schema.py` (historical), legacy monolithic flat schemas.

---

## 1. Architectural Authority Division

The core principle governing agent contracts across the ecosystem is:

> **Make capabilities global when their semantics are app-neutral; make resource access, policy, state, and presentation application-owned.**

| Layer | Canonical Owner | Responsibilities & Artifacts |
|---|---|---|
| **Shared Execution Runtime** | `lazy-agent-service` | Run lifecycle (`admitted`, `running`, `completed`, `failed`, `cancelled`, `timed_out`), queueing, cancellation, deadlines, retries, idempotency, context assembly, receipts, evidence records. |
| **Canonical Contract Definitions** | `lazy-agent-service` (`docs/contracts/`) | `run-contract-v1.json` (v1.1.0), `global-capabilities-v1.json`, `agent-profile-spec-v1.json`, exported contract bundle `contracts-bundle-v1.1.0.json`. |
| **Global Capability Providers** | `lazy-agent-service` | Pure and app-neutral retrieval: `global.web.search`, `global.web.read_page`, `global.data.transform`, `global.data.sort`, `global.data.filter`, `global.data.extract`. |
| **Application Profiles & Bindings** | Each application repo (`HTML-Notes`, `trading-service`, etc.) | Profile manifests pinning role, permitted capabilities, app tool bindings, model constraints, and execution budgets. |
| **Application Domain Tools** | Owning application | Notes CRUD, note linking, canvas read/write/upsert, widget creation, trading order execution, portfolio state. |
| **Presentation & UX** | Owning application | Widget rendering, canvas DOM reconciliation, browser SSE framing, UI components. |

---

## 2. Tool Taxonomy & Effect Model

Tools are strictly namespaced to prevent capability leakage and clarify resource ownership:

```text
global.<domain>.<action>     → Pure or generic retrieval capability owned by lazy-agent-service
html_notes.<domain>.<action> → HTML-Notes resource/canvas mutation owned by HTML-Notes
trading.<domain>.<action>    → Trading order/market tool owned by trading-service
```

### Effect Classifications
Every tool declares its side-effect safety classification:
- `read`: Side-effect-free retrieval or pure in-memory calculation (e.g. `global.web.search`, `global.data.sort`).
- `write`: Stateful creation or modification of application data (e.g. `html_notes.notes.create`, `html_notes.canvas.upsert_widget`).
- `destructive`: Irreversible or high-consequence state alteration (e.g. `html_notes.canvas.remove_widget`, `trading.orders.submit`). Requires confirmation or strict policy gating.

### Data Transformation vs. Mutation Rule
`global.data.*` capabilities (`transform`, `sort`, `filter`, `extract`) are **strictly pure in-memory JSON operations** (`effect: "read"`). They take bounded JSON inputs and return transformed JSON outputs. They **never** receive raw database connections, file handles, or arbitrary state mutation authority.

---

## 3. Contract Distribution (Zero Sibling-Directory Coupling)

To guarantee that no microservice or container fails due to missing neighboring git checkouts:
1. **HTTP Endpoints**:
   - `GET /v1/contracts/spec`: Returns specification metadata and version.
   - `GET /v1/contracts/capabilities`: Returns the list of registered global capabilities.
   - `GET /v1/contracts/bundle`: Returns the self-contained contract bundle JSON containing all schemas and capabilities.
2. **Build Distribution**:
   - `scripts/export-contracts.mjs` compiles schemas into `dist/contracts/` and `dist/schemas/`.
3. **Application Consumption**:
   - Client applications (HTML-Notes, Trading Client) pin `contract_version: "1.1.0"` and consume contracts via HTTP or SDK models (`lazycat-sdk`), maintaining only application-owned tool manifests.

---

## 4. Historical Reference Pointer

The following files and approaches are formally superseded:
- `HTML-Notes/app/schemas/tool-contract-v1.json`: **Superseded**. HTML-Notes must maintain only its local domain tool manifest and profile bindings; global contracts are consumed from `lazy-agent-service`.
- `lazy-agent-service/tool_schemas/`: Historical per-domain build inputs; replaced by versioned contract schemas.
- `lazy-agent-service/ARCHITECTURE.md` sections referencing `build_tool_schemas.py` are marked historical.
