import { beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  __resetWebSearchForTests,
  parseExaText,
  webSearch,
  webSearchStatus,
  type WebSearchDeps,
} from "../WebSearchService.ts";

// The shape Exa's keyless MCP endpoint returned on 2026-10-06, trimmed.
const EXA_TEXT = [
  "Title: Headlines for October 06, 2026",
  "URL: https://www.democracynow.org/2026/10/6/headlines",
  "Published: 2026-10-06T11:56:11.244Z",
  "Author: N/A",
  "Highlights:",
  "Headlines for October 06, 2026 | Democracy Now!",
  "",
  "## Supreme Court Case Will Determine Whether States Can Sue",
  "",
  "---",
  "",
  "Title: Morning Briefing: Oct. 6, 2026",
  "URL: https://aa.com.tr/en/world/morning-briefing-oct-6-2026/4079174",
  "Published: 2026-10-06T06:56:11.244Z",
  "Author: Diyar Guldogan",
  "Highlights:",
  "Top stories of the morning.",
].join("\n");

const sse = (text: string) =>
  `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] }, jsonrpc: "2.0", id: "x" })}\n\n`;

/**
 * A fake Exa plus a clock that only moves when the service sleeps. Concurrent
 * sleeps overlap: each sleeper wakes at (its start + ms), and the clock moves
 * only after every caller has reserved its slot.
 */
function harness(replies: Array<{ status?: number; body?: string; throws?: Error }>) {
  const calls: Array<{ url: string; body: Record<string, any> }> = [];
  const sleeps: number[] = [];
  const clock = { t: 1_000_000 };
  const deps: WebSearchDeps = {
    now: () => clock.t,
    sleep: async ms => {
      sleeps.push(ms);
      const wake = clock.t + ms;
      await Promise.resolve();
      clock.t = Math.max(clock.t, wake);
    },
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      if (reply.throws) throw reply.throws;
      return new Response(reply.body ?? sse(EXA_TEXT), { status: reply.status ?? 200 });
    }) as typeof fetch,
  };
  return { deps, calls, sleeps, clock };
}

beforeEach(() => __resetWebSearchForTests());

describe("parseExaText", () => {
  it("reads one result per block, with the highlights as the snippet", () => {
    const results = parseExaText(EXA_TEXT);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: "Headlines for October 06, 2026",
      url: "https://www.democracynow.org/2026/10/6/headlines",
      published: "2026-10-06T11:56:11.244Z",
      author: "",
    });
    expect(results[0].snippet).toContain("Supreme Court Case");
    expect(results[1].author).toBe("Diyar Guldogan");
  });

  it("skips a block without a usable URL", () => {
    expect(parseExaText("Title: no link here\nHighlights:\ntext")).toEqual([]);
  });
});

