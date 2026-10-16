// Three fixes from the 2026-10-16 telemetry wave (documentation/chapters/
// 08-tool-metrics.md), each pinned against the real executeTool path over real
// sockets / the real dispatch seam. Each test fails on the reverted source:
//   - read_url misroute: reverted executeReadUrl classified "Invalid Twitter/X
//     URL" as kind "other" and returned the bare error with no fallback.
//   - get_music: reverted executeTool forwarded the MusicBrainz status bare.
//   - get_finnhub_news: reverted executeTradingTool passed the rendered text to
//     modelVisibleText, which cut whole lines and dropped most headlines.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
// Static type view of the module loaded dynamically below (env must be set
// before TOOLS_SERVICE_URL is read at module load).
import type * as OrchestratorModule from "../ToolOrchestratorService.js";
import { projectFinnhubNewsText, parseNewsText } from "../FinnhubNewsProjection.js";

const dispatchTool = vi.fn(async () => ({ content: "{}" }));
vi.mock("../ToolDispatch.js", () => ({ dispatchTool: (...args: unknown[]) => dispatchTool(...(args as [])) }));

let orchestrator: typeof OrchestratorModule;
let server: http.Server;
let baseUrl = "";
let readUrlBody: Record<string, unknown> = {};
let scrapeBody: Record<string, unknown> = {};
let scrapeCalls = 0;

// One server playing tools-api (/tools/read_url) and scraper-service (/scrape),
// as ReadUrlFailures.test.ts does.
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/admin/tool-schemas")) {
      const schemas = ["read_url", "get_music"].map((name) => ({
        name,
        description: name,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        endpoint: { method: "GET", path: `/tools/${name}` },
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(schemas));
      return;
    }
    if (url.startsWith("/tools/read_url")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readUrlBody));
      return;
    }
    if (url.startsWith("/scrape")) {
      scrapeCalls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(scrapeBody));
      return;
    }
    if (url.startsWith("/tools/get_music")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "MusicBrainz API error 503: service unavailable" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
  process.env.TOOLS_SERVICE_URL = baseUrl;
  process.env.SCRAPER_SERVICE_URL = baseUrl;
  process.env.ALLOW_PRIVATE_URLS = "1";
  orchestrator = await import("../ToolOrchestratorService.js");
  expect(await orchestrator.default.refreshSchemas()).toBeGreaterThan(0);
});

afterAll(() => server.close());

describe("read_url misrouted to the Twitter fetcher", () => {
  it("a non-twitter /status/<n> page that tools-service misroutes falls back to the web extractor", async () => {
    // tools-service WebContentFetcher sends ANY url with /status/<digits>
    // (not reddit/github/stackoverflow) to its Twitter fetcher, which rejects
    // it with `Invalid Twitter/X URL` — tools-service/src/fetchers/web/
    // TwitterFetcher.ts:41. The page itself is fine (HTML 200 at the origin).
    // Path digits deliberately avoid 401/403/404/5xx so the reverted
    // classifier cannot accidentally match the URL and pass.
    readUrlBody = { error: `Invalid Twitter/X URL: "https://mastodon.social/status/1234"` };
    scrapeCalls = 0;
    scrapeBody = { success: true, content: "<html>page text</html>", engine_used: "http" };
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://mastodon.social/status/1234",
    }, {})) as Record<string, unknown>;
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.content).toBe("<html>page text</html>");
    expect(result.fallback).toBe("web_extract");
    expect(scrapeCalls).toBe(1);
  });

  it("a real twitter URL that fails keeps the bot-block handling, not the misroute fallback", async () => {
    readUrlBody = { error: `Invalid Twitter/X URL: "https://x.com/status/12345"` };
    scrapeCalls = 0;
    scrapeBody = { success: true, content: "nope" };
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://x.com/status/403",
    }, {})) as Record<string, unknown>;
    // x.com is genuinely a twitter URL: no fallback is claimed for the misroute
    // path, so the error passes through classified instead of being retried.
    expect(typeof result.error).toBe("string");
    expect(result.error).toContain("Invalid Twitter/X URL");
    expect(scrapeCalls).toBe(0);
  });
});

describe("get_music failure guidance", () => {
  it("a MusicBrainz 503 comes back with actionable guidance, not a bare status", async () => {
    const result = (await orchestrator.default.executeTool("get_music", {
      action: "search_artists", q: "aphex twin",
    }, {})) as Record<string, unknown>;
    expect(result.error).toContain("MusicBrainz API error 503");
    expect(result.error).toContain("rate-limited or temporarily overloaded");
    expect(result.error).toContain("retry once");
  });
});

describe("get_finnhub_news compact projection", () => {
  const renderNews = (count: number, summaryChars: number) => {
    const rows = Array.from({ length: count }, (_, i) => {
      const summary = `S${i}: ${"fact ".repeat(Math.ceil(summaryChars / 5)).slice(0, summaryChars)}`;
      return `  Title: Headline ${i} for TICKER | Publisher: Finnhub | Date: 2026-10-16 0${i % 10}:00:00 | Key Facts: ${summary} https://finnhub.example/${i}`;
    });
    return ["⚠️ COLD NEWS: the most recent article for TICKER is 2 days old.", "", "## Recent News", `(${count} records, showing up to 20)`, ...rows].join("\n");
  };
  const bridge = (text: string) => ({ role: "tool", tool_call_id: "call_lazy_agent_bridge", name: "get_finnhub_news", content: text });

  it("parses the rendered rows, keeping every headline, the note and a clean url field", () => {
    const parsed = parseNewsText(renderNews(2, 40))!;
    expect(parsed.articles).toHaveLength(2);
    expect(parsed.articles[0]).toMatchObject({
      headline: "Headline 0 for TICKER", source: "Finnhub", datetime: "2026-10-16 00:00:00",
    });
    expect(parsed.articles[0].summary).toContain("S0:");
    expect(parsed.articles[0].url).toBe("https://finnhub.example/0");
    expect(parsed.note).toContain("COLD NEWS");
  });

  it("a 30-article payload becomes valid JSON under the per-result cap with ALL 30 headlines", async () => {
    const text = renderNews(30, 300);
    dispatchTool.mockResolvedValueOnce(bridge(text) as never);
    const result = await orchestrator.default.executeTool("mcp__lazy-agent-service__get_finnhub_news", { ticker: "TICKER" },
      { project: "vllm-trading-bot", agent: "CUSTOM_V3_JUNIOR_ANALYST" });
    expect(typeof result).toBe("string");
    const parsed = JSON.parse(result as string);
    expect(parsed.news).toHaveLength(30);
    for (let i = 0; i < 30; i++) expect(parsed.news[i].headline).toBe(`Headline ${i} for TICKER`);
    expect((result as string).length).toBeLessThanOrEqual(7600);
    // Prism's own rules pass it whole: no list cap (news is not a capped key)
    // and the size is inside the inline budget.
    expect(JSON.stringify(parsed).length).toBeLessThanOrEqual(8000);
  });

  it("a normal 15-article result keeps every summary whole, uncut", () => {
    // 265-char summaries + the url keep the row at/below the 300-char cap, so
    // a normal result (the bridge's own 15-article cap) fits whole.
    const text = renderNews(15, 265);
    const projected = projectFinnhubNewsText(text)!;
    const parsed = JSON.parse(projected);
    expect(parsed.news).toHaveLength(15);
    expect(projected.length).toBeLessThanOrEqual(7600);
    expect(parsed.news.every((a: Record<string, unknown>) => typeof a.summary === "string" && !String(a.summary).endsWith("…"))).toBe(true);
  });
});
