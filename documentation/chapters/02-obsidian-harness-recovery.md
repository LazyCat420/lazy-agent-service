---
part: Runtime
status: verified
updated: 2026-10-06
review-by: 2026-11-06
---

# Obsidian harness admission and recovery

The Obsidian client persists an idempotency key, accepted run ID, replay cursor, and each local tool observation before acknowledging it. A delivery interruption resumes the same run through the existing scoped event replay API. A started mutation without a saved observation pauses for inspection. Transport failures never restart the goal through another agent path.

## Runtime changes

- `POST /v1/runs/:runId/tools/:callId/verify` verifies the persisted signed receipt and every scope/argument field before the client performs a local effect. The route enforces existing vault, profile, project and user scope. Signing material remains on the backend.
- `runtime_overrides.detached_delivery=true` keeps execution alive when an SSE client disconnects. Explicit cancellation and server duration/tool/token budgets still apply. Other clients retain disconnect cancellation by default.
- Receipt-bound tool errors are persisted and returned as model-visible errors for repair, with `tool.failed` telemetry. Policy rejection and invalid admission still fail closed.
- `POST /obsidian-completions/:id/cancel` aborts only the matching scoped durable model job. The terminal cancellation response is persisted, so fetching the same request ID cannot restart it.
- The Obsidian profile admits outlines, section reads/patches and undo. It supports the served `GLM-5.3-Flash-EXL3-TF` model while retaining the older alias. Obsidian application context is user data; it cannot grant new tools or change system policy.

## Compatibility and limits

The profile version remains 1.0.0 because the additional tools are additive. Deploy the service before the plugin: an older backend lacks pre-effect verification and the upgraded client will pause safely. An application reload preserves delivery but a service restart can invalidate a pending local waiter; this remains an explicit stopped outcome, not a replay of an uncertain write. Replaying a saved result acknowledges it without executing it again.

Verification does not make arbitrary filesystem effects transactional. The plugin uses exact paths, revision checks, Obsidian's atomic process callback, persisted undo records and final artifact checks. User intent and content quality are graded separately in the LLMSortObsidian outcome benchmark.

## Validation

Contract checks cover receipt tampering, inactive admission, replay, cross-vault verification, detached disconnect behavior, idempotent acknowledgements and scoped model-job cancellation. TypeScript checking and runtime build passed; all 47 tests in seven selected contract/service suites passed on October 6. After integration, all 916 backend tests passed through the deploy-kit workflow.

The first live shared check caught a wire-format defect in the new verifier: the persisted in-memory receipt had `approval_id: undefined`, while HTTP/SSE correctly omitted that optional field. Exact field comparison now uses the JSON representation of both receipts, preserving every defined field and rejecting additions or tampering. The regression test covers both direct acknowledgements and the JSON round trip. All 917 tests passed after this correction and again during the corrected deploy-kit release.

## Live NAS verification

The corrected release deployed on October 6 as container commit `812cbb6`, running and healthy. `http://10.0.0.16:5591/health` returned `{"status":"ok"}`. The deployed Obsidian profile SHA-256 matched the primary checkout: `56d7b29d4fdb03090011bd939272cb408dd39ac6b7b10835d70408ca92724549`.

[Shared recovery evidence](documentation/artifacts/obsidian-recovery-20261006.json) records a real fixture-vault section edit through the live NAS. After losing an acknowledgement, a fresh client loaded the checkpoint from disk and resumed the same run. The note was modified once, with neighboring bytes preserved. Tampered receipts returned 409, cross-vault verification returned 404 and saved-result verification returned 200. A cancelled durable job retained terminal status 499 on retrieval and resubmission; another scope could not cancel it (404). No production vault data or signing credentials enter this evidence.
