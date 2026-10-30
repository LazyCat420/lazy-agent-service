/**
 * PrismProxyService — request preparation, upstream headers, streaming pump,
 * error mapping and the session tool whitelist. The upstream HTTP endpoint is
 * the only fake; express req/res are small in-memory doubles.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismProxyService } from "../prism/PrismProxyService.ts";

const service = PrismProxyService as unknown as {
  prepareProxiedRequestBody: (req: unknown, basePath: string) =>
    | { ok: true; body: Record<string, unknown> }
    | { ok: false; error: string };
  buildUpstreamHeaders: (req: unknown, body: unknown) => Record<string, string>;
};

type HandleRequest = Parameters<typeof PrismProxyService.handle>[0];
type HandleResponse = Parameters<typeof PrismProxyService.handle>[1];

function fakeReq(overrides: Record<string, unknown> = {}): HandleRequest {
  // Test double for the express request; only the fields handle() reads are set.
  return {
    originalUrl: "/prism-proxy/chat",
    method: "POST",
    body: {},
    headers: {},
    query: {},
    ...overrides,
  } as unknown as HandleRequest;
}

/** Read the `error` field of a JSON error payload without trusting its shape. */
function errorMessage(value: unknown): string {
  if (value && typeof value === "object" && "error" in value) {
    const candidate = value.error;
    return typeof candidate === "string" ? candidate : "";
  }
  return "";
}

function fakeRes() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    headers: {} as Record<string, string>,
    chunks: [] as unknown[],
    ended: false,
    headersSent: false,
    status(this: any, code: number) {
      this.statusCode = code;
      return this;
    },
    json(this: any, value: unknown) {
      this.payload = value;
      this.headersSent = true;
      return this;
    },
    setHeader(this: any, key: string, value: string) {
      this.headers[key] = value;
    },
    flushHeaders() {},
    write(this: any, chunk: unknown) {
      this.chunks.push(chunk);
    },
    end(this: any) {
      this.ended = true;
      this.headersSent = true;
    },
    on() {},
    off() {},
  };
}

const okJson = (value: unknown) =>
  ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => value,
  }) as unknown as Response;

beforeEach(() => {
  PrismProxyService.__resetForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  PrismProxyService.__resetForTests();
  vi.unstubAllGlobals();
});

describe("prepareProxiedRequestBody", () => {
  it("registers the session whitelist for /agent posts", () => {
    const req = fakeReq({
      originalUrl: "/prism-proxy/agent",
      body: {
        conversationId: "conv-prep",
        enabledTools: ["read_file"],
        project: "demo",
      },
    });

    const result = service.prepareProxiedRequestBody(req, "/agent");

    expect(result.ok).toBe(true);
    expect(result.body.enabledTools).toEqual(["read_file"]);
    expect(PrismProxyService.isToolAllowed("conv-prep", "read_file")).toBe(true);
    expect(PrismProxyService.isToolAllowed("conv-prep", "delete_all")).toBe(false);
  });

  it("defaults enabledTools to an empty list when absent", () => {
    const req = fakeReq({
      originalUrl: "/prism-proxy/agent",
      body: { conversationId: "conv-empty-tools" },
    });

    const result = service.prepareProxiedRequestBody(req, "/agent");
    expect(result.body.enabledTools).toEqual([]);
    expect(PrismProxyService.isToolAllowed("conv-empty-tools", "anything")).toBe(false);
  });

  it("reports a 422-style error when trading preparation throws", () => {
    const req = fakeReq({
      originalUrl: "/prism-proxy/agent",
      body: {
        conversationId: "trading-conv",
        project: "vllm-trading-bot",
        provider: "openai",
        messages: [{ role: "user", content: "hi" }],
      },
    });

    const result = service.prepareProxiedRequestBody(req, "/agent");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("vLLM shim provider");
  });

  it("rewrites non-leading system messages for qwen models", () => {
    const original = [
      { role: "system", content: "leading" },
      { role: "user", content: "hello" },
      { role: "system", content: "mid-conversation" },
    ];
    const req = fakeReq({
      originalUrl: "/prism-proxy/chat",
      body: { model: "qwen3-8b", messages: original },
    });

    const result = service.prepareProxiedRequestBody(req, "/chat");

    expect(result.ok).toBe(true);
    expect(result.body.messages).toEqual([
      { role: "system", content: "leading" },
      { role: "user", content: "hello" },
      { role: "user", content: "mid-conversation" },
    ]);
    // The caller's body object is not mutated.
    expect(original[2].role).toBe("system");
  });

  it("leaves messages untouched for other models or non-POST requests", () => {
    const messages = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ];
    const chat = service.prepareProxiedRequestBody(
      fakeReq({ body: { model: "llama-3", messages } }),
      "/chat",
    );
    expect(chat.body.messages).toBe(messages);

    const get = service.prepareProxiedRequestBody(
      fakeReq({ method: "GET", body: { model: "qwen3", messages } }),
      "/chat",
    );
    expect(get.body.messages).toBe(messages);
  });
});

