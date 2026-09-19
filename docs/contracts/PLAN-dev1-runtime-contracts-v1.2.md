# Plan — Developer 1: Shared Runtime & Contracts v1.2

> **Repository:** `lazy-agent-service`  
> **Target Branch:** `dev1/runtime-contracts-v1.2`  
> **Worktree Path:** `.worktrees/wt-dev1-contracts-v1.2`  
> **Date:** 2026-09-19  
> **Authority:** Developer 1  
> **Status:** PROPOSED — AWAITING USER APPROVAL

---

## 1. Scope & Ownership

- **Repository:** `lazy-agent-service`
- **May edit:** `lazy-agent-service` only, plus exported contract artifacts consumed by SDK and applications.
- **Must NOT edit:** `HTML-Notes`, `lazycat-sdk`, or any of Rodrigo's repos (`prism-service`, `portal-service`, `tool-service`, `vault-service`, etc.).

---

## 2. Key Deliverables

1. **Versioned v1.2 Contract Export Package**:
   - `contracts/run-contract-v1.2.json`
   - `contracts/tool-contract-v1.2.json`
   - `contracts/capability-registry-v1.2.json`
   - `contracts/profile-contract-v1.2.json`
   - `contracts/error-codes-v1.2.json`
   - `contracts/fixtures/` (14 canonical fixtures)
2. **Capability Registry v1.2**:
   - Full metadata: `id`, `version`, `owner`, `execution`, `effect`, schemas, `timeout_ms`, `retryable`, `rate_limit_class`, `supports_evidence`, `requires_confirmation`, `requires_user_scope`.
   - 15 app-neutral capabilities registered and typed.
3. **Profile Validator v1.2**:
   - Rejection on: incompatible contract major version, unknown capability, unsupported capability version, malformed local tool declaration, unauthorized tool grants.
4. **Local-Tool Admission Contract**:
   - Distinction between runtime-executed global capabilities and admitted local application tools.
   - Emits `tool.invoked` event with `execution: "local"`, `effect`, `required_scope: { app_id, session_id }`, and `authorization_receipt`.
5. **Shared Fixtures Bundle**:
   - 14 fixtures covering text-only, web-search, local admission/completion, global/local denials, cancellation, timeout, retries, malformed events, outage, version mismatch, duplicate replay, and idempotency race.
6. **HTTP Endpoints & Export Pipeline**:
   - `GET /v1/contracts/spec`, `/capabilities`, `/bundle` serving v1.2 metadata with v1.0/v1.1 backward compatibility.
   - `scripts/export-contracts.mjs` exporting to `dist/contracts/` and `contracts/`.
7. **Test Suite**:
   - All 14 specified Dev 1 vitest test cases.
8. **Release & Migration Notes**:
   - `docs/contracts/MIGRATION-v1.1-to-v1.2.md`.
