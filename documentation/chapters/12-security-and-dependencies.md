---
part: Governance
type: reference
status: verified
updated: 2026-11-15
last-verified: 2026-11-15
review-by: 2026-12-15
covers: lazy-agent-service:src/services/MCPClientService.ts, lazy-agent-service:src/services/AgenticToolResolver.ts, lazy-agent-service:src/boot/healthProbe.ts, lazy-agent-service:src/routes/ExecuteRoutes.ts, lazy-agent-service:src/services/WebExtractService.ts, lazy-agent-service:src/services/harnesses/CodeInterpreter.ts, lazy-agent-service:package.json, lazy-agent-service:Dockerfile, lazy-agent-service:scripts/rotate-execute-key.sh, lazy-agent-service:config.ts, lazy-agent-service:src/routes/McpServersRoutes.ts, scraper-service:scraper_main.py, scraper-service:requirements.txt, spark-console:requirements.txt, tts-service:requirements.txt
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
| Trading tool-surface isolation | `AgenticToolResolver` unlocks core tools and strips unrequested `CORE_AGENTIC_TOOLS` (`search_web`), `CORE_ORCHESTRATOR_TOOLS`, and `system` tools in trading contexts (`T3`, `f10b64d`) | `TradingToolResolverIsolation.test.ts` |
| Read every env var | sandbox gets an empty env; allowlisted stdio servers get a sentinel-checked env, never `process.env` wholesale | `McpStdioGuard.test.ts`, `buildStdioEnv` |
| Reach internals via URL | `url_guard` private-address checks + redirect re-checks | see SSRF below |
| Point an MCP row at an internal URL | `httpRefusalReason` + `MCP_HTTP_ALLOWLIST` | `McpStdioGuard.test.ts` (TCK-1019) |

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
it.

## sse / streamable-http MCP guard (SSRF, TCK-1019)

The same shape guards the network transports. `httpRefusalReason(row)` in
`MCPClientService.ts` refuses an `sse` or `streamable-http` row when its URL is missing or
unparseable, is not `http:`/`https:`, carries credentials (`user:pass@`), or names an internal
host: `localhost`, `*.localhost`, `*.internal`, `0.0.0.0/8`, `127/8`, `10/8`, `172.16/12`,
`192.168/16`, `169.254/16` (cloud metadata), `::1`, `::`, `fc00::/7`, `fe80::/10` and
IPv4-mapped IPv6 forms of all of these. Scheme and credential refusals are absolute; the only
way past the internal-host check is `MCP_HTTP_ALLOWLIST` in
`config.ts`: comma-separated hosts or origins from the `MCP_HTTP_ALLOWLIST` env var, plus the
origin of `LAZY_AGENT_SERVICE_PUBLIC_URL`. A refused URL gets:

- `403` on `POST /mcp-servers` and on `PUT /mcp-servers/:id` when the effective row (stored
  values plus the update) would be refused — `PUT enabled:false` without a URL change stays
  allowed, as for stdio rows;
- `McpHttpRefusedError` from `connect()` and again in `createTransport` (mapped to `403` on
  `/:id/connect`); boot auto-connect (`connectAllFromDB`) skips refused rows.

LAN MCP servers (`10.0.0.x`) therefore need their host on `MCP_HTTP_ALLOWLIST` before they will
connect. Proof: the `sse / streamable-http SSRF guard (TCK-1019)` block in
`McpStdioGuard.test.ts` (refused URL shapes on POST/PUT/connect, and an allowlisted stub that
does connect).

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

Outbound fetch (web extract, scrape_url) resolves against private-address blocks before the
request, and MCP `sse`/`streamable-http` rows pass the guard above; the trading bridge additionally enforces per-run scrape budgets —
dead URLs are recorded dead for the run, refused without re-charging, and the per-run maps
(including known-dead entries) are pruned with the other run state (`a989f16`). Text that is not
a URL is not charged to the budget (`174db2a`). Redirect hops are re-checked on the scraper side
(httpx response hook, Playwright document guard, and post-redirect `UNSCRAPABLE_DOMAINS` check)
against metadata endpoints like `169.254.169.254` (crawl4ai was removed from `scraper-service`
2026-11-04). `scraper-service` also bounds per-worker request concurrency through `AdmissionGate`
(`SCRAPER_ADMISSION_INFLIGHT=8`, `SCRAPER_ADMISSION_WAITING=16`, fast `429` + `Retry-After: 5`)
and shares per-domain pacing across workers via SQLite WAL `rate_limiter.db` (`C3`, `C4`).
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
appearing in command output, and `healthProbe.ts` strips URL credentials before exposing upstream
addresses on `GET /health` (`S-13`). Never open or print `.env*` from tooling or docs.

