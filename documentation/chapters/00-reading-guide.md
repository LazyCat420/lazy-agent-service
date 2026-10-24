---
part: Start Here
status: verified
type: spec
updated: 2026-10-23
review-by: 2026-11-23
---

# How this documentation is organised

lazy-agent-service is the one agent harness every LazyCat420 app runs on (the Prism-to-harness cutover target). The sheet is grouped by **what the service does**, not by when a page was written. Nine areas, one home for each kind of page, and rules that stop it growing into a pile.

## The areas

| Area | What lives here |
|---|---|
| Prism cutover | moving every repo off prism-service: the plan, the parity list, the port verification, what was ported |
| Agent loop and harness | the core loop, stuck/empty-output/final-turn handling, harness audits and roadmap, the harness research plans, the architecture overview |
| Harness2 loop | the self-improving (recursive) harness: its plan and its deep audit |
| Contracts and runtime API | the run contract, profiles and plugin SPI (v1 and v1.2), ownership, the single tool-schema generator, the shared runtime inventories and release evidence |
| Tools and shared services | web search and extract, embeddings, MCP, trading tool fixes, news, tool metrics |
| Models and routing | Jetson/vLLM routing, the wallgarden gate, scheduled-task model resolution |
| Security and operations | security hardening, dependency refreshes, OpenTelemetry tracing |
| Consumer apps | how html-notes, Obsidian, wallgarden and the chat UI use the harness; widgets |

An area is the `part:` in a page's front matter. Pick one; the build fails if a page has none.

## Page types (`type:` in front matter)

- **spec**: how a system works today. Edited in place, kept short.
- **decision**: a short dated note: what was decided and why. Not edited afterwards.
- **plan**: work not yet done. When it finishes, fold the result into the area's spec and archive the plan.
- **record**: evidence of a finished batch (audit, incident, release). Receipts go under `documentation/artifacts/` and are linked, not pasted.

## Rules that keep it from piling up

1. **One current page per topic.** If a new page would repeat an existing one, update that one.
2. **A finished task updates its area's page**, not a new chapter. Evidence goes under `documentation/artifacts/` and is linked in one line.
3. **Superseded and finished-plan pages move to `documentation/archive/`** with a banner naming what replaced them. Nothing is deleted; git keeps every version.
4. **Do not move a page that code reads.** `docs/contracts/` is copied by `scripts/export-contracts.mjs` and served by `ContractRoutes`; `docs/harness-research/` is cited from `src/` comments. Those folders stay where they are.

## Status words

`in-progress` and `approved` (live work, checked for staleness), `blocked`, `shipped`, `verified`, `reference` (kept for provenance), `superseded` (belongs in the archive).

## Where things are

- Compiled chapters: `documentation/chapters/` (built into `documentation/index.html` by `python3 documentation/build_docs.py`).
- Other pages: `docs/` (incident write-ups, runtime September 2026 evidence, contracts, harness research) and four root files (`ARCHITECTURE.md`, `CONTRACT_OWNERSHIP.md`, `HANDOFF.md`, `WIDGETS.md`).
- Archive: `documentation/archive/` (4 pages, each with a banner).
- Active cutover: [05 - Every repo on our own harness](05-own-harness-cutover.md) and [06 - Prism feature parity](06-prism-feature-parity.md).

## Known gaps

- `13-harness2-audit-2026-10-22.md` (89 KB) is too big for one page and should be split.
- Chapter numbers repeat (two 07, two 08, two 13); renaming is deferred because older notes cite them.
- The three exported contract specs in `docs/contracts/` carry no front matter on purpose (they are served as-is).
