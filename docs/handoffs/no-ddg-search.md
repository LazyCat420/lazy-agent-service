# Handoff: no-ddg-search (lazy-agent-service)

From sun-10, 2026-10-06, for the last agent on this repo (sun-20).

## What it contains

- `ToolOrchestratorService.executeTool` now answers `search_web` with the new
  `executeSharedWebSearch`, which calls `WebSearchService` (Exa, one cache and
  one rate limit for the network). It no longer forwards the call to Rod's
  tools-service, whose `search_web` is DuckDuckGo only.
  - The reply keeps tools-service's shape.
  - A search that did not run returns `error`.
  - The session allowlist is still checked first.
- Comment updates: the `WebSearchService` header, `DeepResearchPersona`, and the
  `lazy_web_search` note in `getMCPToolSchemas` (that tool is Bing News and
  Google News RSS, not DuckDuckGo).
- `documentation/chapters/04-shared-web-search.md`: a new section on `search_web`
  on this harness, with 30-day usage numbers from the request logs. The last
  DuckDuckGo searches (2026-09-18 to 2026-10-02) came from
  `CUSTOM_OBSIDIAN_GENERAL_ASSISTANT` on this harness's `/agent`.

## How it was validated

- New test `src/services/__tests__/SearchWebShared.test.ts` (4 tests). `fetch` throws in this test, so any call that leaks to tools-service fails it.
- Negative check: with the new `if` removed, 3 of the 4 tests fail. The allowlist test passes either way.
- `npm run typecheck` is clean.
- Full suite: 75 files, 972 tests, all pass (`vitest run --maxWorkers=4`, under testrun).
- `eslint` could not run. The repo's toolchain crashes at startup with
  "Class extends value undefined" from @typescript-eslint/utils 8.33 on
  eslint 10.4. This was already broken and is unrelated to this change.

## Likely conflicts

- `src/services/ToolOrchestratorService.ts`:
  - one import line after the `ORCHESTRATOR_ONLY_TOOLS` import;
  - a new `if` right after the `mcp__` routing in `executeTool`;
  - the new static method right after `executeMCPTool`.
- `documentation/index.html`: regenerate it with `python3 documentation/build_docs.py`, don't merge it by hand.

## Deploy and live check

1. Deploy between trading cycles: `npm run deploy -- --only=lazy-tool-service --skip-pull` from deploy-kit.
2. Read the two counters:
   - the hub's `search.calls`, from any `POST /execute/web_search` reply;
   - tools-service's `/agentic/web/search` count in Mongo `tools.requests`.
3. Run one native `/agent` turn whose only tool is `search_web`.
4. Pass: the hub count goes up and tools-service's does not.
