/**
 * The stdio guard on /mcp-servers + MCPClientService: a stdio MCP server is a
 * local process, so it only runs when its command is on MCP_STDIO_COMMANDS
 * (empty by default). Covers every path to a spawn: POST, PUT, connect and the
 * boot auto-connect (rows prism-service writes to the shared collection).
 *
 * The refused cases use a payload that would write a marker file, so a pass
 * proves nothing ran, not just that a status code came back.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const allowlist = vi.hoisted(() => [] as string[]);
vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MCP_STDIO_COMMANDS: allowlist,
}));

import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import mcpServersRouter from "../../routes/McpServersRoutes.ts";
import MCPClientService, { buildStdioEnv } from "../MCPClientService.ts";

// ─── In-memory Mongo collection (as in McpServersPort.test.ts) ────────────────
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

// ─── Stub MCP server over SSE (production's rows are sse) ─────────────────────
let sseStub: http.Server;
let sseUrl: string;
const sseSessions = new Map<string, SSEServerTransport>();

// ─── App under test ──────────────────────────────────────────────────────────
let app: http.Server;
let base: string;
let store: ReturnType<typeof fakeDb>;
let tmp: string;
let marker: string;

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-env-mcp-server.mjs");

beforeAll(async () => {
  sseStub = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (req.method === "GET" && url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      sseSessions.set(transport.sessionId, transport);
      res.on("close", () => sseSessions.delete(transport.sessionId));
      const server = new McpServer({ name: "sse-stub", version: "1.0.0" });
      server.registerTool("ping", { description: "Reply pong" }, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      await server.connect(transport);
      return;
    }
    const session = sseSessions.get(url.searchParams.get("sessionId") ?? "");
    if (req.method === "POST" && session) {
      await session.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => sseStub.listen(0, "127.0.0.1", resolve));
  sseUrl = `http://127.0.0.1:${(sseStub.address() as AddressInfo).port}/sse`;

  const express_ = express();
  express_.use(express.json());
  express_.use((req, _res, next) => {
    req.project = "html-notes";
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
  sseStub.closeAllConnections();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => sseStub.close(resolve));
});

beforeEach(async () => {
  await MCPClientService.disconnectAll();
  allowlist.length = 0;
  store = fakeDb();
  vi.spyOn(MongoWrapper, "getDb").mockReturnValue(store.db as never);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-guard-"));
  marker = path.join(tmp, "spawned");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, urlPath: string, body?: unknown) {
  const response = await fetch(`${base}/mcp-servers${urlPath}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** A stdio row that, if ever spawned, writes the marker file. */
function hostileStdio(name = "evil") {
  return {
    name,
    transport: "stdio",
    command: process.execPath,
    args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
  };
}

/** A stdio row as prism-service (or anyone with DB access) would store it. */
function seedStdioRow(enabled = true) {
  const _id = new ObjectId();
  store.docs.push({ _id, project: "html-notes", username: "tester", enabled, ...hostileStdio() });
  return _id;
}

