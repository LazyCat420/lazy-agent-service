/**
 * LocalToolRouter — coverage of the strain (treesearch) routes, news/web search
 * routing, widget plan/create gates, scrape_url guards and the trading-service
 * bridge. External services (treesearch, news, web search, MCP, HTML-Notes,
 * trading-service, scrape budget, call guard) are fakes; the router, the widget
 * plan gate, HTML validation and result classification are real. Assertions
 * read the returned envelopes and the requested URLs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  fetch: vi.fn(),
  guardedRun: vi.fn(),
  newsSearch: vi.fn(),
  newsProviderStatus: vi.fn(),
  webSearch: vi.fn(),
  webSearchStatus: vi.fn(),
  parseMCPToolName: vi.fn(),
  isConnected: vi.fn(),
  callTool: vi.fn(),
  scrapeTargetGuard: vi.fn(),
  chargeScrape: vi.fn(),
  unscrapableDomainOf: vi.fn(),
  filterSearchResultLinks: vi.fn(),
  registerRunUrls: vi.fn(),
  registerSearchResultUrls: vi.fn(),
  executeWebExtract: vi.fn(),
  toolContextSet: vi.fn(),
  toolContextGet: vi.fn(),
}));

vi.mock("../../../config.ts", () => ({
  default: {
    TRADING_SERVICE_URL: "http://trading.test",
    TRADING_SERVICE_API_KEY: "key-1",
    HTML_NOTES_URL: "http://html-notes.test",
    TREESEARCH_SERVICE_URL: "http://treesearch.test",
    EXECUTION_TIMEOUT_MS: 5000,
    SLOW_TOOL_TIMEOUT_MS: 40000,
    SLOW_TOOLS: new Set(["run_backtest"]),
    CACHE_TTL_MS: 60000,
  },
}));
vi.mock("../ToolCallGuard.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  guardedRun: fakes.guardedRun,
}));
vi.mock("../NewsSearchService.ts", () => ({
  newsSearch: fakes.newsSearch,
  newsProviderStatus: fakes.newsProviderStatus,
}));
vi.mock("../WebSearchService.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  webSearch: fakes.webSearch,
  webSearchStatus: fakes.webSearchStatus,
}));
vi.mock("../MCPClientService.ts", () => ({
  default: {
    parseMCPToolName: fakes.parseMCPToolName,
    isConnected: fakes.isConnected,
    callTool: fakes.callTool,
  },
}));
vi.mock("../UnscrapableDomains.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scrapeTargetGuard: fakes.scrapeTargetGuard,
  chargeScrape: fakes.chargeScrape,
  unscrapableDomainOf: fakes.unscrapableDomainOf,
  filterSearchResultLinks: fakes.filterSearchResultLinks,
  registerRunUrls: fakes.registerRunUrls,
  registerSearchResultUrls: fakes.registerSearchResultUrls,
}));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: { executeWebExtract: fakes.executeWebExtract },
}));
vi.mock("../ToolContext.ts", () => ({
  default: { set: fakes.toolContextSet, get: fakes.toolContextGet },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import { routeLocalTool, executeToolViaTradingService } from "../LocalToolRouter.ts";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchCalls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchCalls = [];
  fakes.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return jsonResponse({ status: "success" });
  });
  vi.stubGlobal("fetch", fakes.fetch);
  fakes.guardedRun.mockImplementation(async (options: { run: () => Promise<unknown> }) => options.run());
  fakes.newsSearch.mockResolvedValue({
    source: "google-news",
    items: [{ url: "https://news.test/a" }, { url: "https://news.test/b" }],
  });
  fakes.newsProviderStatus.mockReturnValue({ usable: ["google-news"], configured: ["google-news"] });
  fakes.webSearch.mockResolvedValue({
    status: "ok",
    provider: "exa",
    results: [{ url: "https://a.test/x" }, { url: "https://b.test/y" }],
  });
  fakes.webSearchStatus.mockReturnValue({ provider: "exa", calls: 1 });
  fakes.parseMCPToolName.mockReturnValue(null);
  fakes.isConnected.mockReturnValue(false);
  fakes.callTool.mockResolvedValue({ content: "remote" });
  fakes.scrapeTargetGuard.mockReturnValue(null);
  fakes.chargeScrape.mockReturnValue(null);
  fakes.unscrapableDomainOf.mockReturnValue(null);
  fakes.filterSearchResultLinks.mockImplementation((result: unknown) => result);
  fakes.executeWebExtract.mockResolvedValue({ markdown: "# page" });
  fakes.toolContextGet.mockReturnValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeLocalTool — treesearch strain tools", () => {
  const strainFetch = (body: unknown = { ok: true }) => {
    fakes.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return jsonResponse(body);
    });
  };

  it("searches strains with query, limit and complete_only", async () => {
    strainFetch({ strains: ["Blue Dream"] });
    const result = await routeLocalTool("strain_search", { query: "blue dream", limit: 5, complete_only: true });
    expect(result).toEqual({ strains: ["Blue Dream"] });
    expect(fetchCalls[0].url).toBe(
      "http://treesearch.test/api/strains?search=blue+dream&limit=5&complete_only=true",
    );
  });

  it("defaults the search limit and omits complete_only", async () => {
    strainFetch();
    await routeLocalTool("strain_search", { query: "haze" });
    expect(fetchCalls[0].url).toBe("http://treesearch.test/api/strains?search=haze&limit=20");
  });

  it("fetches strain detail with observations flag", async () => {
    strainFetch({ strain: "OG Kush" });
    const result = await routeLocalTool("strain_detail", { strain_name: "OG Kush", include_observations: true });
    expect(result).toEqual({ strain: "OG Kush" });
    expect(fetchCalls[0].url).toBe(
      "http://treesearch.test/api/strains/OG%20Kush/detail?include_observations=true",
    );
  });

  it("fetches the terpene profile", async () => {
    strainFetch({ terpenes: ["myrcene"] });
    expect(await routeLocalTool("strain_terpene_profile", { strain_name: "Sour D" })).toEqual({
      terpenes: ["myrcene"],
    });
    expect(fetchCalls[0].url).toBe("http://treesearch.test/api/strains/Sour%20D/terpene-profile");
  });

  it("fetches forum posts with limit and source", async () => {
    strainFetch({ posts: [] });
    await routeLocalTool("strain_forum_posts", { strain_name: "Blue Dream", limit: 3, source: "reddit" });
    expect(fetchCalls[0].url).toBe(
      "http://treesearch.test/api/strains/Blue%20Dream/observations?limit=3&source=reddit",
    );
  });

  it("fetches strain images", async () => {
    strainFetch({ images: [] });
    await routeLocalTool("strain_images", { strain_name: "Blue Dream" });
    expect(fetchCalls[0].url).toBe("http://treesearch.test/api/strains/Blue%20Dream/images?limit=20");
  });

  it("fetches nearest neighbour strains", async () => {
    strainFetch({ neighbors: [] });
    await routeLocalTool("strain_neighbors", { strain_name: "Blue Dream", k: 4 });
    expect(fetchCalls[0].url).toBe("http://treesearch.test/api/strains/Blue%20Dream/neighbors?k=4");
  });

  it("starts a strain import as a non-streaming job", async () => {
    strainFetch({ job_id: "job-9" });
    const result = await routeLocalTool("strain_import", { strain_name: "Blue Dream", force: true });
    expect(result).toEqual({ job_id: "job-9" });
    expect(fetchCalls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
      query: "Blue Dream",
      force: true,
      stream: false,
    });
  });

  it("polls an import job", async () => {
    strainFetch({ state: "done" });
    expect(await routeLocalTool("strain_import_status", { job_id: "job 9" })).toEqual({ state: "done" });
    expect(fetchCalls[0].url).toBe("http://treesearch.test/api/import-jobs/job%209");
  });

  it("reports an unknown strain tool", async () => {
    expect(await routeLocalTool("strain_bogus", {})).toEqual({
      error: "Unknown strain tool: strain_bogus",
      is_error: true,
    });
    expect(fakes.fetch).not.toHaveBeenCalled();
  });

  it("returns the service error body on a non-OK response", async () => {
    fakes.fetch.mockResolvedValue(new Response("upstream exploded", { status: 502 }));
    const result = (await routeLocalTool("strain_search", { query: "x" })) as Record<string, unknown>;
    expect(result).toMatchObject({ is_error: true });
    expect(String(result.error)).toBe("treesearch-service 502: upstream exploded");
  });

  it("reports non-JSON bodies", async () => {
    fakes.fetch.mockResolvedValue(new Response("<html>nope</html>", { status: 200 }));
    const result = (await routeLocalTool("strain_detail", { strain_name: "x" })) as Record<string, unknown>;
    expect(result).toEqual({ error: "treesearch-service returned non-JSON: <html>nope</html>", is_error: true });
  });

  it("reports an abort as a timeout", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    fakes.fetch.mockRejectedValue(abortError);
    const result = (await routeLocalTool("strain_images", { strain_name: "x" })) as Record<string, unknown>;
    expect(result).toEqual({ error: "treesearch-service timed out after 5000ms", is_error: true });
  });

  it("reports an unreachable service", async () => {
    fakes.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = (await routeLocalTool("strain_neighbors", { strain_name: "x" })) as Record<string, unknown>;
    expect(result).toEqual({
      error: "treesearch-service unreachable at http://treesearch.test: ECONNREFUSED",
      is_error: true,
    });
  });
});

describe("routeLocalTool — news and web search", () => {
  it("routes news_search with country, category and debug fields", async () => {
    const result = await routeLocalTool("news_search", {
      topic: "  cannabis policy ",
      limit: 3,
      country: "US",
      category: "technology",
      _source: "RSS",
      _provider: "Google",
    });
    expect(fakes.newsSearch).toHaveBeenCalledWith(
      "cannabis policy",
      3,
      "us",
      "technology",
      { source: "rss", provider: "google" },
    );
    expect(fakes.registerRunUrls).toHaveBeenCalledWith(
      ["https://news.test/a", "https://news.test/b"],
      expect.anything(),
    );
    expect(result).toEqual({
      topic: "cannabis policy",
      country: "us",
      category: "technology",
      source: "google-news",
      count: 2,
      items: [{ url: "https://news.test/a" }, { url: "https://news.test/b" }],
      providers: { usable: ["google-news"], configured: ["google-news"] },
    });
  });

  it("uses the default country and top category for unknown values", async () => {
    const result = (await routeLocalTool("news_search", {
      query: "elections",
      category: "not-a-category",
    })) as Record<string, unknown>;
    expect(fakes.newsSearch).toHaveBeenCalledWith("elections", 6, undefined, "", {
      source: "",
      provider: "",
    });
    expect(result).toMatchObject({ country: "(default)", category: "(top)" });
  });

  it("routes web_search with site narrowing and domain filtering", async () => {
    fakes.webSearch.mockResolvedValue({
      status: "ok",
      provider: "exa",
      results: [{ url: "https://docs.blender.org/api" }, { url: "https://example.test/y" }],
    });
    const result = await routeLocalTool("web_search", {
      q: "blender gpu",
      limit: 2,
      allowed_domains: ["docs.blender.org"],
    });
    expect(fakes.webSearch).toHaveBeenCalledWith("site:docs.blender.org blender gpu", 2, undefined, undefined);
    expect(result).toMatchObject({
      query: "blender gpu",
      count: 1,
      status: "ok",
      search: { provider: "exa", calls: 1 },
    });
    expect(result).not.toHaveProperty("is_error");
  });

  it("marks a failed web search as an error result", async () => {
    fakes.webSearch.mockResolvedValue({ status: "error", provider: "exa", results: [], error: "rate limited" });
    const result = await routeLocalTool("web_search", { query: "x" });
    expect(result).toMatchObject({ is_error: true, count: 0, status: "error" });
  });
});

describe("routeLocalTool — widgets", () => {
  it("rejects an incomplete plan with the missing fields", async () => {
    const result = await routeLocalTool("plan_widget", { widgetType: "clock" });
    expect(result).toEqual({
      success: false,
      error: "PLAN_INCOMPLETE",
      missing: ["title", "description"],
      message: expect.stringContaining("plan_widget needs title, description"),
    });
    expect(fakes.toolContextSet).not.toHaveBeenCalled();
  });

  it("registers a complete plan on the conversation", async () => {
    const result = (await routeLocalTool(
      "plan_widget",
      { widgetType: "clock", title: "Desk clock", description: "Shows the time in three cities with a select" },
      { cycleId: "cycle-1" },
    )) as Record<string, unknown>;
    expect(result).toMatchObject({
      success: true,
      plan: { widgetType: "clock", title: "Desk clock" },
    });
    expect(String(result.message)).toContain("Now call create_widget with widgetType='clock'");
    expect(fakes.toolContextSet).toHaveBeenCalledWith("cycle-1", "widgetPlan", expect.objectContaining({ widgetType: "clock" }));
    expect(fakes.toolContextSet).toHaveBeenCalledWith("cycle-1", "widgetPlanApproved", true);
  });

  it("validates widget HTML and reports the errors", async () => {
    const empty = await routeLocalTool("validate_widget_html", { htmlContent: "" });
    expect(empty).toEqual({ valid: false, errors: ["HTML content is empty."] });

    const unbalanced = await routeLocalTool("validate_widget_html", { htmlContent: "<div><span></div>" });
    expect(unbalanced).toMatchObject({ valid: false });
  });

  it("lists the widget types", async () => {
    const result = (await routeLocalTool("list_widget_types", {})) as { success: boolean; types: Array<{ type: string }> };
    expect(result.success).toBe(true);
    expect(result.types.map((type) => type.type)).toContain("clock");
  });

  it("blocks create_widget when no plan was registered", async () => {
    const result = await routeLocalTool("create_widget", { widgetType: "clock", htmlContent: "<div></div>" }, { cycleId: "c1" });
    expect(result).toMatchObject({ success: false, error: "PLANNING_REQUIRED" });
  });

  it("blocks create_widget when it does not match the plan", async () => {
    fakes.toolContextGet.mockReturnValue({ widgetType: "clock", title: "Desk clock", description: "x".repeat(30) });
    const result = await routeLocalTool(
      "create_widget",
      { widgetType: "notes", htmlContent: "<div></div>" },
      { cycleId: "c1" },
    );
    expect(result).toMatchObject({ success: false, error: "PLAN_MISMATCH" });
  });

  it("rejects create_widget with invalid HTML", async () => {
    fakes.toolContextGet.mockReturnValue({ widgetType: "clock", title: "Desk clock", description: "x".repeat(30) });
    const result = await routeLocalTool(
      "create_widget",
      { widgetType: "clock", htmlContent: "<div><span></div>" },
      { cycleId: "c1" },
    );
    expect(result).toMatchObject({ success: false, error: "VALIDATION_FAILED" });
    expect(String((result as Record<string, unknown>).message)).toContain("Widget HTML validation failed");
  });

  it("validates create_widget without a cycle even when no plan exists", async () => {
    const result = await routeLocalTool("create_widget", { htmlContent: "" });
    expect(result).toMatchObject({ success: false, error: "VALIDATION_FAILED" });
  });

  it("rejects update_widget with invalid HTML", async () => {
    const result = await routeLocalTool("update_widget", { htmlContent: "<div></div></span>" });
    expect(result).toMatchObject({ success: false, error: "VALIDATION_FAILED" });
  });

  it("forwards a valid create_widget to HTML-Notes", async () => {
    fakes.toolContextGet.mockReturnValue({ widgetType: "clock", title: "Desk clock", description: "x".repeat(30) });
    const result = await routeLocalTool(
      "create_widget",
      { widgetType: "clock", htmlContent: "<div></div>", title: "Desk clock" },
      { cycleId: "c1" },
    );
    expect(result).toEqual({ status: "success" });
    expect(fetchCalls[0].url).toBe("http://html-notes.test/internal/execute");
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
      tool: "create_widget",
      args: { widgetType: "clock", htmlContent: "<div></div>", title: "Desk clock" },
    });
  });

  it("forwards update_widget without HTML unchanged", async () => {
    const result = await routeLocalTool("update_widget", { widgetId: "w1", title: "New" });
    expect(result).toEqual({ status: "success" });
  });

  it("returns the HTML-Notes error body when forwarding fails", async () => {
    fakes.fetch.mockResolvedValue(new Response("bad widget", { status: 400 }));
    expect(await routeLocalTool("html_notes_get", { id: "n1" })).toEqual({
      error: "bad widget",
      is_error: true,
    });
  });

  it("reports an unreachable HTML-Notes service", async () => {
    fakes.fetch.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const result = (await routeLocalTool("html_notes_create", {})) as Record<string, unknown>;
    expect(result).toEqual({
      error:
        "Failed to connect to html-notes service at http://html-notes.test. Is the service down? Details: connect ECONNREFUSED",
      is_error: true,
    });
  });

  it("handles canvas_modify_dom without HTML natively", async () => {
    expect(await routeLocalTool("canvas_modify_dom", {})).toEqual({
      success: true,
      message: "Handled natively by HTML-Notes client",
    });
    expect(fakes.fetch).not.toHaveBeenCalled();
  });
});

describe("routeLocalTool — scrape_url and remote MCP", () => {
  it("refuses a guarded scrape target", async () => {
    fakes.scrapeTargetGuard.mockReturnValue({ error: "UNVERIFIED_URL", is_error: true });
    expect(await routeLocalTool("scrape_url", { url: "https://x.test/a" })).toEqual({
      error: "UNVERIFIED_URL",
      is_error: true,
    });
    expect(fakes.executeWebExtract).not.toHaveBeenCalled();
  });

  it("skips the budget charge for an unscrapable domain and still extracts", async () => {
    fakes.unscrapableDomainOf.mockReturnValue("pinterest.com");
    const result = await routeLocalTool("scrape_url", { url: "https://pinterest.com/pin/1" });
    expect(result).toEqual({ markdown: "# page" });
    expect(fakes.chargeScrape).not.toHaveBeenCalled();
    expect(fakes.executeWebExtract).toHaveBeenCalledWith({ url: "https://pinterest.com/pin/1" });
  });

  it("refuses when the per-run scrape budget is exhausted", async () => {
    fakes.chargeScrape.mockReturnValue({ error: "SCRAPE_BUDGET_EXHAUSTED", is_error: true });
    expect(await routeLocalTool("scrape_url", { url: "https://blog.test/post" })).toEqual({
      error: "SCRAPE_BUDGET_EXHAUSTED",
      is_error: true,
    });
    expect(fakes.executeWebExtract).not.toHaveBeenCalled();
  });

  it("extracts a plain URL without running the guards", async () => {
    await routeLocalTool("scrape_url", {});
    expect(fakes.scrapeTargetGuard).not.toHaveBeenCalled();
    expect(fakes.executeWebExtract).toHaveBeenCalledWith({});
  });

  it("delegates a connected remote MCP tool", async () => {
    fakes.parseMCPToolName.mockReturnValue({ serverName: "obsidian", toolName: "search" });
    fakes.isConnected.mockReturnValue(true);
    expect(await routeLocalTool("mcp__obsidian__search", { q: "x" })).toEqual({ content: "remote" });
    expect(fakes.callTool).toHaveBeenCalledWith("obsidian", "search", { q: "x" });
  });

  it("falls through to the bridge for a disconnected remote MCP tool", async () => {
    fakes.parseMCPToolName.mockReturnValue({ serverName: "obsidian", toolName: "search" });
    fakes.isConnected.mockReturnValue(false);
    const result = await routeLocalTool("mcp__obsidian__search", { q: "x" });
    expect(result).toEqual({ status: "success" });
    expect(fakes.callTool).not.toHaveBeenCalled();
    expect(fetchCalls[0].url).toBe("http://trading.test/api/v1/agent-tools/execute");
  });

  it("retires music player tools", async () => {
    expect(await routeLocalTool("music_player_play", {})).toEqual({
      error: "Retired tool: music_player_play",
    });
  });

  it("filters and registers lazy_web_search results", async () => {
    fakes.filterSearchResultLinks.mockReturnValue({ status: "success", links: ["https://x.test"] });
    expect(await routeLocalTool("lazy_web_search", { query: "q" }, { cycleId: "c1" })).toEqual({
      status: "success",
      links: ["https://x.test"],
    });
    expect(fakes.registerSearchResultUrls).toHaveBeenCalledWith(
      { status: "success", links: ["https://x.test"] },
      { cycleId: "c1" },
    );
  });
});

describe("routeLocalTool — code_health", () => {
  const files = [{ path: "a.ts", content: "export function f(a) { if (a) { return 1; } return 2; }" }];

  it("requires a non-empty files array", async () => {
    expect(await routeLocalTool("code_health", {})).toEqual({
      error: "code_health requires a non-empty files array",
    });
    expect(await routeLocalTool("code_health", { files: [] })).toEqual({
      error: "code_health requires a non-empty files array",
    });
  });

  it("caps the number of files", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({ path: `f${index}.ts`, content: "x" }));
    expect(await routeLocalTool("code_health", { files: many })).toEqual({
      error: "code_health accepts at most 50 files per call",
    });
  });

  it("rejects malformed entries", async () => {
    expect(await routeLocalTool("code_health", { files: [null] })).toEqual({
      error: "each files entry must be an object with path and content",
    });
    expect(await routeLocalTool("code_health", { files: [{ path: 1, content: "x" }] })).toEqual({
      error: "each files entry needs a string path and string content",
    });
  });

  it("enforces the 2 MB budget", async () => {
    const huge = [{ path: "big.ts", content: "x".repeat(2_000_001) }];
    expect(await routeLocalTool("code_health", { files: huge })).toEqual({
      error: "submitted content exceeds the 2 MB code_health budget; submit fewer files",
    });
  });

  it("analyses healthy files and returns guidance", async () => {
    const result = (await routeLocalTool("code_health", {
      files,
      max_complexity: 5,
      max_lines: 100,
      min_duplicate_tokens: -1,
    })) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.verdict).toBe("ok");
    expect(result.guidance).toBe("No findings at the configured thresholds.");
  });
});

describe("executeToolViaTradingService", () => {
  it("posts the call with context fields and returns the bridge result", async () => {
    const result = await executeToolViaTradingService(
      "get_quote",
      { ticker: "MSFT" },
      { agentName: "trader", ticker: "AAPL", cycleId: "cycle-1" },
    );
    expect(result).toEqual({ status: "success" });
    expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
      tool_name: "get_quote",
      arguments: { ticker: "MSFT" },
      agent_name: "trader",
      ticker: "AAPL",
      cycle_id: "cycle-1",
    });
  });

  it("serves a repeated reusable read from cache", async () => {
    const args = { ticker: "TSLA", section: "cache-probe-1" };
    const first = await executeToolViaTradingService("get_market_data", args);
    const second = await executeToolViaTradingService("get_market_data", args);
    expect(second).toEqual(first);
    expect(fakes.fetch).toHaveBeenCalledTimes(1);
  });

  it("never caches a failed bridge result", async () => {
    fakes.fetch.mockImplementation(async () => jsonResponse({ error: "boom", is_error: true }));
    const args = { ticker: "NVDA", section: "cache-probe-2" };
    await executeToolViaTradingService("get_market_data", args);
    await executeToolViaTradingService("get_market_data", args);
    expect(fakes.fetch).toHaveBeenCalledTimes(2);
  });

  it("returns a structured error for a non-OK bridge response", async () => {
    fakes.fetch.mockResolvedValue(new Response("upstream down", { status: 503 }));
    const result = (await executeToolViaTradingService("get_quote", {})) as Record<string, unknown>;
    expect(result).toEqual({
      error: "trading-service tool execution failed (503): upstream down",
      is_error: true,
    });
  });

  it("reports an unreachable bridge", async () => {
    fakes.fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = (await executeToolViaTradingService("get_quote", {})) as Record<string, unknown>;
    expect(result).toEqual({
      error: "Failed to reach trading-service at http://trading.test/api/v1/agent-tools/execute: ECONNREFUSED",
      is_error: true,
    });
  });

  it("reports an abort as a bridge timeout", async () => {
    fakes.fetch.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const result = (await executeToolViaTradingService("run_backtest", {})) as Record<string, unknown>;
    expect(result).toEqual({
      error: "Failed to reach trading-service at http://trading.test/api/v1/agent-tools/execute: bridge timeout after 40000ms",
      is_error: true,
    });
  });

  it("routes an unknown local tool through the bridge", async () => {
    expect(await routeLocalTool("get_quote", { ticker: "MSFT" })).toEqual({ status: "success" });
    expect(fakes.guardedRun).toHaveBeenCalled();
  });
});
