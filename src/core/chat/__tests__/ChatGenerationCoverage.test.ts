/**
 * ChatGeneration.ts — request validation, model/instance resolution, the
 * non-streaming dispatch, the Image API dispatch and the agent dispatch.
 *
 * Providers, persistence, logging and the agentic loop are stubs; the
 * assertions are on emitted SSE events and on what the provider received.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgent, handleConversation } from "../ChatGeneration.ts";

const stub = vi.hoisted(() => ({
  modelDefinitions: {} as Record<string, Record<string, unknown> | null>,
  defaultModels: {} as Record<string, string>,
  pricing: {} as Record<string, unknown>,
  agentDefaults: {} as Record<string, unknown>,
  provider: null as Record<string, any> | null,
  providers: {} as Record<string, Record<string, any>>,
  modelLookups: [] as string[],
  providerCalls: [] as Array<{ kind: string; args: unknown[] }>,
  generateResult: {} as Record<string, unknown>,
  generateError: null as Error | null,
  isLocal: false,
  releaseCalls: 0,
  localDefaultsCalls: [] as Array<{ provider: string; options: Record<string, unknown>; client: unknown }>,
  nativeMcp: false,
  instances: {} as Record<string, Array<{ id: string; concurrency: number }>>,
  instanceTypes: {} as Record<string, string | null>,
  instanceModels: {} as Record<string, { models?: Array<Record<string, string>> } | Error>,
  providerLookups: [] as string[],
  usableOverrides: new Map<string, string>(),
  usableInstances: [] as Array<{ id: string; concurrency: number }>,
  queueLoads: {} as Record<string, { totalInflight: number; activeCount: number; pending: number; maxConcurrency: number }>,
  mediaMessages: null as unknown,
  generating: [] as unknown[],
  appended: [] as unknown[],
  finalized: [] as unknown[],
  logged: [] as unknown[],
  chatLogs: [] as unknown[],
  uploads: [] as string[],
  uploadError: null as Error | null,
  tracker: [] as Array<{ kind: string; args: unknown[] }>,
  agentLoop: [] as unknown[],
  agentLoopError: null as Error | null,
  abortCalls: [] as unknown[],
  abortError: null as Error | null,
  settings: null as Record<string, unknown> | null,
  toolSchemas: [] as Array<Record<string, unknown>>,
  persona: null as Record<string, unknown> | null,
  personaKnown: true,
  errors: [] as string[],
  warns: [] as string[],
  finalizeError: null as Error | null,
  dispatched: [] as unknown[],
  dispatchError: null as Error | null,
  streamState: {} as Record<string, any>,
  streamCalls: [] as Array<{ kind: string; args: unknown[] }>,
  streamChunks: [] as unknown[],
  streamReturned: 0,
  appendError: null as Error | null,
}));

vi.mock("../../../providers/index.ts", () => ({
  getProvider: (providerName: string) => {
    stub.providerLookups.push(providerName);
    return stub.providers[providerName] ?? stub.provider;
  },
}));

vi.mock("../../../config.ts", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getModelByName: (model: string) => {
      stub.modelLookups.push(model);
      return stub.modelDefinitions[model] ?? null;
    },
    getDefaultModels: () => stub.defaultModels,
    getPricing: () => stub.pricing,
    getAgentDefaults: () => stub.agentDefaults,
  };
});

vi.mock("../../../services/local-provider/index.ts", () => ({
  default: {
    applyLocalDefaults: (provider: string, options: Record<string, unknown>, client: unknown) => {
      stub.localDefaultsCalls.push({ provider, options, client });
      return options;
    },
    isNativeMCP: () => stub.nativeMcp,
  },
}));

vi.mock("../../../services/LocalModelQueue.ts", () => ({
  default: {
    isLocal: () => stub.isLocal,
    acquire: async () => () => {
      stub.releaseCalls += 1;
    },
    _getQueue: (id: string) =>
      stub.queueLoads[id] ?? { totalInflight: 0, activeCount: 0, pending: 0, maxConcurrency: 1 },
  },
}));

vi.mock("../../../providers/instance-registry.ts", () => ({
  getInstancesByType: (type: string) => stub.instances[type] ?? [],
  getInstanceType: (id: string) => stub.instanceTypes[id] ?? null,
  getInstance: (id: string) =>
    Object.values(stub.instances)
      .flat()
      .find((inst) => inst.id === id) ?? null,
}));

vi.mock("../../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: async () => ({
    usable: stub.usableInstances,
    modelOverrides: stub.usableOverrides,
  }),
}));

vi.mock("../../../services/MediaResolutionService.ts", () => ({
  resolveMessageMediaReferences: async (messages: unknown) => {
    stub.mediaMessages = messages;
    return messages;
  },
}));

vi.mock("../../../services/harnesses/lifecycle/Finalizer.ts", () => ({
  finalizeTextGeneration: async (context: unknown, payload: unknown) => {
    stub.finalized.push({ context, payload });
    if (stub.finalizeError) throw stub.finalizeError;
  },
  getCollectionOpts: (project: string | undefined) => ({ project: project ?? "any" }),
  sanitizeMessagesForPersistence: (messages: unknown) => messages,
}));

vi.mock("../../../utils/ConversationUtilities.ts", () => ({
  markGenerating: (...args: unknown[]) => {
    stub.generating.push(args);
  },
  appendAndFinalize: async (...args: unknown[]) => {
    stub.appended.push(args);
    if (stub.appendError) throw stub.appendError;
  },
}));

vi.mock("../../../services/RequestLogger.ts", () => ({
  default: {
    log: async (entry: unknown) => {
      stub.logged.push(entry);
    },
    logChatGeneration: async (entry: unknown) => {
      stub.chatLogs.push(entry);
    },
  },
}));

vi.mock("../../../services/FileService.ts", () => ({
  default: {
    uploadFile: async (dataUrl: string) => {
      stub.uploads.push(dataUrl);
      if (stub.uploadError) throw stub.uploadError;
      return { ref: `minio://gen/${stub.uploads.length}`, size: 1, contentType: "image/png" };
    },
  },
}));

vi.mock("../../../services/ConversationGenerationTracker.ts", () => ({
  default: {
    register: (...args: unknown[]) => {
      stub.tracker.push({ kind: "register", args });
    },
    update: (...args: unknown[]) => {
      stub.tracker.push({ kind: "update", args });
    },
    complete: (...args: unknown[]) => {
      stub.tracker.push({ kind: "complete", args });
    },
  },
}));

vi.mock("../../../services/AgenticLoopService.ts", () => ({
  default: {
    runAgenticLoop: async (params: unknown) => {
      stub.agentLoop.push(params);
      if (stub.agentLoopError) throw stub.agentLoopError;
    },
  },
}));

vi.mock("../../../services/OrchestratorService.ts", () => ({
  default: {
    abortSubAgentsByConversation: async (id: unknown) => {
      stub.abortCalls.push(id);
      if (stub.abortError) throw stub.abortError;
    },
  },
}));

vi.mock("../../../services/SettingsService.ts", () => ({
  default: {
    getSection: async () => stub.settings,
  },
}));

vi.mock("../../../services/ToolOrchestratorService.ts", () => ({
  default: {
    getToolSchemas: () => stub.toolSchemas,
  },
}));

vi.mock("../../../services/AgentPersonaRegistry.ts", () => ({
  default: {
    has: () => stub.personaKnown,
    get: () => stub.persona,
  },
}));

vi.mock("../../../utils/StreamChunkDispatcher.ts", () => ({
  createStreamState: () => stub.streamState,
  dispatchChunk: async (chunk: Record<string, unknown>, state: Record<string, any>) => {
    stub.dispatched.push(chunk);
    if (chunk.type === "text") {
      state.text += chunk.content as string;
      state.outputCharacters = state.text.length;
    }
    state.firstTokenTime ??= 100;
    state.generationEnd = 200;
    if (stub.dispatchError) throw stub.dispatchError;
  },
}));

vi.mock("../../../utils/logger.ts", () => ({
  default: {
    error: (message: string) => {
      stub.errors.push(message);
    },
    warn: (message: string) => {
      stub.warns.push(message);
    },
    info: () => {},
    request: () => {},
    success: () => {},
  },
}));

const textProvider = (overrides: Record<string, unknown> = {}) => {
  const provider: Record<string, any> = {
    generateText: async (...args: unknown[]) => {
      stub.providerCalls.push({ kind: "generateText", args });
      if (stub.generateError) throw stub.generateError;
      return stub.generateResult;
    },
    ...overrides,
  };
  stub.provider = provider;
  return provider;
};

/** Builds a provider without installing it as the default lookup result. */
const mappedTextProvider = (overrides: Record<string, unknown> = {}) => ({
  generateText: async (...args: unknown[]) => {
    stub.providerCalls.push({ kind: "generateText", args });
    if (stub.generateError) throw stub.generateError;
    return stub.generateResult;
  },
  ...overrides,
});

