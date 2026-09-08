# Trading tool fixes and benchmark — September 7, 2026

The four findings in the [tool audit](trading-tool-audit-2026-09-07.md) are repaired in lazy-agent-service. Prism source and deployment are unchanged. The changes restore tool authorization, cycle attribution, current whiteboard reads and truthful MCP failure flags.

## Runtime changes

- Only an explicit set of reusable market/research reads uses the generic cache and in-flight coalescing. Writes, mutable collaboration/account state, composite tools and unknown tools execute independently under the existing concurrency cap. A missing ticker's caller-context fallback participates in the cache key. Returned failures, including JSON-string failures, are not cached.
- The owned request proxy issues a signed, expiring capability containing the role, cycle, ticker, conversation and exact requested tool whitelist. The model shim removes this metadata before inference and attaches it to completed tool-call arguments after generation. Prior tool-call capabilities are removed from subsequent model input. Both buffered and streamed responses are supported; streamed content/reasoning and usage remain visible, while tool arguments wait for a complete finish event.
- REST and MCP use the same capability validator before dispatch. Valid signed context survives process restarts without an in-memory role registry. Identified trading calls without valid authorization are refused. Cycle-scoped whiteboard/peer tools cannot fall back to whichever cycle happens to be active. Legacy non-trading MCP consumers receive a signed connection scope through the supported MCP registration API; that scope never overrides a supplied invalid trading capability. This is role enforcement within the existing trusted application boundary, not a redesign of all ingress authentication.
- A shared result classifier sets MCP `isError` consistently and classifies REST telemetry/cache behavior. Empty successful reads remain successful. Signed values are stripped before downstream execution and redacted from REST argument logs.

The signing key uses `TRADING_TOOL_CONTEXT_KEY` if configured, otherwise the existing `TRADING_SERVICE_API_KEY` (verified configured on the NAS). Capabilities last at most the issued 24-hour lifetime. Key rotation invalidates existing capabilities and connection scopes; reconnect through the normal registration workflow. Trading requests need the SDK's agent/conversation fields and the harness's existing `## Cycle` / `## Ticker` headings for cycle-scoped execution. Generic REST compatibility and other tool-specific policies remain separate from this trading capability contract.

## Measured results

Baseline is commit `c35fbd7`. The benchmark invokes each revision's actual MCP handler, local router, bridge cache and concurrency guard. All tool HTTP is intercepted by an in-memory fixture with a fixed 3ms backend delay; no production tools, account operations or learning writes occur.

| Controlled workload | Before | After |
|---|---:|---:|
| All five checks, 30 repetitions each | 30/150 pass | 150/150 pass |
| Required write in second cycle | 0/30 completed | 30/30 completed |
| Read sees completed whiteboard write immediately | 0/30 | 30/30 |
| Read recovers after one transient provider failure | 0/30 | 30/30 |
| Unauthorized write blocked | 0/30 | 30/30 |
| Healthy burst: 40 equivalent reads | 30/30; one backend request each | 30/30; one backend request each |

The initial fast check deliberately ends at the immediate follow-up read. A separate time-to-correct-result benchmark lets **both versions complete the same handoff**, using the real default 60-second TTL and one-second polling. All three pairs completed:

- Before: 60.145s, 60.136s, 60.136s; 61 poll attempts each.
- After: 0.00567s, 0.00501s, 0.00496s; one poll each.
- Both versions performed three backend operations in each full workflow (initial read, write, final fresh read). The speed difference is removal of the stale cache's waiting/repeated requests, not omission of backend work. This establishes a causal improvement for this incident condition; it does not establish how often the condition occurs in live cycles.

Healthy 40-read burst median elapsed time was 6.884ms before and 8.499ms after in this local fixture. That roughly 1.6ms increase per burst includes the new authorization work. Writes and fresh reads also take more time than an incorrect cached acknowledgment because the required operation now runs. Do not interpret the overall synthetic pass rate or the handoff timing as a percentage improvement in full-cycle trading speed.

The [numeric export](benchmarks/trading-tool-fix-2026-09-07.json) contains all 300 component measurements and six handoff timings. The component uses one capability per role request and identical arguments in both versions. An earlier exploratory component run minted a capability per tool call; its timing is excluded from the final comparison.

## Model replay status

A paired, model-driven workflow replay is prepared: four scenarios, two repetitions with reversed pair order, identical prompts/schemas/limits in both arms, exact token usage, required-work scoring and retained failures. See the [frozen protocol](benchmarks/trading-tool-model-protocol-2026-09-07.txt). It covers a healthy note, stale handoff, cross-cycle note and transient read failure. It is a workflow-step replay, not a complete live trading cycle or P&L experiment.

Execution is pending explicit payload approval. Automatic approval review twice rejected sending the three tool schemas and synthetic workflow instructions, despite verifying that the destination is the user's configured NAS shim and owned DGX. No model requests ran. There is therefore no measured token saving or overall cycle-latency improvement to report yet.

## Validation and release

- 659 tests passed across the service's 30 test files, including regression tests replacing all original defect characterizations.
- Typecheck and production build passed.
- Streaming tests cover fragmented UTF-8, interleaved calls, failure flags, truncation refusal, usage preservation and the actual shim → dispatch → bridge path in both stream modes.
- The tool-only benchmark's worker processes close on completion. No test browsers or audio processes are used.
- Deployed runtime commit `3add6e9` using `deploy-kit`: `npm run deploy -- --only=lazy-tool-service --skip-pull`. Transfer, restart and health checks completed successfully on September 7 at 20:03 PDT. Only the affected service deployed.
- Running NAS image: `sha256:4efee988ce94f8c41a033dd362c4350050ccf20fc18865a5be1254bfe98f70f0`; container status `running/healthy`, HTTP `/health` returned `status=ok`.
- Live MCP smoke test listed 91 tools and refused a signed call outside its empty whitelist with `isError=true` / `PERMISSION_DENIED`. The nonexistent target could not execute a production operation. The test-owned MCP connection was closed.
- Boot logs confirmed the coding, trading and HTML Notes MCP registrations reconnected through the supported API. Deployed `TradingToolContext.js` and `LocalToolRouter.js` SHA-256 values matched the local validated build.
- Deploy-kit also reported DNS reconciliation conflicts; its affected-service deployment result was one passed / zero failed and Caddyfile unchanged. The verified service uses its existing NAS address. No unrelated DNS changes were made as part of these tool fixes.

Remaining limitation: an adapter timeout still does not prove that an underlying write was cancelled. Mutations are no longer globally coalesced; do not retry an ambiguous timed-out write as if no side effect occurred. A durable operation-id contract would be separate work.
