---
part: Tools and shared services
status: shipped
updated: 2026-10-22
review-by: 2026-11-19
type: record
---

# Chapter 14 — MCP stdio guard (2026-10-22)

## Resolved tickets

| Ticket | Issue | Root cause | Fix | Commit |
|---|---|---|---|---|
| MCP-STDIO-RCE | Unauthenticated remote code execution: anyone who could reach port 5591 could `POST /mcp-servers` with `transport: "stdio"` plus a `command`/`args`/`env`, then `POST /mcp-servers/:id/connect`, and the service spawned that command with its whole environment (database URIs, API keys). | `/mcp-servers` has no auth (`AuthMiddleware` only copies identity; `clientIp` trusts `x-forwarded-for`). `PostMcpServerSchema` defaulted `transport` to `"stdio"`. `createTransport` spawned any stdio row with `{...process.env, ...row.env}`. Boot `connectAllFromDB` also launched every enabled row of `prism.mcp_servers`, which prism-service shares. | One guard in `MCPClientService` (`assertStdioAllowed`, called by `connect()` and again in `createTransport`) refuses stdio unless `command` exactly matches `MCP_STDIO_COMMANDS` (empty by default, so stdio is off) and the row env sets no `NODE_OPTIONS`/`LD_*`/`DYLD_*`. Boot skips and logs refused rows. The routes answer 403 for POST, PUT (judged on the merged row) and connect. `transport` is now required (400 without it). An allowed child gets only `PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_*` plus the row's env. | `d1deebd` |

## How it works

Every way a server gets connected goes through `MCPClientService.connect()`: the
`/:id/connect` route, boot auto-connect, `reconnect`, `authenticate` (which writes auth
into a stdio row's env) and the OAuth callback. The guard runs there before anything
else, including before an existing connection is torn down. `createTransport` repeats
the check right before the `StdioClientTransport` is built.

A PUT that only sets `enabled: false` on a refused stdio row is still allowed, so an
owner can turn off a row someone else wrote. DELETE is unchanged.

## Configuration

`MCP_STDIO_COMMANDS` (in `.env`, documented in `.env.example`): comma-separated
absolute paths, exact match. Never list an interpreter or shell (`node`, `npx`,
`python`, `sh`, `bash`): a row's `args` stay caller-controlled, so `-e` would turn it
back into code execution. Production had 0 stdio rows when this landed (6 sse, 1
disabled streamable-http).

## Tests

`src/services/__tests__/McpStdioGuard.test.ts`: refused cases use a payload that
would write a marker file, so they prove nothing was spawned. They cover POST, PUT,
connect, a non-allowlisted command with the allowlist set, and boot skipping a stdio
row while still connecting an sse row. The allowlisted case spawns a real stdio MCP
server (`fixtures/stdio-env-mcp-server.mjs`) that reports its env keys; the test checks
that no `MONGO_*`, `DATABASE_URL` or `*_KEY` variable reaches it. Also covered: a missing
`transport` gives 400, and sse create + connect plus streamable-http create still work.

## Still open

- The `/mcp-servers` routes are still unauthenticated for sse/streamable-http rows,
  so a caller can point the service at internal URLs (SSRF).
- prism-service reads the same collection. Whatever it does with a stdio row is
  outside this guard, which covers only lazy-agent-service.
- CORS is unchanged here (handled separately).