const imageProvider = (overrides: Record<string, unknown> = {}) => {
  const provider: Record<string, any> = {
    generateImage: async (...args: unknown[]) => {
      stub.providerCalls.push({ kind: "generateImage", args });
      if (stub.generateError) throw stub.generateError;
      return stub.generateResult;
    },
    ...overrides,
  };
  stub.provider = provider;
  return provider;
};

const collect = () => {
  const events: Array<Record<string, any>> = [];
  const emit = (event: Record<string, unknown>) => {
    events.push(event as Record<string, any>);
  };
  return { events, emit };
};

beforeEach(() => {
  stub.modelDefinitions = {};
  stub.defaultModels = {};
  stub.pricing = {};
  stub.agentDefaults = {};
  stub.provider = null;
  stub.providers = {};
  stub.modelLookups = [];
  stub.providerCalls = [];
  stub.generateResult = {};
  stub.generateError = null;
  stub.isLocal = false;
  stub.releaseCalls = 0;
  stub.localDefaultsCalls = [];
  stub.nativeMcp = false;
  stub.instances = {};
  stub.instanceTypes = {};
  stub.instanceModels = {};
  stub.providerLookups = [];
  stub.usableOverrides = new Map();
  stub.usableInstances = [];
  stub.queueLoads = {};
  stub.mediaMessages = null;
  stub.generating = [];
  stub.appended = [];
  stub.finalized = [];
  stub.logged = [];
  stub.chatLogs = [];
  stub.uploads = [];
  stub.uploadError = null;
  stub.tracker = [];
  stub.agentLoop = [];
  stub.agentLoopError = null;
  stub.abortCalls = [];
  stub.abortError = null;
  stub.settings = null;
  stub.toolSchemas = [];
  stub.persona = null;
  stub.personaKnown = true;
  stub.errors = [];
  stub.warns = [];
  stub.finalizeError = null;
  stub.dispatched = [];
  stub.dispatchError = null;
  stub.streamState = {
    requestStart: 0,
    text: "",
    thinking: "",
    images: [],
    toolCalls: [],
    audioChunks: [],
    audioSampleRate: 24000,
    usage: { inputTokens: 1, outputTokens: 2 },
    outputCharacters: 0,
    rateLimits: null,
    firstTokenTime: null,
    generationEnd: null,
    stopReason: null,
  };
  stub.streamCalls = [];
  stub.streamChunks = [];
  stub.streamReturned = 0;
  stub.appendError = null;
});

const baseChat = (overrides: Record<string, unknown> = {}) => ({
  provider: "openai",
  model: "gpt-5.2",
  messages: [{ role: "user", content: "hi" }],
  project: "proj",
  username: "alice",
  ...overrides,
});