## Dependency policy

Updates are lockfile-level and smallest-declared-range first; no source churn rides along, and
no `pnpm.overrides` are used. Audit posture (measured, 2026-10-22 `bb00c0d`): **1 critical / 26
high / 43 moderate / 5 low → 0 / 0 / 4 / 0**. The 4 remaining moderates were
`decode-uri-component` and `stream-json` under the unused `minio` direct dependency (removed in
Wave 4A along with `express-rate-limit` and `@opentelemetry/sdk-trace-base`). Recurring bumps:
`@modelcontextprotocol/sdk` pinned (1.32.1), `undici ^8.12.3`, `vitest`, transitive
`proxy-addr`/`fast-uri`/`qs`/`brace-expansion`; `zod ^4.6.6` and relocked `body-parser 2.4.0`
(2026-11-04, `5b970c9`). `vite` is declared as a direct devDependency purely to force vitest off
a stale transitive patch. A dependency-only change does not need its own redeploy; it ships with
the next landing-batch deploy. Validation before landing: `pnpm run typecheck` + full suite under
`testrun` (identical pass count to the previous `main`).

## Known gaps (tracked, not hidden)

- MCP `sse`/`streamable-http` rows are guarded by host, not authenticated: an allowlisted host
  is trusted for any path on it (TCK-1019 closed the internal-address SSRF, not authentication).
- tts-service and spark-console have no API authentication (below).
- prism-service reads the same `prism.mcp_servers` collection; its handling of a stdio row is
  outside this guard (prism-side, Rod's repo — not editable here).

## The sibling services' boundaries

| Service | Who can call it | Guard | Secrets it needs |
|---|---|---|---|
| scraper-service `:8001` | lazy-agent-service, trading-service, LAN | `X-Scraper-Key` on `/scrape`, `/scrape/batch`, `/collect`, `/stream/*` — `hmac.compare_digest` against `SCRAPER_API_KEY`; health routes stay open for Docker's `wget` probe | `SCRAPER_API_KEY` (shared with lazy-agent-service and trading-service), `SEC_USER_AGENT` (SEC Edgar identity, refused with a clear error when unset) |
| spark-console `:8800` / `:8801` | operator browser, ComfyUI guard hook, the workstation usage timer | none on the API; reachability is the UFW rule set on goldspark (LAN `10.0.0.0/24` on 8800/8000/8001/8188/7681, fabric subnets `192.168.177.0/24` and `192.168.178.0/24`) | SSH keys to the boxes it powers and reconciles; Kasa/Home Assistant plug access |
| tts-service `:3032` | HTML-Notes' `/tts/synthesize` proxy and other LAN clients | none; input is sanitised (non-word symbols stripped before Piper) and the synth engine reads no files | none |

scraper-service's key is keyed on the **presence** of `SCRAPER_API_KEY`, not a flag: with no key
set it is open, so a rollout sets the key in the callers first and in the scraper last, and a live
trading cycle never sees a 401 mid-sweep. lazy-agent-service sends the header only when its own
`SCRAPER_API_KEY` is set (`WebSearchService.ts`, `WebExtractService.ts`).

spark-console's `POST /api/render-permit` tears the serving LLM down for any caller that can
reach it, and `POST /api/box/{box}/{action}` powers boxes. Both are LAN-only by firewall, not by
credential — the gap is listed above; do not publish `:8800` or `:8801` beyond the LAN.

### Sibling dependency policy

All three are `python:3.11-slim` images with exact pins in `requirements.txt`:

- **scraper-service** — `fastapi 0.161.0`, `starlette 1.9.0`, `httpx 0.28.1`, `playwright 1.61.0`
  + `playwright-stealth`, `trafilatura`, `feedparser`, `yt-dlp 2026.10.21`,
  `youtube-transcript-api`, `twscrape`. `yt-dlp` is the one that must move often (site changes
  break it); bump it alone and rerun `tests/`.
- **spark-console** — `fastapi 0.161.0`, `uvicorn 0.54.0`, `starlette 1.9.0`, `websockets 17.3`;
  everything else is the standard library, on purpose, because the same file runs as a host
  systemd unit and in the NAS gateway container.
- **tts-service** — `piper-tts 1.2.0`, `onnxruntime 1.18.1`, `numpy 1.26.4`. onnxruntime is
  pinned because 1.18.1's memory-pattern optimisation corrupts ScatterND on the second run of a
  session; the service builds its own `InferenceSession` with `enable_mem_pattern = False`
  (`tts-service/HANDOFF.md`). An onnxruntime bump must re-run the multi-sentence repro there.
