/**
 * ConfigRoutes — catalog assembly, arena-score enrichment, persona tool
 * resolution, tool listing and system-prompt preview.
 *
 * Every service boundary (settings, personas, tool schemas, local provider
 * discovery, MinIO, prompt assembler) is a stand-in; assertions are on the
 * JSON the client receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import router, { localConfigRouter } from "../ConfigRoutes.ts";

const stub = vi.hoisted(() => ({
  settings: { topology: "core" } as Record<string, unknown> | null,
  personas: {} as Record<string, any>,
  personaList: [] as Array<{ id: string; name: string; custom?: boolean }>,
  toolSchemas: [] as Array<Record<string, unknown>>,
  clientSchemas: [] as Array<Record<string, unknown>>,
  refreshResult: 5 as number | Error,
  localModels: {} as Record<string, Array<Record<string, unknown>>>,
  localModelsError: null as Error | null,
  bucketUrl: null as string | null,
  promptResult: {} as Record<string, unknown>,
  promptError: null as Error | null,
  rateLimits: {} as Record<string, unknown>,
}));

vi.mock("../../providers/instance-registry.ts", () => ({
  listInstances: () => [
    { id: "vllm", type: "vllm", instanceNumber: 1, concurrency: 2, nickname: "spark" },
    { id: "ollama", type: "ollama", instanceNumber: 1, concurrency: 1, nickname: undefined },
  ],
}));

vi.mock("../../services/ToolOrchestratorService.ts", () => ({
  default: {
    async ensureSchemas() {},
    getToolSchemas: () => stub.toolSchemas,
    getClientToolSchemas: () => stub.clientSchemas,
    async refreshSchemas() {
      if (stub.refreshResult instanceof Error) throw stub.refreshResult;
      return stub.refreshResult;
    },
  },
}));

vi.mock("../../services/AgentPersonaRegistry.ts", () => ({
  default: {
    list: () => stub.personaList,
    get: (id: string) => stub.personas[id] ?? null,
  },
}));

vi.mock("../../services/SettingsService.ts", () => ({
  default: { async getSection() { return stub.settings; } },
}));

vi.mock("../../services/system-prompt/index.ts", () => ({
  default: class SystemPromptAssembler {
    constructor(public options: Record<string, unknown>) {}
    async assemble() {
      if (stub.promptError) throw stub.promptError;
      return stub.promptResult;
    }
  },
}));

vi.mock("../../services/PromptLocaleService.ts", () => ({
  default: {
    getAvailableLocales: () => ["en", "es", "xx"],
    getDefaultLocale: () => "en",
  },
}));

vi.mock("../../services/RateLimitStore.ts", () => ({
  default: { getAll: () => stub.rateLimits },
}));

vi.mock("../../wrappers/MinioWrapper.ts", () => ({
  default: { getBucketUrl: () => stub.bucketUrl },
}));

vi.mock("../../services/local-provider/index.ts", () => ({
  default: {
    async discoverModels() {
      if (stub.localModelsError) throw stub.localModelsError;
      return stub.localModels;
    },
  },
}));

vi.mock("../../services/local-provider/constants.ts", () => ({
  THINKING_PATTERNS: [{ pattern: "think", tag: "thinking" }],
}));

vi.mock("../../services/OrchestratorPrompt.ts", () => ({
  ORCHESTRATOR_ONLY_TOOLS: ["create_subagent"],
}));

vi.mock("../../utils/resolveToolEntriesToSet.ts", () => ({
  resolveToolEntriesToSet: (entries: string[]) =>
    new Set(entries.map((entry) => entry.replace(/^domain(Key)?:/, "tool:"))),
}));

const handlerFor = (target: any, method: string, path: string) => {
  const layer = target.stack.find(
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
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      res.headersSent = true;
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
    project: null,
    username: undefined,
    ...over,
  };
}

const invoke = async (target: any, method: string, path: string, req: any) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(target, method, path)(req, res, (error: unknown) => errors.push(error));
  return { res, errors };
};

const toolSchema = (name: string, extra: Record<string, unknown> = {}) => ({ name, ...extra });

beforeEach(() => {
  stub.settings = { topology: "core" };
  stub.personas = {};
  stub.personaList = [];
  stub.toolSchemas = [];
  stub.clientSchemas = [];
  stub.refreshResult = 5;
  stub.localModels = {};
  stub.localModelsError = null;
  stub.bucketUrl = null;
  stub.promptResult = {};
  stub.promptError = null;
  stub.rateLimits = {};
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /config", () => {
  it("returns the catalog with only the available providers", async () => {
    stub.toolSchemas = [toolSchema("get_weather"), { function: { name: "search_web" } }, { name: 7 }];
    const { res, errors } = await invoke(router, "get", "/", fakeReq());

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(res.body.fileBaseUrl).toBeNull();
    expect(res.body.providers).toEqual({ VLLM: "vllm", OLLAMA: "ollama" });
    expect(res.body.providerList).toEqual(["vllm", "ollama"]);
    expect(res.body.localProviders).toEqual([
      { id: "vllm", type: "vllm", instanceNumber: 1, concurrency: 2, nickname: "spark" },
      { id: "ollama", type: "ollama", instanceNumber: 1, concurrency: 1, nickname: undefined },
    ]);
    expect(res.body.thinkingPatterns).toEqual([{ pattern: "think", tag: "thinking" }]);
    // Tool names are de-prefixed and humanised, non-string entries dropped.
    expect(res.body.fcSystemPrompt).toContain("weather, search web");
    expect(res.body.textToText.models).toEqual({});
    expect(res.body.textToText.defaults).toEqual({});
    expect(res.body.textToText.recommendedDefault).toBeNull();
    expect(res.body.textToText.recommendedAgenticDefault).toBeNull();
    expect(res.body.textToSpeech.models).toEqual({});
    expect(res.body.parameterDescriptors).toBeDefined();
  });

  it("uses the generic tool sentence when no schemas are loaded", async () => {
    stub.toolSchemas = [];
    stub.bucketUrl = "http://minio/bucket";
    const { res } = await invoke(router, "get", "/", fakeReq());

    expect(res.body.fcSystemPrompt).toContain("general web search and computation");
    expect(res.body.fileBaseUrl).toBe("http://minio/bucket");
  });

  it("merges discovered local models and enriches them with arena scores", async () => {
    stub.localModels = {
      vllm: [
        { name: "claude-opus-4-7", label: "Opus" },
        { name: "google/gemma-3-12b", label: "Gemma" },
        { name: "claude-opus-4-7@q4_k_m", label: "Opus quantised" },
        { name: "totally-unknown-model", label: "Unknown" },
      ],
    };
    const { res } = await invoke(router, "get", "/", fakeReq({ query: { includeLocal: "true" } }));

    const models = res.body.textToText.models.vllm;
    expect(models.map((model: any) => model.name)).toEqual([
      "claude-opus-4-7",
      "google/gemma-3-12b",
      "claude-opus-4-7@q4_k_m",
      "totally-unknown-model",
    ]);
    expect(typeof models[0].arena.text).toBe("number");
    // Path prefix and quantisation suffix are stripped before the lookup.
    expect(typeof models[1].arena.text).toBe("number");
    expect(typeof models[2].arena.text).toBe("number");
    // Nothing matches this name, so no arena block is attached.
    expect(models[3].arena).toBeUndefined();
  });

  it("falls back to cloud-only when local discovery fails", async () => {
    stub.localModelsError = new Error("vllm offline");
    const { res } = await invoke(router, "get", "/", fakeReq({ query: { includeLocal: "true" } }));

    expect(res.statusCode).toBe(200);
    expect(res.body.textToText.models).toEqual({});
  });
});

describe("localConfigRouter GET /config-local", () => {
  it("returns discovered models with arena enrichment", async () => {
    stub.localModels = { ollama: [{ name: "claude-fable-5", label: "Fable" }] };
    const { res } = await invoke(localConfigRouter, "get", "/", fakeReq());

    expect(res.body.models.ollama[0].name).toBe("claude-fable-5");
    expect(typeof res.body.models.ollama[0].arena.text).toBe("number");
  });
});

describe("GET /config/agents — persona tool resolution", () => {
  const personas = {
    WILD: {
      description: "does everything",
      icon: "i",
      avatar: "a.png",
      color: "#fff",
      backgroundImage: "bg.png",
      project: "p",
      availableTools: ["*"],
      enabledByDefaultTools: ["*"],
      coreToolsLocked: true,
      usesDirectoryTree: true,
      usesCodingGuidelines: true,
    },
    DOMAIN: {
      availableTools: ["domain:web", "tool-a"],
      blockedTools: ["sys_one", "domain:blocked"],
      enabledByDefaultTools: ["domain:default"],
      coreToolsLocked: true,
    },
    PROTECT: {
      availableTools: ["sys_one"],
      blockedTools: ["sys_one"],
      coreToolsLocked: true,
    },
    NOLOCK: { availableTools: ["tool-a"], coreToolsLocked: false },
  };

  beforeEach(() => {
    stub.personas = personas;
    stub.personaList = [
      { id: "WILD", name: "Wild", custom: true },
      { id: "DOMAIN", name: "Domain" },
      { id: "PROTECT", name: "Protect" },
      { id: "NOLOCK", name: "NoLock" },
      { id: "GHOST", name: "Ghost" },
    ];
    stub.clientSchemas = [
      { name: "sys_one", system: true },
      { name: "tool-a" },
      { name: "plain_one" },
      { name: "tool:blocked" },
    ];
  });

  it("resolves wildcard, prefixed, blocked and unlocked tool sets", async () => {
    const { res, errors } = await invoke(router, "get", "/agents", fakeReq());
    expect(errors).toEqual([]);
    const byId = Object.fromEntries(res.body.map((agent: any) => [agent.id, agent]));

    expect(byId.WILD).toMatchObject({
      name: "Wild",
      description: "does everything",
      custom: true,
      icon: "i",
      avatar: "a.png",
      color: "#fff",
      backgroundImage: "bg.png",
      project: "p",
      toolCount: -1,
      enabledToolNames: ["*"],
      enabledByDefaultToolNames: ["*"],
      coreToolsLocked: true,
      canSpawnSubAgents: true,
      usesDirectoryTree: true,
      usesCodingGuidelines: true,
    });

    // "sys_one" is denied by blockedTools and not in the enabled set, so the
    // core bypass loses it; "tool-a" survives the denylist.
    expect(byId.DOMAIN).toMatchObject({
      toolCount: 2,
      enabledToolNames: ["tool:web", "tool-a"],
      enabledByDefaultToolNames: ["tool:default"],
      description: "",
      custom: false,
    });

    // A denied tool that the persona explicitly enabled is kept.
    expect(byId.PROTECT).toMatchObject({ toolCount: 1, enabledToolNames: ["sys_one"] });

    // coreToolsLocked: false means no core bypass is added.
    expect(byId.NOLOCK).toMatchObject({
      toolCount: 1,
      enabledToolNames: ["tool-a"],
      enabledByDefaultToolNames: ["tool-a"],
      coreToolsLocked: false,
    });

    // An unknown persona falls back to core-only defaults.
    expect(byId.GHOST).toMatchObject({ toolCount: 1, enabledToolNames: ["sys_one"], coreToolsLocked: true });
  });
});

describe("GET /config/tools", () => {
  beforeEach(() => {
    stub.toolSchemas = [
      { name: "sys_one", system: true },
      { name: "tool-a" },
      { name: "plain_one" },
      { name: "tool:blocked" },
    ];
    stub.clientSchemas = stub.toolSchemas;
  });

  it("returns every schema without an agent filter", async () => {
    const { res } = await invoke(router, "get", "/tools", fakeReq());
    expect(res.body).toEqual(stub.toolSchemas);
  });

  it("returns every schema for a wildcard persona or an unknown agent", async () => {
    stub.personas = { WILD: { availableTools: ["*"] } };
    const wildcard = await invoke(router, "get", "/tools", fakeReq({ query: { agent: "WILD" } }));
    expect(wildcard.res.body).toEqual(stub.toolSchemas);

    const unknown = await invoke(router, "get", "/tools", fakeReq({ query: { agent: "NOPE" } }));
    expect(unknown.res.body).toEqual(stub.toolSchemas);
  });

  it("filters by enabled tools, core bypass and the blockedTools denylist", async () => {
    stub.personas = {
      DOMAIN: { availableTools: ["domain:web", "tool-a"], blockedTools: ["sys_one", "domain:blocked"], coreToolsLocked: true },
      UNLOCKED: { availableTools: ["tool-a"], blockedTools: ["sys_one"], coreToolsLocked: false },
    };
    const domain = await invoke(router, "get", "/tools", fakeReq({ query: { agent: "DOMAIN" } }));
    expect(domain.res.body.map((tool: any) => tool.name)).toEqual(["tool-a"]);

    const unlocked = await invoke(router, "get", "/tools", fakeReq({ query: { agent: "UNLOCKED" } }));
    expect(unlocked.res.body.map((tool: any) => tool.name)).toEqual(["tool-a"]);
  });
});

describe("POST /config/system-prompt-preview", () => {
  beforeEach(() => {
    stub.toolSchemas = [{ name: "tool-a" }, { name: "plain_one" }];
    stub.clientSchemas = stub.toolSchemas;
  });

  it("assembles every section into the preview", async () => {
    stub.promptResult = { prompt: "BASE", skillsText: "SKILLS", memoriesText: "MEM", workflowsText: "WF" };
    const { res, errors } = await invoke(router, "post", "/system-prompt-preview", fakeReq({
      body: { agent: "CODING", disabledTools: ["plain_one"], workspaceEnabled: false, systemPrompt: "USER", locale: "es" },
    }));

    expect(errors).toEqual([]);
    const prompt = "BASE\n\n## User System Instruction\nUSER\n\nSKILLS\n\nMEM\n\nWF";
    expect(res.body).toEqual({
      prompt,
      characterCount: prompt.length,
      estimatedTokens: Math.ceil(prompt.length / 4),
    });
  });

  it("returns an empty preview when the assembler yields nothing", async () => {
    stub.promptResult = {};
    const { res } = await invoke(router, "post", "/system-prompt-preview", fakeReq({ body: {} }));
    expect(res.body).toEqual({ prompt: "", characterCount: 0, estimatedTokens: 0 });
  });

  it("falls back to the settings locale and then the service default", async () => {
    stub.settings = { topology: "core", locale: "de" };
    const fromSettings = await invoke(router, "post", "/system-prompt-preview", fakeReq({ body: {} }));
    expect(fromSettings.res.statusCode).toBe(200);

    stub.settings = null;
    const fromDefault = await invoke(router, "post", "/system-prompt-preview", fakeReq({ body: {} }));
    expect(fromDefault.res.statusCode).toBe(200);
  });

  it("answers 500 with the assembler error message", async () => {
    stub.promptError = new Error("assembler exploded");
    const { res } = await invoke(router, "post", "/system-prompt-preview", fakeReq({ body: {} }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "assembler exploded" });
  });
});

describe("tool refresh, rate limits and locales", () => {
  it("reports the refreshed schema count", async () => {
    const { res } = await invoke(router, "post", "/tools/refresh", fakeReq());
    expect(res.body).toEqual({ ok: true, count: 5 });
  });

  it("answers 500 when the refresh throws", async () => {
    stub.refreshResult = new Error("tools-api unreachable");
    const { res } = await invoke(router, "post", "/tools/refresh", fakeReq());
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "tools-api unreachable" });
  });

  it("returns the rate-limit snapshots", async () => {
    stub.rateLimits = { openai: { remaining: 10 } };
    const { res } = await invoke(router, "get", "/rate-limits", fakeReq());
    expect(res.body).toEqual({ openai: { remaining: 10 } });
  });

  it("labels known locales and uppercases unknown codes", async () => {
    const { res } = await invoke(router, "get", "/locales", fakeReq());
    expect(res.body).toEqual([
      { value: "en", label: "English" },
      { value: "es", label: "Español" },
      { value: "xx", label: "XX" },
    ]);
  });
});