describe("handleConversation validation", () => {
  it("reports a missing provider", async () => {
    const { events, emit } = collect();
    await handleConversation({ messages: [] }, emit);
    expect(events).toEqual([{ type: "error", message: "Missing required field: provider", statusCode: 400 }]);
  });

  it("reports a missing messages array", async () => {
    const { events, emit } = collect();
    await handleConversation({ provider: "openai" }, emit);
    expect(events).toEqual([{ type: "error", message: "Missing or invalid field: messages (must be an array)", statusCode: 400 }]);
  });

  it("reports schema issues with their paths", async () => {
    const { events, emit } = collect();
    await handleConversation({ provider: "openai", messages: [{ role: "nope" }] }, emit);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].statusCode).toBe(400);
    expect(events[0].message).toMatch(/^Validation failed: messages\.0\./);
  });

  it("rejects unknown agents", async () => {
    stub.personaKnown = false;
    const { events, emit } = collect();
    await handleConversation(baseChat({ agent: "ghost" }), emit);
    expect(events).toEqual([{ type: "error", message: 'Unknown agent: "ghost"', statusCode: 400 }]);
  });
});

describe("non-streaming text generation", () => {
  it("emits text, thinking, tool calls and uploaded images, then finalises", async () => {
    textProvider();
    stub.generateResult = {
      text: "hello",
      thinking: "hmm",
      toolCalls: [
        { id: "t1", name: "get_weather", args: { city: "Paris" }, thoughtSignature: "sig", durationMs: 5 },
        { name: "no_id" },
      ],
      images: [{ data: "AAAA", mimeType: "image/png" }, { data: "BBBB" }],
      usage: { inputTokens: 3, outputTokens: 4 },
      rateLimits: { rpm: 10 },
    };
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);

    expect(events.map((event) => event.type)).toEqual(["chunk", "thinking", "toolCall", "toolCall", "image", "image"]);
    expect(events[2]).toEqual({ type: "toolCall", id: "t1", name: "get_weather", args: { city: "Paris" }, thoughtSignature: "sig" });
    expect(events[3]).toEqual({ type: "toolCall", id: null, name: "no_id", args: {}, thoughtSignature: undefined });
    expect(events[4]).toEqual({ type: "image", data: "AAAA", mimeType: "image/png", minioRef: "minio://gen/1" });
    expect(events[5]).toEqual({ type: "image", data: "BBBB", mimeType: undefined, minioRef: "minio://gen/2" });
    expect(stub.uploads).toEqual(["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]);

    const { payload } = stub.finalized.at(-1) as { payload: Record<string, any> };
    expect(payload).toMatchObject({
      text: "hello",
      thinking: "hmm",
      images: ["minio://gen/1", "minio://gen/2"],
      audioChunks: [],
      audioSampleRate: 24000,
      usage: { inputTokens: 3, outputTokens: 4 },
      outputCharacters: 5,
      rateLimits: { rpm: 10 },
      resolvedEnabledTools: null,
    });
    expect(payload.toolCalls).toEqual([
      { id: "t1", name: "get_weather", args: { city: "Paris" }, thoughtSignature: "sig", durationMs: 5 },
      { id: null, name: "no_id", args: {}, thoughtSignature: undefined, durationMs: undefined },
    ]);
  });

  it("keeps the data URL when the image upload fails", async () => {
    textProvider();
    stub.uploadError = new Error("minio down");
    stub.generateResult = { text: "ok", images: [{ data: "CCCC", mimeType: "image/jpeg" }] };
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);

    expect(stub.errors).toContain("[chat/non-stream] MinIO upload failed: minio down");
    expect(events.at(-1)).toEqual({ type: "image", data: "CCCC", mimeType: "image/jpeg", minioRef: null });
    expect((stub.finalized.at(-1) as { payload: Record<string, unknown> }).payload.images).toEqual(["data:image/jpeg;base64,CCCC"]);
  });

  it("skips images when the result carries none", async () => {
    textProvider();
    stub.generateResult = { text: "plain" };
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);
    expect(events).toEqual([{ type: "chunk", content: "plain" }]);
    expect((stub.finalized.at(-1) as { payload: Record<string, unknown> }).payload.images).toEqual([]);
  });

  it("generates a conversation id and title from the first user message", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ conversationId: null }), emit);

    const context = (stub.finalized.at(-1) as { context: Record<string, unknown> }).context;
    expect(context.conversationId).toEqual(expect.any(String));
    expect(context.conversationMeta).toEqual({ title: "hi" });
    expect(stub.generating[0]).toEqual([
      context.conversationId,
      "proj",
      "alice",
      true,
      { project: "proj", title: "hi" },
    ]);
  });

  it("skips persistence and titles when skipConversation is set", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ skipConversation: true }), emit);

    const context = (stub.finalized.at(-1) as { context: Record<string, unknown> }).context;
    expect(context.conversationId).toBeNull();
    expect(context.conversationMeta).toBeNull();
  });

  it("folds the trace id into the conversation meta", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ traceId: "tr-1" }), emit);
    const context = (stub.finalized.at(-1) as { context: Record<string, unknown> }).context;
    expect(context.traceId).toBe("tr-1");
    expect(context.conversationMeta).toEqual({ title: "hi", traceId: "tr-1" });

    stub.finalized = [];
    await handleConversation(baseChat({ traceId: "tr-2", skipConversation: true }), emit);
    expect((stub.finalized.at(-1) as { context: Record<string, unknown> }).context.traceId).toBe("tr-2");
  });

  it("uses a fallback title when the user message is empty", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ messages: [{ role: "system", content: "sys" }] }), emit);
    const context = (stub.finalized.at(-1) as { context: Record<string, unknown> }).context;
    expect(context.conversationMeta).toEqual({ title: "New Conversation" });
  });

  it("uses the non-streaming path when the model disables streaming", async () => {
    const stream = vi.fn();
    textProvider({ generateTextStream: stream });
    stub.modelDefinitions["gpt-5.2"] = { streaming: false };
    stub.generateResult = { text: "buffered" };
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);
    expect(stream).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "chunk", content: "buffered" }]);
  });
});

