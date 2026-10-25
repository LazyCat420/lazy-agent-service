// ============================================================
// UnscrapableDomains — publishers scraper-service cannot read, and the
// per-run scrape_url budget.
//
// WHY: hop 5b of the trading week audit (trading-client ch.47, plan item
// 2.5) measured scrape_url failing ~41% of the time. Read from
// agent_traces over the 65 production cycles of 2026-10-14..10-24, 95
// scrape_url calls, 42 failed; three publishers failed on every attempt:
//   seekingalpha.com   22 / 22   ("no engine returned usable content")
//   reuters.com         5 / 5
//   streetinsider.com   5 / 5
// That is 32 of the 42 failures, each costing the junior a turn and the
// scraper a 20 s browser escalation. msn.com, named in the plan, is NOT
// here: 3 of 16 failed, all HTTP 404 on slugs without an /ar- article id
// (URLs the model built), and 13 returned the article.
//
// Not the security blocklist: WEB_BLOCKED_DOMAINS (WebExtractService) is an
// operator-set "never fetch" list and answers "blocked:". This one is
// "fetching cannot work", it is code-owned so a change carries its
// evidence, and the refusal tells the model to drop the publisher.
//
// One list, three uses: webExtract refuses these hosts before DNS or any
// fetch; LocalToolRouter blanks their links in lazy_web_search results
// (headline, publisher and date stay as evidence, the same shape Google
// News results already have); the refusal text below.
// ============================================================

/** Registrable domains; a host matches itself or any subdomain. */
export const UNSCRAPABLE_DOMAINS: readonly string[] = [
  "seekingalpha.com",
  "reuters.com",
  "streetinsider.com",
];

/** Stable prefixes so telemetry (error_message) can split refusals from real scrape failures. */
export const UNSCRAPABLE_CODE = "UNSCRAPABLE_DOMAIN";
export const SCRAPE_BUDGET_CODE = "SCRAPE_BUDGET_EXHAUSTED";

/** The deny-listed domain a URL belongs to, or null (also for unparseable URLs). */
export function unscrapableDomainOf(url: string): string | null {
  let host: string;
  try {
    host = new URL(String(url ?? "").trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const domain of UNSCRAPABLE_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return domain;
  }
  return null;
}

/**
 * The scrape_url result for a deny-listed URL. Worded so the model moves on:
 * a generic "try again later" invited exactly the retries that made these
 * publishers 32 of 42 failures.
 */
export function unscrapableRefusal(url: string, domain: string): Record<string, unknown> {
  return {
    url,
    content: "",
    success: false,
    skipped: "unscrapable_domain",
    error:
      `${UNSCRAPABLE_CODE}: ${domain} blocks automated reading, so this page was not fetched ` +
      `(every scrape of ${domain} has failed). Do not call scrape_url on any ${domain} link. ` +
      "Use the headline and snippet you already have, or read the same story from another publisher.",
  };
}

/**
 * lazy_web_search results with deny-listed links blanked. Returns a NEW
 * array of new objects (the bridge result is cached and shared by coalesced
 * callers, so it must never be mutated) and how many links were removed.
 */
export function blankUnscrapableLinks(
  results: ReadonlyArray<Record<string, unknown>>,
): { results: Array<Record<string, unknown>>; removed: number } {
  let removed = 0;
  const out = results.map((result) => {
    const domain = typeof result?.url === "string" ? unscrapableDomainOf(result.url) : null;
    if (!domain) return result;
    removed++;
    return { ...result, url: "", note: `headline only — ${domain} blocks automated reading; do not scrape it` };
  });
  return { results: out, removed };
}

/**
 * Post-filter a lazy_web_search result as the trading bridge returns it:
 * `{role, content: "<JSON string>", ...}` (or the JSON string / object
 * itself). Anything that is not a parseable `{results: [...]}` passes
 * through untouched, including errors and truncated content.
 */
export function filterSearchResultLinks(result: unknown): unknown {
  const wrapped = typeof result === "object" && result !== null && !Array.isArray(result)
    && typeof (result as Record<string, unknown>).content === "string";
  const raw = wrapped ? (result as Record<string, unknown>).content : result;
  let body: unknown = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return result;
    }
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).results)) {
    return result;
  }
  const record = body as Record<string, unknown>;
  const { results, removed } = blankUnscrapableLinks(record.results as Array<Record<string, unknown>>);
  if (removed === 0) return result;
  const filtered: Record<string, unknown> = {
    ...record,
    results,
    ...(typeof record.followable === "number"
      ? { followable: results.filter((r) => typeof r?.url === "string" && r.url).length }
      : {}),
    unscrapable_links_removed: removed,
  };
  if (wrapped) return { ...(result as Record<string, unknown>), content: JSON.stringify(filtered) };
  return typeof raw === "string" ? JSON.stringify(filtered) : filtered;
}

// ---------------------------------------------------------------- per-run budget

/**
 * scrape_url calls one agent run may make. Measured over the same window:
 * 42 runs scraped, by calls per run 1:13, 2:16, 3:7, 4:2, 5:3, 6:1, so a
 * budget of 4 refuses 5 calls in 4 runs. SCRAPE_URL_MAX_PER_RUN overrides;
 * 0 turns the budget off.
 */
export function scrapeBudgetPerRun(): number {
  const raw = process.env.SCRAPE_URL_MAX_PER_RUN;
  if (raw === undefined || raw.trim() === "") return 4;
  const value = Math.floor(Number(raw));
  return Number.isFinite(value) && value >= 0 ? value : 4;
}

export interface ScrapeRunScope {
  conversationId?: string;
  cycleId?: string;
  ticker?: string;
  agentName?: string;
}

/**
 * The run a scrape is charged to. A trading call carries a signed context
 * whose conversationId is one agent run; the MCP path passes the
 * conversation as cycleId. No run identity means no budget: falling back to
 * the agent name or "global" would charge every run to one counter.
 */
export function scrapeRunKey(scope: ScrapeRunScope = {}): string | null {
  if (scope.conversationId) return `conv:${scope.conversationId}`;
  if (scope.cycleId) return `run:${scope.cycleId}|${scope.ticker || ""}|${scope.agentName || ""}`;
  return null;
}

const RUN_TTL_MS = 6 * 60 * 60 * 1_000;
const runs = new Map<string, { count: number; at: number }>();

/**
 * Charge one scrape to its run. Returns null when allowed, or the refusal
 * result once the run has used its budget. Callers check the deny-list
 * first: a refused publisher costs nothing and is not charged.
 */
export function chargeScrape(url: string, scope: ScrapeRunScope = {}, now = Date.now()): Record<string, unknown> | null {
  const budget = scrapeBudgetPerRun();
  const key = scrapeRunKey(scope);
  if (budget === 0 || !key) return null;
  if (runs.size > 1_000) {
    for (const [k, v] of runs) if (now - v.at > RUN_TTL_MS) runs.delete(k);
  }
  const entry = runs.get(key);
  const used = entry && now - entry.at <= RUN_TTL_MS ? entry.count : 0;
  if (used >= budget) {
    return {
      url,
      content: "",
      success: false,
      skipped: "scrape_budget",
      error:
        `${SCRAPE_BUDGET_CODE}: this run has used its ${budget} scrape_url calls, so this page was not fetched. ` +
        "Do not call scrape_url again in this run; finish from the headlines, snippets and pages you already have.",
    };
  }
  runs.set(key, { count: used + 1, at: now });
  return null;
}

export function __resetScrapeBudgetForTests(): void {
  runs.clear();
}
