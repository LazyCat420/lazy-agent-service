// Wire contract between this service and tools-service.
//
// The real LAS callers (ToolOrchestratorService, GitWorktreeHelper, DirectoryTreeFormatter) talk
// to a loopback HTTP server that stands in for tools-service. Two things are checked:
//   1. each request LAS puts on the wire is one the tools-service handler accepts
//      (`toolsServiceAccepts`: what the handler reads, and what it checks before doing any work);
//   2. each response in fixtures/tools-service-wire.json, which has the shape the tools-service
//      handler produces, is parsed by LAS into the right result.
// Both sides were derived by reading tools-service source on disk (see the fixture's `provenance`
// and each entry's `from`), not captured from a running service.
import { readFileSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type * as ConfigModule from "../../config.ts";

interface RecordedRequest {
  method: string;
  /** Path as sent, still percent-encoded. */
  path: string;
  /** Query string as sent, with its leading "?", or "". */
  search: string;
  headers: IncomingHttpHeaders;
  bodyText: string;
}
interface StandInReply {
  status?: number;
  body?: unknown;
  /** Sent as a text/event-stream, one `data: <json>` frame per entry, as tools-service does. */
  sse?: unknown[];
}

// The stand-in starts before any import runs, because ToolOrchestratorService reads
// TOOLS_SERVICE_URL and fetches the tool catalog while it is being imported.
const tools = await vi.hoisted(async () => {
  // Dynamic import: vi.hoisted runs before this file's static imports are bound.
  const http = await import("node:http");
  const requests: RecordedRequest[] = [];
  const replies = new Map<string, StandInReply>();
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  let answered = 0;

  const server = http.createServer((incoming, outgoing) => {
    const parts: Buffer[] = [];
    incoming.on("data", (part: Buffer) => parts.push(part));
    incoming.on("end", () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const method = incoming.method ?? "";
      requests.push({ method, path: url.pathname, search: url.search, headers: incoming.headers, bodyText: Buffer.concat(parts).toString() });
      const reply = replies.get(`${method} ${url.pathname}`) ?? { status: 503, body: { error: `stand-in has no reply for ${method} ${url.pathname}` } };
      outgoing.on("finish", () => {
        answered += 1;
        for (const waiter of waiters.splice(0)) {
          if (waiter.count <= answered) waiter.resolve();
          else waiters.push(waiter);
        }
      });
      if (reply.sse) {
        outgoing.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        for (const event of reply.sse) outgoing.write(`data: ${JSON.stringify(event)}\n\n`);
        outgoing.end();
      } else {
        outgoing.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify(reply.body));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("tools-service stand-in has no port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    replies,
    /** Resolves once the stand-in has finished answering `count` requests. */
    answeredAtLeast: (count: number) => (answered >= count ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ count, resolve }))),
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
});

vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  TOOLS_SERVICE_URL: tools.baseUrl,
}));
vi.mock("../../src/utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import PromptLocaleService from "../../src/services/PromptLocaleService.ts";
import ToolOrchestratorService from "../../src/services/ToolOrchestratorService.ts";
import { GitWorktreeHelper } from "../../src/services/orchestrator/GitWorktreeHelper.ts";
import { DirectoryTreeFormatter } from "../../src/services/system-prompt/DirectoryTreeFormatter.ts";

// ── Fixture: responses in the shape tools-service produces ──────────────────────────────────────
const ReplySchema = z.strictObject({
  from: z.string().min(1),
  status: z.number().optional(),
  body: z.unknown().optional(),
  sse: z.array(z.record(z.string(), z.unknown())).optional(),
});
const FixtureSchema = z.strictObject({
  provenance: z.string().min(1),
  toolsServiceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  toolSchemas: ReplySchema,
  adminConfig: ReplySchema,
  adminConfigNoAgents: ReplySchema,
  workspacesUpdated: ReplySchema,
  workspacesRejected: ReplySchema,
  validateVerdict: ReplySchema,
  validateRejected: ReplySchema,
  health: ReplySchema,
  filesystemList: ReplySchema,
  filesystemListRejected: ReplySchema,
  worktreeCreated: ReplySchema,
  worktreeCreateFailed: ReplySchema,
  worktreeForbidden: ReplySchema,
  worktreeDiff: ReplySchema,
  shellStream: ReplySchema,
  jsStream: ReplySchema,
  pythonStream: ReplySchema,
  commandStreamAborted: ReplySchema,
  streamRejected: ReplySchema,
  fileWritten: ReplySchema,
  fileWriteRejected: ReplySchema,
  handlerTimedOut: ReplySchema,
});
const fixture = FixtureSchema.parse(JSON.parse(readFileSync(new URL("./fixtures/tools-service-wire.json", import.meta.url), "utf8")));

// ── What each tools-service handler accepts ─────────────────────────────────────────────────────
// Derived from the handler's own reads and guards at the fixture's commit. A request that fails
// one of these is answered 400 by tools-service before any work is done.
const text = z.string().min(1);
const timeout = z.union([z.number(), z.string()]).optional();
const toolsServiceAccepts = {
  // AdminRoutes.ts: `if (!Array.isArray(roots)) 400`; each entry goes through path resolution.
  "PUT /admin/config/workspaces": z.object({ roots: z.array(z.string()) }),
  // AdminRoutes.ts: `if (!rawPath || typeof rawPath !== "string") 400`.
  "POST /admin/config/workspaces/validate": z.object({ path: text }),
  // AgenticRoutes.ts git worktree routes: each named field is required as a non-empty string.
  "POST /agentic/git/worktree/create": z.object({ path: text, branch: text }),
  "POST /agentic/git/worktree/remove": z.object({ path: text, worktreePath: text }),
  "POST /agentic/git/worktree/diff": z.object({ path: text, branch: text }),
  "POST /agentic/git/worktree/merge": z.object({ path: text, branch: text, message: z.string().optional() }),
  "POST /agentic/git/worktree/cleanup": z.object({ path: text }),
  // ComputeRoutes.ts /shell/stream, /js/stream; UtilityRoutes.ts /python/stream; AgenticRoutes.ts /command/stream.
  "POST /compute/shell/stream": z.object({ command: text, stdin: z.string().optional(), timeout }),
  "POST /compute/js/stream": z.object({ code: text, timeout }),
  "POST /utility/python/stream": z.object({ code: text, timeout }),
  "POST /agentic/command/stream": z.object({ command: text, cwd: z.string().optional(), timeout }),
  // AgenticRoutes.ts /file/write: path non-empty string, content string, createDirs boolean-like.
  "POST /agentic/file/write": z.object({ path: text, content: z.string(), createDirs: z.boolean().optional() }),
} as const;
type BodyRoute = keyof typeof toolsServiceAccepts;

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────
const serve = (route: string, reply: StandInReply) => tools.replies.set(route, reply);
/** Every request since the test began, as "METHOD /path?query". */
const sent = () => tools.requests.map((request) => `${request.method} ${request.path}${request.search}`);
/** The one request made to `route`; fails the test when there is none or more than one. */
function only(route: string): RecordedRequest {
  const matching = tools.requests.filter((request) => `${request.method} ${request.path}` === route);
  expect(matching.map((request) => `${request.method} ${request.path}`), `requests to ${route}`).toEqual([route]);
  return matching[0];
}
/** The JSON body of the one request to `route`, after checking that tools-service accepts it. */
function acceptedBody(route: BodyRoute): unknown {
  const request = only(route);
  expect(request.headers["content-type"]).toBe("application/json");
  const body: unknown = JSON.parse(request.bodyText);
  const verdict = toolsServiceAccepts[route].safeParse(body);
  expect(verdict.success, verdict.success ? "" : `${route} would be rejected: ${verdict.error.message}`).toBe(true);
  return body;
}
const customHeaders = (request: RecordedRequest) => Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith("x-")));