describe("image API models", () => {
  const imageChat = (overrides: Record<string, unknown> = {}) => baseChat({
    model: "gpt-image-1.5",
    conversationId: "conv-1",
    conversationMeta: { title: "Picture" },
    traceId: "tr-9",
    messages: [
      { role: "user", content: "draw a cat", images: ["data:image/png;base64,AAAA"] },
      { role: "assistant", content: "sure", images: ["data:image/png;base64,BBBB"] },
    ],
    ...overrides,
  });

  beforeEach(() => {
    stub.modelDefinitions["gpt-image-1.5"] = {
      imageAPI: true,
      imageTokensPerImage: 1056,
      pricing: { imageOutputPerMillion: 32 },
    };
  });

  it("generates an image, uploads it and persists the turn before done", async () => {
    imageProvider();
    stub.generateResult = { imageData: "IMG", mimeType: "image/webp", text: "here you go" };
    const { events, emit } = collect();
    await handleConversation(imageChat(), emit);

    expect(events.map((event) => event.type)).toEqual(["chunk", "image", "done"]);
    expect(events[1]).toEqual({ type: "image", data: "IMG", mimeType: "image/webp", minioRef: "minio://gen/1" });
    expect(events[2]).toMatchObject({ type: "done", usage: null, traceId: "tr-9", conversationId: "conv-1" });
    expect(events[2].estimatedCost).toBeGreaterThan(0);

    expect(stub.uploads[0]).toBe("data:image/webp;base64,IMG");
    expect(stub.providerCalls[0]).toMatchObject({ kind: "generateImage" });
    expect(stub.providerCalls[0].args.slice(0, 2)).toEqual(["draw a cat", ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"]]);

    const [conversationId, project, username, messagesToAppend, meta] = stub.appended.at(-1) as unknown[];
    expect([conversationId, project, username]).toEqual(["conv-1", "proj", "alice"]);
    expect(messagesToAppend).toHaveLength(2);
    expect(messagesToAppend[0]).toMatchObject({ role: "user", content: "draw a cat" });
    expect(messagesToAppend[1]).toMatchObject({
      role: "assistant",
      content: "here you go",
      images: ["minio://gen/1"],
      model: "gpt-image-1.5",
      provider: "openai",
    });
    expect(meta).toMatchObject({ title: "Picture", settings: { provider: "openai", model: "gpt-image-1.5" } });
    expect(stub.logged.at(-1)).toMatchObject({ operation: "chat:image", success: true, model: "gpt-image-1.5" });
  });

  it("keeps going when the upload fails and omits assistant images", async () => {
    imageProvider();
    stub.uploadError = new Error("bucket down");
    stub.generateResult = { imageData: "IMG", text: "no ref" };
    const { events, emit } = collect();
    await handleConversation(imageChat(), emit);

    expect(stub.errors).toContain("[chat/image-api] MinIO upload failed: bucket down");
    expect(events[1]).toEqual({ type: "image", data: "IMG", mimeType: "image/png", minioRef: null });
    const messagesToAppend = (stub.appended.at(-1) as unknown[])[3] as Array<Record<string, unknown>>;
    expect(messagesToAppend[1]).not.toHaveProperty("images");
  });

  it("does not append a user message when the turn has no conversation meta", async () => {
    imageProvider();
    stub.generateResult = { imageData: "IMG" };
    const { emit } = collect();
    await handleConversation(imageChat({ conversationId: "conv-2", conversationMeta: null, traceId: null }), emit);

    const args = stub.appended.at(-1) as unknown[];
    const messagesToAppend = args[3] as Array<Record<string, unknown>>;
    expect(messagesToAppend).toHaveLength(1);
    expect(messagesToAppend[0].role).toBe("assistant");
    expect(args[4]).toBeUndefined();
    expect(args[0]).toBe("conv-2");
  });

  it("skips persistence when there is no conversation", async () => {
    imageProvider();
    stub.generateResult = { imageData: "IMG" };
    const { events, emit } = collect();
    await handleConversation(imageChat({ skipConversation: true }), emit);

    expect(stub.appended).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", usage: null, estimatedCost: expect.any(Number), totalTime: expect.any(Number), traceId: "tr-9" });
  });

  it("falls back to the default image token count outside OpenAI", async () => {
    stub.provider = null;
    stub.providers["google"] = imageProvider();
    stub.generateResult = { imageData: "IMG" };
    stub.modelDefinitions["gpt-image-1.5"] = { imageAPI: true };
    const { emit } = collect();
    await handleConversation(imageChat({ provider: "google", conversationId: null, conversationMeta: null, traceId: null }), emit);
    expect(stub.logged.at(-1)).toMatchObject({ outputTokens: 1120, provider: "google" });
  });
});

describe("function calling tool injection", () => {
  const toolSchemas = [
    {
      name: "get_weather",
      description: "Weather lookup",
      domain: "Agentic: Weather",
      parameters: {
        properties: { city: { description: "City name" }, unit: { description: "Unit" } },
        required: ["city"],
      },
    },
    { name: "send_email", description: "Send mail", parameters: { properties: {} } },
  ];

  const fcChat = (overrides: Record<string, unknown> = {}) => baseChat({
    functionCallingEnabled: true,
    agenticLoopEnabled: false,
    ...overrides,
  });

  it("groups tools by domain and injects them into a new system prompt", async () => {
    textProvider();
    stub.toolSchemas = toolSchemas;
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(fcChat(), emit);

    const options = stub.providerCalls[0].args[2] as Record<string, unknown>;
    expect((options.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["get_weather", "send_email"]);

    const messages = stub.providerCalls[0].args[0] as Array<Record<string, unknown>>;
    const system = messages.find((message) => message.role === "system") as Record<string, string>;
    expect(system.content).toContain("## Enabled Tools (2)");
    expect(system.content).toContain("**Weather**");
    expect(system.content).toContain("**Other**");
    expect(system.content).toContain("### get_weather\nWeather lookup");
    expect(system.content).toContain("- city (required): City name");
    expect(system.content).toContain("- unit: Unit");

    expect((stub.finalized.at(-1) as { payload: Record<string, unknown> }).payload.resolvedEnabledTools).toEqual(["get_weather", "send_email"]);
  });

  it("appends to an existing system message that lacks the section", async () => {
    textProvider();
    stub.toolSchemas = [toolSchemas[0]];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(fcChat({ messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hi" }] }), emit);

    const messages = stub.providerCalls[0].args[0] as Array<Record<string, string>>;
    expect(messages).toHaveLength(2);
    expect(messages[0].content.startsWith("Be terse.")).toBe(true);
    expect(messages[0].content).toContain("## Enabled Tools (1)");
  });

  it("leaves an already-injected system prompt untouched", async () => {
    textProvider();
    stub.toolSchemas = [toolSchemas[0]];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(fcChat({ messages: [{ role: "system", content: "## Enabled Tools\nstuff" }, { role: "user", content: "hi" }] }), emit);

    const messages = stub.providerCalls[0].args[0] as Array<Record<string, string>>;
    expect(messages[0].content).toBe("## Enabled Tools\nstuff");
  });

  it("filters by enabledTools and disabledTools and skips injection when empty", async () => {
    textProvider();
    stub.toolSchemas = toolSchemas;
    stub.generateResult = { text: "ok" };
    const { emit } = collect();

    await handleConversation(fcChat({ enabledTools: ["send_email"] }), emit);
    expect(((stub.providerCalls.at(-1)!.args[2] as Record<string, unknown>).tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["send_email"]);

    await handleConversation(fcChat({ disabledTools: ["get_weather"] }), emit);
    expect(((stub.providerCalls.at(-1)!.args[2] as Record<string, unknown>).tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["send_email"]);

    stub.toolSchemas = [];
    await handleConversation(fcChat(), emit);
    const messages = stub.providerCalls.at(-1)!.args[0] as Array<Record<string, unknown>>;
    expect(messages.some((message) => message.role === "system")).toBe(false);
  });

  it("uses the configured topology and sets the context length for native MCP providers", async () => {
    textProvider();
    stub.toolSchemas = [toolSchemas[0]];
    stub.nativeMcp = true;
    stub.settings = { topology: "settings-topology" };
    stub.modelDefinitions["gpt-5.2"] = { contextLength: 128000, streaming: true };
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(fcChat({ topology: "explicit-topology" }), emit);

    const options = stub.providerCalls[0].args[2] as Record<string, unknown>;
    expect(options.contextLength).toBe(128000);

    await handleConversation(fcChat(), emit);
    expect(((stub.providerCalls.at(-1)!.args[2] as Record<string, unknown>).contextLength)).toBe(128000);
  });

  it("does not resolve tools when function calling is disabled or the agentic loop owns them", async () => {
    textProvider();
    stub.toolSchemas = [toolSchemas[0]];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat(), emit);
    expect((stub.providerCalls.at(-1)!.args[2] as Record<string, unknown>).tools).toBeUndefined();

    await handleConversation(fcChat({ agenticLoopEnabled: true }), emit);
    expect((stub.providerCalls.at(-1)!.args[2] as Record<string, unknown>).tools).toBeUndefined();
  });
});

describe("failure handling", () => {
  it("persists the partial turn, logs the failure and emits an error", async () => {
    textProvider();
    stub.generateError = new Error("provider exploded");
    const { events, emit } = collect();
    await handleConversation(baseChat({ conversationId: "conv-3", traceId: "tr-3" }), emit);

    expect(events).toEqual([{ type: "error", message: "provider exploded" }]);
    expect(stub.generating.at(-1)).toEqual(["conv-3", "proj", "alice", false, { project: "proj" }]);
    const [, , , messagesToAppend] = stub.appended.at(-1) as unknown[];
    expect(messagesToAppend).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", error: "provider exploded" },
    ]);
    expect(stub.chatLogs.at(-1)).toMatchObject({
      endpoint: "/chat",
      success: false,
      errorMessage: "provider exploded",
      conversationId: "conv-3",
      traceId: "tr-3",
      model: "gpt-5.2",
    });
  });

  it("warns when persisting the failure state itself fails", async () => {
    textProvider();
    stub.generateError = new Error("nope");
    stub.appendError = new Error("db down");
    const { events, emit } = collect();
    await handleConversation(baseChat({ conversationId: "conv-4" }), emit);

    expect(stub.warns).toContain("[chat] Failed to persist error state for conv-4: db down");
    expect(events.at(-1)).toMatchObject({ type: "error", message: "nope" });
  });

  it("does not persist when the conversation is skipped", async () => {
    textProvider();
    stub.generateError = new Error("nope");
    const { emit } = collect();
    await handleConversation(baseChat({ skipConversation: true }), emit);
    expect(stub.appended).toEqual([]);
    expect(stub.chatLogs.at(-1)).toMatchObject({ conversationId: null });
  });

  it("rejects providers without any text generation capability", async () => {
    stub.provider = {};
    const { events, emit } = collect();
    await handleConversation(baseChat({ skipConversation: true }), emit);
    expect(events).toEqual([{ type: "error", message: 'Provider "openai" does not support text generation' }]);
  });

  it("reports finalisation failures through the same path", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    stub.finalizeError = new Error("finalizer broke");
    const { events, emit } = collect();
    await handleConversation(baseChat({ conversationId: "conv-5" }), emit);
    expect(events.at(-1)).toEqual({ type: "error", message: "finalizer broke" });
  });
});

describe("local provider routing", () => {
  it("releases the GPU slot after a successful generation", async () => {
    stub.providers["vllm-dgx"] = textProvider();
    stub.isLocal = true;
    stub.generateResult = { text: "local" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "vllm-dgx", model: "qwen" }), emit);
    expect(stub.releaseCalls).toBe(1);
  });

  it("balances across siblings by load and releases on failure", async () => {
    stub.providers["vllm-dgx-2"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instances["vllm-dgx"] = [
      { id: "vllm-dgx", concurrency: 2 },
      { id: "vllm-dgx-2", concurrency: 4 },
    ];
    stub.usableInstances = stub.instances["vllm-dgx"];
    stub.queueLoads["vllm-dgx"] = { totalInflight: 2, activeCount: 2, pending: 0, maxConcurrency: 2 };
    stub.queueLoads["vllm-dgx-2"] = { totalInflight: 0, activeCount: 0, pending: 0, maxConcurrency: 4 };
    stub.generateError = new Error("local down");
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "vllm-dgx", model: "qwen" }), emit);

    expect(stub.providerLookups).toContain("vllm-dgx-2");
    expect(stub.releaseCalls).toBe(1);
    expect(stub.errors).toEqual([]);
  });

  it("prefers the higher-concurrency sibling on equal load", async () => {
    stub.providers["vllm-b"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instances["vllm-a"] = [
      { id: "vllm-a", concurrency: 2 },
      { id: "vllm-b", concurrency: 8 },
    ];
    stub.usableInstances = stub.instances["vllm-a"];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "vllm-a", model: "qwen" }), emit);
    expect(stub.providerLookups).toContain("vllm-b");
  });

  it("applies a single-instance model override", async () => {
    stub.providers["ollama"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instances["ollama"] = [{ id: "ollama", concurrency: 1 }];
    stub.usableInstances = stub.instances["ollama"];
    stub.usableOverrides = new Map([["ollama", "llama3:8b"]]);
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "ollama", model: "missing-model" }), emit);
    expect(stub.modelLookups.at(-1)).toBe("llama3:8b");
  });

  it("keeps the requested model when no instance can serve it", async () => {
    stub.providers["ollama"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instances["ollama"] = [{ id: "ollama", concurrency: 1 }];
    stub.usableInstances = [];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "ollama", model: "missing-model" }), emit);
    expect(stub.warns.some((warning) => warning.includes('Model "missing-model" not available'))).toBe(true);
    expect(stub.modelLookups.at(-1)).toBe("missing-model");
  });

  it("resolves a pinned instance model override", async () => {
    stub.providers["lm-studio-2"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instanceTypes["lm-studio-2"] = "lm-studio";
    stub.instances["lm-studio"] = [{ id: "lm-studio-2", concurrency: 1 }];
    stub.usableOverrides = new Map([["lm-studio-2", "pinned-model"]]);
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "lm-studio-2", model: "requested" }), emit);
    expect(stub.modelLookups.at(-1)).toBe("pinned-model");
  });

  it("returns the requested model for a pinned instance that is not registered", async () => {
    stub.providers["lm-studio-9"] = mappedTextProvider();
    stub.isLocal = true;
    stub.instanceTypes["lm-studio-9"] = "lm-studio";
    stub.instances["lm-studio"] = [];
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "lm-studio-9", model: "requested" }), emit);
    expect(stub.modelLookups.at(-1)).toBe("requested");
  });
});

