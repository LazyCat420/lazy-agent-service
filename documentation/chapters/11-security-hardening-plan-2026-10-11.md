---
part: Plans
status: in-progress
updated: 2026-10-11
review-by: 2026-10-25
---

# Security Hardening Plan — the three remaining weak spots (2026-10-11)

Follows "Harness Audit Fixes + Security Bench". That chapter left three known limits. This
plan audits each one, then fixes them one at a time (plan → implement → test → land).

Labels: **CONFIRMED** = measured or read in code at the cited line; **ASSUMPTION** = to be
checked by the step that relies on it.

## 1. Audit

### W1 — code_interpreter isolation is not an OS boundary

- The interpreter runs in a `worker_threads` Worker inside the service process; a `vm`
  escape (one was found and fixed in `6c05067`) lands in the real process: its files, its
  network, its `/proc/self/environ`. CONFIRMED (code).
- Node's permission model (`--permission`, no grants), probed with `env -i`:
  - **v26.1.0**: fs read (incl. `/proc/self/environ`), child_process, worker, `net.connect`,
    `fetch`, DNS and `process.binding` all `ERR_ACCESS_DENIED`; env empty. CONFIRMED.
  - **v24.14.1**: the same probe hangs (the network is not locked). CONFIRMED.
  - The container runs **`node:22-slim`** (`Dockerfile:6,26`), so it has no network lock. CONFIRMED.
  - `--disallow-code-generation-from-strings` applies process-wide, so even a leaked
    outer-realm `Function` cannot compile; `vm` and stdin still work. CONFIRMED.
  - `node:26-slim` is published (2026-10-08); the suite already runs on 26 locally; the one
    native dep (sharp 0.34) ships prebuilt binaries. CONFIRMED.

### W2 — scraper-service follows redirects without re-checking them

- Source of truth is `trading-service/app/scraper` (copied in by `scraper-service/deploy.sh:19-49`). CONFIRMED.
- `core/url_guard.py:check_url` resolves and blocks private targets, but only for the
  initial URL (`api/routes/scrape.py:60,120`). CONFIRMED.
- httpx client `follow_redirects=True` (`core/session_manager.py:67-71`): a public URL that
  302s to `169.254.169.254` is fetched. CONFIRMED (code).
- Playwright (`engines/playwright_engine.py:186-207`) and crawl4ai follow redirects and
  load sub-resources with no host check. CONFIRMED (code).
- No other agent is editing `app/scraper` (trading-service `master` @ `1843da70`, no
  scraper commits since 2026-10-09). CONFIRMED.

### W3 — `POST /execute` is LAN-open

- `requireExecuteKey` exists but is off while `EXECUTE_API_KEY` is unset. CONFIRMED.
- 9 production callers, none sends a key: html-notes `app/services/search.py:70,406`,
  `news_pipeline.py:361`; LLMSortObsidian `free_web_search.ts:243,439`, `settings.ts:463`;
  treesearch `src/shared_web_search.py:22`; trading-client `app/services/web_search.py:51`;
  lazycat-sdk `grounded_research.py:93`, `tools.py:70` (the `ToolExecutor` trading-service
  uses); bittle-agent `app/research_tools.py:173`. CONFIRMED.
- Deployed secrets come from `deploy-kit/.env.deploy`, copied as each service's `.env`;
  services with `env_file: .env` get a new key automatically; html-notes needs an explicit
  compose line; the Obsidian plugin needs a setting. CONFIRMED.

## 2. Plan (in order)

**Item 1 — W1 sandbox process** (lazy-agent-service)
1. Each snippet runs in a fresh `node` child: `--permission` (no grants),
   `--disallow-code-generation-from-strings`, 64 MB heap, empty env, cwd tmp; SIGKILL at
   the deadline; 1 MB output cap; at most 2 at once. Inside it, the `vm` context from `6c05067`.
2. A startup self-test runs inside a sandbox and requires fs, net, dns, child_process,
   worker, binding and codegen all denied with an empty env; otherwise the interpreter
   **fails closed** (`CODE_INTERPRETER_UNAVAILABLE`).
3. Dockerfile → `node:26-slim` (both stages).
4. **Red-team ablation suite** (the "can we get hello world out?" test): for each wall —
   vm context, process-wide codegen ban, permission model, empty env — run the attack that
   wall is meant to stop with that wall **switched off** (it must land: "hello world"
   reaches a local listener / file / spawned `echo` / planted secret) and **switched on** (it
   must not). A wall whose attack never lands even when it is off is reported as unproven.
   Accept: every wall proven; full suite green; live container probe shows the sandbox
   available on Node 26.

**Item 2 — W2 scraper redirects** (trading-service `app/scraper`, then scraper-service redeploy)
1. httpx: `follow_redirects=False` loop (or a request event hook) that runs `check_url` on
   every hop.
2. Playwright: route every request (navigations, redirects, sub-resources) through the host
   check; abort private targets.
3. crawl4ai: same hook if it exposes one, else refuse private-resolving redirects by
   checking the final URL and dropping the content.
4. Tests: public→302→metadata refused for each engine. Accept: live `/scrape` of a
   redirect-to-private URL returns an error.

**Item 3 — W3 `/execute` key** (deploy-kit + 6 consumer repos, enforcement last)
1. Generate the key into `deploy-kit/.env.deploy` and `vault-service/.env` (never in git).
2. Every caller sends `x-api-key` from `EXECUTE_API_KEY` when set (harmless while the
   server does not enforce): lazycat-sdk `ToolExecutor` + `grounded_research`, html-notes,
   treesearch, trading-client, bittle-agent; Obsidian plugin gets an "Execute key" setting.
3. Deploy the callers; check each still works.
4. Only then set `EXECUTE_API_KEY` on lazy-tool-service and redeploy; live-check that an
   unkeyed call gets 401 and each caller still gets results.
5. Obsidian: enforcement waits until the plugin update with the key setting is installed;
   until then the plan stops at step 3 for that consumer (reported, not silently skipped).

## 3. Status

- Item 1: in progress.
- Items 2–3: not started.
