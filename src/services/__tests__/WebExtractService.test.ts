// WebExtractService: scrape_url on this harness — scraper-service under a
// character budget, truncate-and-store, URL+limit-bucketed 20 min cache.
// WebSearchService: the SearXNG fallback answers when Exa fails.
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketCharLimit,
  truncateAndStore,
  webExtract,
  __resetWebExtractForTests,
} from "../WebExtractService.ts";
import { webSearch, __resetWebSearchForTests } from "../WebSearchService.ts";

const harness = (responses: Array<Record<string, unknown>>) => {
  const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    const next = responses[calls.length - 1] ?? {};
    if (next.throws) throw next.throws;
    return new Response(next.body ?? "{}", { status: next.status ?? 200 });
  });
  return { calls, fetchImpl, deps: { fetch: fetchImpl as unknown as typeof fetch, now: () => Date.now() } };
};

afterEach(() => {
  __resetWebExtractForTests();
  __resetWebSearchForTests();
  vi.restoreAllMocks();
});

describe("truncateAndStore", () => {
  it("returns the whole text at or under the budget", () => {
    expect(truncateAndStore("short page", 15_000)).toEqual({ content: "short page", truncated: false });
  });

  it("keeps a 75/25 head+tail window and reports truncation", () => {
    const text = `${"a".repeat(9_000)}\n${"b".repeat(9_000)}`;
    const out = truncateAndStore(text, 15_000);
    expect(out.truncated).toBe(true);
    expect(out.content).toContain("[TRUNCATED]");
    expect(out.content.startsWith("a")).toBe(true);
    expect(out.content.endsWith("b")).toBe(true);
    expect(out.content).toContain("characters of the middle were cut");
  });
});

describe("bucketCharLimit", () => {
  it("buckets near-identical limits so cache entries are shared", () => {
    expect(bucketCharLimit(2_000)).toBe(2_000);
    expect(bucketCharLimit(2_100)).toBe(5_000);
    expect(bucketCharLimit(14_000)).toBe(15_000);
    expect(bucketCharLimit(600_000)).toBe(500_000);
  });
});

describe("webExtract", () => {
  it("scrapes through scraper-service engine auto and returns the content", async () => {
    const h = harness([{ body: JSON.stringify({ success: true, content: "page text", engine_used: "http" }) }]);
    const result = await webExtract("https://example.com/article", 15_000, h.deps);
    expect(result).toMatchObject({ status: "ok", content: "page text", truncated: false, engineUsed: "http", cached: false });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("http://localhost:8001/scrape");
    expect(h.calls[0].body).toEqual({ url: "https://example.com/article", engine: "auto" });
  });

  it("stores the full text and names it in the footer when over budget", async () => {
    const longText = `${"x".repeat(40_000)}\nEND-OF-PAGE`;
    const h = harness([{ body: JSON.stringify({ success: true, content: longText, engine_used: "playwright" }) }]);
    const result = await webExtract("https://example.com/long", 15_000, h.deps);
    expect(result.truncated).toBe(true);
    expect(result.storedPath).toBeTruthy();
    expect(result.content).toContain(result.storedPath!);
    expect(result.content).toContain("END-OF-PAGE");
    const stored = await fs.readFile(result.storedPath!, "utf-8");
    expect(stored).toBe(longText);
  });

  it("answers a repeated URL from the cache without scraping again", async () => {
    const h = harness([{ body: JSON.stringify({ success: true, content: "once" }) }]);
    await webExtract("https://example.com/dup", 15_000, h.deps);
    const again = await webExtract("https://example.com/dup", 15_000, h.deps);
    expect(again.cached).toBe(true);
    expect(h.calls).toHaveLength(1);
  });

  it("never caches a failed scrape", async () => {
    const h = harness([{ body: JSON.stringify({ success: false, error: "boom" }) }, { body: JSON.stringify({ success: true, content: "recovered" }) }]);
    expect((await webExtract("https://example.com/flaky", 15_000, h.deps)).status).toBe("error");
    expect((await webExtract("https://example.com/flaky", 15_000, h.deps)).content).toBe("recovered");
    expect(h.calls).toHaveLength(2);
  });

  it("refuses a non-http URL without calling scraper-service", async () => {
    const h = harness([]);
    expect((await webExtract("ftp://example.com", 15_000, h.deps)).status).toBe("error");
    expect(h.calls).toHaveLength(0);
  });
});

describe("the web_search SearXNG fallback", () => {
  it("falls back to scraper-service's searxng collector when Exa fails", async () => {
    const h = harness([
      { status: 500, body: "exa down" },
      { body: JSON.stringify({ success: true, items: [{ title: "Result", url: "https://example.com/r", snippet: "snip", publishedDate: "2026-10-01" }] }) },
    ]);
    const result = await webSearch("query", 6, h.deps);
    expect(result).toMatchObject({ status: "ok", provider: "searxng", cached: false });
    expect(result.results[0]).toMatchObject({ title: "Result", url: "https://example.com/r", published: "2026-10-01" });
    expect(h.calls[1].url).toBe("http://localhost:8001/collect");
    expect(h.calls[1].body).toEqual({ source: "searxng", query: "query", limit: 6 });
  });

  it("keeps the Exa failure when the fallback also fails or is empty", async () => {
    const h = harness([
      { status: 429, body: "rate limit" },
      { body: JSON.stringify({ success: true, items: [] }) },
    ]);
    const result = await webSearch("q", 6, h.deps);
    expect(result).toMatchObject({ status: "rate_limited", provider: "exa" });
    expect(h.calls).toHaveLength(2);
  });

  it("does not call the fallback when Exa succeeds", async () => {
    const exaText = "Title: T\nURL: https://example.com/a\nPublished: 2026-10-01\nAuthor: N/A\n---\nTitle: U\nURL: https://example.com/b\nPublished: 2026-10-02\nAuthor: N/A";
    const h = harness([{ body: JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: exaText }] } }) }]);
    const result = await webSearch("q", 6, h.deps);
    expect(result).toMatchObject({ status: "ok", provider: "exa" });
    expect(h.calls).toHaveLength(1);
  });
});
