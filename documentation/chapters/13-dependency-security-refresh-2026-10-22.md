---
part: Operations
status: shipped
updated: 2026-10-22
review-by: 2026-11-19
---

# Chapter 13 — Dependency security refresh 2026-10-22

## Context
`pnpm audit` on the repo root reported 1 critical, 26 high, 43 moderate, 5 low advisories. Most were pulled in transitively (express via `@modelcontextprotocol/sdk` for `proxy-addr`, `minimatch` for `brace-expansion`, `ajv` for `fast-uri`, vitest for `vite`/`postcss`). Only lockfile-level updates and the smallest declared-range bumps were made; no source change.

## Bumps
| Package | From | To | Kind |
|---|---|---|---|
| `@modelcontextprotocol/sdk` (pinned) | 1.29.0 | 1.32.1 | direct, minor |
| `undici` | 8.5.0 (`^8.4.1`) | 8.12.3 (`^8.12.3`) | direct, range |
| `vitest` | 4.1.10 | 4.1.12 | dev, patch |
| `vite` (new direct devDependency `^8.1.6`, was transitive 8.1.4) | 8.1.4 | 8.1.6 | dev; vitest's own range allows a stale vite, so it is declared to force the patch |
| `sharp` | 0.34.5 | 0.35.5 | direct, 0.x minor (own commit; usage is only `metadata`/`resize`/`jpeg` in `src/utils/media.ts`) |
| `proxy-addr` | 2.0.7 | 2.0.8 | transitive (express), critical |
| `fast-uri` | 3.1.2 | 3.1.9 | transitive (ajv) |
| `ip-address` | 10.2.0 | 10.7.4 | transitive (express-rate-limit) |
| `brace-expansion` | 5.0.6 | 5.0.12 | transitive (minimatch/eslint) |
| `fast-xml-parser` | 5.9.3 | 5.11.2 | transitive (minio) |
| `qs` | 6.15.3 | 6.16.1 | transitive (body-parser) |
| `protobufjs` | 7.6.4 | 7.6.6 | transitive (@google/genai) |
| `hono` / `@hono/node-server` | 4.12.27 / 1.19.14 | 4.13.13 / 2.1.5 | transitive (mcp sdk) |
| `postcss`, `nanoid`, `source-map-js`, `@vitest/mocker` | | patched | transitive (vite) |

No `pnpm.overrides` were added.

## Audit before and after
| | critical | high | moderate | low |
|---|---|---|---|---|
| before | 1 | 26 | 43 | 5 |
| after | 0 | 0 | 4 | 0 |

The 4 remaining moderate advisories are `decode-uri-component` (0.2.2, via `minio` > `query-string@7`) and `stream-json` (1.9.1, 3 advisories, via `minio`). `minio` 8.0.7 is the latest release and pins both lines; the fixes need `stream-json` 3.x and `decode-uri-component` 0.4.x, which `minio` does not accept. Revisit when `minio` ships a release that bumps them.

## Validation (primary checkout, after `pnpm install --frozen-lockfile`)
- `pnpm run typecheck`: 0 errors, before and after.
- `pnpm test --maxWorkers=4`: 169 files / 1798 tests passed, identical to the baseline on the previous `main`.
- No redeploy is required for the dependency change alone; it ships with the next landing-batch deploy.
