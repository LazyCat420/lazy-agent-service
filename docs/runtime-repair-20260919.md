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
- Approvals have no resolution command yet; tools requiring approval are denied. Restart recovery preserves failure and effects; it does not resume an in-flight model process.
- Required trading financial/market validators and researcher worker plugins must be registered before those profiles can run. Their declarations no longer silently pass.
- Full generated-model parity, resumable event replay, aggregate retry/usage coverage, and the other consumer cutovers remain release gates. Do not remove legacy loops or enable further applications based on this batch alone.
- Preserve the trading-service 20-replay/canary gate. Obsidian entrypoint selection, Music job parity and Wallgarden completion-only parity require their own subsequent application releases.

Validation and deployment evidence are recorded in the session's release report; a successful build alone is not a deployed-workflow result.
