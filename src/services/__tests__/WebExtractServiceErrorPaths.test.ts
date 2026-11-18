// WebExtractService: what a caller gets when scraper-service fails, when callers overlap, at the
// cache and character-limit boundaries, and which hosts are refused before anything is fetched.
// WebExtractService.test.ts covers the happy path; nothing here repeats it.
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isBlockedHost, isCacheExemptHost, webExtract, __resetWebExtractForTests, type WebExtractDeps } from "../WebExtractService.ts";

interface Reply {
  status?: number;
  /** Raw response body. */
  body?: string;
  /** JSON response body. */
  json?: unknown;
  /** The fetch rejects with this. */
  throws?: Error;
}

/** A scraper-service stand-in: answers the Nth fetch with the Nth reply. */
const harness = (replies: Reply[], clock?: { t: number }) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = replies[calls.length - 1] ?? {};
    if (next.throws) throw next.throws;
    return new Response(next.json !== undefined ? JSON.stringify(next.json) : (next.body ?? "{}"), { status: next.status ?? 200 });
  };
  const deps: WebExtractDeps = { fetch: fetchImpl, now: () => (clock ? clock.t : Date.now()) };
  return { calls, deps };
};

const ok = (content: string): Reply => ({ json: { success: true, content } });

afterEach(() => {
  __resetWebExtractForTests();
  vi.unstubAllEnvs();
});

describe("webExtract: scraper-service failures", () => {
  const failed = { status: "error", content: "", cached: false, truncated: false };

  it("W1 an HTTP error from the scraper is reported with its status and the first 200 characters of its body", async () => {
    const h = harness([{ status: 502, body: "x".repeat(500) }]);
    const result = await webExtract("https://example.com/w1", 15_000, h.deps);
    expect(result).toMatchObject(failed);
    expect(result.error).toBe(`scraper-service HTTP 502: ${"x".repeat(200)}`);
  });

  it("W2 a refused connection is reported as unreachable with the cause", async () => {
    const h = harness([{ throws: new Error("connect ECONNREFUSED 127.0.0.1:8001") }]);
    const result = await webExtract("https://example.com/w2", 15_000, h.deps);
    expect(result).toMatchObject(failed);
    expect(result.error).toBe("scraper-service unreachable: connect ECONNREFUSED 127.0.0.1:8001");
  });

  it("W3 a timeout is reported with how long was waited, not the raw abort message", async () => {
    const h = harness([{ throws: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }]);
    const result = await webExtract("https://example.com/w3", 15_000, h.deps);
    expect(result).toMatchObject(failed);
    expect(result.error).toMatch(/^scraper-service unreachable: timed out after \d+(\.\d+)? s$/);
  });

  it("W4 a 200 reply that is not JSON is an error result, not a thrown exception", async () => {
    const h = harness([{ body: "<html>not json" }]);
    const result = await webExtract("https://example.com/w4", 15_000, h.deps);
    expect(result).toMatchObject(failed);
    expect(result.error?.startsWith("scraper-service unreachable: ")).toBe(true);
  });

  it.each([
    ["W5 success:false with null content and null error", { success: false, content: null, error: null }],
    ["W6 success:true with empty content", { success: true, content: "" }],
  ])("%s is reported as nothing extracted", async (_name, json) => {
    const h = harness([{ json }]);
    const result = await webExtract("https://example.com/w5-w6", 15_000, h.deps);
    expect(result).toMatchObject(failed);
    expect(result.error).toBe("scrape failed (no content extracted)");
  });

  it("W7 a failed scrape drops its partial content and reports the first 200 characters of the scraper's error", async () => {
    const scraperError = `captcha wall ${"y".repeat(400)}`;
    const h = harness([{ json: { success: false, content: "partial", error: scraperError, engine_used: "browser" } }]);
    const result = await webExtract("https://example.com/w7", 15_000, h.deps);
    expect(result).toMatchObject({ ...failed, engineUsed: "browser" });
    expect(result.error).toBe(`scrape failed: ${scraperError.slice(0, 200)}`);
  });

  it("W8 a thin page is a success marked thin, and stays marked thin when served from the cache", async () => {
    const h = harness([{ json: { success: false, content: "Headline only", error: "Thin content: 13 chars", engine_used: "http" } }]);
    const first = await webExtract("https://example.com/w8", 15_000, h.deps);
    expect(first).toMatchObject({ status: "ok", content: "Headline only", contentQuality: "thin", engineUsed: "http", truncated: false, cached: false });

    const second = await webExtract("https://example.com/w8", 15_000, h.deps);
    expect(second).toMatchObject({ status: "ok", content: "Headline only", contentQuality: "thin", cached: true });
    expect(h.calls).toHaveLength(1);
  });

  it.each<[string, Reply]>([
    ["an HTTP error", { status: 502, body: "bad gateway" }],
    ["an unreachable scraper", { throws: new Error("connect ECONNREFUSED 127.0.0.1:8001") }],
    ["an empty extraction", { json: { success: false, content: null, error: null } }],
  ])("W9 after %s the same URL is scraped again (failures are never cached)", async (_name, failure) => {
    const h = harness([failure, ok("recovered")]);
    expect((await webExtract("https://example.com/w9", 15_000, h.deps)).status).toBe("error");
    const second = await webExtract("https://example.com/w9", 15_000, h.deps);
    expect(second).toMatchObject({ status: "ok", content: "recovered", cached: false });
    expect(h.calls).toHaveLength(2);
  });
});

