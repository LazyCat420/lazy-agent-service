---
part: Governance
type: decisions
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/services/ToolAuthorization.ts, lazy-agent-service:scripts/export_tool_schemas.py, lazy-agent-service:src/services/MCPClientService.ts, lazy-agent-service:src/services/harnesses/CodeInterpreter.ts, lazy-agent-service:src/services/AgenticLoopService.ts, lazy-agent-service:src/services/LocalToolRouter.ts
---

# Decisions

Settled choices, each with the reason and the proof. Not edited afterwards — a changed decision
gets a new entry saying it supersedes the old one. `ADR-01`, `ADR-02` and `ADR-05` are cited
from other chapters; keep the numbers stable.

## ADR-01 — Every repo on our own harness; prism-service retired (2026-10-06 → 2026-10-31)

**Decision.** Every LazyCat420 repo runs its agents through this service's harness (`/agent`,
`/chat`, `/embed`, `/custom-agents`), never through prism-service. Prism was first demoted to
logging only (rows kept flowing to the shared `prism.requests` collection so audit readers kept
working), then removed from the stack entirely on 2026-10-31 (`ee61164`): re-dialer,
`PrismProxyService`, `PrismAttribution` and the `PRISM_MCP_*` compose variables deleted. Nothing
forwards to `:7777` anymore. Registration with prism had already gone (`f2f78a4`,
`PrismRegistrationService.ts` deleted 2026-10-16). **prism-service itself is never edited** —
it is Rodrigo Barraza's repo; Rod's projects keep using prism on their own.
**Consequences.** lazycat-sdk `harness_base_url()` strips `/prism-proxy` so no production call
can reach prism through a proxy; endpoint coverage is pinned by
`src/routes/__tests__/NativePrismExitRoutes.test.ts`; the shared `prism.custom_agents`
collection is read directly, so all 34 agents (trading V3 included) needed no migration.

## ADR-02 — One tool-schema generator (2026-10-22)

**Decision.** The shards in `tool_schemas/<owner_app>/*.json` are the source of truth and one
command, `scripts/export_tool_schemas.py`, turns them into the flat `tool_schemas.json` — and,
with `--out`, byte-identical copies into the trading repos. The two-generator state before
(which repo deployed last decided the shipped file; `news_search` lost its `owner_app` and was
miscounted as a trading tool) is closed. Unknown CLI arguments are an error; the trading
PRE_BUILD steps probe `--supports-out` and refuse a stale exporter.
**Proof.** `src/services/__tests__/ToolSchemaExport.test.ts` + `--check` gate (ch.05, ch.09).

## ADR-03 — Parity is measured through the real caller, never a log replay (2026-10-07)

**Decision.** Harness-vs-harness parity runs go through trading's own client code
(`trading-service scripts/harness/parity_check.py`), same input to both loops. Log replays from
`prism.requests` are forbidden as evidence: prism strips `systemPrompt`, `enabledTools` and
`autoApprove`, and without `autoApprove` the `ApprovalGate` burns the full
`APPROVAL_TIMEOUT_MS = 120_000` per call — the exact 120 s gaps that once masqueraded as harness
behavior. Synthetic `probe-parity-` cycles are refused cycle-escaping write tools by the bridge.

## ADR-04 — One tool-authorization decision (2026-10-16)

**Decision.** Every gate — harness approvals, `/chat` function calling, the Live API,
`/v1/runs`, plan approval, the post-write validator — funnels through the single decision
`decideToolCall` (`src/services/ToolAuthorization.ts`), fed by `PolicyEngine` rules and applied
by `ApprovalGate.authorizeToolCalls`. `AutoApprovalEngine` was removed: there is no second path
that says yes. Trading tools additionally require the signed `_lazy_trading_context`; a forged
one without the key is `PERMISSION_DENIED` (`dispatchTool` → `authorizeTradingTool` verifies the
signature).

## ADR-05 — LocalToolRouter repeat guards stay after the prism era (2026-10-31)

**Decision.** When prism-service was retired, the `LocalToolRouter` repeat-call guards from that
era were **kept** as harness-side defense-in-depth: identical read-only tool calls within a run
are reused, not re-paid (`ebdda0d` screener reuse, `260c020` `run_tool_chain` read-only reuse),
and a repeat is not a `TOOL_STALL` failure. The guards no longer protect prism's Mongo; they
protect the model's context window and the external APIs' rate limits — the same reason the
trading-run scrape/tool budgets exist (ch.03).

## ADR-06 — stdio MCP only from an operator allowlist (2026-10-22)