const context = {
  project: "contract-test",
  username: "fixture-user",
  agent: "CODING",
  requestId: "req-1",
  traceId: "trace-1",
  agentConversationId: "agent-conv-1",
  conversationId: "conv-1",
  iteration: 3,
  workspaceRoot: "/srv/workspace",
  enabledTools: ["execute_shell", "write_file"],
  _providerName: "vllm",
  _resolvedModel: "replay-model",
};

/** Loads the fixture catalog into the service, as it happens at boot. */
async function loadCatalog(): Promise<void> {
  serve("GET /admin/tool-schemas", fixture.toolSchemas);
  serve("GET /admin/config", fixture.adminConfig);
  expect(await ToolOrchestratorService.refreshSchemas()).toBe(3);
  tools.requests.length = 0;
}

beforeAll(async () => {
  // Importing ToolOrchestratorService fetches the catalog, then one catalog per non-default
  // locale. Wait until the stand-in has answered all of them so none lands inside a test.
  // ("en" is never fetched as a locale: it is the catalog itself.) If the service ever makes
  // fewer boot requests than this, the wait cannot finish and this hook fails at vitest's hook
  // timeout: recount the boot requests here.
  const otherLocales = PromptLocaleService.getAvailableLocales().filter((locale) => locale !== PromptLocaleService.getDefaultLocale() && locale !== "en");
  await tools.answeredAtLeast(1 + otherLocales.length);
});
afterAll(() => tools.close());
beforeEach(() => {
  ToolOrchestratorService._resetCaches();
  tools.replies.clear();
  tools.requests.length = 0;
});