describe("dynamic vllm model resolution", () => {
  it("picks the first model advertised by a sibling", async () => {
    stub.instances["vllm-1"] = [{ id: "vllm-a", concurrency: 1 }];
    stub.providers["vllm-a"] = mappedTextProvider({ listModels: async () => ({ models: [{ id: "qwen-7b" }] }) });
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "vllm-1", model: null }), emit);

    expect(stub.modelLookups).toContain("qwen-7b");
    expect((stub.finalized.at(-1) as { context: Record<string, unknown> }).context).toMatchObject({
      providerName: "vllm-a",
      resolvedModel: "qwen-7b",
    });
  });

  it("accepts key/name model shapes and skips siblings without discovery", async () => {
    stub.instances["vllm-1"] = [
      { id: "vllm-skip", concurrency: 1 },
      { id: "vllm-empty", concurrency: 1 },
      { id: "vllm-broken", concurrency: 1 },
      { id: "vllm-key", concurrency: 1 },
    ];
    stub.providers["vllm-empty"] = { listModels: async () => ({ data: [] }) };
    stub.providers["vllm-broken"] = {
      listModels: async () => {
        throw new Error("discovery failed");
      },
    };
    stub.providers["vllm-key"] = mappedTextProvider({ listModels: async () => ({ models: [{ key: "key-model" }] }) });
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ provider: "vllm-1", model: null }), emit);

    expect(stub.warns.some((warning) => warning.includes("Failed to dynamically fetch models for vllm-broken"))).toBe(true);
    expect(stub.modelLookups.at(-1)).toBe("key-model");
  });

  it("leaves non-vllm providers and explicit models alone", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat(), emit);
    expect(stub.instances).toEqual({});

    await handleConversation(baseChat({ provider: "vllm-2", model: "explicit" }), emit);
    expect(stub.modelLookups.at(-1)).toBe("explicit");
  });

  it("falls back to the default model for the provider", async () => {
    textProvider();
    stub.defaultModels = { openai: "gpt-5.2" };
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ model: null }), emit);
    expect(stub.modelLookups.at(-1)).toBe("gpt-5.2");
  });
});

