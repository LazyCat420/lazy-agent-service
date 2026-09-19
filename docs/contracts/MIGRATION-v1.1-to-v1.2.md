# Migration Guide: Runtime Contracts v1.1 → v1.2

> **Version:** 1.2.0  
> **Date:** 2026-09-19  
> **Author:** Developer 1 (Antigravity)  
> **Target Audiences:** `HTML-Notes` (Dev 2, Dev 3), `lazycat-sdk`, and downstream service integrations.

---

## 1. Summary of Changes

Version 1.2.0 establishes a strict architectural decoupling between **shared execution runtime capabilities** and **application-owned domain resources**:

1. **Global vs Local Tool Segregation**:
   - Runtime only authorizes and executes global capabilities (`global.*`).
   - For application local tools (e.g. `html_notes.canvas.upsert_widget`), runtime authorizes, records, and emits an admitted `tool.invoked` event containing:
     - `execution: "local"`
     - `effect: "write" | "read" | "destructive"`
     - `authorization_receipt`: signed tamper-evident receipt
     - `required_scope`: `{ app_id: "html-notes", session_id: "..." }`
   - Runtime **never** attempts to execute local application code inside the runtime container.

2. **Expanded Canonical Capabilities**:
   - Expanded from 6 to 15 app-neutral capabilities with explicit metadata schemas:
     `global.web.search`, `global.web.read_page`, `global.web.fetch_metadata`, `global.data.transform`, `global.data.sort`, `global.data.filter`, `global.data.group`, `global.data.extract`, `global.data.classify`, `global.document.chunk`, `global.document.summarize`, `global.time.now`, `global.math.calculate`, `global.media.transcribe`, `global.media.describe_image`.

3. **Profile Manifest Format**:
   - Profiles now explicitly declare:
     - `allowed_global_capabilities`: list of global capabilities with optional semver constraints (e.g. `global.web.search@1.2`).
     - `allowed_local_tools`: list of application tools (e.g. `html_notes.canvas.upsert_widget@1.0`).
   - The legacy `tool_policy.whitelist` continues to be supported for backward compatibility with v1.1 profiles.

4. **Self-Contained Contract Distribution**:
   - Canonical contract bundle exported to `contracts/` and `dist/contracts/contracts-bundle-v1.2.0.json`.
   - Consumer services validate contracts over HTTP (`/v1/contracts/bundle`) without sibling filesystem dependencies.

---

## 2. Breaking Changes & Rejection Rules

The runtime rejects requests and profile manifests under the following conditions:

| Scenario | Rejection Point | Error Code |
|---|---|---|
| Incompatible Contract Major (`!= 1`) | Run Admission / Profile Load | `CONTRACT_VERSION_MISMATCH` |
| Unknown Global Capability in Profile | Profile Load | `PROFILE_VALIDATION_ERROR` / `UNKNOWN_CAPABILITY` |
| Unsupported Capability Version | Profile Load | `PROFILE_VALIDATION_ERROR` |
| Local Tool without Scope / Session ID | Tool Invocation | `SCOPE_VIOLATION` |
| Local Tool Caller `app_id` Mismatch | Tool Invocation | `SCOPE_VIOLATION` |
| Unwhitelisted Tool Invocation | Tool Invocation | `POLICY_VIOLATION` |

---

## 3. Action Items for Workstreams

### Developer 2 (`HTML-Notes` Runtime Cutover)
- Pin SDK dependency and runtime configuration to `contract_version: "1.2.0"`.
- When receiving `tool.invoked` with `execution: "local"`, verify `authorization_receipt` and `required_scope`, then dispatch to `LocalToolExecutor.execute()`.
- Do not expect runtime to execute canvas or notes tools.

### Developer 3 (`HTML-Notes` Domain Cleanup)
- Declare all local application tools in `html_notes.domain-tools.json` matching the `html_notes.<domain>.<action>` format.
- Ensure all write tools require `session_id` and `app_id`.