describe("webSearch", () => {
  it("asks Exa's keyless endpoint and returns its results", async () => {
    const h = harness([{}]);
    const result = await webSearch("today's world news", 5, h.deps);
    expect(result).toMatchObject({ status: "ok", provider: "exa", cached: false });
    expect(result.results).toHaveLength(2);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].url).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
    expect(h.calls[0].body.params).toEqual({ name: "web_search_exa", arguments: { query: "today's world news", numResults: 5 } });
  });

  it("answers an identical search from the cache", async () => {
    const h = harness([{}]);
    await webSearch("Rust borrow checker", 6, h.deps);
    const again = await webSearch("  rust   BORROW checker ", 6, h.deps);
    expect(again.cached).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(webSearchStatus(h.clock.t)).toMatchObject({ calls: 1, cacheHits: 1 });
  });

  it("shares one call between identical searches already in flight", async () => {
    const h = harness([{}]);
    const [a, b] = await Promise.all([webSearch("same", 6, h.deps), webSearch("same", 6, h.deps)]);
    expect(h.calls).toHaveLength(1);
    expect([a.cached, b.cached].sort()).toEqual([false, true]);
  });

  it("spaces Exa calls at least 1.5 s apart", async () => {
    const h = harness([{}]);
    await Promise.all([webSearch("one", 6, h.deps), webSearch("two", 6, h.deps), webSearch("three", 6, h.deps)]);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toEqual([1_500, 3_000]);
  });

  it("answers busy instead of queueing past 20 s", async () => {
    const h = harness([{}]);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => webSearch(`query ${i}`, 6, h.deps)));
    expect(results.filter(r => r.status === "busy").length).toBeGreaterThan(0);
    expect(h.calls.length).toBeLessThanOrEqual(14);
  });

  it("after a 429 sends nothing to Exa for a minute, then searches again", async () => {
    const searxngQuiet = { body: JSON.stringify({ success: true, items: [] }) };
    const h = harness([{ status: 429, body: "rate limit" }, searxngQuiet, searxngQuiet, {}]);
    expect((await webSearch("first", 6, h.deps)).status).toBe("rate_limited");
    h.clock.t += 30_000;
    const during = await webSearch("second", 6, h.deps);
    expect(during.status).toBe("rate_limited");
    expect(during.error).toMatch(/resume in \d+ s/);
    expect(h.calls.filter(c => c.url.startsWith("https://mcp.exa.ai/"))).toHaveLength(1);
    h.clock.t += 31_000;
    expect((await webSearch("third", 6, h.deps)).status).toBe("ok");
    expect(h.calls.filter(c => c.url.startsWith("https://mcp.exa.ai/"))).toHaveLength(2);
  });

  it("treats a rate-limit JSON-RPC error like a 429", async () => {
    const h = harness([
      { body: JSON.stringify({ jsonrpc: "2.0", id: "x", error: { code: -32000, message: "Rate limit exceeded" } }) },
      { body: JSON.stringify({ success: true, items: [] }) },
    ]);
    expect((await webSearch("q", 6, h.deps)).status).toBe("rate_limited");
    expect((await webSearch("other", 6, h.deps)).status).toBe("rate_limited");
    expect(h.calls.filter(c => c.url.startsWith("https://mcp.exa.ai/"))).toHaveLength(1);
  });

  it("reports errors without caching them", async () => {
    const h = harness([{ status: 500, body: "boom" }, { status: 500, body: "fallback down" }, {}]);
    const failed = await webSearch("flaky", 6, h.deps);
    expect(failed).toMatchObject({ status: "error", results: [] });
    expect(failed.error).toContain("HTTP 500");
    expect((await webSearch("flaky", 6, h.deps)).status).toBe("ok");
    expect(h.calls.filter(c => c.url.startsWith("https://mcp.exa.ai/"))).toHaveLength(2);
  });

  it("reports an unreachable or slow Exa as an error", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    const h = harness([
      { throws: timeout },
      { throws: new Error("getaddrinfo ENOTFOUND mcp.exa.ai") },
      { throws: new Error("getaddrinfo ENOTFOUND mcp.exa.ai") },
      {},
    ]);
    expect((await webSearch("a", 6, h.deps)).error).toMatch(/timed out after 15 s/);
    expect((await webSearch("b", 6, h.deps)).error).toMatch(/ENOTFOUND/);
  });

  it("refuses an empty query without calling Exa", async () => {
    const h = harness([{}]);
    expect(await webSearch("   ", 6, h.deps)).toMatchObject({ status: "error", error: "query is required" });
    expect(h.calls).toHaveLength(0);
  });

  it("caps the result count at 10", async () => {
    const h = harness([{}]);
    await webSearch("many", 50, h.deps);
    expect(h.calls[0].body.params.arguments.numResults).toBe(10);
  });

  it("falls back to scraper-service's SearXNG when Exa fails, Exa alone when it succeeds", async () => {
    const h = harness([
      { status: 500, body: "boom" },
      { body: JSON.stringify({ success: true, items: [{ title: "R", url: "https://example.com/r", snippet: "s" }] }) },
      {},
    ]);
    const failed = await webSearch("a", 6, h.deps);
    expect(failed).toMatchObject({ status: "ok", provider: "searxng", cached: false });
    expect(h.calls[1].url).toBe("http://localhost:8001/collect");
    const ok = await webSearch("b", 6, h.deps);
    expect(ok).toMatchObject({ status: "ok", provider: "exa" });
    for (const call of h.calls.filter(c => c.url.startsWith("https://mcp.exa.ai/"))) {
      expect(call.url.startsWith("https://mcp.exa.ai/")).toBe(true);
    }
  });

  it("does not pile onto the fallback when the queue is busy", async () => {
    const h = harness([{}]);
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => webSearch(`q ${i}`, 6, h.deps)));
    expect(results.some(r => r.status === "busy")).toBe(true);
    expect(h.calls.filter(c => c.url.endsWith("/collect"))).toHaveLength(0);
  });
});

describe("the web_search tool surface", () => {
  // 2026-10-10: web_search gained an in-repo schema (tool_schemas/shared/web.json)
  // that advertises allowed_domains/blocked_domains — the remote search_web
  // schema cannot carry them. Dispatch stays in ToolOrchestratorService.
  it("is in tool_schemas.json with domain filters advertised", () => {
    const schemas = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, "../../../tool_schemas.json"), "utf8"),
    ) as Array<{ name: string; parameters?: { properties?: Record<string, unknown> } }>;
    const webSearch = schemas.find((t) => t.name === "web_search");
    expect(webSearch).toBeDefined();
    expect(Object.keys(webSearch!.parameters!.properties!)).toEqual(
      expect.arrayContaining(["query", "allowed_domains", "blocked_domains"]),
    );
  });
});
