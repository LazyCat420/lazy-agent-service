/**
 * /mcp-servers + the MCP client, against a real MCP server (the SDK's own
 * McpServer over streamable HTTP, in-process) — no mocks of our classes.
 * Only the Mongo collection is an in-memory stand-in.
 *
 * Ported from prism-service McpServersRoutes / MCPClientService: callers are
 * html-notes and vllm-trading-bot (GET /mcp-servers, POST /:id/connect).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import mcpServersRouter from "../../routes/McpServersRoutes.ts";
import MCPClientService from "../MCPClientService.ts";
import ToolOrchestratorService from "../ToolOrchestratorService.ts";
import { dispatchTool } from "../ToolDispatch.ts";

// ─── In-memory Mongo collection (the only stand-in) ───────────────────────────
type Doc = Record<string, unknown> & { _id: ObjectId };
function matches(doc: Doc, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, want]) => {
    const have = doc[key];
    if (want && typeof want === "object" && "$ne" in (want as object)) {
      return String(have) !== String((want as { $ne: unknown }).$ne);
    }
    return String(have) === String(want);
  });
}
function fakeDb() {
  const docs: Doc[] = [];
  const collection = {
    find: (filter: Record<string, unknown>) => ({
      sort: () => ({ toArray: async () => docs.filter((d) => matches(d, filter)).reverse() }),
      toArray: async () => docs.filter((d) => matches(d, filter)),
    }),
    findOne: async (filter: Record<string, unknown>) => docs.find((d) => matches(d, filter)) ?? null,
    insertOne: async (doc: Record<string, unknown>) => {
      const _id = new ObjectId();
      doc._id = _id;
      docs.push(doc as Doc);
      return { insertedId: _id };
    },
    findOneAndUpdate: async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
      const doc = docs.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set);
      return doc ?? null;
    },
    findOneAndDelete: async (filter: Record<string, unknown>) => {
      const index = docs.findIndex((d) => matches(d, filter));
      return index < 0 ? null : docs.splice(index, 1)[0];
    },
  };
  return { docs, db: { collection: () => collection } };
}

// ─── Stub MCP server: stateless streamable HTTP, one tool ─────────────────────
let stub: http.Server;
let stubUrl: string;
function buildStubServer() {
  const server = new McpServer({ name: "stub", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: JSON.stringify({ echoed: text }) }] }),
  );
  return server;
}

// ─── App under test ──────────────────────────────────────────────────────────
let app: http.Server;
let base: string;
let store: ReturnType<typeof fakeDb>;

beforeAll(async () => {
  stub = http.createServer(async (req, res) => {
    const server = buildStubServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/mcp`;

  const express_ = express();
  express_.use(express.json());
  express_.use((req, _res, next) => {
    req.project = String(req.headers["x-project"] || "html-notes");
    req.username = "tester";
    next();
  });
  express_.use("/mcp-servers", mcpServersRouter);
  app = http.createServer(express_);
  await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await MCPClientService.disconnectAll();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => stub.close(resolve));
});

beforeEach(async () => {
  await MCPClientService.disconnectAll();
  store = fakeDb();
  vi.spyOn(MongoWrapper, "getDb").mockReturnValue(store.db as never);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}/mcp-servers${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const create = (overrides: Record<string, unknown> = {}) =>
  call("POST", "", { name: "stub", transport: "streamable-http", url: stubUrl, ...overrides });

describe("/mcp-servers routes", () => {
  it("creates a server and lists it (disconnected) in its own scope only", async () => {
    const created = await create();
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "stub", displayName: "stub", enabled: true });

    const listed = await call("GET", "");
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ id: created.body.id, name: "stub", connected: false, toolCount: 0 });

    expect((await call("GET", "", undefined, { "x-project": "other" })).body).toEqual([]);
  });

  it("connects: discovers the stub's tool, and the list then shows it live", async () => {
    const { body: server } = await create();
    const connected = await call("POST", `/${server.id}/connect`);
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({
      success: true,
      serverName: "stub",
      toolCount: 1,
      tools: [{ name: "mcp__stub__echo", description: "Echo text back" }],
    });

    const listed = await call("GET", "");
    expect(listed.body[0]).toMatchObject({ connected: true, toolCount: 1, tools: [{ name: "echo" }] });
  });

  it("disconnects, and delete removes the config and its connection", async () => {
    const { body: server } = await create();
    await call("POST", `/${server.id}/connect`);
    expect(MCPClientService.isConnected("stub")).toBe(true);

    expect((await call("POST", `/${server.id}/disconnect`)).body).toEqual({ success: true });
    expect(MCPClientService.isConnected("stub")).toBe(false);
    expect((await call("GET", "")).body[0].connected).toBe(false);

    await call("POST", `/${server.id}/connect`);
    expect((await call("DELETE", `/${server.id}`)).body).toEqual({ success: true });
    expect(MCPClientService.isConnected("stub")).toBe(false);
    expect((await call("GET", "")).body).toEqual([]);
  });

  it("answers 502 when the server cannot be reached", async () => {
    const { body: server } = await create({ name: "dead", url: "http://127.0.0.1:1/mcp" });
    const result = await call("POST", `/${server.id}/connect`);
    expect(result.status).toBe(502);
    expect(result.body.error).toMatch(/MCP server connection failed/);
  });

  it("rejects duplicate names (409), a malformed id (404) and another scope's server (404)", async () => {
    const { body: server } = await create();
    expect((await create()).status).toBe(409);
    expect((await call("POST", "/not-an-id/connect")).status).toBe(404);
    expect((await call("POST", `/${server.id}/connect`, undefined, { "x-project": "other" })).status).toBe(404);
    expect((await call("DELETE", `/${server.id}`, undefined, { "x-project": "other" })).status).toBe(404);
  });

  it("refuses a name that would shadow this service's own tool namespace", async () => {
    const { body: server } = await create({ name: "lazy-agent-service" });
    const result = await call("POST", `/${server.id}/connect`);
    expect(result.status).toBe(502);
    expect(result.body.error).toMatch(/reserved/);
  });

  it("connectAllFromDB reconnects enabled servers only (boot path)", async () => {
    await create({ name: "stub" });
    await create({ name: "off", enabled: false });
    await MCPClientService.connectAllFromDB(store.db as never);
    expect(MCPClientService.isConnected("stub")).toBe(true);
    expect(MCPClientService.isConnected("off")).toBe(false);
  });
});

describe("connected MCP tools in the native catalog", () => {
  it("appear in getMCPToolSchemas only while connected, and the call round-trips", async () => {
    const name = "mcp__stub__echo";
    expect(ToolOrchestratorService.getMCPToolSchemas().map((t) => t.name)).not.toContain(name);

    const { body: server } = await create();
    await call("POST", `/${server.id}/connect`);

    const schema = ToolOrchestratorService.getMCPToolSchemas().find((t) => t.name === name);
    expect(schema).toMatchObject({ description: "Echo text back", _mcpServer: "stub", _mcpOriginalName: "echo" });
    expect(JSON.stringify(schema?.parameters)).toContain("text");
    // the local catalog is still there
    expect(ToolOrchestratorService.getMCPToolSchemas().some((t) => t.name.startsWith("mcp__lazy-agent-service__"))).toBe(true);

    expect(await ToolOrchestratorService.executeTool(name, { text: "hi" })).toEqual({ echoed: "hi" });
    expect(await dispatchTool(name, { text: "via dispatch" })).toEqual({ echoed: "via dispatch" });

    await call("POST", `/${server.id}/disconnect`);
    expect(ToolOrchestratorService.getMCPToolSchemas().map((t) => t.name)).not.toContain(name);
    expect(await ToolOrchestratorService.executeTool(name, { text: "hi" })).toMatchObject({
      error: expect.stringContaining("not connected"),
    });
  });
});
