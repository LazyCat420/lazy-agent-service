---
part: Agent loop and harness
status: shipped
updated: 2026-10-26
type: record
---

# Harness Audit Fixes + Security Bench (2026-10-11)

> **Docs audit 2026-10-26: still shipped.** All 17 commits this record cites are
> ancestors of `origin/main` (`a0ac42b`), and no commit since 2026-10-11 reverts any
> of them. `review-by` removed: a shipped record is a claim about the past. Phases C
> and D are tracked in the audit chapter ("Harness Audit + Handoff Plan").

Fixes every lazy-agent-service defect in the audit chapter (D1–D11 and the PARTIAL commit
verdicts), plus one sandbox escape the branch's own security review found. Phases C
(moving consumers off prism) and D (agent-quality evals) of the audit plan are **not** in
this change.

## 1. What changed

| Audit item | Fix | Commit |
|---|---|---|
| D3 code interpreter in the service process | Runs in a `worker_threads` Worker (empty env, 64 MB heap, terminate on deadline) inside a `vm` context with no host objects and string/wasm codegen off. Goes through the approval gate; refused on profile-admitted `/v1/runs`. | `c8b3ddb` |
| Security review: thenable escape | Worker called a snippet-returned `then` with worker-realm callbacks (whose `.constructor` reaches the real `process`). Promise settling and serialization now run inside the context through locked helpers; the worker only reads a JSON string. | `6c05067` |
| D6 SSRF | New `src/utils/UrlSafety.ts`: every resolved A/AAAA must be public (adds `0.0.0.0/8`, `100.64/10`, reserved, multicast, IPv4-mapped, NAT64); each redirect hop re-checked; connect-time lookup re-validates the dialled address (DNS rebinding); body read under a byte cap. Used by `read_page`, `fetch_metadata` (model headers no longer forwarded) and as a DNS pre-check in WebExtract. | `4bdc302` |
| D2 offload not retrievable | One process-wide store (`getSharedOffloadStore`), one file per id, memory miss reads the id's file, unique tmp names, legacy file migrated. | `1adaa8a` |
| D1 direct trading runs die | Catalog fallback advertises tools under the profile's admitted name; `trading-analyst-v1` gets four `trading.*` read tools with a `local_tool_policy`. | `4bea7da` |
| D5/D7 web path bypass | `routeLocalTool` (the chokepoint for `/execute`, trading dispatch and MCP) answers `scrape_url` with the shared extractor; `web_search` there honours `siteSearch`, domain filters and abort. A failed prompted extract is `success:false`. | `0a75729` |
| D10 reasoning dropped | Assistant tool turns send `reasoning_content` back (`ROUND_TRIP_REASONING=0` disables). | `7bf3a56` |
| D8 search cancellation | Shared backend job with its own AbortController, aborted only when the last waiter leaves; entry kept until settle; status `cancelled` → `CAPABILITY_CANCELLED`. | `e81dfea` |
| D4 live tail | Resumes after the replayed snapshot, polls serially, ends idle orphans (`RUN_TAIL_IDLE_MS`, 10 min). | `277db15` |
| D9 /chat stop | No `conversationId` ⇒ disconnect aborts; registry cleanup removes only its own entry. | `f50083f` |
| D11 lows | Role alternation matches `tool_call_id` and keeps images; stored extracts swept after 1 day; compaction memory flush bounded (30 s); prism-proxy whitelists persisted; optional `EXECUTE_API_KEY`; `published` never `"N/A"`. | `0c1c2b3` |
| Verdict table PARTIALs | Extract cache cuts per caller; single allowed domain → `site:`; run resume keeps tool pairs; user-cancelled durable job not restarted; `/chat` writes serial, reads bounded; action grants only match this service's tools; OTel host from compose + shutdown flush. | `3964cc6` `b70db33` `ba1cc2f` `21411ef` `02c87b5` |
| Dead wiring | Removed turn mailbox, non-blocking questions, goal gate, `UnattendedPolicy`/platform `ApprovalRegistry` (no producers or callers) and their tests. Compression aux chain wired into compaction. The vision aux chain stays: tested, no caller yet. | `dd69148` |

## 2. Security bench

`scripts/benchmarks/security-bench.mts` — deterministic, no model or GPU. It plants a random
canary in `process.env` and fails if any attack lands.

```
testrun -- npx tsx scripts/benchmarks/security-bench.mts --live --out documentation/artifacts/security-bench-2026-10-11.json
```

Result (2026-10-11): **79/79 pass** — report: [security-bench-2026-10-11.json](artifacts/security-bench-2026-10-11.json).

| Section | Checks | What it attacks |
|---|---|---|
| code_interpreter | 21 | computed `process`, Function-constructor chains, thenable and `Promise.prototype.then` escapes, helper swap, eval/wasm, stack-trace callsites, sync loop, `Atomics.wait`, memory/string bombs, recursion, never-settling promise; host event-loop lag ≤ 8 ms throughout |
| ssrf | 45 | hex/octal/short IPv4, mapped/NAT64 IPv6, metadata IP, CGNAT, `0.0.0.0`, `.local`/`.internal`/single-label, names resolving private, mixed DNS answers, NXDOMAIN, non-http schemes, credentials in URL, redirect to private, redirect loop, body cap |
| ssrf-live | 4 | real DNS: `127.0.0.1.nip.io`, `localtest.me`, `169.254.169.254.nip.io` refused; `example.com` fetched |
| execute-key | 6 | open when unset; wrong key / wrong length refused; `x-api-key` and Bearer accepted |
| offload | 2 | cross-instance retrieve; path-traversal id refused |
| reasoning | 1 | tool turn carries `reasoning_content` |

Secret scan: `secret_scan.py --range main..HEAD` clean; tests generate credentials at runtime.

## 3. Validation

- `tsc --noEmit` clean; full vitest **119 files / 1,389 tests** pass (was 1,336; new
  regression tests fail on the pre-fix code where checked — D3 thenable, D4, D1).
- `/security-review` on the branch: one HIGH finding (the thenable escape), fixed in `6c05067`.

## 4. Known limits (not fixed here)

- `/execute` stays LAN-open unless `EXECUTE_API_KEY` is set; turning it on needs html-notes,
  Obsidian, treesearch and trading configured with the key first.
- WebExtract hands the URL to scraper-service; redirects that service follows are checked
  only by its own guard.
- `node:vm` in a worker is defence in depth, not an OS sandbox; the interpreter also stays
  behind approval. A true isolate (`isolated-vm` or a locked-down child process) is the
  next step if untrusted tenants ever get auto-approve.
- Phases C and D of the audit plan (consumer cutover off prism, agent-quality evals).