describe("webExtract: overlapping callers, the cache and the character limit", () => {
  /** A scraper whose reply the test releases by hand, to hold a scrape in flight. */
  const heldScraper = (laterReplies: Reply[] = []) => {
    const gate = Promise.withResolvers<Response>();
    let fetches = 0;
    const later = harness(laterReplies);
    const deps: WebExtractDeps = {
      now: () => Date.now(),
      fetch: async (url, init) => {
        fetches += 1;
        return fetches === 1 ? gate.promise : later.deps.fetch(url, init);
      },
    };
    return { deps, release: (json: unknown) => gate.resolve(new Response(JSON.stringify(json))), fetches: () => fetches };
  };

  it("W10 two callers asking for one URL at the same time share a single scrape", async () => {
    const scraper = heldScraper();
    const both = Promise.all([
      webExtract("https://example.com/w10", 15_000, scraper.deps),
      webExtract("https://example.com/w10", 15_000, scraper.deps),
    ]);
    scraper.release({ success: true, content: "shared" });
    const [first, second] = await both;

    expect(scraper.fetches()).toBe(1);
    expect(first).toMatchObject({ status: "ok", content: "shared", cached: false });
    expect(second).toMatchObject({ status: "ok", content: "shared", cached: true });
  });

  it("W11a a caller that joins a failing scrape gets the same error without a second fetch, and the failure is not kept", async () => {
    const scraper = heldScraper([ok("recovered")]);
    const both = Promise.all([
      webExtract("https://example.com/w11", 15_000, scraper.deps),
      webExtract("https://example.com/w11", 15_000, scraper.deps),
    ]);
    scraper.release({ success: false, content: null, error: "origin returned 500" });
    const [first, second] = await both;

    expect(scraper.fetches()).toBe(1);
    expect(first).toMatchObject({ status: "error", error: "scrape failed: origin returned 500" });
    expect(second).toMatchObject({ status: "error", error: "scrape failed: origin returned 500" });

    const third = await webExtract("https://example.com/w11", 15_000, scraper.deps);
    expect(third).toMatchObject({ status: "ok", content: "recovered" });
    expect(scraper.fetches()).toBe(2);
  });

  // Regression (fixed 2026-11-18): the `pending` branch used to answer the joining caller of a
  // failed scrape with `cached: true`, although a failure is never cached.
  it("W11b a failure handed to a joining caller is not labelled as served from the cache", async () => {
    const scraper = heldScraper();
    const both = Promise.all([
      webExtract("https://example.com/w11-label", 15_000, scraper.deps),
      webExtract("https://example.com/w11-label", 15_000, scraper.deps),
    ]);
    scraper.release({ success: false, content: null, error: "origin returned 500" });
    const [, second] = await both;

    expect(second.status).toBe("error");
    expect(second.cached).toBe(false);
  });

  it("W12 a cached page is served until exactly 20 minutes after the scrape, then fetched again", async () => {
    // The service reads this override once at import, so it cannot be stubbed per test. If the
    // machine exports it, fail here with the reason instead of on the 20-minute numbers below.
    expect(process.env.WEB_EXTRACT_CACHE_TTL_MS).toBeUndefined();
    const ttl = 20 * 60 * 1_000;
    const clock = { t: 1_000_000 };
    const h = harness([ok("first"), ok("second")], clock);

    expect(await webExtract("https://example.com/w12", 15_000, h.deps)).toMatchObject({ content: "first", cached: false });

    clock.t = 1_000_000 + ttl - 1;
    expect(await webExtract("https://example.com/w12", 15_000, h.deps)).toMatchObject({ content: "first", cached: true });
    expect(h.calls).toHaveLength(1);

    clock.t = 1_000_000 + ttl;
    expect(await webExtract("https://example.com/w12", 15_000, h.deps)).toMatchObject({ content: "second", cached: false });
    expect(h.calls).toHaveLength(2);
  });

  it("W13 one scrape serves callers with different limits, each cut to its own limit", async () => {
    const page = "line\n".repeat(12_000);
    const h = harness([ok(page)]);

    const small = await webExtract("https://example.com/w13", 2_000, h.deps);
    try {
      expect(small.truncated).toBe(true);
      expect(small.content).toContain("[TRUNCATED]");
      expect(small.content.length).toBeLessThan(3_000);
      expect(typeof small.storedPath).toBe("string");

      const large = await webExtract("https://example.com/w13", 500_000, h.deps);
      expect(large).toMatchObject({ truncated: false, cached: true });
      expect(large.content).toBe(page);
      expect(large.storedPath).toBeUndefined();
      expect(h.calls).toHaveLength(1);
    } finally {
      if (small.storedPath) await fs.rm(small.storedPath, { force: true });
    }
  });

  /** True when a page of `pageLength` characters comes back cut for the given limit. */
  const isCut = async (pageLength: number, charLimit: number | undefined): Promise<boolean> => {
    __resetWebExtractForTests();
    const h = harness([ok("z".repeat(pageLength))]);
    const result = await webExtract("https://example.com/w14", charLimit, h.deps);
    if (result.storedPath) await fs.rm(result.storedPath, { force: true });
    expect(result.status).toBe("ok");
    return result.truncated;
  };

  it("W14a a limit below 2,000 is raised to 2,000", async () => {
    expect(await isCut(2_000, 10)).toBe(false);
    expect(await isCut(2_001, 10)).toBe(true);
  });

  it.each([
    ["NaN", Number.NaN],
    ["0", 0],
    ["undefined", undefined],
  ])("W14b a limit of %s means the default of 15,000", async (_name, charLimit) => {
    // Read once at import, like the cache lifetime in W12: a precondition, not a stub.
    expect(process.env.WEB_EXTRACT_CHAR_LIMIT).toBeUndefined();
    expect(await isCut(15_000, charLimit)).toBe(false);
    expect(await isCut(15_001, charLimit)).toBe(true);
  });

  it("W14c a limit above 500,000 is lowered to 500,000", async () => {
    expect(await isCut(500_000, 9_999_999)).toBe(false);
    expect(await isCut(500_001, 9_999_999)).toBe(true);
  });
});

