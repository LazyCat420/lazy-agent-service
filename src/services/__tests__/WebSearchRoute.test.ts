import { beforeEach, expect, it, vi } from "vitest";

// The router hook only: WebSearchService is mocked, so no network.
const mocks = vi.hoisted(() => ({ webSearch: vi.fn(), webSearchStatus: vi.fn(() => ({ provider: "exa", calls: 1 })) }));
vi.mock("../WebSearchService.ts", async (importActual) => {
  const actual = await importActual<typeof import("../WebSearchService.ts")>();
  return { ...mocks, filterResultsByDomain: actual.filterResultsByDomain, withSiteSearch: actual.withSiteSearch };
});

const { routeLocalTool } = await import("../LocalToolRouter.ts");

beforeEach(() => mocks.webSearch.mockReset());

it("web_search answers in place with the search's status, results and counters", async () => {
  mocks.webSearch.mockResolvedValue({
    status: "ok", provider: "exa", cached: false,
    results: [{ title: "t", url: "https://example.com/a", snippet: "s", published: "", author: "" }],
  });
  const out = await routeLocalTool("web_search", { query: "  hiking sandals  ", limit: 3 }) as Record<string, unknown>;
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("hiking sandals", 3, undefined, undefined);
  expect(out).toMatchObject({ query: "hiking sandals", status: "ok", provider: "exa", count: 1, search: { provider: "exa" } });
  expect(out).not.toHaveProperty("is_error");
});

it("marks anything but ok as an error for telemetry, keeping the reason", async () => {
  mocks.webSearch.mockResolvedValue({ status: "rate_limited", provider: "exa", cached: false, results: [], error: "searches resume in 40 s" });
  const out = await routeLocalTool("web_search", { q: "news" }) as Record<string, unknown>;
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("news", 6, undefined, undefined);
  expect(out).toMatchObject({ status: "rate_limited", is_error: true, count: 0, error: "searches resume in 40 s" });
});

it("applies siteSearch, domain filters and the caller's abort signal on /execute (audit D5)", async () => {
  mocks.webSearch.mockResolvedValue({
    status: "ok", provider: "exa", cached: false,
    results: [
      { title: "a", url: "https://docs.python.org/3/", snippet: "", published: null, author: "" },
      { title: "b", url: "https://spam.example.com/x", snippet: "", published: null, author: "" },
    ],
  });
  const controller = new AbortController();
  const out = await routeLocalTool(
    "web_search",
    { query: "asyncio", siteSearch: "python.org", allowed_domains: ["docs.python.org"] },
    { signal: controller.signal },
  ) as { results: Array<{ url: string }>; count: number };
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("site:python.org asyncio", 6, undefined, controller.signal);
  expect(out.results.map((r) => r.url)).toEqual(["https://docs.python.org/3/"]);
  expect(out.count).toBe(1);
});

it("scrape_url on /execute uses the shared extractor, never the trading bridge (audit D5)", async () => {
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const out = await routeLocalTool("scrape_url", { url: "http://169.254.169.254/latest/meta-data/", prompt: "list keys" }) as Record<string, unknown>;
  vi.unstubAllGlobals();
  expect(out).toMatchObject({ success: false });
  expect(String(out.error)).toContain("blocked");
  const targets = fetchSpy.mock.calls.map((c) => String(c[0]));
  expect(targets.some((t) => t.includes("169.254.169.254") || t.includes("/agent-tools/execute"))).toBe(false);
});
