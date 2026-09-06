import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  CATEGORIES,
  __resetEditorialCacheForTests,
  editorialStatus,
  mergeAndRank,
  parseFeed,
  sameStory,
  titleTokens,
  topHeadlines,
} from "../EditorialHeadlinesService.ts";
import { BBC, GOOGLE_TOP, GOOGLE_WORLD, LOCAL, NYT } from "./fixtures/feeds.ts";

describe("parseFeed", () => {
  it("strips Google's ' - Publisher' suffix and reads the real publisher from <source url>", () => {
    const items = parseFeed(GOOGLE_TOP, "google:top");
    expect(items).toHaveLength(3);
    expect(items[0].title).toBe(
      "U.S. military says it hit 3 Iranian tankers after Navy ships targeted",
    );
    expect(items[0].source).toBe("washingtonpost.com");
    // The link is still a Google redirect stub, so it must be marked as one:
    // it does NOT resolve server-side and its og:image is Google's logo.
    expect(items[0].stub).toBe(true);
    expect(items[0].image).toBe("");
    expect(items[0].rank).toBe(0);
    expect(items[1].rank).toBe(1);
  });

  it("reads CDATA titles, descriptions and media:content / media:thumbnail images", () => {
    const nyt = parseFeed(NYT, "nyt");
    expect(nyt[0].title).toBe(
      "U.S. Strikes Three Iranian 'Shadow Network' Oil Tankers, Military Says",
    );
    expect(nyt[0].image).toBe("https://static01.nyt.com/images/2026/09/05/tankers.jpg");
    expect(nyt[0].snippet).toContain("two Navy destroyers");
    expect(nyt[0].stub).toBe(false);
    expect(nyt[0].source).toBe("nytimes.com");

    const bbc = parseFeed(BBC, "bbc");
    expect(bbc[0].title).toBe("US envoys set for Ukraine talks after meeting Putin in Moscow");
    expect(bbc[0].image).toBe("https://ichef.bbci.co.uk/news/640/moscow.jpg");
  });

  it("returns [] for junk rather than throwing", () => {
    expect(parseFeed("", "x")).toEqual([]);
    expect(parseFeed("<html>not a feed</html>", "x")).toEqual([]);
  });
});

describe("sameStory", () => {
  it("matches two newsrooms' wording of one event", () => {
    expect(
      sameStory(
        titleTokens("U.S. military says it hit 3 Iranian tankers after Navy ships targeted"),
        titleTokens("U.S. Strikes Three Iranian 'Shadow Network' Oil Tankers, Military Says"),
      ),
    ).toBe(true);
  });

  it("does not match unrelated stories that share a common word", () => {
    expect(
      sameStory(
        titleTokens("Trump envoys Witkoff and Kushner meet with Putin about ending the Ukraine war"),
        titleTokens("10,000 Maniacs perform at Reg Lenna Center for 45th anniversary show"),
      ),
    ).toBe(false);
  });
});

