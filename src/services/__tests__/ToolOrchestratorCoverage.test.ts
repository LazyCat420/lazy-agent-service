/**
 * ToolOrchestratorService — coverage of tool dispatch, the streaming executor,
 * the image/screenshot post-processing and the orchestrator-tool bridge.
 * tools-api, MinIO/FileService, MCP and settings are fakes; the service is real
 * and assertions read the dispatched request bodies or the returned results.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConfigModule from "../../../config.ts";

const fakes = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  extractKey: vi.fn(),
  getFile: vi.fn(),
}));

vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Promise<typeof ConfigModule>>()),
  TOOLS_SERVICE_URL: "http://tools.test",
}));
vi.mock("../MCPClientService.ts", () => ({
  default: {
    getConnectedClients: vi.fn().mockReturnValue([]),
    getAllToolSchemas: vi.fn().mockReturnValue([]),
    getToolSchemas: vi.fn().mockReturnValue([]),
    parseMCPToolName: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
  },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: { get: vi.fn().mockReturnValue(null), list: vi.fn().mockReturnValue([]) },
}));
vi.mock("../local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getClientSchemas: vi.fn().mockReturnValue([]),
    getAISchemas: vi.fn().mockReturnValue([]),
    getSchemas: vi.fn().mockReturnValue([]),
  },
}));
vi.mock("../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }),
    getCached: vi.fn().mockReturnValue({
      agents: { locale: "en", topology: "hierarchical" },
      creative: {},
    }),
  },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));
vi.mock("../RequestLogger.ts", () => ({ default: { logRequest: vi.fn() } }));
vi.mock("../FileService.ts", () => ({
  default: {
    uploadFile: fakes.uploadFile,
    extractKey: fakes.extractKey,
    getFile: fakes.getFile,
  },
}));

import ToolOrchestratorService from "../ToolOrchestratorService.ts";

const strictParameters = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: [],
});

const SCHEMAS = [
  {
    name: "evaluate_expression",
    description: "Arithmetic",
    parameters: strictParameters({
      a: { type: "string" },
      b: { type: "string" },
    }),
    endpoint: { path: "/utility/calculate", method: "GET", queryParams: ["a", "b"] },
    domain: "Utility",
    dataSource: "local",
  },
  {
    name: "write_file",
    description: "Write a file",
    parameters: strictParameters({ path: { type: "string" }, content: { type: "string" } }),
    endpoint: { path: "/agentic/files/write", method: "POST" },
    domain: "Core",
    dataSource: "local",
  },
  {
    name: "search_events",
    description: "Search events",
    parameters: strictParameters({ query: { type: "string" } }),
    endpoint: { path: "/events/search", method: "GET", queryParams: ["q"] },
    domain: "Utility",
    dataSource: "local",
  },
  {
    name: "generate_image",
    description: "Generate an image",
    parameters: strictParameters({ prompt: { type: "string" } }),
    endpoint: { path: "/image/generate", method: "POST" },
    domain: "Creative",
    dataSource: "local",
  },
  {
    name: "control_browser",
    description: "Drive a browser",
    parameters: strictParameters({ action: { type: "string" } }),
    endpoint: { path: "/browser/action", method: "POST" },
    domain: "Web",
    dataSource: "local",
  },
  {
    name: "convert_image_to_ascii",
    description: "ASCII art",
    parameters: strictParameters({ input: { type: "string" } }),
    endpoint: { path: "/utility/image/ascii", method: "POST" },
    domain: "Utility",
    dataSource: "local",
  },
  {
    name: "create_3d_model",
    description: "3D model",
    parameters: strictParameters({ prompt: { type: "string" } }),
    endpoint: { path: "/3d/model", method: "POST" },
    domain: "Creative",
    dataSource: "local",
  },
  {
    name: "create_vector_animation",
    description: "Vector animation",
    parameters: strictParameters({ prompt: { type: "string" } }),
    endpoint: { path: "/vector/animate", method: "POST" },
    domain: "Creative",
    dataSource: "local",
  },
];

type RecordedRequest = { url: string; init: RequestInit };

const requests: RecordedRequest[] = [];
let fetchImpl: (url: string, init: RequestInit) => Promise<Response> = async () =>
  Response.json({ ok: true });

beforeEach(() => {
  vi.clearAllMocks();
  requests.length = 0;
  fakes.uploadFile.mockResolvedValue({ ref: "minio://generations/out.png" });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/admin/tool-schemas")) return Response.json(structuredClone(SCHEMAS));
    if (url.endsWith("/admin/config")) {
      return Response.json({ workspaceRoots: ["/workspace"], staticRoots: ["/static"] });
    }
    return fetchImpl(url, init);
  });
});

/** Populate the tool catalog from the stubbed tools-api. */
async function loadCatalog() {
  ToolOrchestratorService._resetCaches();
  await ToolOrchestratorService.ensureSchemas();
}

