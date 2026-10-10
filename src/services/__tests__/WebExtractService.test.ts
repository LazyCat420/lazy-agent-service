// WebExtractService: scrape_url on this harness — scraper-service under a
// character budget, truncate-and-store, URL+limit-bucketed 20 min cache.
// WebSearchService: the SearXNG fallback answers when Exa fails.
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import * as WebExtractModule from "../WebExtractService.ts";
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

describe("SSRF guard", () => {
  it.each([
    "http://example.com/page",
    "http://localhost:8001/x",
    "https://localhost/x",
    "https://printer.local/status",
    "https://nas/admin",
    "https://127.0.0.1/x",
    "https://127.9.9.9/x",
    "https://10.1.2.3/x",
    "https://192.168.1.1/x",
    "https://172.16.0.1/x",
    "https://172.31.255.255/x",
    "https://169.254.1.1/x",
    "https://[::1]/x",
    "https://[fe80::1]/x",
    "https://[fc00::1]/x",
  ])("blocks %s without any network call", async (u) => {
    const h = harness([]);
    const result = await webExtract(u, 15_000, h.deps);
    expect(result).toMatchObject({ status: "error", cached: false });
    expect(result.error).toContain("blocked");
    expect(h.calls).toHaveLength(0);
  });

  it("allows public https hosts", () => {
    expect(WebExtractModule.isBlockedHost("https://example.com/page")).toBe(false);
  });

  it("permits private hosts under ALLOW_PRIVATE_URLS=1", async () => {
    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
    const h = harness([{ body: JSON.stringify({ success: true, content: "lan" }) }]);
    expect(WebExtractModule.isBlockedHost("https://10.0.0.1/x")).toBe(false);
    expect((await webExtract("https://10.0.0.1/x", 15_000, h.deps)).content).toBe("lan");
    vi.unstubAllEnvs();
  });

  it("blocks WEB_BLOCKED_DOMAINS hosts and subdomains before fetching", async () => {
    vi.stubEnv("WEB_BLOCKED_DOMAINS", "evil.example");
    const h = harness([]);
    expect(WebExtractModule.isBlockedHost("https://sub.evil.example/x")).toBe(true);
    expect((await webExtract("https://sub.evil.example/x", 15_000, h.deps)).error).toContain("WEB_BLOCKED_DOMAINS");
    expect(h.calls).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("never caches a blocked result", async () => {
    vi.stubEnv("WEB_BLOCKED_DOMAINS", "evil.example");
    await webExtract("https://evil.example/x", 15_000, harness([]).deps);
    vi.unstubAllEnvs();
    const h = harness([{ body: JSON.stringify({ success: true, content: "now allowed" }) }]);
    expect((await webExtract("https://evil.example/x", 15_000, h.deps)).content).toBe("now allowed");
    expect(h.calls).toHaveLength(1);
  });
});

describe("WEB_CACHE_EXEMPT_HOSTS", () => {
  it("fetches exempt hosts live on every call, never from cache", async () => {
    vi.stubEnv("WEB_CACHE_EXEMPT_HOSTS", "fresh.example, *.live.example");
    const h = harness([
      { body: JSON.stringify({ success: true, content: "first" }) },
      { body: JSON.stringify({ success: true, content: "second" }) },
    ]);
    const first = await webExtract("https://fresh.example/a", 15_000, h.deps);
    const second = await webExtract("https://fresh.example/a", 15_000, h.deps);
    expect(first.cached).toBe(false);
    expect(second).toMatchObject({ cached: false, content: "second" });
    expect(h.calls).toHaveLength(2);
    const wild = await webExtract("https://sub.live.example/b", 15_000, h.deps);
    expect(wild.cached).toBe(false);
    expect(h.calls).toHaveLength(3);
    vi.unstubAllEnvs();
  });

  it("does not exempt unlisted hosts", async () => {
    vi.stubEnv("WEB_CACHE_EXEMPT_HOSTS", "other.example");
    const h = harness([{ body: JSON.stringify({ success: true, content: "once" }) }]);
    await webExtract("https://example.com/c", 15_000, h.deps);
    expect((await webExtract("https://example.com/c", 15_000, h.deps)).cached).toBe(true);
    expect(h.calls).toHaveLength(1);
    vi.unstubAllEnvs();
  });
});

describe("scrape_url handler", () => {
  it("dispatches the answered path when prompt is set and the plain path otherwise", async () => {
    const plainSpy = vi.spyOn(WebExtractModule, "webExtract").mockResolvedValue({ status: "ok", url: "https://example.com/a", content: "raw text", truncated: false, cached: false });
    const answeredSpy = vi.spyOn(WebExtractModule, "webExtractAnswered").mockResolvedValue({ url: "https://example.com/a", answer: "42", truncated: false, cached: false });

    const answered = await (ToolOrchestratorService as any).executeWebExtract({ url: "https://example.com/a", prompt: "what is the answer?" });
    expect(answered).toMatchObject({ url: "https://example.com/a", success: true, answer: "42", truncated: false, cached: false });
    expect(answeredSpy).toHaveBeenCalledWith("https://example.com/a", "what is the answer?", undefined);

    const plain = await (ToolOrchestratorService as any).executeWebExtract({ url: "https://example.com/a" });
    expect(plain).toMatchObject({ url: "https://example.com/a", success: true, content: "raw text" });
    expect(plainSpy).toHaveBeenCalledWith("https://example.com/a", undefined);
    plainSpy.mockRestore();
    answeredSpy.mockRestore();
  });
});