**Decision.** `POST /mcp-servers` + `connect` were unauthenticated remote code execution: any
caller could have the service spawn a command with the whole process environment. The fix is one
guard — `assertStdioAllowed` in `MCPClientService.connect()` (repeated in `createTransport`) —
and `MCP_STDIO_COMMANDS`: comma-separated **absolute paths, exact match**. Never list an
interpreter or shell (`node`, `npx`, `python`, `sh`): row `args` stay caller-controlled, so
`-e` re-opens the hole. Disabling a refused row (`PUT enabled:false`) stays allowed (ch.12).

## ADR-07 — code_interpreter fails closed in an OS-locked child (2026-10-11)

**Decision.** The `vm` inside the service process was not a boundary (one escape was fixed in
`6c05067`). Each snippet now runs in a fresh `node` child: `--permission` (no grants),
`--disallow-code-generation-from-strings`, 64 MB heap, empty env, cwd tmp, SIGKILL deadline,
1 MB output cap, ≤2 concurrent. A boot self-test inside a sandbox requires fs/net/dns/child/
worker/binding/codegen all denied; otherwise the interpreter reports
`CODE_INTERPRETER_UNAVAILABLE` rather than run. Image is `node:26-slim` — Node 24/22's
permission model does not lock the network. Proof is ablation: each attack must land with its
wall off and fail with it on (`scripts/benchmarks/sandbox-redteam.mts`, `340140e` + `f2701c6`).

## ADR-08 — Measured gates; verify excludes Prettier (2026-10-29)

**Decision.** Quality is executable: a claim of "done" names a command. `npm run verify`
(typecheck → lint → tests → dry → arch → prompt) blocks in CI; CRAP/complexity ratchets to
0 offenders; the ESLint `complexity` rule is **error at 20**. `verify` excludes
`prettier --check` because the repo has never been Prettier-formatted (406 files) and a mass
reformat would bury real diffs. The local pre-push hook belongs to the workspace secret
scanner, so quality enforcement lives in `.github/workflows/quality.yml`. Sensors are
deterministic and cheap: `code_health` measures submitted files in-process — no shell, FS or
network (ch.09).

## ADR-09 — Harness² follows upstream at every decision point (2026-10-22)

**Decision.** The recursive port keeps upstream's task schedule (4k-rollout/3k-stage budget,
INV/DOM split, sequential checkpoints, parallel compose) and adopts upstream's **decision
points**: the selection pool is the k finals only (a base output can no longer be "adopted"
into the lesson store), k=1 delivers the single final with no selector call, reflection and
`library.add` run only on a successful selection, an all-failed base stops with `base-failed`,
and the library never reads a task's own entry. `selectionPool: "mixed"` keeps the old pool as
an explicit opt-in. Evidence floors are upstream's (tool results ≥ 10,000 chars) with a
240,000-char mission budget before compaction. The loop is kept honest about its limits:
cross-task library transfer measured +0.00, so production agents are not silently changed by it.

## ADR-10 — Runs outlive the client (2026-10)

**Decision.** A dropped SSE connection never cancels a run. `ActiveGenerationTracker` +
`AgentSessionRegistry` own the run lifecycle independently of the HTTP connection;
`/agent/stop` is the only cancel. Obsidian completions are durable rows (`PUT
/obsidian-completions/:id`) with SSE re-attach, and the first-party chat UI re-attaches to the
durable record (`9276e3f` streams live reasoning, `activeTools` and SSE updates). Mobile clients
closing a tab in the field must never lose a trading analysis.

## ADR-11 — Catalog-first, model-agnostic harness (2026-10-29)

**Decision.** Per-model special cases come from the model catalog, not string patterns:
`getModelProfile` reads limits, effort vocabulary and "does it think" from the catalog
(family-name patterns are only the unlisted-model fallback); the openai provider's reasoning
detection and the inworld provider's TTS steering read catalog flags. An unknown model takes the
safe path (omit sampling, send `max_completion_tokens`). Qwen coder-format text tool calls are
recovered in the openai-compat path and carry the signed trading context for allowlisted tools
(`5cb9ecf`, `58f8a54`, `55d55ed`, `b87dacb`). Judges never grade their own author: `CriticGate`
picks a different model of the same provider and reports `judgeIndependent`.

## ADR-12 — /execute key: rollout before enforcement (2026-10-11)

**Decision.** `POST /execute` was LAN-open with 9 production callers. The key
(`EXECUTE_API_KEY`, 64 hex, canonical home `vault-service/projects.json` → `config`, never in
git) was deployed to every caller first — each sends `x-api-key` only when its env var is set —
and enforcement was switched on last, verified live (no key → 401, keyed → 200, one full
trading cycle with 0 denials after). Rotation is a script that never prints the key:
`scripts/rotate-execute-key.sh` (`a3944c3`, enforcement `0c1c2b3`). Rollout items that depend on
a stopped container or a human paste are reported open, never silently skipped.
