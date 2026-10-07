import { beforeEach, expect, it, vi } from "vitest";

// The router hook only: WebSearchService is mocked, so no network.
const mocks = vi.hoisted(() => ({ webSearch: vi.fn(), webSearchStatus: vi.fn(() => ({ provider: "exa", calls: 1 })) }));
vi.mock("../WebSearchService.ts", () => mocks);

const { routeLocalTool } = await import("../LocalToolRouter.ts");

beforeEach(() => mocks.webSearch.mockReset());

it("web_search answers in place with the search's status, results and counters", async () => {
  mocks.webSearch.mockResolvedValue({
    status: "ok", provider: "exa", cached: false,
    results: [{ title: "t", url: "https://example.com/a", snippet: "s", published: "", author: "" }],
  });
  const out = await routeLocalTool("web_search", { query: "  hiking sandals  ", limit: 3 }) as Record<string, unknown>;
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("hiking sandals", 3);
  expect(out).toMatchObject({ query: "hiking sandals", status: "ok", provider: "exa", count: 1, search: { provider: "exa" } });
  expect(out).not.toHaveProperty("is_error");
});

it("marks anything but ok as an error for telemetry, keeping the reason", async () => {
  mocks.webSearch.mockResolvedValue({ status: "rate_limited", provider: "exa", cached: false, results: [], error: "searches resume in 40 s" });
  const out = await routeLocalTool("web_search", { q: "news" }) as Record<string, unknown>;
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("news", 6);
  expect(out).toMatchObject({ status: "rate_limited", is_error: true, count: 0, error: "searches resume in 40 s" });
});
