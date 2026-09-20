# Shared runtime repair release

The September 19 repair follows the audit's staged rollout. Prism is unchanged.

Implemented in this batch:

- Strategy chat preserves partial replies and explicit outcomes, correlates the gateway conversation with the chat row, removes whole-request fallback, separates Stop from timeout, and keeps the current message once.
- Runtime admission normalizes aliases and validates effective overrides; exact profile versions, zero budgets, scoped idempotency, terminal replay, and required extension readiness are enforced.
- Local calls wait for receipt-bound observations through `POST /v1/runs/{run_id}/tools/{tool_call_id}/result`. Pending calls and acknowledgements are persisted; identical retries are acknowledged and conflicting results are rejected.
- Runtime routes require `x-runtime-token`, configured from `RUNTIME_API_TOKEN`, `RUNTIME_AUTH_SECRET`, or `INTERNAL_EXECUTE_TOKEN`. Only authenticated application backends assert project/user identity. Run inspection and cancellation enforce this ownership.
- Python and TypeScript clients handle fragmented LF/CRLF, duplicate events and premature EOF. They provide result submission without implementing a separate reasoning loop.
- Required context/verifier extensions fail readiness when absent. Local effects come from registered profile metadata. Unresolved approval requirements fail closed.
- Unimplemented media/summarization capabilities are unavailable. Unknown model usage remains null. Runtime run identity is retained by the harness.
- Interrupted runs are sealed failed on restart, preserving pending effects without automatic re-execution. Durable writes use atomic replacement.
- HTML-Notes forwards assembled history/system/focus context, returns actual local results, and cancels on consumer close. The legacy mutation-only callback cannot acknowledge completion.
- A read-only `trading-strategy-chat-v1` profile and `STRATEGY_CHAT_RUNTIME_ENABLED` switch provide the first canary path. Default remains off until parity is verified.

Compatibility and rollout gates:

- SDK source must be deployed with runtime/HTML-Notes because local acknowledgement and runtime authentication are required. Existing signed local receipts and application ownership checks remain in force.
- Runtime authentication grants trusted backend authority, not independent end-user authentication. Applications remain responsible for authenticating users before asserting identity.
- Approval resolution is implemented in the follow-up below. Restart recovery preserves failure and effects; it does not resume an in-flight model process.
- Required trading financial/market validators and researcher worker plugins must be registered before those profiles can run. Their declarations no longer silently pass.
- Generated contract checks, replay delivery, model accounting, and consumer migrations are being integrated below. Do not remove legacy loops or enable a consumer until its actual workflow passes parity.
- Preserve the trading-service 20-replay/canary gate. Obsidian entrypoint selection, Music job parity and Wallgarden completion-only parity require their own subsequent application releases.

Validation and deployment evidence are recorded in the session's release report; a successful build alone is not a deployed-workflow result.

## Follow-up integration

- Model-call accounting now wraps the provider itself, including compaction and
  repair calls. Prompt bytes plus output allowance reserve the budget
  conservatively; measured billing remains separate. Missing/partial reports
  produce null totals with measured-call coverage, including failed runs.
- Scoped desktop bearer sessions bind app, user, profile and vault session for
  at most 24 hours. A trusted backend provisions them; the signing key never
  belongs in a plugin. Local executors retain file/session authorization.
- Approval requests pause execution. The authenticated resolution command is
  bound to the exact call and arguments, persists the decision, and rejects
  conflicting duplicates. Cancellation and expiry cannot authorize execution.
- Event snapshots at `GET /v1/runs/{id}/events` accept `Last-Event-ID` or `after`.
  They deliver recorded events only and do not restart reasoning or effects.
  Closing the original run stream still cancels it. A reconnect can inspect that
  outcome; it cannot silently restart a partially executed mutation.
- Steering at `POST /v1/runs/{id}/steer` is bounded and applies at the next model
  turn. It does not undo an already admitted effect.
- Run data is now mounted at `/app/runtime-data`; deployment migrates the old
  container-layer snapshot once, preserving the prior store.

## TinyModels shadow bridge

The runtime owns the decision-provider interface and receipt store. Profiles
opt into `semantic.choice.v1` for public state only. The first automatic hook
scores public search/page observations for evidence sufficiency. Signals never
change tool availability, discard evidence, or authorize effects. All calls
have a bounded payload/deadline and one attempt. Failures record a typed
fallback and leave the primary model workflow intact. Replaying a request ID
returns its frozen receipt rather than querying the current model.

Configure `TINYMODELS_SHADOW_ENABLED=true`, `TINYMODELS_URL`, and credentials via
Vault (`JETSON_FEATURES_API_KEY`) or the runtime environment. Pin
`TINYMODELS_EXPECTED_VERSION` and `TINYMODELS_EXPECTED_DEPLOYMENT` to the reviewed
release. The supported provider contract is `decision-provider.v1`, with
`semantic.choice.v1` explicitly advertising `/v1/system1/decide`. Old feature
API responses are refused; no model availability is inferred from health or a
model catalogue. The provider response includes exact model/deployment identity,
input/output hashes, calibration state, latency, and process-unload evidence.

Read-only Jetson inspection on September 19 found commit
`cd7e9300104711068e601978ad39311c5257f6d3`, feature capability schema 1, and no
`/v1/system1/status` or `/v1/training/capabilities`. That deployment does not yet
satisfy the new decision-provider contract. Training/lifecycle changes require
its source checkout and actual worker/container acceptance; no training,
model loading, promotion, or protected Nemotron changes were attempted.