describe("option construction", () => {
  const optionsOf = (index = -1) =>
    (stub.providerCalls.at(index)!.args[2] as Record<string, unknown>);

  it("keeps only the meaningful option values", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({
      temperature: 0,
      seed: "",
      stopSequences: [],
      tools: [],
      responseMimeType: "",
      logprobs: 0,
      topLogprobs: 3,
      enabledTools: [],
      maxTokens: 512,
    }), emit);

    const options = optionsOf();
    expect(options).toMatchObject({ temperature: 0, maxTokens: 512, topLogprobs: 3 });
    expect(options).not.toHaveProperty("seed");
    // Empty arrays are truthy, so they are forwarded as-is.
    expect(options.stopSequences).toEqual([]);
    expect(options.tools).toEqual([]);
    expect(options.enabledTools).toEqual([]);
    expect(options).not.toHaveProperty("responseMimeType");
    expect(options).not.toHaveProperty("logprobs");

  });

  it("drops thinking options when thinking is disabled", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ thinkingEnabled: false, thinkingLevel: "high", thinkingBudget: 5, reasoningEffort: "low" }), emit);

    const options = optionsOf();
    expect(options).not.toHaveProperty("thinkingLevel");
    expect(options).not.toHaveProperty("thinkingBudget");
    expect(options).not.toHaveProperty("reasoningEffort");
  });

  it("mirrors thinkingLevel and reasoningEffort into each other", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { emit } = collect();

    await handleConversation(baseChat({ thinkingLevel: "high" }), emit);
    expect(optionsOf()).toMatchObject({ thinkingLevel: "high", reasoningEffort: "high" });

    await handleConversation(baseChat({ reasoningEffort: "low" }), emit);
    expect(optionsOf()).toMatchObject({ thinkingLevel: "low", reasoningEffort: "low" });
  });

  it("applies persona policies, thinking defaults and registry defaults", async () => {
    textProvider();
    stub.persona = { policies: [{ tool: "get_weather" }], thinkingDefault: true };
    stub.agentDefaults = { temperature: 0.5, topP: 0.9 };
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ agent: "atlas", temperature: 0.2 }), emit);

    const options = optionsOf();
    expect(options.policies).toEqual([{ tool: "get_weather" }]);
    expect(options.thinkingEnabled).toBe(true);
    expect(options.temperature).toBe(0.2);
    expect(options.topP).toBe(0.9);
    expect(stub.localDefaultsCalls.at(-1)).toMatchObject({ provider: "openai", client: { thinkingEnabled: true } });
  });

  it("honours an explicit thinking flag over the persona default", async () => {
    textProvider();
    stub.persona = { thinkingDefault: true };
    stub.agentDefaults = { temperature: 0.5 };
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ agent: "atlas", thinkingEnabled: false }), emit);

    expect(optionsOf().thinkingEnabled).toBe(false);
    expect(stub.localDefaultsCalls.at(-1)).toMatchObject({ client: { thinkingEnabled: false } });
  });

  it("leaves options alone for a persona without overrides", async () => {
    textProvider();
    stub.persona = {};
    stub.generateResult = { text: "ok" };
    const { emit } = collect();
    await handleConversation(baseChat({ agent: "atlas" }), emit);
    expect(optionsOf()).not.toHaveProperty("policies");
    expect(stub.localDefaultsCalls.at(-1)).toMatchObject({ client: { thinkingEnabled: undefined } });
  });
});

