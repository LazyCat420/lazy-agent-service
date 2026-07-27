# HANDOFF — retired the `python/` mirror, split the two port variables (2026-07-27)

**Deployed:** yes — see Verification below.
**Companion changes:** `lazycat-sdk` (version bump + consumer docs),
`vault-service/projects.json` (stale repo URL), `sun/.scratch/check_schemas.js`.

## What this repo is (the confusion this change removes)

One container, two names, both correct. The repo was renamed
`lazy-tool-service` → `lazy-agent-service` on 2026-07-15; the **deployed
identity deliberately stayed** `lazy-tool-service` (image, `container_name`, MCP
registration, prism attribution, telemetry `service_source`). The MCP name is a
protocol identifier — `mcp__lazy-tool-service__*` derives from it, ~195
references ecosystem-wide. See the **Names** table at the top of
`ARCHITECTURE.md`. Do not rename it.

`sun/lazy-tool-service/` had also survived the rename as an empty, root-owned
`data/charts/` directory (docker auto-creates a compose bind-mount source when
the path is missing). Deleted. There was never a second container.

## The `python/` tree is gone

It was a deploy-time mirror of `trading-service/app`, its `scripts/`,
`requirements.txt`, and `lazycat-sdk/lazycat` — 12 MB, **549 tracked files**, and
the reason the last ten commits here were all `chore(python-mirror): sync …`.

**It never ran.** Verified eight ways:

1. `Dockerfile` stage 2 copies only `node_modules`, `dist`, `package.json`,
   `tool_schemas.json`, `public` onto a bare `node:22-slim` — no interpreter.
2. The only subprocess calls in all of `src/` are `ffmpeg` (`utils/media.ts`) and
   `git` (`harnesses/lifecycle/SandboxExecutor.ts`). Nothing spawns python.
3. `PYTHON_INTERPRETER` / `PYTHON_EXEC_SCRIPT` / `PYTHON_CWD` / `PYTHONPATH` in
   `config.ts` had **zero importers**.
4. The container path they pointed at (`/opt/venv/bin/python`) is never created.
5. `LocalToolRouter.ts` already said so: the `spawn execute_tool.py` bridge "could
   never run in the Node-only container and was removed".
6. `execute_python` the *tool* goes over HTTP — `/utility/python/stream`.
7. Nothing outside this repo read `lazy-agent-service/python/**`.
8. `deploy-kit/lib.sh` ships the image only (`docker save | ssh docker load`).

Changes: `deploy.sh` `PRE_BUILD()` python-staging block deleted; `python/` added
to `.gitignore` and `git rm -r --cached`'d; the dead python config block removed
from `config.ts`; `ARCHITECTURE.md`'s "Python Layer" section replaced.

**Do not reinstate it** without also adding Python to the Dockerfile.

## Two ports, two variables (was one variable, two meanings)

`LAZY_TOOL_SERVICE_PORT` defaulted to `7778` in `config.ts` but `5591` in
`PrismRegistrationService.ts`. With the deployed env (which sets it to 5591), the
self-referential `LAZY_TOOL_SERVICE_URL` resolved to `localhost:5591` — **a port
nothing listens on inside the container**, where the bind is 7778.

Now:

| Variable | Meaning | Default |
|---|---|---|
| `PORT` | host-side publish port for compose | 5591 |
| `LAZY_TOOL_BIND_PORT` | what this process listens on in-container | 7778 |
| `LAZY_TOOL_SERVICE_PORT` | external port advertised to prism/siblings | 5591 |

`LAZY_TOOL_SERVICE_URL` is no longer read from the environment — it is derived
from the bind port as `http://127.0.0.1:<bind>`. `src/index.ts` now imports
`LAZY_TOOL_BIND_PORT` from `config.ts` instead of re-reading `process.env`.

Also fixed: `src/providers/lm-studio.ts` hardcoded
`DEFAULT_MCP_SERVER_URL = "http://lazy-tool-service:7778"` — docker-DNS by
`container_name`, silently coupled to `IMAGE_NAME`, and unresolvable across
compose projects anyway (no shared `networks:` block exists in this ecosystem).
It now uses the loopback `LAZY_TOOL_SERVICE_URL`; it is our own `/mcp` endpoint.

## Verification

- `pnpm run typecheck` / `lint` / `test` green; `deploy.sh --dry-run` green.
- `tool_schemas.json` byte-identical before and after (`md5 af6a0b3b…`) — this is
  the contract behind all 83 tools, so it must not move.
- Post-deploy: `:5591/health` ok; prism `GET /mcp-servers` still shows exactly one
  row, `lazy-tool-service` → `:5591/mcp/sse`, `connected: true`, **`toolCount: 83`**.
- `docker ps` checked *after* deploy — a healthy endpoint is not a healthy
  container.

## Gotcha for next time

`vault-service/projects.json` is **gitignored** (it holds secrets), so the catalog
fix there is a live working-tree edit that only reaches the NAS via
`vault-service`'s own deploy — and this repo's `PRE_BUILD` copies it in at build
time. If you change it, deploy vault-service too or the change is local-only.