describe("executeTool — generic dispatch", () => {
  it("rejects an unknown tool", async () => {
    await loadCatalog();
    const result = await ToolOrchestratorService.executeTool("nope", {}, {});
    expect(result).toEqual({ error: "Unknown tool: nope" });
  });

  it("sends GET query parameters built from the endpoint metadata", async () => {
    await loadCatalog();
    fetchImpl = async () => Response.json({ result: 12 });
    const result = await ToolOrchestratorService.executeTool(
      "evaluate_expression",
      { a: "5", b: "7", unused: "ignored" },
      { project: "proj", username: "alice", agent: "coding", requestId: "req-1", iteration: 2 },
    );

    expect(result).toEqual({ result: 12 });
    expect(requests.at(-1)!.url).toBe("http://tools.test/utility/calculate?a=5&b=7");
    expect(requests.at(-1)!.init.headers).toEqual({
      "X-Project": "proj",
      "X-Username": "alice",
      "X-Agent": "coding",
      "X-Request-Id": "req-1",
      "X-Iteration": "2",
    });
  });

  it("remaps legacy argument names before building the URL", async () => {
    await loadCatalog();
    fetchImpl = async () => Response.json({ events: [] });
    await ToolOrchestratorService.executeTool("search_events", { query: "election" }, {});
    expect(requests.at(-1)!.url).toBe("http://tools.test/events/search?q=election");
  });

  it("posts the arguments with injected session context and rewrites worktree paths", async () => {
    await loadCatalog();
    fetchImpl = async () => Response.json({ written: true });
    ToolOrchestratorService._setWorktree("conv-1", {
      originalRoot: "/workspace",
      worktreePath: "/workspace/.worktrees/wt-a",
    });

    const result = await ToolOrchestratorService.executeTool(
      "write_file",
      {
        path: "/workspace/src/a.ts",
        filePath: "/workspace/b.ts",
        oldPath: "/workspace/c.ts",
        newPath: "/elsewhere/d.ts",
        cwd: "/workspace",
        directory: "/workspace/sub",
        content: "x",
      },
      { agentConversationId: "conv-1", project: "proj", username: "alice", agent: "coding" },
    );

    expect(result).toEqual({ written: true });
    const request = requests.at(-1)!;
    expect(request.url).toBe("http://tools.test/agentic/files/write");
    expect(request.init.method).toBe("POST");
    expect(JSON.parse(String(request.init.body))).toEqual({
      path: "/workspace/.worktrees/wt-a/src/a.ts",
      filePath: "/workspace/.worktrees/wt-a/b.ts",
      oldPath: "/workspace/.worktrees/wt-a/c.ts",
      newPath: "/elsewhere/d.ts",
      cwd: "/workspace/.worktrees/wt-a",
      directory: "/workspace/.worktrees/wt-a/sub",
      content: "x",
      project: "proj",
      agent: "coding",
      username: "alice",
    });
    expect(request.init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Workspace-Override": "/workspace/.worktrees/wt-a",
    });
    ToolOrchestratorService._clearWorktree("conv-1");
  });
});

