// Read_url failure-path tests against real HTTP servers (2026-10-16 telemetry
// wave). Spins up one local server that plays BOTH tools-api (the read_url
// endpoint the orchestrator forwards to) and scraper-service (the fallback
// fetcher executeReadUrl uses for bot-blocked hosts). No fetch mocking: the
// requests go over real sockets. Fails on reverted source because reverted
// executeTool forwarded read_url straight to tools-service and returned the
// raw "HTTP 403: …" error with no fallback and no guidance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as http from "node:http";
// Static type view of the module loaded dynamically below.
import type * as OrchestratorModule from "../ToolOrchestratorService.js";

type SchemasResponse = Array<Record<string, unknown>>;

let server: http.Server;
let baseUrl = "";
let readUrlStatus = 200;
let readUrlBody: Record<string, unknown> = { content: "ok" };
let scrapeCalls = 0;
let scrapeBody: Record<string, unknown> = { success: true, content: "fallback page text", engine_used: "http" };

// Dynamic import is intentional: TOOLS_SERVICE_URL and SCRAPER_SERVICE_URL
// are read at module-load time, so env must be set before the module loads —
// a module-loading boundary, not runtime-selected code.
let orchestrator: typeof OrchestratorModule;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/admin/tool-schemas")) {
      const schemas: SchemasResponse = [
        {
          name: "read_url",
          description: "Read a URL",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
            additionalProperties: false,
          },
          endpoint: { method: "GET", path: "/tools/read_url" },
        },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(schemas));
      return;
    }
    if (url.startsWith("/tools/read_url")) {
      res.writeHead(readUrlStatus, { "Content-Type": "application/json" });
      res.end(JSON.stringify(readUrlBody));
      return;
    }
    if (url.startsWith("/scrape")) {
      scrapeCalls += 1;
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString();
      });
      req.on("end", () => {
        expect(JSON.parse(raw).engine).toBe("auto");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(scrapeBody));
      });
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
  const loaded = await orchestrator.default.refreshSchemas();
  expect(loaded).toBeGreaterThan(0);
});

afterAll(() => {
  server.close();
});

describe("read_url failure handling", () => {
  it("passes a successful read through unchanged", async () => {
    readUrlStatus = 200;
    readUrlBody = { content: "hello page" };
    scrapeCalls = 0;
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://example.com/ok",
    }, {})) as Record<string, unknown>;
    expect(result).toEqual({ content: "hello page" });
    expect(scrapeCalls).toBe(0);
  });

  it("falls back to scraper-service on a 403 bot-block and returns the page", async () => {
    readUrlStatus = 403;
    readUrlBody = { error: "HTTP 403: https://www.discogs.com/artist/251731-Winston-Fergus" };
    scrapeCalls = 0;
    scrapeBody = { success: true, content: "discogs artist text", engine_used: "http" };
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://www.discogs.com/artist/251731-Winston-Fergus",
    }, {})) as Record<string, unknown>;
    expect(result.success).toBe(true);
    expect(result.content).toBe("discogs artist text");
    expect(result.fallback).toBe("web_extract");
    expect(scrapeCalls).toBe(1);
  });

  it("reports a bot-block with guidance when the fallback also fails", async () => {
    readUrlStatus = 403;
    readUrlBody = { error: "HTTP 403: https://www.discogs.com/release/999999-test" };
    scrapeCalls = 0;
    scrapeBody = { success: false, error: "render failed" };
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://www.discogs.com/release/999999-test",
    }, {})) as Record<string, unknown>;
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("blocks automated fetchers");
    expect(result.error).toContain("scrape_url or read_web_page");
    expect(result.error).toContain("render failed");
    expect(scrapeCalls).toBe(1);
  });

  it("short-circuits fallback scrape when the 403 URL is on UNSCRAPABLE_DOMAINS (thestreet.com)", async () => {
    readUrlStatus = 403;
    readUrlBody = { error: "HTTP 403: https://www.thestreet.com/stock-market-today" };
    scrapeCalls = 0;
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://www.thestreet.com/stock-market-today",
    }, {})) as Record<string, unknown>;
    expect(result.error).toContain("HTTP 403");
    expect(result.error).toContain("UNSCRAPABLE_DOMAIN");
    expect(scrapeCalls).toBe(0);
  });

  it("does not fall back on a 404 and tells the model what to do", async () => {
    readUrlStatus = 404;
    readUrlBody = { error: "HTTP 404: https://www.reggaedb.org/artist/251731" };
    scrapeCalls = 0;
    const result = (await orchestrator.default.executeTool("read_url", {
      url: "https://www.reggaedb.org/artist/251731",
    }, {})) as Record<string, unknown>;
    expect(result.error).toContain("HTTP 404");
    expect(result.error).toContain("does not exist");
    expect(result.error).toContain("search_web");
    expect(scrapeCalls).toBe(0);
  });

  it("keeps the full original error in the message the model sees", async () => {
    readUrlStatus = 404;
    const longUrl = "https://www.unitedreggae.com/news/n1012/0108-king-earthquake-meets-winston-fergus/";
    readUrlBody = { error: `HTTP 404: ${longUrl}` };
    const result = (await orchestrator.default.executeTool("read_url", {
      url: longUrl,
    }, {})) as Record<string, unknown>;
    expect(result.error).toContain(longUrl);
  });

  it("validates the url argument itself instead of forwarding garbage", async () => {
    scrapeCalls = 0;
    const result = (await orchestrator.default.executeTool("read_url", {}, {})) as Record<string, unknown>;
    expect(result.error).toContain("url");
    expect(scrapeCalls).toBe(0);
  });
});
