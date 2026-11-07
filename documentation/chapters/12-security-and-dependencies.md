---
part: Governance
type: reference
status: verified
updated: 2026-11-06
last-verified: 2026-11-06
review-by: 2026-12-06
covers: lazy-agent-service:src/services/MCPClientService.ts, lazy-agent-service:src/routes/ExecuteRoutes.ts, lazy-agent-service:src/services/WebExtractService.ts, lazy-agent-service:src/services/harnesses/CodeInterpreter.ts, lazy-agent-service:package.json, lazy-agent-service:Dockerfile, lazy-agent-service:scripts/rotate-execute-key.sh
---

# Security and dependencies

This service is the workspace's agent gateway: one Express process on the NAS at `:5591`
holding database URIs, provider keys, and the trading bridge. The rule at every boundary is the
same — caller-controlled things (commands, URLs, keys, snippets) need an explicit, minimal
allowlist, and each boundary's proof is a named test or script (ch.09).

## Trust model (honest version)

`AuthMiddleware` copies identity headers (`x-project`, `x-username`) for scoping; it does **not**
authenticate. The service is a LAN/NAS deployment, so what protects it is defense-in-depth at
each capability, not a login:

| Capability | Boundary | Proof |
|---|---|---|
| Spawn a process | stdio MCP allowlist | `McpStdioGuard.test.ts` |
| Run arbitrary JS | permission-locked sandbox child, fails closed | `sandbox-redteam.mts` |
| Spend external API budget | `EXECUTE_API_KEY` on `/execute`; per-run scrape/tool budgets on trading runs | `ExecuteApiKey.test.ts`, budget tests in `src/core/loop/__tests__/` |
| Trade | signed `_lazy_trading_context`; unsigned/forged → `PERMISSION_DENIED` | `NativeTradingBoundary.test.ts` |
| Read every env var | sandbox gets an empty env; allowlisted stdio servers get a sentinel-checked env, never `process.env` wholesale | `McpStdioGuard.test.ts`, `buildStdioEnv` |
| Reach internals via URL | `url_guard` private-address checks + redirect re-checks | see SSRF below |

## stdio MCP guard

One guard: `assertStdioAllowed` in `MCPClientService.connect()` — called by the `/:id/connect`
route, boot auto-connect (`connectAllFromDB`), `reconnect`, `authenticate` and the OAuth
callback — and repeated in `createTransport` right before `StdioClientTransport` is built. A row
is refused unless its exact `command` is on `MCP_STDIO_COMMANDS` (comma-separated absolute paths,
documented in `.env.example`). Never list an interpreter (`node`, `npx`, `python`, `sh`, `bash`):
a row's `args` stay caller-controlled and `-e` re-opens code execution. `PUT enabled:false` on a
refused row is still allowed so an owner can turn someone else's row off. The refused-path tests
use a payload that would write a marker file and prove nothing was spawned; the allowlisted test
spawns a real fixture server and asserts no `MONGO_*`, `DATABASE_URL` or `*_KEY` variable reaches
it. **Open (TCK-1019):** `sse`/`streamable-http` rows are still unauthenticated, so a caller can
point the service at internal URLs (SSRF) — filed in the ledger, not fixed here.

## /execute and the execute key

`POST /execute` (Exa web search + scrape proxy used by html-notes, LLMSortObsidian, treesearch,
trading-client, lazycat-sdk, bittle-agent) is gated by `requireExecuteKey`
(`src/routes/ExecuteRoutes.ts`): when `EXECUTE_API_KEY` is set, no key → 401, wrong key → 401,
`x-api-key` or `Authorization: Bearer` → 200. The key's canonical home is
`vault-service/projects.json` → top-level `config` (plus the deploy-kit and vault master `.env`
copies that deploys copy); **never in git**. Rotation is
`scripts/rotate-execute-key.sh` — writes all four places, restarts the vault, redeploys,
verifies 401/200, copies to clipboard, never prints the secret (`--no-deploy` writes only).

## SSRF: fetch and scrape

Outbound fetch (web extract, scrape_url, MCP `sse` connects) resolves against private-address
blocks before the request; the trading bridge additionally enforces per-run scrape budgets —
dead URLs are recorded dead for the run, refused without re-charging, and the per-run maps
(including known-dead entries) are pruned with the other run state (`a989f16`). Text that is not
a URL is not charged to the budget (`174db2a`). Redirect hops are re-checked on the scraper side
(httpx response hook, Playwright document guard) against metadata endpoints like
`169.254.169.254`; **crawl4ai remains a documented residual** (it is not in the default ladder).
A repeated read of the same URL within a run is reused, not re-fetched (ADR-05).

## Snippet execution

`code_interpreter` never runs inside the service process (ADR-07): fresh `node` child per
snippet with `--permission` and no grants, `--disallow-code-generation-from-strings`, empty env,
64 MB heap, SIGKILL deadline, 1 MB output cap, ≤2 concurrent, and a boot self-test that disables
the tool outright if any capability probe comes back allowed. Image is `node:26-slim` in both
Dockerfile stages — the permission model only locks the network on 26.

## Secrets and config hygiene

`.env.example` documents every variable (`MCP_STDIO_COMMANDS`, `EXECUTE_API_KEY`, provider
URLs); production reads secrets from the vault/deploy-kit chain. `9810c4f` locked CORS to an
explicit origin allowlist, hard-failed on a missing API key in production, and removed the
hardcoded credential from `config.ts`. DB-name inputs pass the `BAD_DB_NAMES` guard (parity with
trading-service's `clean_db_name`, `a8a3319`). The MCP OAuth/execute keys rotate without ever
appearing in command output. Never open or print `.env*` from tooling or docs.

## Dependency policy

Updates are lockfile-level and smallest-declared-range first; no source churn rides along, and
no `pnpm.overrides` are used. Audit posture (measured, 2026-10-22 `bb00c0d`): **1 critical / 26
high / 43 moderate / 5 low → 0 / 0 / 4 / 0**. The 4 remaining moderates are
`decode-uri-component` and `stream-json`, both pinned by `minio` 8.0.7 (latest), which will not
accept the fixed lines — revisit when `minio` ships. Recurring bumps:
`@modelcontextprotocol/sdk` pinned (1.32.1), `undici ^8.12.3`, `vitest`, transitive
`proxy-addr`/`fast-uri`/`qs`/`brace-expansion`; `zod ^4.6.6` and relocked `body-parser 2.4.0`
(2026-11-04, `5b970c9`). `vite` is declared as a direct devDependency purely to force vitest off
a stale transitive patch. A dependency-only change does not need its own redeploy; it ships with
the next landing-batch deploy. Validation before landing: `pnpm run typecheck` + full suite under
`testrun` (identical pass count to the previous `main`).

## Known gaps (tracked, not hidden)

- `TCK-1019` — unauthenticated `sse`/`streamable-http` MCP rows (SSRF).
- crawl4ai redirect re-check (documented residual; default ladder is guarded).
- prism-service reads the same `prism.mcp_servers` collection; its handling of a stdio row is
  outside this guard (prism-side, Rod's repo — not editable here).