describe("handleAgent", () => {
  const agentChat = (overrides: Record<string, unknown> = {}) => baseChat({
    agent: "atlas",
    agentConversationId: "ac-1",
    conversationId: "conv-a",
    conversationMeta: { title: "Agent run" },
    ...overrides,
  });

  it("creates the conversation stub and runs the agentic loop", async () => {
    textProvider();
    stub.generateResult = { text: "ok" };
    const { events, emit } = collect();
    await handleAgent(agentChat(), emit);

    expect(stub.generating[0]).toEqual([
      "conv-a",
      "proj",
      "alice",
      true,
      { project: "proj", agent: "atlas", agentConversationId: "ac-1", title: "Agent run" },
    ]);
    expect(stub.agentLoop.at(-1)).toMatchObject({
      providerName: "openai",
      resolvedModel: "gpt-5.2",
      agentConversationId: "ac-1",
      conversationId: "conv-a",
      isNewConversation: false,
      project: "proj",
      username: "alice",
      agent: "atlas",
    });
    expect(events).toEqual([]);
  });

  it("generates ids and titles for a brand new agent conversation", async () => {
    textProvider();
    const { emit } = collect();
    await handleAgent(agentChat({ agentConversationId: null, conversationId: null, conversationMeta: null }), emit);

    const params = stub.agentLoop.at(-1) as Record<string, unknown>;
    expect(params.agentConversationId).toEqual(expect.any(String));
    expect(params.conversationId).toEqual(expect.any(String));
    expect(params.isNewConversation).toBe(true);
    expect(params.conversationMeta).toBeNull();
    expect(params.traceId).toBeNull();
  });

  it("releases the GPU slot and aborts sub-agents when the client disconnects", async () => {
    textProvider();
    stub.isLocal = true;
    const controller = new AbortController();
    controller.abort();
    const { emit } = collect();
    await handleAgent(agentChat(), emit, { signal: controller.signal });

    expect(stub.releaseCalls).toBe(1);
    expect(stub.abortCalls).toEqual(["conv-a"]);
  });

  it("warns when sub-agent cleanup fails", async () => {
    textProvider();
    stub.abortError = new Error("cleanup broke");
    const controller = new AbortController();
    controller.abort();
    const { emit } = collect();
    await handleAgent(agentChat(), emit, { signal: controller.signal });
    expect(stub.warns).toContain("[agent] Sub-agent cleanup failed: cleanup broke");
  });

  it("clears generating state and logs the failure when the loop throws", async () => {
    textProvider();
    stub.agentLoopError = new Error("loop died");
    const { events, emit } = collect();
    await handleAgent(agentChat({ traceId: "tr-a" }), emit);

    expect(events).toEqual([{ type: "error", message: "loop died" }]);
    expect(stub.generating.at(-1)).toEqual(["conv-a", "proj", "alice", false, { project: "proj" }]);
    expect(stub.chatLogs.at(-1)).toMatchObject({
      endpoint: "/agent",
      operation: "agent",
      success: false,
      errorMessage: "loop died",
      agentConversationId: "ac-1",
      conversationId: "conv-a",
      traceId: "tr-a",
    });
  });

  it("rejects providers without text generation before starting the loop", async () => {
    stub.provider = {};
    const { events, emit } = collect();
    await handleAgent(agentChat(), emit);
    expect(stub.agentLoop).toEqual([]);
    expect(events).toEqual([{ type: "error", message: 'Provider "openai" does not support text generation' }]);
  });

  it("reports validation errors without creating a stub", async () => {
    const { events, emit } = collect();
    await handleAgent({ messages: [] }, emit);
    expect(events).toEqual([{ type: "error", message: "Missing required field: provider", statusCode: 400 }]);
    expect(stub.generating).toEqual([]);
  });
});