async function settle() {
  // Long enough for a spawned `node -e` to have written its marker.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

describe("stdio refused by default", () => {
  it("POST of a stdio server → 403, nothing stored or spawned", async () => {
    const created = await call("POST", "", hostileStdio());
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/stdio refused/);
    expect(store.docs).toHaveLength(0);
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("PUT that switches a row to stdio, or edits a stdio row, → 403", async () => {
    const created = await call("POST", "", { name: "remote", transport: "sse", url: sseUrl });
    expect(created.status).toBe(201);
    const { transport: _t, ...rest } = hostileStdio("remote");
    const switched = await call("PUT", `/${created.body.id}`, { ...rest, transport: "stdio" });
    expect(switched.status).toBe(403);
    expect(store.docs[0].transport).toBe("sse");

    const seeded = seedStdioRow(false);
    expect((await call("PUT", `/${seeded}`, { enabled: true })).status).toBe(403);
    expect((await call("PUT", `/${seeded}`, { command: "/bin/true" })).status).toBe(403);
    // Turning a refused row off stays allowed.
    expect((await call("PUT", `/${seeded}`, { enabled: false })).status).toBe(200);
  });

  it("POST /:id/connect on a stored stdio row → 403, nothing spawned", async () => {
    const id = seedStdioRow();
    const connected = await call("POST", `/${id}/connect`);
    expect(connected.status).toBe(403);
    expect(connected.body.error).toMatch(/MCP_STDIO_COMMANDS/);
    expect(MCPClientService.isConnected("evil")).toBe(false);
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a command off the allowlist is refused even when the allowlist is set", async () => {
    allowlist.push("/usr/local/bin/some-mcp-server");
    const id = seedStdioRow();
    expect((await call("POST", `/${id}/connect`)).status).toBe(403);
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("boot auto-connect skips a stdio row without crashing and still connects the rest", async () => {
    seedStdioRow();
    store.docs.push({
      _id: new ObjectId(), project: "html-notes", username: "tester", enabled: true,
      name: "remote", transport: "sse", url: sseUrl,
    });
    await expect(MCPClientService.connectAllFromDB(store.db as never)).resolves.toBeUndefined();
    expect(MCPClientService.isConnected("remote")).toBe(true);
    expect(MCPClientService.isConnected("evil")).toBe(false);
    await settle();
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("an allowlisted stdio command", () => {
  const sentinels = ["MONGO_URI", "DATABASE_URL", "X_SERVICE_API_KEY"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of sentinels) {
      saved[key] = process.env[key];
      process.env[key] = `sentinel_${crypto.randomBytes(8).toString("hex")}`;
    }
  });
  afterEach(() => {
    for (const key of sentinels) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("connects, and the child gets only the minimal env plus the row's env", async () => {
    allowlist.push(process.execPath);
    const report = path.join(tmp, "env.json");
    const created = await call("POST", "", {
      name: "local",
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE, report],
      env: { ROW_SETTING: "1" },
    });
    expect(created.status).toBe(201);

    const connected = await call("POST", `/${created.body.id}/connect`);
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ success: true, toolCount: 1 });

    const keys = JSON.parse(fs.readFileSync(report, "utf8")) as string[];
    expect(keys).toContain("PATH");
    expect(keys).toContain("ROW_SETTING");
    for (const key of sentinels) expect(keys).not.toContain(key);
    expect(keys.filter((key) => /MONGO|DATABASE_URL|_KEY$/.test(key))).toEqual([]);
  });

  it("a row env that sets NODE_OPTIONS or LD_* is refused", async () => {
    allowlist.push(process.execPath);
    const created = await call("POST", "", {
      ...hostileStdio("loader"),
      args: [FIXTURE],
      env: { NODE_OPTIONS: "--require /tmp/x.js" },
    });
    expect(created.status).toBe(403);
    expect(created.body.error).toMatch(/NODE_OPTIONS/);
  });

  it("buildStdioEnv keeps PATH/HOME/LANG/TMPDIR/NODE_* only", () => {
    const leaked = () => `sentinel_${crypto.randomBytes(8).toString("hex")}`;
    const env = buildStdioEnv(
      { ROW: "r" },
      { PATH: "/bin", HOME: "/h", LANG: "C", TMPDIR: "/t", NODE_ENV: "test", MONGO_URI: leaked(), SOME_API_KEY: leaked() },
    );
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LANG: "C", TMPDIR: "/t", NODE_ENV: "test", ROW: "r" });
  });
});

describe("transport validation and http/sse still work", () => {
  it("an omitted transport → 400", async () => {
    const created = await call("POST", "", { name: "bare", command: "/bin/true" });
    expect(created.status).toBe(400);
    expect(store.docs).toHaveLength(0);
  });

  it("sse create + connect", async () => {
    const created = await call("POST", "", { name: "remote", transport: "sse", url: sseUrl });
    expect(created.status).toBe(201);
    const connected = await call("POST", `/${created.body.id}/connect`);
    expect(connected.status).toBe(200);
    expect(connected.body).toMatchObject({ success: true, toolCount: 1 });
  });

  it("streamable-http create validates", async () => {
    const created = await call("POST", "", { name: "web", transport: "streamable-http", url: "http://127.0.0.1:1/mcp" });
    expect(created.status).toBe(201);
    expect(store.docs[0].transport).toBe("streamable-http");
  });
});
