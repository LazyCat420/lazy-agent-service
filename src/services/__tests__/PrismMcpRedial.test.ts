import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  PrismMcpRedialer,
  readPrismMcpRedialConfig,
  startPrismMcpRedial,
  type PrismMcpRedialConfig,
  type RedialLogger,
} from "../PrismMcpRedial.ts";
import McpAdapter from "../McpAdapter.ts";

// The re-dialer that keeps prism-service's MCP link to /mcp/sse alive across
// this service's restarts (documentation ch.16). Every test drives the real
// PrismMcpRedialer against a fake prism on 127.0.0.1 that speaks the shape of
// prism's GET /mcp-servers and POST /mcp-servers/:id/connect
// (prism-service src/routes/McpServersRoutes.ts:128, :324).

const SERVER_ID = "6a764f9e6729baa25e6f2153";

interface FakePrism {
  url: string;
  connects: Array<{ project?: string; username?: string }>;
  statusCalls: number;
  connected: boolean;
  enabled: boolean;
  /** Fail this many connect calls with 502 before succeeding. */
  failConnects: number;
  close: () => Promise<void>;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFakePrism(): Promise<FakePrism> {
  const state = {
    connects: [] as FakePrism["connects"],
    statusCalls: 0,
    connected: false,
    enabled: true,
    failConnects: 0,
  };
  const server = http.createServer((req, res) => {
    const project = req.headers["x-project"] as string | undefined;
    const username = req.headers["x-username"] as string | undefined;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/mcp-servers") {
      state.statusCalls += 1;
      // Prism scopes the list by HEADERS; a wrong scope answers [].
      const inScope = project === "vllm-trading-bot" && username === "lazy-trader";
      res.end(JSON.stringify(inScope ? [
        { id: "6ab9d2fc7bf4306586321d51", name: "github", enabled: false, connected: false, toolCount: 0 },
        { id: SERVER_ID, name: "lazy-agent-service", transport: "sse", enabled: state.enabled,
          connected: state.connected, toolCount: state.connected ? 72 : 0 },
      ] : []));
      return;
    }
    if (req.method === "POST" && req.url === `/mcp-servers/${SERVER_ID}/connect`) {
      state.connects.push({ project, username });
      if (state.failConnects > 0) {
        state.failConnects -= 1;
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "MCP server connection failed: fetch failed" }));
        return;
      }
      state.connected = true;
      res.end(JSON.stringify({ success: true, serverName: "lazy-agent-service", toolCount: 72, tools: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "MCP server not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fake = Object.assign(state, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }) as FakePrism;
  cleanups.push(fake.close);
  return fake;
}

/** A port nothing listens on: prism is down. */
async function deadUrl(): Promise<string> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function captureLogger(): RedialLogger & { lines: string[] } {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return { lines, info: push, warn: push, error: push };
}

function config(url: string, overrides: Partial<PrismMcpRedialConfig> = {}): PrismMcpRedialConfig {
  return {
    url,
    serverId: SERVER_ID,
    project: "vllm-trading-bot",
    username: "lazy-trader",
    intervalMs: 40,
    bootDelayMs: 10,
    bootRetryDelaysMs: [15, 15, 15],
    requestTimeoutMs: 2_000,
    clientName: "prism",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function startRedialer(cfg: PrismMcpRedialConfig, localSessions?: () => number | null) {
  const log = captureLogger();
  const redialer = new PrismMcpRedialer(cfg, {
    logger: log,
    ...(localSessions && { countLocalClientSessions: () => localSessions() }),
  });
  cleanups.push(() => redialer.stop());
  redialer.start();
  return { redialer, log };
}

describe("readPrismMcpRedialConfig", () => {
  it("is disabled (null) unless both URL and server id are set", () => {
    expect(readPrismMcpRedialConfig({})).toBeNull();
    expect(readPrismMcpRedialConfig({ PRISM_MCP_REDIAL_URL: "http://10.0.0.16:7777" })).toBeNull();
    expect(readPrismMcpRedialConfig({ PRISM_MCP_SERVER_ID: SERVER_ID })).toBeNull();
  });

  it("applies the documented defaults", () => {
    const cfg = readPrismMcpRedialConfig({
      PRISM_MCP_REDIAL_URL: "http://10.0.0.16:7777/",
      PRISM_MCP_SERVER_ID: SERVER_ID,
    });
    expect(cfg).toMatchObject({
      url: "http://10.0.0.16:7777",
      serverId: SERVER_ID,
      project: "vllm-trading-bot",
      username: "lazy-trader",
      intervalMs: 300_000,
      bootRetryDelaysMs: [5_000, 15_000, 60_000],
      clientName: "prism",
    });
  });
});

describe("startPrismMcpRedial", () => {
  it("logs once and starts nothing when the env is unset", async () => {
    const prism = await startFakePrism();
    const log = captureLogger();
    expect(startPrismMcpRedial({ logger: log }, {})).toBeNull();
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("disabled");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(prism.connects).toHaveLength(0);
    expect(prism.statusCalls).toBe(0);
  });

  it("starts from env and dials prism on boot with the scope headers", async () => {
    const prism = await startFakePrism();
    const log = captureLogger();
    const redialer = startPrismMcpRedial({ logger: log }, {
      PRISM_MCP_REDIAL_URL: prism.url,
      PRISM_MCP_SERVER_ID: SERVER_ID,
      PRISM_MCP_REDIAL_BOOT_DELAY_MS: "10",
      PRISM_MCP_REDIAL_INTERVAL_MS: "100000",
    });
    expect(redialer).not.toBeNull();
    cleanups.push(() => redialer!.stop());
    await waitFor(() => prism.connects.length === 1);
    expect(prism.connects[0]).toEqual({ project: "vllm-trading-bot", username: "lazy-trader" });
  });
});

describe("PrismMcpRedialer", () => {
  it("dials on boot even when prism already reports connected (its entry is stale after our restart)", async () => {
    const prism = await startFakePrism();
    prism.connected = true;
    const { log } = startRedialer(config(prism.url, { intervalMs: 100_000 }));
    await waitFor(() => prism.connects.length === 1);
    await waitFor(() => log.lines.some((line) => line.includes("72 tools")));
    expect(log.lines.some((line) => line.includes("reason: boot"))).toBe(true);
  });

  it("re-dials when the periodic status says connected:false", async () => {
    const prism = await startFakePrism();
    const { log } = startRedialer(config(prism.url), () => 1);
    await waitFor(() => prism.connects.length === 1); // boot dial
    prism.connected = false; // prism dropped the link later
    await waitFor(() => prism.connects.length === 2);
    expect(log.lines.some((line) => line.includes("prism reports connected:false"))).toBe(true);
  });

  it("does not dial while prism says connected and a live prism session exists here", async () => {
    const prism = await startFakePrism();
    startRedialer(config(prism.url), () => 1);
    await waitFor(() => prism.connects.length === 1); // boot dial
    const statusBefore = prism.statusCalls;
    await waitFor(() => prism.statusCalls >= statusBefore + 3);
    expect(prism.connects).toHaveLength(1);
  });

  it("re-dials when prism says connected but no live prism session exists here", async () => {
    const prism = await startFakePrism();
    let local = 1;
    const { log } = startRedialer(config(prism.url), () => local);
    await waitFor(() => prism.connects.length === 1);
    local = 0;
    await waitFor(() => prism.connects.length === 2);
    expect(log.lines.some((line) => line.includes("stale entry"))).toBe(true);
  });

  it("leaves a server disabled in prism alone", async () => {
    const prism = await startFakePrism();
    const redialer = new PrismMcpRedialer(config(prism.url), { logger: captureLogger() });
    prism.enabled = false;
    const outcome = await redialer.checkOnce();
    expect(outcome.action).toBe("skipped");
    expect(prism.connects).toHaveLength(0);
  });

  it("reports a wrong server id / scope instead of dialing", async () => {
    const prism = await startFakePrism();
    const redialer = new PrismMcpRedialer(config(prism.url, { project: "other" }), { logger: captureLogger() });
    const outcome = await redialer.checkOnce();
    expect(outcome).toMatchObject({ action: "skipped" });
    expect((outcome as { reason: string }).reason).toContain("not in prism's list");
    expect(prism.connects).toHaveLength(0);
  });

  it("retries the boot dial with backoff when prism refuses, then succeeds", async () => {
    const prism = await startFakePrism();
    prism.failConnects = 2;
    const { log } = startRedialer(config(prism.url, { intervalMs: 100_000 }));
    await waitFor(() => prism.connects.length === 3);
    await waitFor(() => log.lines.some((line) => line.includes("72 tools")));
    expect(log.lines.filter((line) => line.includes("retrying in"))).toHaveLength(2);
  });

  it("survives prism being down: retries, falls back to the periodic check, never rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => void process.off("unhandledRejection", onUnhandled));

    const url = await deadUrl();
    const { redialer, log } = startRedialer(config(url, { bootRetryDelaysMs: [10, 10] }), () => 0);
    await waitFor(() => log.lines.some((line) => line.includes("periodic check every")));
    await waitFor(() => log.lines.some((line) => line.includes("status check skipped: prism unreachable")));
    expect(log.lines.filter((line) => line.includes("re-dial failed: prism unreachable"))).toHaveLength(3);
    expect(redialer.running).toBe(true);
    expect(unhandled).toEqual([]);
  });

  it("stop() cancels the pending timers", async () => {
    const prism = await startFakePrism();
    const { redialer } = startRedialer(config(prism.url, { bootDelayMs: 50 }));
    redialer.stop();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(prism.connects).toHaveLength(0);
    expect(redialer.running).toBe(false);
  });
});

describe("McpAdapter.countLiveClientSessions", () => {
  async function startAdapter() {
    const adapter = new McpAdapter();
    const app = express();
    app.use(express.json());
    app.get("/mcp/sse", (req, res, next) => adapter.handleSse(req, res).catch(next));
    app.post("/mcp/messages", (req, res, next) => adapter.handleMessage(req, res).catch(next));
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    cleanups.push(() => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }));
    return { adapter, url: `http://127.0.0.1:${port}/mcp/sse` };
  }

  async function connectClient(url: string, name: string) {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(new SSEClientTransport(new URL(url)));
    return client;
  }

  it("counts only initialised sessions from the named client, and drops closed ones", async () => {
    const { adapter, url } = await startAdapter();
    expect(adapter.countLiveClientSessions("prism")).toBe(0);

    const prism = await connectClient(url, "prism");
    const other = await connectClient(url, "trading-service");
    expect(adapter.countLiveClientSessions("prism")).toBe(1);
    expect(adapter.countLiveClientSessions("trading-service")).toBe(1);

    await prism.close();
    await waitFor(() => adapter.countLiveClientSessions("prism") === 0);
    expect(adapter.countLiveClientSessions("trading-service")).toBe(1);
    await other.close();
  });

  it("feeds the redialer: a closed prism session triggers a re-dial", async () => {
    const { adapter, url } = await startAdapter();
    const fakePrism = await startFakePrism();
    fakePrism.connected = true;
    const client = await connectClient(url, "prism");
    const redialer = new PrismMcpRedialer(config(fakePrism.url), {
      logger: captureLogger(),
      countLocalClientSessions: (name) => adapter.countLiveClientSessions(name),
    });
    expect((await redialer.checkOnce()).action).toBe("healthy");
    await client.close();
    await waitFor(() => adapter.countLiveClientSessions("prism") === 0);
    const outcome = await redialer.checkOnce();
    expect(outcome).toMatchObject({ action: "redialed", dial: { ok: true, toolCount: 72 } });
    expect(fakePrism.connects).toHaveLength(1);
  });
});