describe("streaming text generation", () => {
  const streamProvider = () => {
    const provider: Record<string, any> = {
      generateTextStream: (...args: unknown[]) => {
        stub.streamCalls.push({ kind: "stream", args });
        const iterable = (async function* () {
          for (const chunk of stub.streamChunks) yield chunk;
        })() as AsyncIterable<unknown> & { return?: () => unknown };
        const originalReturn = iterable.return?.bind(iterable);
        iterable.return = (...returnArgs: [] | [unknown]) => {
          stub.streamReturned += 1;
          return originalReturn ? originalReturn(...returnArgs) : Promise.resolve({ done: true, value: undefined });
        };
        return iterable;
      },
      generateTextStreamLive: (...args: unknown[]) => {
        stub.streamCalls.push({ kind: "streamLive", args });
        return (async function* () {
          for (const chunk of stub.streamChunks) yield chunk;
        })();
      },
    };
    stub.provider = provider;
    return provider;
  };

  it("consumes the provider stream and finalises the accumulated state", async () => {
    streamProvider();
    stub.streamChunks = [{ type: "text", content: "streamed" }, { type: "text", content: "!" }];
    const { emit } = collect();
    await handleConversation(baseChat(), emit);

    expect(stub.dispatched).toHaveLength(2);
    expect(stub.streamCalls[0].args[0]).toEqual([{ role: "user", content: "hi" }]);
    const payload = (stub.finalized.at(-1) as { payload: Record<string, any> }).payload;
    expect(payload).toMatchObject({ text: "streamed!", outputCharacters: 9, usage: { inputTokens: 1, outputTokens: 2 } });
    expect(payload.timeToGenerationSec).toEqual(expect.any(Number));
    expect(payload.generationSec).toEqual(expect.any(Number));
  });

  it("uses the live stream for live API models", async () => {
    streamProvider();
    stub.modelDefinitions["gpt-5.2"] = { liveAPI: true, streaming: true };
    stub.streamChunks = [{ type: "text", content: "live" }];
    const { emit } = collect();
    await handleConversation(baseChat(), emit);

    expect(stub.streamCalls[0].kind).toBe("streamLive");
    expect((stub.streamCalls[0].args[2] as Record<string, unknown>)).toHaveProperty("signal");
    expect((stub.finalized.at(-1) as { payload: Record<string, any> }).payload.text).toBe("live");
  });

  it("aborts the stream and persists the partial text when the client disconnects", async () => {
    streamProvider();
    stub.streamChunks = [{ type: "text", content: "partial" }];
    const controller = new AbortController();
    const { emit } = collect();
    await handleConversation(baseChat({ conversationId: "conv-s" }), emit, { signal: controller.signal });
    expect(stub.streamReturned).toBe(0);

    const aborting = streamProvider();
    stub.streamChunks = [{ type: "text", content: "never" }];
    controller.abort();
    stub.streamCalls = [];
    stub.dispatched = [];
    stub.streamReturned = 0;
    await handleConversation(baseChat({ conversationId: "conv-s" }), emit, { signal: controller.signal });
    expect(stub.streamCalls).toHaveLength(1);
    expect(stub.dispatched).toEqual([]);
    expect(stub.streamReturned).toBeGreaterThanOrEqual(1);
    expect(aborting).toBeTruthy();
  });

  it("warns about a truncated empty response", async () => {
    streamProvider();
    stub.streamChunks = [];
    stub.streamState.stopReason = "length";
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);

    expect(events.map((event) => event.type)).toEqual(["chunk", "status"]);
    expect(events[0].content).toContain("max_tokens");
    expect(events[1]).toMatchObject({ phase: "truncated" });
    expect((stub.finalized.at(-1) as { payload: Record<string, any> }).payload.text).toContain("max_tokens");
  });

  it("does not warn when the response has text", async () => {
    streamProvider();
    stub.streamChunks = [{ type: "text", content: "done" }];
    stub.streamState.stopReason = "max_tokens";
    const { events, emit } = collect();
    await handleConversation(baseChat(), emit);
    expect(events).toEqual([]);
  });

  it("persists the partial text when the provider stream throws", async () => {
    streamProvider();
    stub.streamChunks = [{ type: "text", content: "partial" }];
    stub.dispatchError = new Error("stream broke");
    const { events, emit } = collect();
    await handleConversation(baseChat({ conversationId: "conv-t" }), emit);

    expect(events).toEqual([{ type: "error", message: "stream broke" }]);
    const messagesToAppend = (stub.appended.at(-1) as unknown[])[3] as Array<Record<string, unknown>>;
    expect(messagesToAppend[1]).toMatchObject({ role: "assistant", content: "partial", error: "stream broke" });
  });
});