describe("requests LAS sends are ones tools-service accepts", () => {
  it("C1 loading the catalog reads /admin/tool-schemas, then /admin/config, with no query and no body", async () => {
    serve("GET /admin/tool-schemas", fixture.toolSchemas);
    serve("GET /admin/config", fixture.adminConfig);
    await ToolOrchestratorService.refreshSchemas();
    expect(sent()).toEqual(["GET /admin/tool-schemas", "GET /admin/config"]);
    expect(tools.requests.map((request) => request.bodyText)).toEqual(["", ""]);
  });

  it("C2 a localized catalog is requested with the locale as the one query parameter, percent-encoded", async () => {
    await loadCatalog();
    serve("GET /admin/tool-schemas", fixture.toolSchemas);
    await ToolOrchestratorService.ensureSchemas("zh-Hant&debug=1");
    // AdminRoutes.ts reads `req.query.locale`.
    const query = new URLSearchParams(only("GET /admin/tool-schemas").search);
    expect([...query.entries()]).toEqual([["locale", "zh-Hant&debug=1"]]);
  });

  it("C3 updating the workspace roots sends { roots } as JSON with PUT", async () => {
    serve("PUT /admin/config/workspaces", fixture.workspacesUpdated);
    await ToolOrchestratorService.updateWorkspaceRoots(["/srv/extra", "relative/dir"]);
    expect(acceptedBody("PUT /admin/config/workspaces")).toEqual({ roots: ["/srv/extra", "relative/dir"] });
  });

  it("C4 validating a workspace path sends { path } as JSON with POST", async () => {
    serve("POST /admin/config/workspaces/validate", fixture.validateVerdict);
    await ToolOrchestratorService.validateWorkspacePath("/srv/missing");
    expect(acceptedBody("POST /admin/config/workspaces/validate")).toEqual({ path: "/srv/missing" });
  });

  it("C5 the health check and the agent probe are plain GETs", async () => {
    serve("GET /health", fixture.health);
    serve("GET /admin/config", fixture.adminConfig);
    await ToolOrchestratorService.checkApiHealth();
    await ToolOrchestratorService.isWorkspaceAgentConnected();
    expect(sent()).toEqual(["GET /health", "GET /admin/config"]);
  });

  it("C6 the directory tree is requested with the workspace root as `path` and a depth within the service's limit", async () => {
    serve("GET /filesystem/list", fixture.filesystemList);
    await new DirectoryTreeFormatter("/srv/my repo/café & co").fetchDirectoryTree();
    // FilesystemRoutes.ts: `path` must be a non-empty string; depth is parseInt'd and capped at 5.
    const query = new URLSearchParams(only("GET /filesystem/list").search);
    expect(query.get("path")).toBe("/srv/my repo/café & co");
    expect(query.get("depth")).toBe("2");
    expect([...query.keys()]).toEqual(["path", "depth"]);
  });

  it.each<[BodyRoute, () => Promise<unknown>, Record<string, unknown>]>([
    ["POST /agentic/git/worktree/create", () => GitWorktreeHelper.createWorktree("/srv/workspace", "orchestrator/agent-1"), { path: "/srv/workspace", branch: "orchestrator/agent-1" }],
    [
      "POST /agentic/git/worktree/remove",
      () => GitWorktreeHelper.removeWorktree("/srv/workspace", "/srv/workspace-worktrees/agent-1"),
      { path: "/srv/workspace", worktreePath: "/srv/workspace-worktrees/agent-1" },
    ],
    ["POST /agentic/git/worktree/diff", () => GitWorktreeHelper.getWorktreeDiff("/srv/workspace", "orchestrator/agent-1"), { path: "/srv/workspace", branch: "orchestrator/agent-1" }],
    [
      "POST /agentic/git/worktree/merge",
      () => GitWorktreeHelper.mergeWorktree("/srv/workspace", "orchestrator/agent-1", "merge agent-1"),
      { path: "/srv/workspace", branch: "orchestrator/agent-1", message: "merge agent-1" },
    ],
    ["POST /agentic/git/worktree/cleanup", () => GitWorktreeHelper.cleanupWorktrees("/srv/workspace"), { path: "/srv/workspace" }],
  ])("C7 %s carries every field the handler requires", async (route, call, body) => {
    serve(route, { status: 200, body: {} });
    await call();
    expect(acceptedBody(route)).toEqual(body);
  });

  it.each<[string, BodyRoute, Record<string, unknown>]>([
    [TOOL_NAMES.EXECUTE_SHELL, "POST /compute/shell/stream", { command: "echo hi" }],
    [TOOL_NAMES.EXECUTE_JAVASCRIPT, "POST /compute/js/stream", { code: "console.log(total)" }],
    [TOOL_NAMES.EXECUTE_PYTHON, "POST /utility/python/stream", { code: "print(2 + 2)", timeout: 60000 }],
    [TOOL_NAMES.RUN_COMMAND, "POST /agentic/command/stream", { command: "npm test", cwd: "/srv/workspace" }],
  ])("C8a the streaming tool %s posts the model's arguments unchanged to %s", async (name, route, args) => {
    serve(route, fixture.shellStream);
    await ToolOrchestratorService.executeToolStreaming(name, args, null, context);
    expect(acceptedBody(route)).toEqual(args);
  });

  it("C8b a streaming call carries the caller identity in the headers tools-service reads", async () => {
    serve("POST /compute/shell/stream", fixture.shellStream);
    await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.EXECUTE_SHELL, { command: "echo hi" }, null, context);
    // tools-service reads x-project, x-username, x-agent, x-request-id, x-conversation-id and
    // x-iteration (ToolCallLoggerMiddleware.ts, via IDENTITY_HEADERS), x-trace-id (utilities.ts),
    // x-workspace-root (AgentConnectionManager.ts), x-enabled-tools, x-provider and x-model
    // (AgenticRoutes.ts). LAS also sends x-agent-conversation-id, which nothing there reads,
    // so it is not part of this contract and not checked.
    expect(customHeaders(only("POST /compute/shell/stream"))).toMatchObject({
      "x-project": "contract-test",
      "x-username": "fixture-user",
      "x-agent": "CODING",
      "x-request-id": "req-1",
      "x-trace-id": "trace-1",
      "x-conversation-id": "conv-1",
      "x-iteration": "3",
      "x-workspace-root": "/srv/workspace",
      "x-enabled-tools": "execute_shell,write_file",
      "x-provider": "vllm",
      "x-model": "replay-model",
    });
  });

  it("C9a a catalog tool with path and query parameters becomes a GET the route can read", async () => {
    await loadCatalog();
    serve("GET /finance/prices/BRK%20B", { status: 200, body: { symbol: "BRK B", prices: [] } });
    await ToolOrchestratorService.executeTool("get_historical_prices", { symbol: "BRK B", interval: "1wk", period: "", fields: ["date", "close"] }, context);
    const request = only("GET /finance/prices/BRK%20B");
    // FinanceRoutes.ts reads req.params.symbol, req.query.interval, req.query.period (default
    // "3mo" when absent); FieldProjectionMiddleware.ts reads req.query.fields as a comma list.
    const query = new URLSearchParams(request.search);
    expect([...query.entries()]).toEqual([
      ["interval", "1wk"],
      ["fields", "date,close"],
    ]);
    expect(request.bodyText).toBe("");
  });

  it("C9b a catalog tool whose endpoint says GET explicitly puts a numeric path parameter in the path", async () => {
    await loadCatalog();
    serve("GET /agentic/command/background/4242", { status: 200, body: { pid: 4242, running: false } });
    await ToolOrchestratorService.executeTool("get_background_output", { pid: 4242 }, context);
    expect(sent()).toEqual(["GET /agentic/command/background/4242"]);
  });

  it("C9c a catalog tool with method POST sends its declared bodyParams as a JSON body", async () => {
    await loadCatalog();
    serve("POST /agentic/file/write", fixture.fileWritten);
    await ToolOrchestratorService.executeTool("write_file", { path: "/srv/workspace/notes.md", content: "hello world", createDirs: true }, context);
    // project, agent and username are added by LAS from the session; the handler ignores them.
    expect(acceptedBody("POST /agentic/file/write")).toEqual({
      path: "/srv/workspace/notes.md",
      content: "hello world",
      createDirs: true,
      project: "contract-test",
      agent: "CODING",
      username: "fixture-user",
    });
    expect(only("POST /agentic/file/write").search).toBe("");
  });

  it("C9d inside a worktree the file path is redirected and x-workspace-override names the worktree", async () => {
    await loadCatalog();
    serve("POST /agentic/file/write", fixture.fileWritten);
    ToolOrchestratorService._setWorktree("agent-conv-1", { originalRoot: "/srv/workspace", worktreePath: "/srv/workspace-worktrees/agent-1" });
    try {
      await ToolOrchestratorService.executeTool("write_file", { path: "/srv/workspace/notes.md", content: "hello world" }, context);
    } finally {
      ToolOrchestratorService._clearWorktree("agent-conv-1");
    }
    expect(acceptedBody("POST /agentic/file/write")).toMatchObject({ path: "/srv/workspace-worktrees/agent-1/notes.md" });
    // AgentConnectionManager.ts resolves the workspace from x-workspace-override first.
    expect(only("POST /agentic/file/write").headers["x-workspace-override"]).toBe("/srv/workspace-worktrees/agent-1");
  });
});

