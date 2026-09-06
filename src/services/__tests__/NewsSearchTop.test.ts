import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The editorial module is mocked so this file tests the ROUTING decision —
// which mechanism answers an empty topic — without touching the network.
const topHeadlines = vi.fn();
vi.mock("../EditorialHeadlinesService.ts", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, topHeadlines };
});

const { newsSearch, newsProviderStatus } = await import("../NewsSearchService.ts");

const ITEM = {
  title: "U.S. military says it hit 3 Iranian tankers after Navy ships targeted",
  url: "https://www.nytimes.com/2026/09/05/us/politics/iran-tankers.html",
  image: "https://static01.nyt.com/tankers.jpg",
  source: "nytimes.com",
  snippet: "",
  date: "Sat, 05 Sep 2026 22:10:00 GMT",
  feed: "google:top",
  rank: 0,
  stub: false,
  consensus: 3,
  category: "top",
};

describe("newsSearch: an empty topic means today's headlines", () => {
  beforeEach(() => {
    topHeadlines.mockReset();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers from the editorial feeds and spends NO keyed-provider quota", async () => {
    topHeadlines.mockResolvedValue({ items: [ITEM], stale: false, feeds: ["google:top"] });
    const before = JSON.stringify(newsProviderStatus().usedToday);

    const out = await newsSearch("", 6);

    expect(out.source).toBe("editorial");
    expect(out.items[0].consensus).toBe(3);
    // The free tiers are small and a second rotator in trading-service spends
    // the same keys, so the top-stories path must not consume any of them.
    expect(JSON.stringify(newsProviderStatus().usedToday)).toBe(before);
  });

  it("marks a stale answer as stale rather than passing it off as fresh", async () => {
    topHeadlines.mockResolvedValue({ items: [ITEM], stale: true, feeds: ["cache:stale"] });
    expect((await newsSearch("", 6)).source).toBe("editorial:stale");
  });

  it("forwards the country and the section", async () => {
    topHeadlines.mockResolvedValue({ items: [ITEM], stale: false, feeds: [] });
    await newsSearch("", 8, "gb", "world");
    expect(topHeadlines).toHaveBeenCalledWith(
      expect.objectContaining({ country: "gb", category: "world", limit: 8 }),
    );
  });

  it("falls back to the keyed providers when the feeds return nothing", async () => {
    topHeadlines.mockResolvedValue({ items: [], stale: false, feeds: [] });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ articles: [] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await newsSearch("", 6);
    // Either a provider was tried, or none was usable — both are the keyed
    // path. What must NOT happen is silently returning the empty editorial set
    // as though the providers had been asked.
    expect(out.source).not.toBe("editorial");
  });

  it("falls back rather than throwing when the editorial path errors", async () => {
    topHeadlines.mockRejectedValue(new Error("boom"));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })));
    await expect(newsSearch("", 6)).resolves.toBeDefined();
  });

  it("a TOPIC search never reaches the editorial path", async () => {
    topHeadlines.mockResolvedValue({ items: [ITEM], stale: false, feeds: [] });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })));
    await newsSearch("federal reserve rate decision", 6);
    expect(topHeadlines).not.toHaveBeenCalled();
  });

  it("_source: keyed skips the editorial feeds, for the bench baseline", async () => {
    topHeadlines.mockResolvedValue({ items: [ITEM], stale: false, feeds: [] });
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })));
    await newsSearch("", 6, undefined, "", { source: "keyed" });
    expect(topHeadlines).not.toHaveBeenCalled();
  });
});
