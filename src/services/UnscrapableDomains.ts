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
  "chartmill.com",
  "thestreet.com",
];

/** Stable prefixes so telemetry (error_message) can split refusals from real scrape failures. */
export const UNSCRAPABLE_CODE = "UNSCRAPABLE_DOMAIN";
export const SCRAPE_BUDGET_CODE = "SCRAPE_BUDGET_EXHAUSTED";
export const USE_DEDICATED_TOOL_CODE = "USE_DEDICATED_TOOL";
export const UNVERIFIED_URL_CODE = "UNVERIFIED_URL";

/** True when the URL is a Yahoo Finance /m/<uuid> partner teaser stub. */
export function isPartnerTeaserUrl(url: string): boolean {
  try {
    const parsed = new URL(String(url ?? "").trim());
    const host = parsed.hostname.toLowerCase();
    return (host === "finance.yahoo.com" || host.endsWith(".yahoo.com")) && /^\/m\/[0-9a-f-]+/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

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
    const rawUrl = typeof result?.url === "string" ? result.url : "";
    const domain = rawUrl ? unscrapableDomainOf(rawUrl) : null;
    if (domain) {
      removed++;
      return { ...result, url: "", note: `headline only — ${domain} blocks automated reading; do not scrape it` };
    }
    if (rawUrl && isPartnerTeaserUrl(rawUrl)) {
      removed++;
      return {
        ...result,
        url: "",
        note: "teaser only — Yahoo /m/ link is a 1-paragraph partner stub; use the headline and snippet",
      };
    }
    return result;
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
const runUrls = new Map<string, { urls: Set<string>; at: number }>();

/**
 * Corporate IR / press-release path patterns that models frequently guess
 * (e.g. ge.com/investors/earnings, salesforce.com/investor-relations/financials/,
 * lockheedmartin.com/en-us/investors/earnings/2026-q3.html) and hit 404.
 * Allowed when the exact URL was returned by a search tool in the same run.
 */
const GUESSED_IR_PATH_RE =
  /^\/(?:[a-z]{2}-[a-z]{2}\/)?(?:dt\/corporate\/)?(?:investors|investor-relations|investor-centre|newsroom)\/(?:earnings|financials|financial-results|press-releases|news-events)(?:\/|$)/i;

function normalizeUrlForRegistry(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim().replace(/\/$/, "");
  }
}

/** Record URLs returned by search/news tools so scrapeTargetGuard knows they were discovered, not guessed. */
export function registerRunUrls(urls: Iterable<string>, scope: ScrapeRunScope = {}, now = Date.now()): void {
  const key = scrapeRunKey(scope);
  if (!key) return;
  if (runUrls.size > 1_000) {
    for (const [k, v] of runUrls) if (now - v.at > RUN_TTL_MS) runUrls.delete(k);
  }
  const existing = runUrls.get(key);
  const set = existing && now - existing.at <= RUN_TTL_MS ? existing.urls : new Set<string>();
  for (const u of urls) {
    if (typeof u === "string" && u.trim()) {
      set.add(normalizeUrlForRegistry(u));
    }
  }
  runUrls.set(key, { urls: set, at: now });
}

/** Extract and register URLs from a lazy_web_search bridge response. */
export function registerSearchResultUrls(result: unknown, scope: ScrapeRunScope = {}): void {
  const wrapped = typeof result === "object" && result !== null && !Array.isArray(result)
    && typeof (result as Record<string, unknown>).content === "string";
  const raw = wrapped ? (result as Record<string, unknown>).content : result;
  let body: unknown = raw;
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw);
    } catch {
      return;
    }
  }
  if (typeof body !== "object" || body === null || !Array.isArray((body as Record<string, unknown>).results)) {
    return;
  }
  const urls: string[] = [];
  for (const row of (body as Record<string, unknown>).results as Array<Record<string, unknown>>) {
    if (typeof row?.url === "string" && row.url.trim()) urls.push(row.url);
  }
  if (urls.length > 0) registerRunUrls(urls, scope);
}

/**
 * Guard against scraping domains that have dedicated structured tools
 * (finviz.com, finnhub.com, sec.gov/edgar/search) or hallucinated corporate IR
 * root paths that were never returned by a search tool in this run.
 */
export function scrapeTargetGuard(url: string, scope: ScrapeRunScope = {}, now = Date.now()): Record<string, unknown> | null {
  let parsed: URL;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname || "/";

  if (host === "finviz.com" || host.endsWith(".finviz.com")) {
    return {
      url,
      content: "",
      success: false,
      skipped: "use_dedicated_tool",
      error:
        `${USE_DEDICATED_TOOL_CODE}: finviz.com blocks generic scraping and has a dedicated tool. ` +
        "Call get_finviz_fundamentals(ticker=...) instead of scrape_url.",
    };
  }
  if (host === "finnhub.com" || host.endsWith(".finnhub.com")) {
    return {
      url,
      content: "",
      success: false,
      skipped: "use_dedicated_tool",
      error:
        `${USE_DEDICATED_TOOL_CODE}: finnhub.com stock pages do not exist. ` +
        "Call get_finnhub_news(ticker=...) instead of scrape_url.",
    };
  }
  if (
    (host === "sec.gov" || host.endsWith(".sec.gov")) &&
    (/^\/edgar\/search/i.test(pathname) || /^\/cgi-bin\/browse-edgar/i.test(pathname))
  ) {
    return {
      url,
      content: "",
      success: false,
      skipped: "use_dedicated_tool",
      error:
        `${USE_DEDICATED_TOOL_CODE}: SEC EDGAR search pages cannot be read with scrape_url. ` +
        "Call get_sec_filings(ticker=...) and query_sec_filing(...) instead of scrape_url.",
    };
  }

  if (GUESSED_IR_PATH_RE.test(pathname)) {
    const key = scrapeRunKey(scope);
    const entry = key ? runUrls.get(key) : undefined;
    const known = entry && now - entry.at <= RUN_TTL_MS && entry.urls.has(normalizeUrlForRegistry(url));
    if (!known) {
      return {
        url,
        content: "",
        success: false,
        skipped: "unverified_url",
        error:
          `${UNVERIFIED_URL_CODE}: '${url}' looks like a guessed corporate investor-relations or press-release URL ` +
          "that was not returned by lazy_web_search in this run (guessed IR paths fail with HTTP 404). " +
          "Call lazy_web_search first and only pass exact URLs returned in its results to scrape_url.",
      };
    }
  }

  return null;
}

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
  runUrls.clear();
}

/**
 * How much of this run's scrape budget is left, for the tool result. Four of
 * 31 scrape_url calls on 2026-10-30 were made after the budget was spent: the
 * refusal only fires on the call that exceeds it, so a model that cannot see
 * the counter spends its remaining steps on refusals. Attaching the counter to
 * every successful result lets it plan instead of guessing.
 */
export function scrapeBudgetStatus(
  scope: ScrapeRunScope = {},
  now = Date.now(),
): { used: number; budget: number; remaining: number } {
  const budget = scrapeBudgetPerRun();
  const key = scrapeRunKey(scope);
  const entry = key ? runs.get(key) : undefined;
  const used = entry && now - entry.at <= RUN_TTL_MS ? entry.count : 0;
  return { used, budget, remaining: Math.max(0, budget - used) };
}
