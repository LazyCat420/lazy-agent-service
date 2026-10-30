/**
 * Agentic platform helpers — tool resolution (persona and disabled-tools
 * modes), agentic-loop settings application, live host probing and MCP
 * authentication. Registries, Mongo, the MCP SDK client and transports are
 * fakes; resolution logic runs for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => {
  class FakeClient {
    async connect() {}
    async listTools() {
      return {
        tools: [
          { name: "echo", description: "Echoes", inputSchema: { type: "object" } },
          { name: "ping", description: "Pings", inputSchema: { type: "object" } },
        ],
      };
    }
    async close() {}
  }
  class FakeTransport {
    async close() {}
  }
  return {
    FakeClient,
    FakeTransport,
    getSection: vi.fn(),
    getToolSchemas: vi.fn(),
    getMCPToolSchemas: vi.fn(),
    getClientToolSchemas: vi.fn(),
    ensureSchemas: vi.fn(),
    isTradingRequest: vi.fn(),
    personaGet: vi.fn(),
    toolContextGet: vi.fn(),
    toolContextGetStore: vi.fn(),
    toolContextSet: vi.fn(),
    toolContextEnsureLoaded: vi.fn(),
    startRun: vi.fn(),
    harnessGet: vi.fn(),
    getProvider: vi.fn(),
    getInstancesByType: vi.fn(),
  };
});

vi.mock("../SettingsService.ts", () => ({ default: { getSection: fakes.getSection } }));
vi.mock("../SettingsService.js", () => ({ default: { getSection: fakes.getSection } }));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: fakes.ensureSchemas,
    getToolSchemas: fakes.getToolSchemas,
    getMCPToolSchemas: fakes.getMCPToolSchemas,
    getClientToolSchemas: fakes.getClientToolSchemas,
    isTradingRequest: fakes.isTradingRequest,
  },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: { get: fakes.personaGet },
}));
vi.mock("../ToolContext.ts", () => ({
  default: {
    get: fakes.toolContextGet,
    getStore: fakes.toolContextGetStore,
    set: fakes.toolContextSet,
    ensureLoaded: fakes.toolContextEnsureLoaded,
  },
}));
vi.mock("../platform/trace/HarnessInstrumenter.ts", () => ({
  HarnessInstrumenter: { startRun: fakes.startRun },
}));
vi.mock("../platform/skills/SkillRegistry.ts", () => ({
  SkillRegistry: class {
    discover() {
      return [];
    }
  },
}));
vi.mock("../harnesses/HarnessRegistry.ts", () => ({
  default: { get: fakes.harnessGet },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstancesByType: fakes.getInstancesByType,
}));
vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: () => null, getCollection: () => null },
}));
vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MCP_STDIO_COMMANDS: ["npx"],
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: fakes.FakeClient }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: fakes.FakeTransport,
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: fakes.FakeTransport,
}));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: fakes.FakeTransport,
}));
vi.mock("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class UnauthorizedError extends Error {},
}));

import AgenticToolResolver from "../AgenticToolResolver.ts";
import AgenticLoopService from "../AgenticLoopService.ts";
import { DynamicModelResolver } from "../DynamicModelResolver.ts";
import MCPClientService from "../MCPClientService.ts";

const tool = (name: string, domain?: string) => ({ name, description: name, domain });

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getSection.mockResolvedValue({ topology: "default" });
  fakes.getToolSchemas.mockReturnValue([tool("read_file"), tool("write_file")]);
  fakes.getMCPToolSchemas.mockReturnValue([]);
  fakes.getClientToolSchemas.mockReturnValue([
    tool("read_file", "core_workspace"),
    tool("write_file", "core_workspace"),
    tool("other_tool", "other"),
  ]);
  fakes.ensureSchemas.mockResolvedValue(undefined);
  fakes.isTradingRequest.mockReturnValue(false);
  fakes.toolContextGet.mockReturnValue(undefined);
  fakes.toolContextGetStore.mockReturnValue(new Map());
  fakes.toolContextEnsureLoaded.mockResolvedValue(undefined);
  fakes.startRun.mockReturnValue({
    runManifest: { trace_id: "trace-1", run_id: "run-1" },
    rootSpan: { span_id: "span-1" },
  });
  fakes.personaGet.mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  DynamicModelResolver.setMockStatuses(null);
});

describe("AgenticToolResolver disabled-tools mode", () => {
  it("removes disabled tools from the dynamic catalog when no persona applies", async () => {
    const result = await AgenticToolResolver.resolve({
      options: { disabledTools: ["write_file"] },
    });

    expect(result.resolvedEnabledTools).toEqual(["read_file"]);
    expect(result.finalTools.map((entry) => entry.name)).toEqual(["read_file"]);
  });

  it("expands persona domains and applies the disabled denylist", async () => {
    fakes.personaGet.mockReturnValue({ availableTools: ["domain:core_workspace", "extra"] });

    const result = await AgenticToolResolver.resolve({
      agent: "coding",
      options: { disabledTools: ["write_file"] },
    });

    expect(result.resolvedEnabledTools?.sort()).toEqual(["extra", "read_file"]);
    expect(result.finalTools.map((entry) => entry.name)).toEqual(["read_file"]);
  });

  it("treats a wildcard persona as unrestricted", async () => {
    fakes.personaGet.mockReturnValue({ availableTools: ["*"] });

    const result = await AgenticToolResolver.resolve({
      agent: "coding",
      options: { disabledTools: ["read_file"] },
    });

    expect(result.resolvedEnabledTools).toEqual(["write_file"]);
  });
});

describe("AgenticToolResolver persona tools", () => {
  it("returns null for an unknown persona", async () => {
    const result = await AgenticToolResolver.resolve({ agent: "ghost", options: {} });
    expect(result.resolvedEnabledTools).toBeNull();
    expect(result.finalTools).toHaveLength(2);
  });

  it("uses enabledByDefaultTools for a wildcard persona", async () => {
    fakes.personaGet.mockReturnValue({
      availableTools: ["*"],
      enabledByDefaultTools: ["read_file"],
    });

    const result = await AgenticToolResolver.resolve({ agent: "coding", options: {} });
    expect(result.resolvedEnabledTools).toEqual(["read_file"]);
  });

  it("returns null for a wildcard persona without a default list", async () => {
    fakes.personaGet.mockReturnValue({ availableTools: ["*"] });

    const result = await AgenticToolResolver.resolve({ agent: "coding", options: {} });
    expect(result.resolvedEnabledTools).toBeNull();
  });

  it("uses availableTools when enabledByDefaultTools is a wildcard", async () => {
    fakes.personaGet.mockReturnValue({
      availableTools: ["read_file"],
      enabledByDefaultTools: ["*"],
    });

    const result = await AgenticToolResolver.resolve({ agent: "coding", options: {} });
    expect(result.resolvedEnabledTools).toEqual(["read_file"]);
  });

  it("uses enabledByDefaultTools when both lists are concrete", async () => {
    fakes.personaGet.mockReturnValue({
      availableTools: ["read_file", "write_file"],
      enabledByDefaultTools: ["write_file"],
    });

    const result = await AgenticToolResolver.resolve({ agent: "coding", options: {} });
    expect(result.resolvedEnabledTools).toEqual(["write_file"]);
  });

  it("drops an invalid reasoningEffort value", async () => {
    const options: Record<string, unknown> = { reasoningEffort: "extreme" };

    await AgenticToolResolver.resolve({ options });
    expect(options.reasoningEffort).toBeUndefined();

    const valid: Record<string, unknown> = { reasoningEffort: "high" };
    await AgenticToolResolver.resolve({ options: valid });
    expect(valid.reasoningEffort).toBe("high");
  });
});

describe("AgenticLoopService settings application", () => {
  const baseContext = () => ({
    options: {} as Record<string, unknown>,
    messages: [],
    project: "demo",
    username: "admin",
    agentConversationId: "agent-conv",
    conversationId: "conv",
    runtimeTools: { finalTools: [], resolvedEnabledTools: null },
    providerName: "vllm",
    resolvedModel: "some-model",
  });

  it("copies critic and reminder models from agent settings into options", async () => {
    fakes.getSection.mockResolvedValue({
      harness: "standard",
      topology: "default",
      thoughtStructure: "react",
      criticModel: "critic-x",
      reminderModel: "reminder-y",
      reminderProvider: "vllm-2",
    });
    fakes.harnessGet.mockReturnValue(undefined);
    const context = baseContext();

    await expect(
      AgenticLoopService.runAgenticLoop(context as never),
    ).rejects.toBeDefined();

    expect(context.options.enableCriticGate).toBe(true);
    expect(context.options.criticModel).toBe("critic-x");
    expect(context.options.reminderModel).toBe("reminder-y");
    expect(context.options.reminderProvider).toBe("vllm-2");
  });

  it("keeps explicit critic settings and ignores a null settings section", async () => {
    fakes.getSection.mockResolvedValue(null);
    fakes.harnessGet.mockReturnValue(undefined);
    const context = baseContext();
    context.options = { enableCriticGate: false, criticModel: "explicit" };

    await expect(
      AgenticLoopService.runAgenticLoop(context as never),
    ).rejects.toBeDefined();

    expect(context.options.enableCriticGate).toBe(false);
    expect(context.options.criticModel).toBe("explicit");
    expect(context.options.reminderModel).toBeUndefined();
  });
});

describe("DynamicModelResolver.queryLiveHosts", () => {
  const instances = [
    { id: "vllm", baseUrl: "http://vllm.test", nickname: "Jetson" },
    { id: "vllm-2", baseUrl: "http://vllm2.test", nickname: "Gold Spark" },
  ];

  it("returns stub statuses without probing", async () => {
    DynamicModelResolver.setMockStatuses([
      { instanceId: "vllm", baseUrl: "http://vllm.test", nickname: "Jetson", models: [], online: false },
    ]);

    expect(await DynamicModelResolver.queryLiveHosts()).toHaveLength(1);
    expect(fakes.getInstancesByType).not.toHaveBeenCalled();
  });

  it("normalizes model ids and marks hosts online", async () => {
    fakes.getInstancesByType.mockReturnValue(instances);
    fakes.getProvider.mockImplementation((id: string) =>
      id === "vllm"
        ? { listModels: async () => ({ data: [{ id: "GLM-5.3-Flash-EXL3" }] }) }
        : { listModels: async () => ({ models: [{ key: "org/Qwen3-8B" }] }) },
    );

    const statuses = await DynamicModelResolver.queryLiveHosts(true);

    expect(statuses).toEqual([
      {
        instanceId: "vllm",
        baseUrl: "http://vllm.test",
        nickname: "Jetson",
        models: ["GLM-5.3-Flash-EXL3-TF"],
        online: true,
      },
      {
        instanceId: "vllm-2",
        baseUrl: "http://vllm2.test",
        nickname: "Gold Spark",
        models: ["org/Qwen3-8B"],
        online: true,
      },
    ]);
  });

  it("marks hosts offline when the provider cannot list models or throws", async () => {
    fakes.getInstancesByType.mockReturnValue(instances);
    fakes.getProvider.mockImplementation((id: string) =>
      id === "vllm"
        ? {}
        : {
            listModels: async () => {
              throw new Error("probe failed");
            },
          },
    );

    const statuses = await DynamicModelResolver.queryLiveHosts(true);

    expect(statuses.every((status) => status.online === false)).toBe(true);
    expect(statuses.every((status) => status.models.length === 0)).toBe(true);
  });

  it("serves repeated probes from the cache unless forced", async () => {
    fakes.getInstancesByType.mockReturnValue(instances);
    fakes.getProvider.mockReturnValue({ listModels: async () => ({ data: [{ id: "m" }] }) });

    await DynamicModelResolver.queryLiveHosts(true);
    await DynamicModelResolver.queryLiveHosts();

    expect(fakes.getProvider).toHaveBeenCalledTimes(2);
  });

  it("normalizes the stale GLM model id", () => {
    expect(DynamicModelResolver.normalizeModelId("GLM-5.3-Flash-EXL3")).toBe(
      "GLM-5.3-Flash-EXL3-TF",
    );
    expect(DynamicModelResolver.normalizeModelId("org/GLM-5.3-Flash-EXL3")).toBe(
      "org/GLM-5.3-Flash-EXL3-TF",
    );
    expect(DynamicModelResolver.normalizeModelId("other")).toBe("other");
  });
});

describe("MCPClientService.authenticate", () => {
  it("reports an unknown server", async () => {
    const result = await MCPClientService.authenticate("never-connected");
    expect(result).toEqual({ error: 'MCP server "never-connected" is not connected' });
  });

  it("merges bearer, API-key and custom headers for an HTTP server", async () => {
    await MCPClientService.connect({
      name: "http-srv",
      transport: "streamable-http",
      url: "https://mcp.test/mcp",
      headers: { "X-Existing": "1" },
    });
    const connectSpy = vi
      .spyOn(MCPClientService, "connect")
      .mockResolvedValue({ tools: [{}, {}], serverName: "http-srv", quarantinedTools: [] });

    const result = await MCPClientService.authenticate("http-srv", {
      token: "tok",
      apiKey: "key",
      apiKeyHeader: "X-Custom-Key",
      headers: { "X-Extra": "yes" },
    });

    expect(result).toEqual({
      acknowledged: true,
      serverName: "http-srv",
      toolCount: 2,
      message: 'Successfully authenticated with "http-srv". 2 tools available.',
    });
    const updated = connectSpy.mock.calls[0][0] as { headers: Record<string, string> };
    expect(updated.headers).toEqual({
      "X-Existing": "1",
      Authorization: "Bearer tok",
      "X-Custom-Key": "key",
      "X-Extra": "yes",
    });

    connectSpy.mockRestore();
  });

  it("uses the default API-key header and injects stdio env vars", async () => {
    await MCPClientService.connect({
      name: "stdio-srv",
      transport: "stdio",
      command: "npx",
      args: ["server"],
      env: { EXISTING: "1" },
    });
    const connectSpy = vi
      .spyOn(MCPClientService, "connect")
      .mockResolvedValue({ tools: [{}], serverName: "stdio-srv", quarantinedTools: [] });

    const result = await MCPClientService.authenticate("stdio-srv", {
      token: "tok",
      apiKey: "key",
      env: { EXTRA: "2" },
    });

    expect(result).toMatchObject({ acknowledged: true, toolCount: 1 });
    const updated = connectSpy.mock.calls[0][0] as { env: Record<string, string> };
    expect(updated.env).toEqual({
      EXISTING: "1",
      MCP_AUTH_TOKEN: "tok",
      MCP_API_KEY: "key",
      EXTRA: "2",
    });

    connectSpy.mockRestore();
  });

  it("uses the default X-API-Key header for HTTP servers", async () => {
    await MCPClientService.connect({
      name: "http-default",
      transport: "streamable-http",
      url: "https://mcp.test/mcp",
    });
    const connectSpy = vi
      .spyOn(MCPClientService, "connect")
      .mockResolvedValue({ tools: [{}], serverName: "http-default", quarantinedTools: [] });

    await MCPClientService.authenticate("http-default", { apiKey: "key" });

    const updated = connectSpy.mock.calls[0][0] as { headers: Record<string, string> };
    expect(updated.headers["X-API-Key"]).toBe("key");

    connectSpy.mockRestore();
  });

  it("returns an error when the reconnect fails", async () => {
    await MCPClientService.connect({
      name: "http-fail",
      transport: "streamable-http",
      url: "https://mcp.test/mcp",
    });
    const connectSpy = vi
      .spyOn(MCPClientService, "connect")
      .mockRejectedValue(new Error("upstream down"));

    const result = await MCPClientService.authenticate("http-fail", { token: "t" });

    expect(result).toEqual({
      error: 'Authentication failed for "http-fail": upstream down',
    });

    connectSpy.mockRestore();
  });
});
