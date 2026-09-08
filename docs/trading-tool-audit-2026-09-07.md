# Trading tool execution audit — September 7, 2026

Continuation of the trading memory/rule audit, performed without subagents. Inspected lazy-agent-service runtime HEAD `7908bc5` and trading-service `cacc3003`. This batch examines REST/MCP dispatch, caller context, Python bridge caching and failure envelopes. It is not a complete audit of every tool implementation or a measurement of live incident frequency. No production execution, database write, model request or Prism modification occurred.

## Findings

### P1: Bridge cache can suppress a write in a different cycle

`src/services/LocalToolRouter.ts:49` keys its cache by tool name and arguments only, checks it before dispatch, and caches successful results at line 116. There is no read/write permission distinction. Context (cycle, agent and ticker attribution) is outside the key. Default TTL is 60 seconds (`config.ts:133`). In-flight coalescing also uses this same key.

The actual `whiteboard_write` implementation in trading-service `app/tools/whiteboard_tools.py` derives cycle from execution context, rather than a schema argument. Identical ticker/section/content/author arguments in two cycles therefore represent separate writes. The offline bridge test requests these writes with different cycle contexts: only one mocked HTTP call occurs and the second receives the first cycle's success object. This proves suppression at the bridge; it does not prove a production write has been lost. Concurrent overlap or another request within TTL is necessary.

Repair direction: explicitly classify state-changing tools and bypass generic result caching/coalescing for them. If a write supports retry deduplication, use a deliberate operation identity with destination scope and durable semantics. Context-sensitive reads need cycle/identity in their cache keys. Do not remove concurrency protection for expensive reads.

### P1: MCP dispatch lacks the REST role check and drops caller context

`src/services/McpAdapter.ts:136` invokes `routeLocalTool(toolName, toolArgs)` without its third context argument. It does not consult the session whitelist used by `ExecuteRoutes.ts:115`. `createMcpServer` receives no caller identity; the MCP transport session is not a registered trading role session. The offline handler test confirms dispatch of an unlisted synthetic name to the mocked router, with exactly two arguments.

For bridge tools this produces empty agent/ticker/cycle attribution (`LocalToolRouter.ts:95`). The receiving trading endpoint resolves a cycle fallback, then calls the registry with `skip_permission_check=True` (`app/routers/agent_tools_router.py`). It does not restore the missing role whitelist at that handoff. Tool-specific validation still applies, and a nonexistent name can fail later; this is not a claim that arbitrary tools necessarily succeed or that the endpoint is unauthenticated. Upstream tool visibility can reduce exposure but is not execution authorization.

Repair direction: one owned dispatch authorization contract across REST and MCP. Bind verified trading role/session identity before execution; recover legitimate context explicitly and refuse identified trading calls with absent authorization. Preserve non-trading compatibility deliberately. Implement only on our side of Prism's supported interfaces.

### P2: Successful whiteboard writes do not invalidate cached reads

The same generic bridge cache returns an earlier empty `whiteboard_read` after a successful `whiteboard_write` for that ticker/cycle. The offline test models the underlying board changing and confirms the second read never reaches it. This can hide newly available collaboration evidence until TTL expiry. Cross-cycle reads have the additional missing-scope issue above.

Repair direction: bypass the generic cache for mutable collaboration state, or implement versioned scoped reads with write invalidation. A market-data TTL cannot be applied indiscriminately to a shared working document. This mechanism could resemble missing research to an agent, but the audit does not attribute the earlier benchmark's failures to it: that replay used offline fixtures.

### P2: MCP resolved failures lose the protocol error flag

`McpAdapter.ts:136` converts all resolved results to a text content block, without classifying failure. The test supplies `{error: "offline failure", is_error: true}`; the returned text retains the failure but the MCP envelope has no `isError`. Thrown exceptions and deadline timeouts do set it. REST has a separate `classifyToolResult` implementation, so the two paths disagree.

Repair direction: share a failure-envelope classifier and propagate `isError` for returned failures while preserving their payload. Empty successful results must remain successful. This finding concerns protocol metadata; it does not mean the model cannot read the embedded error, or prove that every consumer records it as success.

## Validation and limits

Four offline characterizations passed in two files:

- `src/services/__tests__/McpAuditCharacterization.test.ts`: actual handler construction with mocked SDK registration and mocked local routing; unlisted dispatch/context and returned-failure envelope.
- `src/services/__tests__/BridgeCacheAuditCharacterization.test.ts`: actual bridge/cache code with globally mocked fetch; cross-cycle write suppression and stale read after write.

Run: `npx vitest run src/services/__tests__/McpAuditCharacterization.test.ts src/services/__tests__/BridgeCacheAuditCharacterization.test.ts` after initializing Linux nvm. These tests intentionally describe current defective behavior; passing is reproduction, not a safety guarantee. Convert their expectations to desired behavior when implementing fixes. No servers or browsers are started, and no production telemetry is emitted.

Previously reported REST unknown-session fail-open behavior remains present. This batch extends that finding to the separate MCP path. Remaining useful audit areas include schema/catalog parity, per-tool error representations and caching, tool-name normalization, role-aware repeat limits, cancellation of timed-out writes, and live traffic attribution. These are follow-up areas, not established findings in this report.

Only tests and this report changed; no deployable runtime changed, so no NAS restart is required.