describe("fetchJsonWithBody — error handling", () => {
  beforeEach(async () => {
    await loadCatalog();
  });

  it("forwards the tools-api error body", async () => {
    fetchImpl = async () => Response.json({ error: "path is outside the workspace" }, { status: 400 });
    const result = await ToolOrchestratorService.executeTool("write_file", { path: "/x" }, {});
    expect(result).toEqual({ error: "path is outside the workspace" });
  });

  it("reports the HTTP status when the error body is not JSON", async () => {
    fetchImpl = async () =>
      new Response("<html>oops</html>", { status: 500, statusText: "Internal Server Error" });
    const result = await ToolOrchestratorService.executeTool("write_file", { path: "/x" }, {});
    expect(result).toEqual({ error: "API returned 500: Internal Server Error" });
  });

  it("reports aborts and unreachable APIs", async () => {
    fetchImpl = async () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    };
    expect(await ToolOrchestratorService.executeTool("write_file", {}, {})).toEqual({
      error: "Tool execution aborted",
    });

    fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9999");
    };
    expect(await ToolOrchestratorService.executeTool("write_file", {}, {})).toEqual({
      error: "Failed to reach API: connect ECONNREFUSED 127.0.0.1:9999",
    });
  });
});

describe("executeTool — conversation image injection", () => {
  beforeEach(async () => {
    await loadCatalog();
  });

  it("attaches HTTP and data-URL reference images to generate_image and drops other refs", async () => {
    fetchImpl = async () => Response.json({ image: { data: "QUJD", mimeType: "image/png" } });
    await ToolOrchestratorService.executeTool(
      "generate_image",
      { prompt: "cat" },
      {
        messages: [
          { role: "user", images: ["https://cdn.test/a.png", "data:image/png;base64,QQ==", 42] },
        ],
      },
    );

    const body = JSON.parse(String(requests.at(-1)!.init.body));
    expect(body).toEqual({
      prompt: "cat",
      referenceImages: ["https://cdn.test/a.png", "data:image/png;base64,QQ=="],
    });
  });

  it("leaves the arguments untouched when the conversation has no usable images", async () => {
    fetchImpl = async () => Response.json({ ok: true });
    await ToolOrchestratorService.executeTool(
      "generate_image",
      { prompt: "cat" },
      { messages: [{ role: "user", images: [42] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ prompt: "cat" });

    await ToolOrchestratorService.executeTool(
      "generate_image",
      { prompt: "dog" },
      { messages: [{ role: "assistant", content: "no images" }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ prompt: "dog" });
  });

  it("injects the first conversation image as 'input' for image utilities", async () => {
    fetchImpl = async () => Response.json({ ascii: "..#" });
    await ToolOrchestratorService.executeTool(
      "convert_image_to_ascii",
      { width: 40 },
      { messages: [{ role: "user", images: ["data:image/png;base64,QQ=="] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({
      width: 40,
      input: "data:image/png;base64,QQ==",
    });

    await ToolOrchestratorService.executeTool(
      "convert_image_to_ascii",
      { width: 40 },
      { messages: [{ role: "user", images: [7] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ width: 40 });
  });

  it("injects the reference texture / vector image for creative tools", async () => {
    fetchImpl = async () => Response.json({ ok: true });
    await ToolOrchestratorService.executeTool(
      "create_3d_model",
      { prompt: "chair" },
      { messages: [{ role: "user", images: ["https://cdn.test/tex.png"] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({
      prompt: "chair",
      referenceTextureUrl: "https://cdn.test/tex.png",
    });

    await ToolOrchestratorService.executeTool(
      "create_vector_animation",
      { prompt: "spin" },
      { messages: [{ role: "user", images: ["data:image/png;base64,QQ=="] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({
      prompt: "spin",
      referenceImageUrl: "data:image/png;base64,QQ==",
    });

    await ToolOrchestratorService.executeTool(
      "create_vector_animation",
      { prompt: "spin" },
      { messages: [{ role: "user", images: ["s3://not-an-image"] }] },
    );
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ prompt: "spin" });
  });
});

describe("executeTool — MinIO post-processing", () => {
  beforeEach(async () => {
    await loadCatalog();
  });

  it("stores generated images and browser screenshots, leaving failures in place", async () => {
    fetchImpl = async () => Response.json({ image: { data: "QUJD", mimeType: "image/webp" } });
    const imageResult = (await ToolOrchestratorService.executeTool("generate_image", {}, {
      project: "proj",
      username: "alice",
    })) as { image: { data: string; minioRef?: string } };

    expect(fakes.uploadFile).toHaveBeenCalledWith(
      "data:image/webp;base64,QUJD",
      "generations",
      "proj",
      "alice",
    );
    expect(imageResult.image.minioRef).toBe("minio://generations/out.png");

    fetchImpl = async () => Response.json({ screenshot: "QUJD", mimeType: "image/jpeg" });
    const browserResult = (await ToolOrchestratorService.executeTool("control_browser", {}, {
      project: "proj",
      username: "alice",
    })) as { screenshot?: string; screenshotRef?: string };

    expect(fakes.uploadFile).toHaveBeenLastCalledWith(
      "data:image/jpeg;base64,QUJD",
      "screenshots",
      "proj",
      "alice",
    );
    expect(browserResult.screenshotRef).toBe("minio://generations/out.png");
    expect(browserResult.screenshot).toBeUndefined();
  });

  it("skips the upload for errored or empty image results", async () => {
    fetchImpl = async () => Response.json({ image: { data: "QUJD" }, error: "moderation" });
    await ToolOrchestratorService.executeTool("generate_image", {}, {});
    expect(fakes.uploadFile).not.toHaveBeenCalled();

    fetchImpl = async () => Response.json({ image: null });
    await ToolOrchestratorService.executeTool("generate_image", {}, {});
    expect(fakes.uploadFile).not.toHaveBeenCalled();
  });
});

describe("executeToolStreaming", () => {
  const sseBody = (lines: string[]) => new Response(lines.join("\n") + "\n");

  it("delegates non-streamable tools to the generic executor", async () => {
    await loadCatalog();
    fetchImpl = async () => Response.json({ result: 3 });
    const result = await ToolOrchestratorService.executeToolStreaming(
      "evaluate_expression",
      { a: "1", b: "2" },
      null,
      {},
    );
    expect(result).toEqual({ result: 3 });
  });

  it("streams stdout/stderr, skips malformed lines and returns the exit summary", async () => {
    const chunks: Array<{ event: string; data: string | null; meta?: Record<string, unknown> }> = [];
    fetchImpl = async () =>
      sseBody([
        'data: {"event":"start","command":"ls"}',
        'data: {"event":"stdout","data":"line one\\n"}',
        "event: ping",
        "data: {not json",
        'data: {"event":"stderr","data":"warning"}',
        'data: {"event":"stdout"}',
        'data: {"event":"exit","success":true,"exitCode":0,"executionTimeMs":42}',
      ]);

    const result = await ToolOrchestratorService.executeToolStreaming(
      "execute_shell",
      { command: "ls" },
      (event, data, meta) => chunks.push({ event, data, meta }),
      { project: "proj", username: "alice", agentConversationId: "conv-1" },
    );

    expect(result).toEqual({
      success: true,
      stdout: "line one\n",
      stderr: "warning",
      exitCode: 0,
      executionTimeMs: 42,
      timedOut: false,
    });
    expect(chunks.map((chunk) => chunk.event)).toEqual(["start", "stdout", "stderr", "stdout", "exit"]);
    expect(chunks[3].data).toBeUndefined();
    expect(chunks[4].data).toBeNull();
    expect(chunks[4].meta).toEqual(result);
    expect(requests.at(-1)!.url).toBe("http://tools.test/compute/shell/stream");
    expect(JSON.parse(String(requests.at(-1)!.init.body))).toEqual({ command: "ls" });
    expect(requests.at(-1)!.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Project": "proj",
      "X-Username": "alice",
      "X-Agent-Conversation-Id": "conv-1",
    });
  });

  it("remaps arguments for streamable tools", async () => {
    fetchImpl = async () =>
      sseBody(['data: {"event":"exit","success":true,"exitCode":0,"executionTimeMs":1}']);
    await ToolOrchestratorService.executeToolStreaming(
      "execute_python",
      { code: "print(1)" },
      null,
      {},
    );
    expect(requests.at(-1)!.url).toBe("http://tools.test/utility/python/stream");
  });

  it("synthesises a failed result when the stream ends without an exit event", async () => {
    fetchImpl = async () => sseBody(['data: {"event":"stdout","data":"partial"}']);
    const partial = await ToolOrchestratorService.executeToolStreaming(
      "execute_javascript",
      {},
      null,
      {},
    );
    expect(partial).toEqual({
      success: false,
      stdout: "partial",
      stderr: "",
      exitCode: null,
      error: "Stream ended without exit event",
    });

    fetchImpl = async () => sseBody([]);
    expect(await ToolOrchestratorService.executeToolStreaming("execute_command", {}, null, {})).toEqual({
      error: "Stream ended without exit event",
    });
  });

  it("reports an HTTP error, an unreadable body and transport failures", async () => {
    fetchImpl = async () => new Response("nope", { status: 502, statusText: "Bad Gateway" });
    expect(await ToolOrchestratorService.executeToolStreaming("execute_shell", {}, null, {})).toEqual({
      error: "API returned 502: Bad Gateway",
    });

    fetchImpl = async () => new Response(null);
    expect(await ToolOrchestratorService.executeToolStreaming("execute_shell", {}, null, {})).toEqual({
      error: "Response body is not readable",
    });

    fetchImpl = async () => {
      throw new Error("socket hang up");
    };
    expect(await ToolOrchestratorService.executeToolStreaming("execute_shell", {}, null, {})).toEqual({
      error: "Streaming failed: socket hang up",
    });
  });

  it("aborts the request when the session signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchImpl = async (_url, init) => {
      if ((init.signal as AbortSignal | undefined)?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return sseBody(['data: {"event":"exit","success":true,"exitCode":0,"executionTimeMs":0}']);
    };
    expect(
      await ToolOrchestratorService.executeToolStreaming("execute_shell", {}, null, {
        signal: controller.signal,
      }),
    ).toEqual({ error: "Streaming failed: aborted" });
  });

  it("propagates a session abort that arrives mid-request and cleans up its listener", async () => {
    const controller = new AbortController();
    fetchImpl = async () => {
      controller.abort();
      return sseBody(['data: {"event":"exit","success":true,"exitCode":0,"executionTimeMs":7}']);
    };
    const result = await ToolOrchestratorService.executeToolStreaming("execute_shell", {}, null, {
      signal: controller.signal,
    });
    expect(result).toMatchObject({ success: true, exitCode: 0 });
    // The abort listener was registered once and removed by the controller's own abort.
    expect(controller.signal).toBeDefined();
  });
});

describe("executeOrchestratorTool", () => {
  it("routes message/stop/output/delete tools to the real orchestrator", { timeout: 30000 }, async () => {
    expect(
      await ToolOrchestratorService.executeTool("send_subagent_message", { to: "agent-x", message: "hi" }, {}),
    ).toEqual({ error: 'Sub-agent "agent-x" not found' });

    expect(await ToolOrchestratorService.executeTool("stop_subagent", { agent_id: "agent-x" }, {})).toEqual({
      error: 'Sub-agent "agent-x" not found',
    });

    expect(await ToolOrchestratorService.executeTool("get_subagent_output", { agent_id: "agent-x" }, {})).toEqual({
      error: 'Sub-agent "agent-x" not found. It may have been cleaned up.',
    });

    expect(
      await ToolOrchestratorService.executeTool("delete_subagents", { teamName: "alpha" }, {}),
    ).toEqual({ name: "alpha", deleted: true, subAgentsAborted: 0 });
  });

  it("rejects orchestrator tool names it does not implement", async () => {
    expect(
      await ToolOrchestratorService.executeTool("resume_subagent", { agent_id: "agent-x" }, {}),
    ).toEqual({ error: "Unknown orchestrator tool: resume_subagent" });
  });
});
