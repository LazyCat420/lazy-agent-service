// UnscrapableDomains (trading-client ch.47 plan item 2.5): publishers whose
// every scrape failed are refused without a network call, their links are
// blanked in lazy_web_search results, and one agent run gets a bounded number
// of scrape_url calls. Fails on reverted source: webExtract fetched the
// deny-listed hosts, lazy_web_search passed their links through, and
// scrape_url had no budget.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import { routeLocalTool } from "../LocalToolRouter.ts";
import { resetGuard } from "../ToolCallGuard.ts";
import { webExtract, __resetWebExtractForTests } from "../WebExtractService.ts";
import {
  SCRAPE_BUDGET_CODE,
  UNSCRAPABLE_CODE,
  UNSCRAPABLE_DOMAINS,
  __resetScrapeBudgetForTests,
  filterSearchResultLinks,
  unscrapableDomainOf,
} from "../UnscrapableDomains.ts";

const scraperOk = (content = "Article body. ".repeat(40)) =>
  new Response(JSON.stringify({ success: true, content, engine_used: "http" }), { status: 200 });

beforeEach(() => {
  __resetScrapeBudgetForTests();
  __resetWebExtractForTests();
  resetGuard();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("deny-listed domains are refused without a network call", () => {
  it("matches the domain and its subdomains, nothing else", () => {
    expect(UNSCRAPABLE_DOMAINS).toEqual([
      "seekingalpha.com",
      "reuters.com",
      "streetinsider.com",
      "chartmill.com",
      "thestreet.com",
    ]);
    expect(unscrapableDomainOf("https://seekingalpha.com/news/1")).toBe("seekingalpha.com");
    expect(unscrapableDomainOf("https://www.reuters.com/markets/x")).toBe("reuters.com");
    expect(unscrapableDomainOf("https://www.chartmill.com/news/AAPL/1")).toBe("chartmill.com");
    expect(unscrapableDomainOf("https://www.thestreet.com/investing/x")).toBe("thestreet.com");
    expect(unscrapableDomainOf("https://notreuters.com/x")).toBeNull();
    expect(unscrapableDomainOf("https://www.msn.com/en-us/money/x/ar-AA1")).toBeNull();
    expect(unscrapableDomainOf("not a url")).toBeNull();
  });

  it("webExtract refuses before DNS and before scraper-service", async () => {
    const fetchImpl = vi.fn(async () => scraperOk());
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    const out = await webExtract("https://www.seekingalpha.com/article/123", 15_000, {
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => Date.now(),
      resolve,
    });
    expect(out.status).toBe("error");
    expect(out.unscrapable).toBe("seekingalpha.com");
    expect(out.error).toContain(UNSCRAPABLE_CODE);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("scrape_url answers with a refusal that tells the model to move on", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const out = (await routeLocalTool("mcp__lazy-agent-service__scrape_url",
      { url: "https://www.streetinsider.com/Corporate+News/x" },
      { conversationId: "deny-run", cycleId: "cycle-v3-1", ticker: "AAPL", agentName: "v3_junior_analyst" },
    )) as Record<string, unknown>;
    expect(out.success).toBe(false);
    expect(out.skipped).toBe("unscrapable_domain");
    expect(String(out.error)).toMatch(/^UNSCRAPABLE_DOMAIN: streetinsider\.com/);
    expect(String(out.error)).toContain("Do not call scrape_url on any streetinsider.com link");
    expect(String(out.error)).not.toContain("Try again later");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a non-listed domain is still scraped", async () => {
    const fetchImpl = vi.fn(async () => scraperOk("Dell shares climbed 5.2% in pre-market trading."));
    const out = await webExtract("https://www.msn.com/en-us/news/other/dell/ar-AA2fJBV1", 15_000, {
      fetch: fetchImpl as unknown as typeof fetch,
      now: () => Date.now(),
    });
    expect(out.status).toBe("ok");
    expect(out.unscrapable).toBeUndefined();
    expect(out.content).toContain("Dell shares climbed");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("lazy_web_search results lose links to deny-listed publishers", () => {
  const searchBody = () => ({
    status: "success",
    results: [
      { title: "SA piece", url: "https://seekingalpha.com/news/4401", provider: "bing_news" },
      { title: "Reuters piece", url: "https://www.reuters.com/business/x", provider: "bing_news" },
      { title: "MSN piece", url: "https://www.msn.com/en-us/money/x/ar-AA2", provider: "bing_news" },
      { title: "GN headline", url: "", source: "Reuters", provider: "google_news" },
    ],
    followable: 3,
    provider_errors: null,
  });

  it("blanks them through the router, keeps the headline, recounts followable", async () => {
    const bridged = { role: "tool", name: "lazy_web_search", content: JSON.stringify(searchBody()) };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(bridged), { status: 200 }));
    const out = (await routeLocalTool("mcp__lazy-agent-service__lazy_web_search",
      { query: "denylist router probe" }, { cycleId: "cycle-v3-2", ticker: "AAPL", agentName: "v3_junior_analyst" },
    )) as Record<string, unknown>;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(out.content));
    expect(body.results.map((r: Record<string, unknown>) => r.title)).toEqual(["SA piece", "Reuters piece", "MSN piece", "GN headline"]);
    expect(body.results.map((r: Record<string, unknown>) => r.url)).toEqual(["", "", "https://www.msn.com/en-us/money/x/ar-AA2", ""]);
    expect(body.results[0].note).toContain("seekingalpha.com blocks automated reading");
    expect(body.followable).toBe(1);
    expect(body.unscrapable_links_removed).toBe(2);
    expect(out.role).toBe("tool");
  });

  it("never mutates the (cached, shared) bridge result", () => {
    const original = { role: "tool", content: JSON.stringify(searchBody()) };
    const snapshot = JSON.stringify(original);
    const filtered = filterSearchResultLinks(original) as Record<string, unknown>;
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(filtered).not.toBe(original);
  });

  it("passes through results with no listed link, errors and unparseable content untouched", () => {
    const clean = { role: "tool", content: JSON.stringify({ status: "success", results: [{ title: "t", url: "https://fool.com/a" }], followable: 1 }) };
    expect(filterSearchResultLinks(clean)).toBe(clean);
    const error = { role: "tool", content: JSON.stringify({ status: "error", degraded: true, message: "every provider failed" }) };
    expect(filterSearchResultLinks(error)).toBe(error);
    const truncated = { role: "tool", content: '{"status": "success", "results": [ [TRUNCATED' };
    expect(filterSearchResultLinks(truncated)).toBe(truncated);
  });

  it("blanks Yahoo /m/ partner teaser links with a teaser note", () => {
    const payload = {
      role: "tool",
      content: JSON.stringify({
        status: "success",
        results: [
          {
            title: "Partner stub",
            url: "https://finance.yahoo.com/m/bb1a0bc9-aa0d-3fa7-b20e-7290988735b7/story.html",
            provider: "bing_news",
          },
          {
            title: "Full Yahoo article",
            url: "https://finance.yahoo.com/news/real-story-123456.html",
            provider: "bing_news",
          },
        ],
        followable: 2,
      }),
    };
    const filtered = filterSearchResultLinks(payload) as Record<string, unknown>;
    const body = JSON.parse(String(filtered.content));
    expect(body.results[0].url).toBe("");
    expect(body.results[0].note).toContain("teaser only");
    expect(body.results[1].url).toBe("https://finance.yahoo.com/news/real-story-123456.html");
    expect(body.followable).toBe(1);
    expect(body.unscrapable_links_removed).toBe(1);
  });
});

describe("tool-redirect and guessed corporate IR URL guards", () => {
  const call = (url: string, context: Record<string, string>) =>
    routeLocalTool("mcp__lazy-agent-service__scrape_url", { url }, context) as Promise<Record<string, unknown>>;

  it("refuses finviz.com, finnhub.com, and sec.gov/edgar/search with dedicated-tool guidance", async () => {
    const extract = vi.spyOn(ToolOrchestratorService, "executeWebExtract");
    const run = { conversationId: "conv-guard-1" };

    const finviz = await call("https://finviz.com/quote.ashx?t=CRWV", run);
    expect(finviz.success).toBe(false);
    expect(finviz.skipped).toBe("use_dedicated_tool");
    expect(String(finviz.error)).toContain("get_finviz_fundamentals");

    const finnhub = await call("https://finnhub.com/stocks/gm", run);
    expect(finnhub.success).toBe(false);
    expect(finnhub.skipped).toBe("use_dedicated_tool");
    expect(String(finnhub.error)).toContain("get_finnhub_news");

    const edgar = await call("https://www.sec.gov/edgar/search/#/q=LMND", run);
    expect(edgar.success).toBe(false);
    expect(edgar.skipped).toBe("use_dedicated_tool");
    expect(String(edgar.error)).toContain("get_sec_filings");

    expect(extract).not.toHaveBeenCalled();
  });

  it("refuses guessed corporate IR URLs unless returned by lazy_web_search in the same run", async () => {
    const extract = vi.spyOn(ToolOrchestratorService, "executeWebExtract").mockResolvedValue({
      url: "x",
      success: true,
      content: "verified IR release",
    });
    const run = { conversationId: "conv-guard-ir", cycleId: "cycle-v3-ir", ticker: "GE", agentName: "v3_junior_analyst" };

    const guessed1 = await call("https://www.ge.com/investors/earnings", run);
    expect(guessed1.success).toBe(false);
    expect(guessed1.skipped).toBe("unverified_url");
    expect(String(guessed1.error)).toContain("UNVERIFIED_URL");

    const guessed2 = await call("https://www.salesforce.com/investor-relations/financials/", run);
    expect(guessed2.success).toBe(false);
    expect(guessed2.skipped).toBe("unverified_url");

    const guessed3 = await call("https://www.lockheedmartin.com/en-us/investors/earnings/2026-q3.html", run);
    expect(guessed3.success).toBe(false);
    expect(guessed3.skipped).toBe("unverified_url");

    expect(extract).not.toHaveBeenCalled();

    // Now simulate lazy_web_search returning an exact IR URL in this run
    const verifiedUrl = "https://www.ge.com/investors/earnings/q3-2026-release";
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({
          role: "tool",
          name: "lazy_web_search",
          content: JSON.stringify({
            status: "success",
            results: [{ title: "GE Q3 Earnings", url: verifiedUrl, provider: "bing_news" }],
            followable: 1,
          }),
        }),
        { status: 200 },
      ),
    );
    await routeLocalTool("mcp__lazy-agent-service__lazy_web_search", { query: "GE Q3 earnings" }, run);

    const allowed = await call(verifiedUrl, run);
    expect(allowed.success).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);
  });
});

describe("scrape_url budget per agent run", () => {
  const ok = { url: "x", success: true, content: "page" };
  const call = (url: string, context: Record<string, string>) =>
    routeLocalTool("mcp__lazy-agent-service__scrape_url", { url }, context) as Promise<Record<string, unknown>>;

  it("allows 4 scrapes per run, then refuses without scraping", async () => {
    const extract = vi.spyOn(ToolOrchestratorService, "executeWebExtract").mockResolvedValue(ok);
    const run = { conversationId: "conv-A", cycleId: "cycle-v3-3", ticker: "SMR", agentName: "v3_junior_analyst" };
    for (let i = 1; i <= 4; i++) expect((await call(`https://fool.com/a${i}`, run)).success).toBe(true);
    const fifth = await call("https://fool.com/a5", run);
    expect(fifth.success).toBe(false);
    expect(fifth.skipped).toBe("scrape_budget");
    expect(String(fifth.error)).toMatch(new RegExp(`^${SCRAPE_BUDGET_CODE}: this run has used its 4 scrape_url calls`));
    expect(extract).toHaveBeenCalledTimes(4);
    // Another run (a different conversation) has its own budget.
    expect((await call("https://fool.com/b1", { ...run, conversationId: "conv-B" })).success).toBe(true);
    expect(extract).toHaveBeenCalledTimes(5);
  });

  it("keys on cycle, ticker and agent when there is no conversation id", async () => {
    vi.spyOn(ToolOrchestratorService, "executeWebExtract").mockResolvedValue(ok);
    const run = { cycleId: "cycle-v3-4", ticker: "IREN", agentName: "v3_junior_analyst" };
    for (let i = 1; i <= 4; i++) await call(`https://fool.com/c${i}`, run);
    expect((await call("https://fool.com/c5", run)).skipped).toBe("scrape_budget");
    expect((await call("https://fool.com/c6", { ...run, ticker: "CRWV" })).success).toBe(true);
  });

  it("does not charge deny-listed refusals to the run", async () => {
    const extract = vi.spyOn(ToolOrchestratorService, "executeWebExtract");
    const run = { conversationId: "conv-C" };
    for (let i = 1; i <= 3; i++) await call(`https://seekingalpha.com/news/${i}`, run);
    extract.mockResolvedValue(ok);
    for (let i = 1; i <= 4; i++) expect((await call(`https://fool.com/d${i}`, run)).success).toBe(true);
  });

  it("applies no budget without a run identity, and SCRAPE_URL_MAX_PER_RUN=0 turns it off", async () => {
    vi.spyOn(ToolOrchestratorService, "executeWebExtract").mockResolvedValue(ok);
    for (let i = 1; i <= 6; i++) expect((await call(`https://fool.com/e${i}`, {})).success).toBe(true);
    vi.stubEnv("SCRAPE_URL_MAX_PER_RUN", "0");
    for (let i = 1; i <= 6; i++) expect((await call(`https://fool.com/f${i}`, { conversationId: "conv-D" })).success).toBe(true);
  });
});