describe("webExtract: hosts refused before anything is fetched", () => {
  it.each(["https://2130706433/x", "https://0x7f000001/x", "https://127.1/x", "https://017700000001/x"])(
    "W15 %s is loopback written as a number, and is blocked",
    async (url) => {
      const h = harness([]);
      expect(isBlockedHost(url)).toBe(true);
      const result = await webExtract(url, 15_000, h.deps);
      expect(result.status).toBe("error");
      expect(result.error).toContain("blocked");
      expect(h.calls).toHaveLength(0);
    },
  );

  it.each([
    "https://172.15.255.255/x",
    "https://172.32.0.1/x",
    "https://11.0.0.1/x",
    "https://192.169.0.1/x",
    "https://169.253.255.255/x",
    "https://100.63.255.255/x",
    "https://100.128.0.1/x",
    "https://8.8.8.8/x",
  ])("W16 %s is just outside a private range, and is not blocked", (url) => {
    expect(isBlockedHost(url)).toBe(false);
  });

  it.each(["not a url", "", "ftp://example.com/x", "file:///etc/passwd", "HTTP://example.com/x", "https://LOCALHOST/x", "https://Printer.LOCAL/x"])(
    "W17 %j is blocked (not a URL, not https, or a local name in upper case)",
    (url) => {
      expect(isBlockedHost(url)).toBe(true);
    },
  );

  it("W18 WEB_BLOCKED_DOMAINS blocks the domain and its subdomains only, and ALLOW_PRIVATE_URLS does not lift it", () => {
    vi.stubEnv("WEB_BLOCKED_DOMAINS", "evil.example");
    expect(isBlockedHost("https://evil.example/")).toBe(true);
    expect(isBlockedHost("https://a.b.evil.example/")).toBe(true);
    expect(isBlockedHost("https://notevil.example/")).toBe(false);
    expect(isBlockedHost("https://evil.example.org/")).toBe(false);

    vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
    expect(isBlockedHost("https://evil.example/")).toBe(true);
  });

  it("W19 WEB_CACHE_EXEMPT_HOSTS matches a listed host, its subdomains and wildcard subdomains, in any case", () => {
    const urls = {
      exempt: ["https://fresh.example/a", "https://sub.fresh.example/a", "https://x.live.example/a", "https://FRESH.example/a"],
      notExempt: ["https://live.example/a", "https://notfresh.example/a", "https://fresh.example.org/a", "not a url"],
    };
    expect([...urls.exempt, ...urls.notExempt].map(isCacheExemptHost)).toEqual(Array(8).fill(false));

    vi.stubEnv("WEB_CACHE_EXEMPT_HOSTS", "fresh.example, *.live.example");
    expect(urls.exempt.map(isCacheExemptHost)).toEqual([true, true, true, true]);
    expect(urls.notExempt.map(isCacheExemptHost)).toEqual([false, false, false, false]);
  });

  it.each([["a ticker", "AAPL"], ["an empty string", ""], ["a file path", "/tmp/file.txt"], ["undefined", undefined as never]])(
    "W20 %s is not a URL: the caller is told what a URL looks like and nothing is fetched",
    async (_name, url) => {
      const h = harness([]);
      const result = await webExtract(url, 15_000, h.deps);
      expect(result.status).toBe("error");
      expect(result.error).toContain("must be a full URL starting with http(s)://");
      expect(h.calls).toHaveLength(0);
    },
  );
});