describe("responses tools-service defines are parsed by LAS", () => {
  const CatalogSchema = z.array(z.looseObject({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }));
  const catalog = CatalogSchema.parse(fixture.toolSchemas.body);
  const catalogEntry = (name: string) => {
    const entry = catalog.find((tool) => tool.name === name);
    if (!entry) throw new Error(`fixture catalog has no ${name}`);
    return entry;
  };

  it("C10a a catalog entry reaches the UI with its grouping metadata and without its endpoint", async () => {
    await loadCatalog();
    const shown = ToolOrchestratorService.getClientToolSchemas(undefined, "en").find((tool) => tool.name === "write_file");
    const { endpoint: _endpoint, parameters, ...metadata } = catalogEntry("write_file");
    expect(shown).toMatchObject(metadata);
    expect(shown).toMatchObject({ parameters: { properties: parameters.properties, required: parameters.required } });
    expect(shown).not.toHaveProperty("endpoint");
  });

  it("C10b a catalog entry reaches the model without endpoint, dataSource or domain, and closed to extra arguments", async () => {
    await loadCatalog();
    const offered = ToolOrchestratorService.getToolSchemas(undefined, "en").find((tool) => tool.name === "get_historical_prices");
    const { parameters, name, description } = catalogEntry("get_historical_prices");
    expect(offered).toMatchObject({ name, description });
    // tools-service definitions do not set additionalProperties; LAS closes them.
    expect(offered?.parameters).toEqual({ ...parameters, additionalProperties: false });
    for (const key of ["endpoint", "dataSource", "domain"]) expect(offered).not.toHaveProperty(key);
  });

  it("C11a the workspace roots come from /admin/config", async () => {
    await loadCatalog();
    expect(ToolOrchestratorService.getWorkspaceRoots()).toEqual(["/srv/workspace", "/srv/second"]);
    expect(ToolOrchestratorService.getWorkspaceRoot()).toBe("/srv/workspace");
  });

  it("C11b a workspace agent counts as connected when /admin/config lists one with roots", async () => {
    serve("GET /admin/config", fixture.adminConfig);
    expect(await ToolOrchestratorService.isWorkspaceAgentConnected()).toBe(true);
    serve("GET /admin/config", fixture.adminConfigNoAgents);
    expect(await ToolOrchestratorService.isWorkspaceAgentConnected()).toBe(false);
  });

  it("C12 /admin/config has no staticRoots key, so LAS has no static roots to report", async () => {
    // LAS reads `staticRoots` from this response (ToolOrchestratorService fetchSchemas,
    // refreshWorkspaceRoots, updateWorkspaceRoots); tools-service never sends it, and the
    // fixture's /admin/config body has the two keys the route sends and no other.
    await loadCatalog();
    await ToolOrchestratorService.refreshWorkspaceRoots();
    expect(ToolOrchestratorService.getStaticRoots()).toEqual([]);
  });

  it("C13a a workspace update returns the service's answer, per-path errors included, and adopts its roots", async () => {
    serve("PUT /admin/config/workspaces", fixture.workspacesUpdated);
    expect(await ToolOrchestratorService.updateWorkspaceRoots(["/srv/extra", "relative/dir"])).toEqual(fixture.workspacesUpdated.body);
    expect(ToolOrchestratorService.getWorkspaceRoots()).toEqual(["/srv/workspace", "/srv/extra"]);
  });

  it("C13b a refused workspace update throws the service's error text", async () => {
    serve("PUT /admin/config/workspaces", fixture.workspacesRejected);
    await expect(ToolOrchestratorService.updateWorkspaceRoots([])).rejects.toThrow("'roots' must be an array of path strings");
  });

  it("C14 a path verdict is returned as the service sent it, whether it is a 200 verdict or a 400", async () => {
    serve("POST /admin/config/workspaces/validate", fixture.validateVerdict);
    expect(await ToolOrchestratorService.validateWorkspacePath("/srv/missing")).toEqual(fixture.validateVerdict.body);
    serve("POST /admin/config/workspaces/validate", fixture.validateRejected);
    expect(await ToolOrchestratorService.validateWorkspacePath("")).toEqual(fixture.validateRejected.body);
  });

  it("C15 a healthy service leaves every tool online; a failing one takes every catalog tool offline", async () => {
    await loadCatalog();
    serve("GET /health", fixture.health);
    const healthy = await ToolOrchestratorService.checkApiHealth();
    expect(healthy.apiStatus).toEqual({ [tools.baseUrl]: true });
    expect([...healthy.offline]).toEqual([]);

    // server.ts global error handler: 500 { error }.
    serve("GET /health", { status: 500, body: { error: "Internal server error" } });
    const failing = await ToolOrchestratorService.checkApiHealth();
    expect(failing.apiStatus).toEqual({ [tools.baseUrl]: false });
    expect([...failing.offline].sort()).toEqual(["get_background_output", "get_historical_prices", "write_file"]);
  });

  it("C16a the directory listing becomes a two-level tree", async () => {
    serve("GET /filesystem/list", fixture.filesystemList);
    expect(await new DirectoryTreeFormatter("/srv/workspace").fetchDirectoryTree()).toBe("📁 src\n  📄 index.ts\n📄 README.md");
  });

  it("C16b a refused directory listing yields an empty tree", async () => {
    serve("GET /filesystem/list", fixture.filesystemListRejected);
    expect(await new DirectoryTreeFormatter("/srv/workspace").fetchDirectoryTree()).toBe("");
  });

  it("C17a a created worktree is returned as the service describes it", async () => {
    serve("POST /agentic/git/worktree/create", fixture.worktreeCreated);
    expect(await GitWorktreeHelper.createWorktree("/srv/workspace", "orchestrator/agent-1")).toEqual(fixture.worktreeCreated.body);
  });

  it("C17b a refused worktree call is reduced to the service's error text, for 400 and for 403", async () => {
    serve("POST /agentic/git/worktree/create", fixture.worktreeCreateFailed);
    expect(await GitWorktreeHelper.createWorktree("/srv/workspace", "orchestrator/agent-1")).toEqual({
      error: "fatal: a branch named 'orchestrator/agent-1' already exists",
    });
    serve("POST /agentic/git/worktree/create", fixture.worktreeForbidden);
    expect(await GitWorktreeHelper.createWorktree("/etc", "orchestrator/agent-1")).toEqual({
      error: "Path '/etc' is outside allowed roots: /srv/workspace",
    });
  });

  it("C18a the worktree diff is handed on exactly as tools-service sent it", async () => {
    serve("POST /agentic/git/worktree/diff", fixture.worktreeDiff);
    expect(await GitWorktreeHelper.getWorktreeDiff("/srv/workspace", "orchestrator/agent-contract")).toEqual(fixture.worktreeDiff.body);
  });

  // What LAS requires of a diff before it keeps it: the gate in commitAndCollectSubAgentDiff
  // (src/services/OrchestratorService.ts) and the type WorktreeDiff (src/types/orchestrator.ts).
  // Any other shape is stored as `diff = null`. Keep this in step with that gate.
  const LasWorktreeDiffSchema = z.object({ hasChanges: z.boolean(), additions: z.number(), deletions: z.number(), files: z.array(z.unknown()) });

  // DEFECT?: the two sides disagree on the diff shape. tools-service sends { branch, base,
  // files: [{ path, status }], patch, stats: { filesChanged, additions, deletions } } (its pinned
  // tests/fixtures/worktree-diff-contract.json); LAS expects { hasChanges, additions, deletions,
  // files: string[] } at the top level. The gate never passes, so every sub-agent's diff is null
  // and its result reports no changes. Remove .fails when LAS reads the tools-service shape.
  it.fails("C18b the tools-service worktree diff is one LAS keeps", async () => {
    serve("POST /agentic/git/worktree/diff", fixture.worktreeDiff);
    const diff = await GitWorktreeHelper.getWorktreeDiff("/srv/workspace", "orchestrator/agent-contract");
    expect(LasWorktreeDiffSchema.safeParse(diff).success).toBe(true);
  });

  it("C19a a shell stream becomes one result holding the joined output and the exit event's fields", async () => {
    serve("POST /compute/shell/stream", fixture.shellStream);
    const chunks: Array<[string, string | null]> = [];
    const result = await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.EXECUTE_SHELL, { command: "echo hi" }, (event, data) => chunks.push([event, data]), context);
    expect(result).toEqual({ success: true, stdout: "hi\n", stderr: "", exitCode: 0, executionTimeMs: 12, timedOut: false });
    expect(chunks).toEqual([
      ["start", null],
      ["stdout", "hi\n"],
      ["exit", null],
    ]);
  });

  it("C19b a JavaScript stream, whose exit event has no timedOut or error, reports a failure through stderr and the exit code", async () => {
    serve("POST /compute/js/stream", fixture.jsStream);
    const result = await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.EXECUTE_JAVASCRIPT, { code: "console.log(total)" }, null, context);
    expect(result).toEqual({ success: false, stdout: "", stderr: "ReferenceError: total is not defined\n", exitCode: 1, executionTimeMs: 3, timedOut: false });
  });

  it("C19c a Python stream that timed out keeps timedOut and the service's error text", async () => {
    serve("POST /utility/python/stream", fixture.pythonStream);
    const result = await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.EXECUTE_PYTHON, { code: "print(2 + 2)" }, null, context);
    expect(result).toEqual({ success: false, stdout: "4\n", stderr: "", exitCode: 1, executionTimeMs: 60000, timedOut: true, error: "Execution timed out after 60000ms" });
  });

  // DEFECT?: /agentic/command/stream marks a run the caller cancelled with `aborted: true` in
  // its exit event. LAS's stream parser (applyStreamEvent) copies success, exitCode,
  // executionTimeMs, timedOut and error only, so the result is an ordinary failure with
  // nothing saying it was cancelled. Remove .fails when the result carries `aborted`.
  it.fails("C19d a command stream the caller aborted is reported as aborted", async () => {
    serve("POST /agentic/command/stream", fixture.commandStreamAborted);
    const result = await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.RUN_COMMAND, { command: "npm test" }, null, context);
    expect(result).toMatchObject({ success: false, stdout: "running\n", aborted: true });
  });

  // DEFECT?: every stream route answers a bad request with 400 { error: "<what is wrong>" }
  // before it opens the stream. executeToolStreaming returns "API returned 400: Bad Request"
  // and drops that text, where the non-streaming path (fetchJsonWithBody) forwards it. The
  // model is not told which argument to fix. Remove .fails when the text is forwarded.
  it.fails("C20 a stream route's refusal reaches the caller with the service's error text", async () => {
    serve("POST /compute/shell/stream", fixture.streamRejected);
    const result = await ToolOrchestratorService.executeToolStreaming(TOOL_NAMES.EXECUTE_SHELL, {}, null, context);
    expect(result).toEqual({ error: "Request body must include 'command' (string)" });
  });

  it("C21 a catalog tool's success body is returned unchanged", async () => {
    await loadCatalog();
    serve("POST /agentic/file/write", fixture.fileWritten);
    const result = await ToolOrchestratorService.executeTool("write_file", { path: "/srv/workspace/notes.md", content: "hello world" }, context);
    expect(result).toEqual(fixture.fileWritten.body);
  });

  it.each([
    ["a 400 with code and retryable", "fileWriteRejected", "Request body must include 'content' (string)"],
    ["a 504 handler timeout", "handlerTimedOut", "Tool handler timed out after 120000ms (POST /agentic/file/write)"],
  ] as const)("C21 %s from a catalog tool is reduced to { error } with the service's text", async (_name, key, message) => {
    await loadCatalog();
    serve("POST /agentic/file/write", fixture[key]);
    const result = await ToolOrchestratorService.executeTool("write_file", { path: "/srv/workspace/notes.md", content: "hello world" }, context);
    expect(result).toEqual({ error: message });
  });
});
