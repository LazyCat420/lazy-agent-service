/**
 * WorkspacesRoutes — root listing, name disambiguation, config validation and
 * the tools-service proxies. tools-service is a fetch stand-in; assertions are
 * on the JSON the client receives.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import router from "../WorkspacesRoutes.ts";

const service = vi.hoisted(() => ({
  roots: [] as string[],
  staticRoots: [] as string[],
  updated: null as unknown,
  validated: null as unknown,
  updateThrows: null as Error | null,
  validateThrows: null as Error | null,
}));

vi.mock("../../services/ToolOrchestratorService.ts", () => ({
  default: {
    async refreshWorkspaceRoots() {},
    getWorkspaceRoots: () => service.roots,
    getStaticRoots: () => service.staticRoots,
    async updateWorkspaceRoots(roots: string[]) {
      if (service.updateThrows) throw service.updateThrows;
      service.updated = roots;
      return { roots, updated: true };
    },
    async validateWorkspacePath(path: string) {
      if (service.validateThrows) throw service.validateThrows;
      service.validated = path;
      return { valid: true, path };
    },
  },
}));

const handlerFor = (method: string, path: string) => {
  const layer = (router as any).stack.find(
    (entry: any) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer) throw new Error(`${method} ${path} is not registered`);
  return layer.route.stack.at(-1).handle as (req: any, res: any, next: any) => Promise<unknown>;
};

function fakeRes() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
    headers: {} as Record<string, string>,
    chunks: [] as unknown[],
    ended: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string) {
      res.headers[name] = value;
    },
    write(chunk: unknown) {
      res.chunks.push(chunk);
    },
    end() {
      res.ended = true;
    },
    on() {
      return res;
    },
  };
  return res;
}

function fakeReq(over: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    query: {},
    headers: { host: "prism.local" },
    protocol: "http",
    setTimeout() {},
    socket: { setTimeout() {} },
    on() {},
    get: () => "prism.local",
    ...over,
  };
}

const invoke = async (method: string, path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(method, path)(req, res, (error: unknown) => errors.push(error));
  return { res, errors };
};

const jsonResponse = (payload: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  headers: { get: () => null },
  body: null,
});

const downloadResponse = (chunks: Uint8Array[], headers: Record<string, string> = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({}),
  headers: { get: (name: string) => headers[name] ?? null },
  body: {
    getReader() {
      let index = 0;
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
      };
    },
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  service.updateThrows = null;
  service.validateThrows = null;
});

describe("GET /workspaces — list with disambiguated names", () => {
  it("qualifies duplicate names by hostname, agent name or parent directory", async () => {
    service.roots = ["/home/lazy/sun", "/mnt/sun", "/opt/sun", "/", "/solo/alpha"];
    service.staticRoots = ["/home/lazy/sun"];
    vi.stubGlobal("fetch", async () =>
      jsonResponse({
        agents: [
          { id: "a1", name: "sun", roots: ["/home/lazy/sun"], hostInfo: { hostname: "builder", platform: "linux", arch: "x64" }, clientIp: "10.0.0.5" },
          { id: "a2", name: "agent-two", roots: ["/mnt/sun"] },
          { id: "a3", name: "sun", roots: ["/opt/sun"] },
        ],
      }),
    );

    const { res, errors } = await invoke("get", "/", fakeReq());
    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);

    const byPath = Object.fromEntries(res.body.map((workspace: any) => [workspace.path, workspace]));
    expect(byPath["/home/lazy/sun"]).toMatchObject({
      name: "sun (builder)",
      isPinned: true,
      isAgentServed: true,
      agentId: "a1",
      hostname: "builder",
      platform: "linux",
      arch: "x64",
      clientIp: "10.0.0.5",
    });
    expect(byPath["/mnt/sun"]).toMatchObject({ name: "sun (agent-two)", isPinned: false, agentName: "agent-two", hostname: null });
    expect(byPath["/opt/sun"]).toMatchObject({ name: "sun (opt)", isAgentServed: true });
    // "/" has no parent segment, so it keeps its bare name.
    expect(byPath["/"]).toMatchObject({ name: "", isAgentServed: false, agentId: null, clientIp: null });
    // A unique name is left alone.
    expect(byPath["/solo/alpha"].name).toBe("alpha");
  });

  it("lists roots without agent metadata when the config call fails", async () => {
    service.roots = ["/w/one"];
    service.staticRoots = [];
    vi.stubGlobal("fetch", async () => {
      throw new Error("tools-service down");
    });

    const { res } = await invoke("get", "/", fakeReq());
    expect(res.body).toEqual([
      {
        id: "/w/one",
        name: "one",
        path: "/w/one",
        isPinned: false,
        isAgentServed: false,
        agentId: null,
        agentName: null,
        hostname: null,
        platform: null,
        arch: null,
        clientIp: null,
      },
    ]);
  });

  it("ignores a non-ok config response and answers 500 when the root lookup throws", async () => {
    service.roots = ["/w/one"];
    vi.stubGlobal("fetch", async () => jsonResponse({ agents: [{ id: "x", name: "x" }] }, 500));
    const nonOk = await invoke("get", "/", fakeReq());
    expect(nonOk.res.body[0].isAgentServed).toBe(false);

    service.roots = null as unknown as string[];
    const broken = await invoke("get", "/", fakeReq());
    expect(broken.res.statusCode).toBe(500);
    expect(broken.res.body).toEqual({ error: "Failed to retrieve workspace roots" });
  });
});

describe("GET /workspaces/full", () => {
  it("returns workspaces, agents and static roots", async () => {
    service.roots = ["/home/lazy/sun", "/mnt/sun"];
    service.staticRoots = ["/home/lazy/sun"];
    const agents = [
      { id: "a1", name: "sun", roots: ["/home/lazy/sun"], hostInfo: { hostname: "builder" } },
      { id: "a2", name: "second", roots: ["/mnt/sun"] },
    ];
    vi.stubGlobal("fetch", async () => jsonResponse({ agents }));

    const { res } = await invoke("get", "/full", fakeReq());
    expect(res.body.agents).toEqual(agents);
    expect(res.body.staticRoots).toEqual(["/home/lazy/sun"]);
    expect(res.body.workspaces.map((workspace: any) => workspace.name)).toEqual([
      "sun (builder)",
      "sun (second)",
    ]);
  });

  it("returns roots only when the config fetch fails", async () => {
    service.roots = ["/w/one"];
    service.staticRoots = [];
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });

    const { res } = await invoke("get", "/full", fakeReq());
    expect(res.body.agents).toEqual([]);
    expect(res.body.workspaces[0].name).toBe("one");
  });
});

describe("PUT /workspaces and POST /workspaces/validate", () => {
  it("rejects an invalid roots payload before calling tools-service", async () => {
    const put = await invoke("put", "/", fakeReq({ body: { roots: "nope" } }));
    expect(put.res.statusCode).toBe(400);
    expect(put.res.body.error).toContain("roots:");

    const validate = await invoke("post", "/validate", fakeReq({ body: {} }));
    expect(validate.res.statusCode).toBe(400);
    expect(validate.res.body.error).toContain("path:");
  });

  it("forwards valid payloads and reports the service result", async () => {
    const put = await invoke("put", "/", fakeReq({ body: { roots: ["/a", "/b"] } }));
    expect(put.res.body).toEqual({ roots: ["/a", "/b"], updated: true });
    expect(service.updated).toEqual(["/a", "/b"]);

    const validate = await invoke("post", "/validate", fakeReq({ body: { path: "/a" } }));
    expect(validate.res.body).toEqual({ valid: true, path: "/a" });
    expect(service.validated).toBe("/a");
  });

  it("answers 500 when the service throws", async () => {
    service.updateThrows = new Error("write failed");
    const put = await invoke("put", "/", fakeReq({ body: { roots: ["/a"] } }));
    expect(put.res.statusCode).toBe(500);
    expect(put.res.body).toEqual({ error: "Failed to update workspace roots" });

    service.validateThrows = new Error("stat failed");
    const validate = await invoke("post", "/validate", fakeReq({ body: { path: "/a" } }));
    expect(validate.res.statusCode).toBe(500);
    expect(validate.res.body).toEqual({ error: "Failed to validate workspace path" });
  });
});

describe("GET /workspaces/tree", () => {
  it("requires a path query parameter", async () => {
    const { res } = await invoke("get", "/tree", fakeReq({ query: {} }));
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "'path' query parameter is required" });
  });

  it("passes path and depth to tools-service and returns its payload", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return jsonResponse({ tree: ["src"], path: "/w" });
    });

    const { res } = await invoke("get", "/tree", fakeReq({ query: { path: "/w", maxDepth: "5" } }));
    expect(res.body).toEqual({ tree: ["src"], path: "/w" });
    expect(calls[0].body).toEqual({ path: "/w", maxDepth: 5 });

    const defaulted = await invoke("get", "/tree", fakeReq({ query: { path: "/w" } }));
    expect(defaulted.res.body).toEqual({ tree: ["src"], path: "/w" });
    expect(calls[1].body.maxDepth).toBe(3);
  });

  it("relays upstream errors, falling back to the status message", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "no such agent" }, 404));
    const withError = await invoke("get", "/tree", fakeReq({ query: { path: "/w" } }));
    expect(withError.res.statusCode).toBe(404);
    expect(withError.res.body).toEqual({ error: "no such agent" });

    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 503,
      json: async () => {
        throw new Error("not json");
      },
      headers: { get: () => null },
      body: null,
    }));
    const withoutError = await invoke("get", "/tree", fakeReq({ query: { path: "/w" } }));
    expect(withoutError.res.statusCode).toBe(503);
    expect(withoutError.res.body).toEqual({ error: "tools-service returned 503" });
  });

  it("answers 504 for a timeout and 500 for other failures", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", async () => {
      throw timeout;
    });
    const slow = await invoke("get", "/tree", fakeReq({ query: { path: "/w" } }));
    expect(slow.res.statusCode).toBe(504);
    expect(slow.res.body.error).toContain("timed out");

    vi.stubGlobal("fetch", async () => {
      throw new Error("socket closed");
    });
    const failed = await invoke("get", "/tree", fakeReq({ query: { path: "/w" } }));
    expect(failed.res.statusCode).toBe(500);
    expect(failed.res.body.error).toContain("socket closed");
  });
});

describe("GET /workspaces/download/agent", () => {
  it("streams the agent file with its upstream headers", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      const headers = url.includes("platform=")
        ? { "Content-Type": "text/javascript", "Content-Disposition": 'attachment; filename="agent.mjs"', "Content-Length": "3" }
        : {};
      return downloadResponse([new Uint8Array([1, 2]), new Uint8Array([3])], headers);
    });

    const { res } = await invoke("get", "/download/agent", fakeReq({ query: { platform: "linux-x64" } }));
    expect(calls[0]).toContain("platform=linux-x64");
    expect(res.headers["Content-Type"]).toBe("text/javascript");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="agent.mjs"');
    expect(res.headers["Content-Length"]).toBe("3");
    expect(res.headers["Cache-Control"]).toBe("public, max-age=300");
    expect(res.chunks).toHaveLength(2);
    expect(res.ended).toBe(true);

    const bare = await invoke("get", "/download/agent", fakeReq({ query: {} }));
    expect(calls[1]).not.toContain("platform=");
    expect(bare.res.headers["Content-Type"]).toBe("application/octet-stream");
    expect(bare.res.headers["Content-Disposition"]).toBe('attachment; filename="workspace-agent.mjs"');
    expect(bare.res.headers["Content-Length"]).toBeUndefined();
  });

  it("relays upstream errors and rejects an empty body", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "gone" }, 410));
    const relayed = await invoke("get", "/download/agent", fakeReq({ query: {} }));
    expect(relayed.res.statusCode).toBe(410);
    expect(relayed.res.body).toEqual({ error: "gone" });

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: () => null },
      body: null,
    }));
    const empty = await invoke("get", "/download/agent", fakeReq({ query: {} }));
    expect(empty.res.statusCode).toBe(502);
    expect(empty.res.body).toEqual({ error: "Empty response from tools-service" });
  });

  it("answers 502 when the download request throws", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection reset");
    });
    const { res } = await invoke("get", "/download/agent", fakeReq({ query: {} }));
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "Failed to download workspace agent from tools-service" });
  });
});

describe("GET /workspaces/download/tray-app", () => {
  it("requires a platform parameter", async () => {
    const { res } = await invoke("get", "/download/tray-app", fakeReq({ query: {} }));
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("Missing 'platform' query parameter");
  });

  it("streams the installer and derives the default filename from the platform", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return downloadResponse([new Uint8Array([9])], { "Content-Type": "application/octet-stream" });
    });

    const { res } = await invoke("get", "/download/tray-app", fakeReq({ query: { platform: "win-x64" } }));
    expect(calls[0]).toContain("platform=win-x64");
    expect(res.headers["Content-Disposition"]).toBe('attachment; filename="prism-workspace-agent-win-x64"');
    expect(res.chunks).toHaveLength(1);
    expect(res.ended).toBe(true);
  });

  it("relays upstream errors, rejects an empty body and reports fetch failures", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ error: "no installer" }, 404));
    const relayed = await invoke("get", "/download/tray-app", fakeReq({ query: { platform: "linux-x64" } }));
    expect(relayed.res.statusCode).toBe(404);
    expect(relayed.res.body).toEqual({ error: "no installer" });

    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
      headers: { get: () => null },
      body: null,
    }));
    const empty = await invoke("get", "/download/tray-app", fakeReq({ query: { platform: "linux-x64" } }));
    expect(empty.res.statusCode).toBe(502);

    vi.stubGlobal("fetch", async () => {
      throw new Error("boom");
    });
    const failed = await invoke("get", "/download/tray-app", fakeReq({ query: { platform: "linux-x64" } }));
    expect(failed.res.statusCode).toBe(502);
    expect(failed.res.body).toEqual({ error: "Failed to download tray app installer from tools-service" });
  });
});
