// WebExtractService: scrape_url on this harness — scraper-service under a
// character budget, truncate-and-store, URL+limit-bucketed 20 min cache.
// WebSearchService: the SearXNG fallback answers when Exa fails.
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import * as WebExtractModule from "../WebExtractService.ts";
import { normalizeScrapeUrl } from "../../utils/ScrapeUrl.ts";
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

  it("stores the full text but tells the model to re-call with a higher char_limit", async () => {
    const longText = `${"x".repeat(40_000)}\nEND-OF-PAGE`;
    const h = harness([{ body: JSON.stringify({ success: true, content: longText, engine_used: "playwright" }) }]);
    const result = await webExtract("https://example.com/long", 15_000, h.deps);
    expect(result.truncated).toBe(true);
    expect(result.storedPath).toBeTruthy();
    // No agent in this service has a read_file tool, so a footer naming a
    // /tmp path made agents scrape_url that path (3 of 31 calls on 10-30).
    expect(result.content).not.toContain(result.storedPath!);
    expect(result.content).not.toContain("read_file");
    expect(result.content).toContain("higher char_limit");
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
    "https://0.0.0.0/x",
    "https://100.64.0.1/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[::ffff:a9fe:a9fe]/x",
  ])("blocks %s without any network call", async (u) => {
    const h = harness([]);
    const result = await webExtract(u, 15_000, h.deps);
    expect(result).toMatchObject({ status: "error", cached: false });
    expect(result.error).toContain("blocked");
    expect(h.calls).toHaveLength(0);
  });

  it("blocks a public-looking name that resolves private (audit D6)", async () => {
    const h = harness([]);
    const result = await webExtract("https://127.0.0.1.nip.io/x", 15_000, {
      ...h.deps,
      resolve: async () => ["127.0.0.1"],
    });
    expect(result.error).toMatch(/blocked: .*private address 127\.0\.0\.1/);
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

describe("normalizeScrapeUrl", () => {
  it("keeps a full http(s) URL untouched", () => {
    expect(normalizeScrapeUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeScrapeUrl("HTTP://Example.com")).toBe("HTTP://Example.com");
  });

  it("upgrades a bare host, with or without a path or port", () => {
    expect(normalizeScrapeUrl("finviz.com/quote.ashx?t=BWFG")).toBe("https://finviz.com/quote.ashx?t=BWFG");
    expect(normalizeScrapeUrl("www.sec.gov/Archives/edgar/data/1")).toBe("https://www.sec.gov/Archives/edgar/data/1");
    expect(normalizeScrapeUrl("blog.test:8443/post")).toBe("https://blog.test:8443/post");
    expect(normalizeScrapeUrl("example.com")).toBe("https://example.com");
  });

  it("turns a protocol-relative URL into https", () => {
    expect(normalizeScrapeUrl("//cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  it("leaves a relative path or a bare word alone so the caller can reject it", () => {
    expect(normalizeScrapeUrl("/investors/earnings")).toBe("/investors/earnings");
    expect(normalizeScrapeUrl("localhost")).toBe("localhost");
    expect(normalizeScrapeUrl("")).toBe("");
    expect(normalizeScrapeUrl(undefined)).toBe("");
    expect(normalizeScrapeUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });
});

describe("scrape_url handler", () => {
  it("upgrades a bare domain to https before extracting", async () => {
    const h = harness([{ body: JSON.stringify({ success: true, content: "page text", engine_used: "http" }) }]);
    const result = await webExtract("example.com/article", 15_000, h.deps);
    expect(result).toMatchObject({ status: "ok", url: "https://example.com/article", content: "page text" });
    expect(h.calls[0].body).toEqual({ url: "https://example.com/article", engine: "auto" });
  });

  it("rejects a relative path with the actionable full-URL message", async () => {
    const h = harness([]);
    const result = await webExtract("/investors/earnings", 15_000, h.deps);
    expect(result.status).toBe("error");
    expect(result.error).toContain("https://");
    expect(h.calls).toHaveLength(0);
  });

  it("tells the model to retry with a full URL when the argument is malformed", async () => {
    const out = await ToolOrchestratorService.executeWebExtract({ url: "/investors/earnings" });
    expect(out.success).toBe(false);
    expect(out.error).toContain("Call scrape_url again with the full URL including https://");
    expect(out.error).toContain("(url: /investors/earnings)");
  });

  it("never hands the model a stored-file path it cannot read", async () => {
    const plainSpy = vi.spyOn(WebExtractModule, "webExtract").mockResolvedValue({
      status: "ok", url: "https://example.com/long", content: "head\n\n[TRUNCATED] ...\n\ntail",
      truncated: true, cached: false, storedPath: "/tmp/lazy-agent-web-extract/abc-1.txt",
    });
    const out = await (ToolOrchestratorService as any).executeWebExtract({ url: "https://example.com/long" });
    expect(out).toMatchObject({ url: "https://example.com/long", success: true, truncated: true });
    expect(out).not.toHaveProperty("stored_path");
    expect(out).not.toHaveProperty("read_hint");
    expect(JSON.stringify(out)).not.toContain("/tmp/lazy-agent-web-extract");
    plainSpy.mockRestore();
  });

  it("normalizes a bare domain through the handler", async () => {
    const plainSpy = vi.spyOn(WebExtractModule, "webExtract").mockResolvedValue({ status: "ok", url: "https://sec.gov/a", content: "filing", truncated: false, cached: false });
    const out = await ToolOrchestratorService.executeWebExtract({ url: "sec.gov/a" });
    expect(plainSpy).toHaveBeenCalledWith("https://sec.gov/a", undefined);
    expect(out).toMatchObject({ url: "https://sec.gov/a", success: true });
    plainSpy.mockRestore();
  });

  it("reports a failed extract with a prompt as success:false, not an empty answer (audit D7)", async () => {
    const out = await (ToolOrchestratorService as any).executeWebExtract({ url: "https://127.0.0.1/x", prompt: "what?" });
    expect(out.success).toBe(false);
    expect(out.error).toContain("blocked");
    expect(out).not.toHaveProperty("answer");
  });

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

describe("stored extract cleanup (audit D11)", () => {
  it("removes stored full texts older than the TTL and keeps fresh ones", async () => {
    const nodeFs = await import("node:fs");
    const nodeOs = await import("node:os");
    const nodePath = await import("node:path");
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "extract-sweep-"));
    const old = nodePath.join(dir, "old.txt");
    const fresh = nodePath.join(dir, "fresh.txt");
    nodeFs.writeFileSync(old, "x");
    nodeFs.writeFileSync(fresh, "y");
    const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1_000) / 1_000;
    nodeFs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    expect(await WebExtractModule.sweepExtractStore(Date.now(), dir)).toBe(1);
    expect(nodeFs.existsSync(old)).toBe(false);
    expect(nodeFs.existsSync(fresh)).toBe(true);
    nodeFs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("per-caller char limit over one cached scrape (audit bc1049a)", () => {
  it("two limits in the same bucket each get their own cut from one scrape", async () => {
    const page = Array.from({ length: 2_000 }, (_, i) => `line ${i} of the page`).join("\n");
    const h = harness([{ body: JSON.stringify({ success: true, content: page }) }]);
    const small = await webExtract("https://example.com/long", 3_000, h.deps);
    const larger = await webExtract("https://example.com/long", 4_800, h.deps);
    expect(h.calls).toHaveLength(1);
    expect(larger.cached).toBe(true);
    expect(small.content.length).toBeLessThan(larger.content.length);
    expect(larger.content.length).toBeLessThanOrEqual(4_800 + 400);
  });
});
