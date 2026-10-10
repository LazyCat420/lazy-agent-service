# PLAN — ARIA Snapshot Extraction for Scrape Paths

Written: 2026-10-10. Status: **NOT IMPLEMENTED — parked**.
Parent work: `documentation/chapters/web-harness-hardening-2026-10-10.md` (trading web_search enablement, deployed `d8d78e2`).

## Why

Every scrape path today returns **plain `innerText`** only. The model sees a wall of text with no
structure: it cannot tell "this is the earnings table" from "this is the nav bar", and it cannot
identify clickable/interactive elements for follow-up actions. Playwright's accessibility tree
(ARIA snapshot) gives a compact role/name/hierarchy view — typically 10–50× fewer tokens than raw
text for the same page — and is exactly what "identify what to scrape" needs.

Current state (verified 2026-10-10, grep of both repos):
- `scraper-service/app/scraper/engines/playwright_engine.py` — `article`/`main`/paragraph `innerText`
  heuristics only; `aria-label` appears solely in close-button selectors.
- `lazy-agent-service/src/services/WebExtractService.ts` — consumes scraper-service plain text
  (`POST /scrape`, engine `auto`), applies head+tail truncation (`truncateAndStore`).
- No `accessibility.snapshot()` / `ariaSnapshot` / aria-tree usage anywhere.

## Design (2 layers, keep both backward-compatible)

### Layer 1 — scraper-service (Python; read-only for us? NO — scraper-service is LazyCat420-owned)

⚠️ **Verify ownership before editing**: scraper-service lives in `~/github/projects/sun/scraper-service`.
Confirm it is not on Rodrigo's read-only list (`prism-service`, `portal-service`, `tools-service`,
`vault-service`, `workspace-service`, `components-library`, `lupos-bot`). [ASSUMPTION-1: owned by us;
validation: `git -C scraper-service remote -v` + commit history]

Change (in `playwright_engine.py`, after `page.goto` + settle):
1. **Primary: `page.accessibility.snapshot()`** (stable API, works on all Playwright ≥1.0).
   - Filter to `role` ∈ {link, button, textbox, heading, table, list, listitem, img, tab, combobox,
     search, navigation, main, article, form, dialog} — drop `generic`/`text` to cut noise.
   - Flatten to indented text lines: `- heading "Q2 2026 Results" [level=2]` (Playwright
     `locator.aria_snapshot()` format, available Playwright ≥1.49 — prefer this if the pinned
     Playwright version allows; it is YAML and exactly what an LLM parses best). [Testable claim:
     pin the version in requirements.txt and assert in a smoke script.]
   - Budget: cap at ~8,000 tokens equivalent (~32 KB) with head+tail cut — reuse the same shape as
     `truncateAndStore` in WebExtractService for consistency.
2. **Response shape**: extend the scrape response with `structure: { format: "aria" | "none",
     content: string, truncated: bool } | null`. `engine: "http"` (no browser) → `structure: null`.
   Do NOT remove or reshape existing `text` field — every current consumer (WebExtractService,
   finnews/reddit collectors' callers) must keep working. [Testable claim: existing
   scraper-service contract tests + WebExtractService tests stay green untouched.]
3. **Cost control**: ARIA snapshot only when request asks for it (`include_structure: true`) or
   query param `?structure=1`. Default off — zero overhead for existing callers. [ASSUMPTION-2:
   default-off is right because snapshot costs ~50–200 ms per page; validation: bench in the smoke
   script.]

### Layer 2 — lazy-agent-service (TypeScript, ours)

1. `WebExtractService.ts`: pass-through `includeStructure` flag on the extract call; when the
   response carries `structure`, store it alongside the text (same file store,
   `<id>.aria.txt` sibling) and expose it in the tool result only when the agent asked.
2. `scrape_url` tool schema (`tool_schemas/trading/research-intelligence.json`): add optional
   boolean param `include_structure` (default false). Regenerate `tool_schemas.json` via
   `python3 scripts/export_tool_schemas.py` (**required after every shard edit** — drift-checked).
   ⚠️ `scrape_url` result shape is consumed by v3 trading agents — adding an *optional* param to the
   request schema is safe; changing the response shape is NOT. Keep response additive.
   [Testable claim: `test/contract/ContractV12Suite.test.ts` suite stays green; the scrape_url
   shard metadata (tier/permission/domain) must be preserved — it was restored from git bc1049a
   once already.]
3. Optional later (do NOT bundle now): `web_search` → auto-extract top-1 result with structure.

## Execution order (each step independently shippable)

1. **Verify ownership + pin Playwright** (Layer 0): `git remote -v`; `pip show playwright`;
   `python3 -c "from playwright.sync_api import sync_playwright"` — confirm `aria_snapshot()`
   exists on the pinned version. If it doesn't, use `accessibility.snapshot()` fallback path.
2. **scraper-service engine change** + smoke script (`scraper-service/scripts/aria_smoke.py`):
   fetch 3 pages (static HTML, JS-heavy SPA, login-walled) → print token counts text vs ARIA.
   Exit nonzero if ARIA > text tokens (sanity). Worktree `wt-aria-snapshot`, `testrun` for any
   local test run, `git push origin main`, `npm run deploy` (scraper-service container).
3. **lazy-agent-service pass-through + schema** + tests:
   - unit: WebExtractService stores/serves structure sibling file;
   - contract: ContractV12Suite scrape_url shape unchanged (additive param only);
   - live: POST `/v1/runs` junior-analyst "scrape https://news.ycombinator.com with
     include_structure=true, list the top 3 story links" — model must answer from ARIA lines
     (proves structure reached the model and is parseable).
4. **Deploy + verify**: `./deploy.sh` (lazy-agent-service), health-check
   `ssh nas "curl http://localhost:5591/health"`, live run above.
5. **Docs**: new chapter `documentation/chapters/aria-snapshot-extraction.md` + update
   `08-shared-web-extract.md`; `python3 documentation/build_docs.py` must pass.

## Claim ledger (per .agents/plan-verification-standard.md)

| # | Claim | Class | Validation path |
|---|---|---|---|
| V1 | No ARIA extraction exists today | Verified Fact | grep 2026-10-10, both repos (see Why) |
| V2 | scraper-service is ours to edit | ASSUMPTION-1 | `git remote -v` before any edit |
| V3 | `aria_snapshot()` available on pinned Playwright | Testable | step 1 probe; fallback is `accessibility.snapshot()` |
| V4 | ARIA is 10–50× fewer tokens | HYPOTHESIS | measured in smoke script step 2 (target: ≥5× on the 3 test pages, else revisit) |
| V5 | Default-off keeps existing callers free of overhead | Testable | bench before/after on same page |
| V6 | Additive response shape keeps v3 agents + WebExtractService green | Testable | contract suites + live run |

Zero Unverifiable claims. In scope: the 5 steps above. **Out of scope**: ARIA for the SearXNG
collector (no browser), auto-chaining web_search→scrape, agentic clicking/navigation (a separate,
much larger plan — the snapshot only *describes* the page; acting on it is not included).

## Risks

- `accessibility.snapshot()` output on huge SPAs can itself be huge — the 32 KB budget + head/tail
  cut is mandatory, not optional.
- Playwright version drift between scraper-service requirements.txt and the container image — pin
  and verify inside the container after deploy (`docker exec … python3 -c …`).
- ARIA tree of login-walled/anti-bot pages may be empty; engine must return `structure: null`
  (never fail the whole scrape because structure extraction failed — wrap in try/except).