describe("mergeAndRank", () => {
  const feeds = () => ({
    "google:top": parseFeed(GOOGLE_TOP, "google:top"),
    "google:world": parseFeed(GOOGLE_WORLD, "google:world"),
    nyt: parseFeed(NYT, "nyt"),
    bbc: parseFeed(BBC, "bbc"),
    local: parseFeed(LOCAL, "local"),
  });

  it("counts consensus across independent feeds and ranks by it", () => {
    const out = mergeAndRank(feeds(), { limit: 10 });
    const tankers = out.find((i) => /tankers/i.test(i.title));
    expect(tankers).toBeDefined();
    // google:top + google:world are ONE newsroom and must not both count.
    // Google + NYT = 2.
    expect(tankers!.consensus).toBe(2);
    const maniacs = out.find((i) => /Maniacs/i.test(i.title));
    expect(maniacs!.consensus).toBe(1);
    expect(out.indexOf(tankers!)).toBeLessThan(out.indexOf(maniacs!));
  });

  it("adopts the publisher's real URL and image over the Google stub", () => {
    const out = mergeAndRank(feeds(), { limit: 10 });
    const tankers = out.find((i) => /tankers/i.test(i.title))!;
    expect(tankers.url).toContain("nytimes.com");
    expect(tankers.url).not.toContain("news.google.com");
    expect(tankers.image).toBe("https://static01.nyt.com/images/2026/09/05/tankers.jpg");
    expect(tankers.stub).toBe(false);
  });

  it("keeps the Google link when no publisher feed carries the story, and says it is a stub", () => {
    const out = mergeAndRank(feeds(), { limit: 10 });
    const scoop = out.find((i) => /Republican midterms/i.test(i.title))!;
    expect(scoop.url).toContain("news.google.com");
    expect(scoop.stub).toBe(true);
    expect(scoop.source).toBe("axios.com");
  });

  it("labels each story with the section feed it came from", () => {
    const out = mergeAndRank(feeds(), { limit: 10 });
    expect(out.find((i) => /Nepal tunnel/i.test(i.title))!.category).toBe("world");
    expect(out.find((i) => /Republican midterms/i.test(i.title))!.category).toBe("top");
  });

  it("never returns the same story twice, and honours the limit", () => {
    const out = mergeAndRank(feeds(), { limit: 3 });
    expect(out).toHaveLength(3);
    const keys = out.map((i) => [...titleTokens(i.title)].sort().join(" "));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("topHeadlines", () => {
  beforeEach(() => __resetEditorialCacheForTests());
  afterEach(() => vi.useRealTimers());

  const fetcher = (bodies: Record<string, string>) =>
    vi.fn(async (url: string) => {
      for (const [frag, body] of Object.entries(bodies)) {
        if (url.includes(frag)) return body;
      }
      return "";
    });

  it("serves a category from its section feed", async () => {
    const f = fetcher({ "topic/WORLD": GOOGLE_WORLD, "nytimes": NYT, "bbci": BBC });
    const out = await topHeadlines({ category: "world", limit: 5, fetcher: f });
    expect(out.items.length).toBeGreaterThan(0);
    expect(f.mock.calls.some(([u]) => String(u).includes("topic/WORLD"))).toBe(true);
  });

  it("caches within the TTL and refetches after it", async () => {
    vi.useFakeTimers();
    const f = fetcher({ "news.google.com": GOOGLE_TOP });
    await topHeadlines({ limit: 5, fetcher: f });
    const first = f.mock.calls.length;
    await topHeadlines({ limit: 5, fetcher: f });
    expect(f.mock.calls.length).toBe(first);

    vi.advanceTimersByTime(6 * 60 * 1000);
    await topHeadlines({ limit: 5, fetcher: f });
    expect(f.mock.calls.length).toBeGreaterThan(first);
  });

  it("serves the stale entry when every feed fails, rather than nothing", async () => {
    vi.useFakeTimers();
    const good = fetcher({ "news.google.com": GOOGLE_TOP });
    const warm = await topHeadlines({ limit: 5, fetcher: good });
    expect(warm.items.length).toBeGreaterThan(0);

    vi.advanceTimersByTime(6 * 60 * 1000);
    const dead = vi.fn(async () => {
      throw new Error("HTTP 429");
    });
    const out = await topHeadlines({ limit: 5, fetcher: dead });
    expect(out.items.length).toBe(warm.items.length);
    expect(out.stale).toBe(true);
  });

  it("returns empty rather than throwing when there is nothing cached and everything fails", async () => {
    const dead = vi.fn(async () => {
      throw new Error("HTTP 500");
    });
    const out = await topHeadlines({ limit: 5, fetcher: dead });
    expect(out.items).toEqual([]);
    expect(out.stale).toBe(false);
  });

  it("reports its own state for the health surface", async () => {
    const f = fetcher({ "news.google.com": GOOGLE_TOP });
    await topHeadlines({ limit: 5, fetcher: f });
    const st = editorialStatus() as Record<string, unknown>;
    expect(Array.isArray(st.cached)).toBe(true);
    expect(CATEGORIES).toContain("world");
    expect(CATEGORIES).toContain("business");
  });
});