describe("buildUpstreamHeaders", () => {
  it("forwards identity headers and adds attribution", () => {
    const req = fakeReq({
      headers: {
        "x-project": "proj-a",
        "x-username": "alice",
        authorization: "Bearer token",
        "x-workspace-root": "/w",
      },
    });

    const headers = service.buildUpstreamHeaders(req, {});
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-project"]).toBe("proj-a");
    expect(headers["x-username"]).toBe("alice");
    expect(headers.authorization).toBe("Bearer token");
    expect(headers["x-workspace-root"]).toBe("/w");
  });

  it("falls back to query, body and service defaults", () => {
    const fromQuery = service.buildUpstreamHeaders(
      fakeReq({ query: { project: "q-proj", username: "q-user" } }),
      {},
    );
    expect(fromQuery["x-project"]).toBe("q-proj");
    expect(fromQuery["x-username"]).toBe("q-user");

    const fromBody = service.buildUpstreamHeaders(fakeReq(), {
      project: "b-proj",
      username: "b-user",
    });
    expect(fromBody["x-project"]).toBe("b-proj");
    expect(fromBody["x-username"]).toBe("b-user");

    const defaults = service.buildUpstreamHeaders(fakeReq(), null);
    expect(defaults["x-project"]).toBe("lazy-agent-service");
    expect(defaults["x-username"]).toBe("admin");
  });
});

describe("session tool whitelist", () => {
  it("allows everything without a conversation id", () => {
    expect(PrismProxyService.isToolAllowed("", "dangerous")).toBe(true);
  });

  it("fails open for unknown conversations and strips MCP prefixes", () => {
    expect(PrismProxyService.isToolAllowed("unknown-conv", "read_file")).toBe(true);

    PrismProxyService.registerSession("conv-prefix", ["read_file"]);
    expect(
      PrismProxyService.isToolAllowed("conv-prefix", "mcp__tools__read_file"),
    ).toBe(true);
    expect(
      PrismProxyService.isToolAllowed("conv-prefix", "mcp__tools__write_file"),
    ).toBe(false);
  });

  it("replaces an existing registration on re-register", () => {
    PrismProxyService.registerSession("conv-rereg", ["a"]);
    PrismProxyService.registerSession("conv-rereg", ["b"]);

    expect(PrismProxyService.isToolAllowed("conv-rereg", "a")).toBe(false);
    expect(PrismProxyService.isToolAllowed("conv-rereg", "b")).toBe(true);
  });

  it("persists registrations to disk", async () => {
    PrismProxyService.registerSession("conv-flush", ["read_file"]);
    await PrismProxyService.__flushForTests();

    PrismProxyService.__resetForTests();
    // Reloading from disk happens on the next lookup.
    expect(PrismProxyService.isToolAllowed("conv-flush", "read_file")).toBe(true);
    expect(PrismProxyService.isToolAllowed("conv-flush", "write_file")).toBe(false);
  });
});

describe("handle", () => {
  it("returns 422 when the request cannot be prepared", async () => {
    const res = fakeRes();
    await PrismProxyService.handle(
      fakeReq({
        originalUrl: "/prism-proxy/agent",
        body: {
          conversationId: "t",
          project: "vllm-trading-bot",
          provider: "openai",
        },
      }),
      res as unknown as HandleResponse,
    );

    expect(res.statusCode).toBe(422);
    expect(errorMessage(res.payload)).toContain("vLLM shim provider");
  });

  it("forwards a JSON response unchanged", async () => {
    const fetchMock = vi.fn(async () => okJson({ choices: [{ message: "ok" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = fakeRes();

    await PrismProxyService.handle(
      fakeReq({ originalUrl: "/prism-proxy/chat", body: { model: "llama-3" } }),
      res as unknown as HandleResponse,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/chat");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ model: "llama-3" }));
    expect(res.payload).toEqual({ choices: [{ message: "ok" }] });
  });

  it("omits the body for GET requests", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const res = fakeRes();

    await PrismProxyService.handle(
      fakeReq({ originalUrl: "/prism-proxy/health", method: "GET" }),
      res as unknown as HandleResponse,
    );

    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBeUndefined();
    expect(res.payload).toEqual({ status: "ok" });
  });

  it("maps upstream error statuses onto the client", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        headers: { get: () => "application/json" },
        text: async () => "upstream unavailable",
      })),
    );
    const res = fakeRes();

    await PrismProxyService.handle(fakeReq(), res as unknown as HandleResponse);

    expect(res.statusCode).toBe(503);
    expect(res.payload).toEqual({ error: "upstream unavailable" });
  });

  it("streams SSE chunks and ends the response", async () => {
    const cancel = vi.fn(async () => {});
    const read = vi
      .fn()
      .mockResolvedValueOnce({ done: false, value: "data: one\n\n" })
      .mockResolvedValueOnce({ done: false, value: "data: two\n\n" })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "text/event-stream" },
        body: { getReader: () => ({ read, cancel }) },
      })),
    );
    const res = fakeRes();

    await PrismProxyService.handle(
      fakeReq({ originalUrl: "/prism-proxy/chat", body: { model: "llama-3" } }),
      res as unknown as HandleResponse,
    );

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.headers["Cache-Control"]).toBe("no-cache");
    expect(res.chunks).toEqual(["data: one\n\n", "data: two\n\n"]);
    expect(res.ended).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("streams an agent response requested with stream=true even without SSE headers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        body: undefined,
      })),
    );
    const res = fakeRes();

    await PrismProxyService.handle(
      fakeReq({
        originalUrl: "/prism-proxy/agent?stream=true",
        query: { stream: "true" },
        body: { model: "llama-3" },
      }),
      res as unknown as HandleResponse,
    );

    expect(res.headers["Content-Type"]).toBe("text/event-stream");
    expect(res.ended).toBe(true);
    expect(res.payload).toBeUndefined();
  });

  it("returns 500 when the upstream fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const res = fakeRes();

    await PrismProxyService.handle(fakeReq(), res as unknown as HandleResponse);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({ error: "ECONNREFUSED" });
  });
});
