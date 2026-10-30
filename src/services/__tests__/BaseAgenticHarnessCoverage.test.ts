/**
 * BaseAgenticHarness — coverage of the stream-chunk router, native tool-call
 * handling, token estimation, the context-exhaustion guard and finalization.
 * A real ReActHarness drives the shared base class; the provider, Mongo,
 * RequestLogger, FileService and tracing are fakes, and assertions read the
 * emitted SSE events, mutated state and persisted documents.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  uploadFile: vi.fn(),
  insertPending: vi.fn(),
  logRequest: vi.fn(),
  logChatGeneration: vi.fn(),
  completePending: vi.fn(),
  request: vi.fn(),
  enqueueSpan: vi.fn(),
  listAllDescendantSubAgents: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  getCollection: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: {
    getDb: () => null,
    getCollection: fakes.getCollection,
    getClient: () => null,
  },
}));
vi.mock("../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() {
      return TraceExporter.instance;
    }
    enqueueSpan(span: unknown) {
      fakes.enqueueSpan(span);
    }
    getQueuedSpans() {
      return [];
    }
  }
  return { TraceExporter };
});
vi.mock("../FileService.ts", () => ({ default: { uploadFile: fakes.uploadFile } }));
vi.mock("../RequestLogger.ts", () => ({
  default: {
    insertPending: fakes.insertPending,
    logRequest: fakes.logRequest,
    logChatGeneration: fakes.logChatGeneration,
    completePending: fakes.completePending,
    request: fakes.request,
  },
}));
vi.mock("../OrchestratorService.ts", () => ({
  default: { listAllDescendantSubAgents: fakes.listAllDescendantSubAgents },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
    metric: vi.fn(),
  },
}));

import ReActHarness from "../harnesses/ReActHarness.ts";
import AgenticLoopState from "../AgenticLoopState.ts";
import type { AgenticContext, ConversationMessage, PassState } from "../harnesses/types.ts";

type Event = Record<string, unknown>;
type Harness = ReActHarness & {
  estimateInputTokens(messages: ConversationMessage[]): number;
  _emitContextExhaustedAndSpan(clampedMaxTokens: number): null;
};

let emitted: Event[];

function buildHarness(overrides: Partial<AgenticContext> = {}) {
  emitted = [];
  const context = {
    options: { maxIterations: 2, maxTokens: 4096, autoApprove: true },
    messages: [{ role: "user", content: "Summarise the repo" }] as ConversationMessage[],
    project: "proj",
    username: "alice",
    modelDefinition: null,
    agentConversationId: "conv-1",
    conversationId: "conv-1",
    provider: {},
    providerName: "mock",
    resolvedModel: "mock-model",
    signal: null,
    emit: (event: Event) => emitted.push(event),
    runtimeTools: { finalTools: [{ name: "read_file" }], resolvedEnabledTools: null },
    runtimeToolExecutor: async () => ({ ok: true }),
    requestId: "req-1",
    traceId: "trace-1",
    ...overrides,
  } as unknown as AgenticContext;
  const state = new AgenticLoopState({ originalMessageCount: 1 });
  const harness = new ReActHarness(context, state, context.runtimeTools!) as Harness;
  return { harness, context, state };
}

function passState(harness: ReActHarness): PassState {
  return harness.createPassState({} as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.insertPending.mockResolvedValue(null);
  fakes.logChatGeneration.mockResolvedValue(null);
  fakes.completePending.mockResolvedValue(null);
  fakes.request.mockResolvedValue({});
  fakes.uploadFile.mockResolvedValue({ ref: "minio://generations/img.png" });
  fakes.getCollection.mockReturnValue({ findOne: fakes.findOne, updateOne: fakes.updateOne });
  fakes.findOne.mockResolvedValue({ subAgents: [{ agentId: "old-agent" }] });
  fakes.updateOne.mockResolvedValue({ matchedCount: 1 });
  fakes.listAllDescendantSubAgents.mockReturnValue([]);
});

describe("processStreamChunk — control chunks", () => {
  it("breaks on an aborted signal before touching any state", () => {
    const controller = new AbortController();
    controller.abort();
    const { harness, state } = buildHarness({ signal: controller.signal });
    expect(harness.processStreamChunk("ignored", passState(harness), new Set())).toEqual({
      action: "break",
    });
    expect(state.finalStreamedText).toBe("");
  });

  it("records usage, rate limits, stop reason and thinking signatures", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    expect(
      harness.processStreamChunk(
        { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
        pass,
        new Set(),
      ),
    ).toEqual({ action: "continue" });
    expect(pass.usage.inputTokens).toBe(10);

    harness.processStreamChunk({ type: "rateLimits", rateLimits: { remaining: 4 } }, pass, new Set());
    expect(state.lastRateLimits).toEqual({ remaining: 4 });

    harness.processStreamChunk({ type: "stopReason", stopReason: "end_turn" }, pass, new Set());
    expect(pass.stopReason).toBe("end_turn");

    harness.processStreamChunk({ type: "thinking_signature", signature: "sig-1" }, pass, new Set());
    expect(pass.thinkingSignature).toBe("sig-1");
  });

  it("streams thinking and text, keeping display fragments in order", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    harness.processStreamChunk({ type: "thinking", content: "pondering" }, pass, new Set());
    harness.processStreamChunk("Hello ", pass, new Set());
    harness.processStreamChunk("world", pass, new Set());

    expect(state.streamedThinking).toBe("pondering");
    expect(state.finalStreamedText).toBe("Hello world");
    expect(state.displayTextFragments).toEqual(["Hello world"]);
    expect(state.displaySegments.at(-1)).toEqual({ type: "text", fragmentIndex: 0 });
    // "pondering" (9) plus the two text chunks (11) are all counted as output.
    expect(state.overallOutputCharacters).toBe(20);
    expect(emitted.filter((event) => event.type === "chunk").map((event) => event.content)).toEqual([
      "Hello ",
      "world",
    ]);
    expect(emitted.some((event) => event.type === "thinking")).toBe(true);
    expect(emitted.some((event) => event.type === "status")).toBe(true);
  });

  it("emits nothing for an empty text chunk but still records the pass", () => {
    const { harness } = buildHarness();
    const pass = passState(harness);
    harness.processStreamChunk("", pass, new Set());
    expect(emitted.filter((event) => event.type === "chunk")).toEqual([]);
    expect(pass.outputCharacters).toBe(0);
  });

  it("routes tool-call start/delta chunks and tracks characters", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    harness.processStreamChunk(
      { type: "toolCallStart", name: "read_file", id: "call-1" },
      pass,
      new Set(["read_file"]),
    );
    harness.processStreamChunk({ type: "toolCallDelta", characters: 120 }, pass, new Set());

    expect(emitted).toContainEqual({
      type: "tool_execution",
      tool: { name: "read_file", args: {}, id: "call-1" },
      status: "streaming",
    });
    expect(state.overallOutputCharacters).toBe(120);
  });

  it("passes through code execution, web search and audio chunks", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    harness.processStreamChunk({ type: "executableCode", code: "print(1)", language: "python" }, pass, new Set());
    harness.processStreamChunk({ type: "codeExecutionResult", output: "1", outcome: "OUTCOME_OK" }, pass, new Set());
    harness.processStreamChunk({ type: "webSearchResult", results: [{ title: "x" }] }, pass, new Set());
    harness.processStreamChunk(
      { type: "audio", data: "AAAA", mimeType: "audio/L16; rate=24000" },
      pass,
      new Set(),
    );
    harness.processStreamChunk({ type: "status", message: "working", detail: 1 }, pass, new Set());

    expect(emitted.map((event) => event.type)).toEqual([
      "executableCode",
      "codeExecutionResult",
      "webSearchResult",
      "audio",
      "status",
    ]);
    expect(state.streamedAudioChunks).toEqual(["AAAA"]);
    expect(state.audioSampleRate).toBe(24000);
    expect(emitted.at(-1)).toEqual({ type: "status", message: "working", detail: 1 });
  });
});

describe("processStreamChunk — tool calls", () => {
  it("collects a native tool call while it is being called, then completes it", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    const started = harness.processStreamChunk(
      { type: "toolCall", native: true, status: "calling", id: "nt-1", name: "read_file", args: { path: "a.ts" } },
      pass,
      new Set(["read_file"]),
    );
    expect(started).toEqual({ action: "continue" });
    expect(state.streamedToolCalls).toEqual([
      { id: "nt-1", name: "read_file", args: { path: "a.ts" } },
    ]);
    expect(state.displaySegments).toEqual([{ type: "tools", toolIds: ["nt-1"] }]);

    harness.processStreamChunk(
      {
        type: "toolCall",
        native: true,
        status: "done",
        id: "nt-1",
        name: "read_file",
        args: { path: "b.ts" },
        result: "contents",
      },
      pass,
      new Set(["read_file"]),
    );

    expect(state.streamedToolCalls[0]).toEqual({
      id: "nt-1",
      name: "read_file",
      args: { path: "b.ts" },
      result: "contents",
      status: "done",
    });
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: "toolCall", id: "nt-1", status: "done", result: "contents" }),
    );
  });

  it("matches an existing native call by name and keeps its args when none are supplied", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    harness.processStreamChunk(
      { type: "toolCall", native: true, status: "calling", name: "read_file", args: { path: "a.ts" } },
      pass,
      new Set(["read_file"]),
    );
    harness.processStreamChunk(
      { type: "toolCall", native: true, status: "error", name: "read_file", result: "boom" },
      pass,
      new Set(["read_file"]),
    );

    expect(state.streamedToolCalls[0]).toMatchObject({
      name: "read_file",
      args: { path: "a.ts" },
      result: "boom",
      status: "error",
    });
  });

  it("emits a completion event for a native call it never saw start", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    harness.processStreamChunk(
      { type: "toolCall", native: true, status: "done", id: "ghost", name: "shell", result: "ok" },
      pass,
      new Set(),
    );

    expect(state.streamedToolCalls).toEqual([]);
    expect(emitted).toContainEqual(
      expect.objectContaining({ type: "toolCall", id: "ghost", status: "done" }),
    );
  });

  it("builds a pending tool call for a non-native chunk and flags unauthorized names", () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    const allowed = harness.processStreamChunk(
      { type: "toolCall", id: "call-1", name: "read_file", args: { path: "a.ts" } },
      pass,
      new Set(["read_file"]),
    );
    expect(allowed).toEqual({
      action: "toolCall",
      toolCall: { id: "call-1", name: "read_file", args: { path: "a.ts" }, isUnauthorized: false },
    });
    expect(pass.pendingToolCalls).toHaveLength(1);

    const denied = harness.processStreamChunk(
      { type: "toolCall", id: "call-2", name: "delete_everything", args: {} },
      pass,
      new Set(["read_file"]),
    );
    expect(denied).toMatchObject({ action: "toolCall", toolCall: { isUnauthorized: true } });

    // A tool that is in the catalog but not in the allowed set is auto-loaded.
    const autoloaded = harness.processStreamChunk(
      { type: "toolCall", id: "call-3", name: "read_file", args: {} },
      pass,
      new Set(),
    );
    expect(autoloaded).toMatchObject({ action: "toolCall", toolCall: { isUnauthorized: false } });
    expect(state.loadedTools.has("read_file")).toBe(true);
  });

  it("carries parse errors and MCP-prefixed names into the tool call object", () => {
    const { harness } = buildHarness({
      runtimeTools: {
        finalTools: [{ name: "mcp__tools__read_file" }],
        resolvedEnabledTools: null,
      },
    });
    const pass = passState(harness);

    const action = harness.processStreamChunk(
      {
        type: "toolCall",
        id: "call-9",
        name: "read_file",
        argsParseError: true,
        rawArgs: "{broken",
        responsesItemId: "item-1",
        thoughtSignature: "sig",
      },
      pass,
      new Set(["mcp__tools__read_file"]),
    );

    expect(action).toMatchObject({
      action: "toolCall",
      toolCall: {
        id: "call-9",
        name: "mcp__tools__read_file",
        responsesItemId: "item-1",
        thoughtSignature: "sig",
        _argsParseError: true,
        _rawArgs: "{broken",
      },
    });
  });

  it("stores generated images in MinIO and falls back to inline data on failure", async () => {
    const { harness, state } = buildHarness();
    const pass = passState(harness);

    await harness.processStreamChunk(
      { type: "image", data: "QUJD", mimeType: "image/webp" },
      pass,
      new Set(),
    );
    expect(fakes.uploadFile).toHaveBeenCalledWith(
      "data:image/webp;base64,QUJD",
      "generations",
      "proj",
      "alice",
    );
    expect(state.streamedImages).toEqual(["minio://generations/img.png"]);
    expect(emitted.at(-1)).toEqual({
      type: "image",
      mimeType: "image/webp",
      minioRef: "minio://generations/img.png",
    });

    fakes.uploadFile.mockRejectedValue(new Error("minio down"));
    await harness.processStreamChunk({ type: "image", data: "QUJD" }, pass, new Set());
    expect(state.streamedImages.at(-1)).toBe("data:image/png;base64,QUJD");
    expect(emitted.at(-1)).toEqual({ type: "image", data: "QUJD", mimeType: undefined, minioRef: null });
  });
});

describe("estimateInputTokens", () => {
  it("counts text, structured content, thinking, tool calls and images", () => {
    const { harness } = buildHarness();
    const tokens = harness.estimateInputTokens([
      { role: "user", content: "12345678" } as ConversationMessage,
      { role: "assistant", content: [{ type: "text", text: "1234" }] } as unknown as ConversationMessage,
      { role: "assistant", content: "", thinking: "12345678" } as unknown as ConversationMessage,
      { role: "assistant", content: "", toolCalls: [{ id: "c" }] } as unknown as ConversationMessage,
      { role: "user", content: "", images: ["a", "b"] } as unknown as ConversationMessage,
      { role: "assistant", content: "" } as unknown as ConversationMessage,
    ]);

    // 8 chars -> 2 tokens, JSON([{text:"1234"}]) -> 2, thinking 8 -> 2,
    // toolCalls JSON 2, two images -> 2000.
    expect(tokens).toBeGreaterThanOrEqual(2000);
    expect(tokens).toBeLessThan(2100);
  });
});

describe("_emitContextExhaustedAndSpan", () => {
  it("emits context_exhausted and enqueues a failed model span", () => {
    const { harness } = buildHarness({
      modelDefinition: { maxInputTokens: 8000 } as never,
    });

    expect(harness._emitContextExhaustedAndSpan(200)).toBeNull();

    expect(emitted).toContainEqual({
      type: "status",
      message: "context_exhausted",
      availableOutputTokens: 200,
      contextWindow: 8000,
    });
    const span = fakes.enqueueSpan.mock.calls[0][0] as {
      name: string;
      attributes: Record<string, unknown>;
      status: string;
    };
    expect(span.name).toBe("llm.generate:mock-model");
    expect(span.attributes).toMatchObject({
      model: "mock-model",
      provider: "mock",
      error: "context_exhausted",
    });
  });
});

describe("finalize", () => {
  /** Provider that streams one text chunk and ends the turn. */
  function textProvider(text: string) {
    return {
      generateTextStream() {
        return (async function* () {
          yield text;
        })();
      },
    };
  }

  it("persists the turn and appends the assistant message", async () => {
    const { harness, context, state } = buildHarness();
    context.provider = textProvider("Final answer") as never;
    const result = await harness.run();

    expect(result.messages.at(-1)).toMatchObject({ role: "assistant", content: "Final answer" });
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[1]).toMatchObject({ role: "user", content: "Summarise the repo" });
    expect(state.conversationOutcome).toBe("completed");
    expect(state.overallUsage.requests).toBe(1);
    // insertPending resolves without a document id, so the turn is logged through
    // the legacy chat-generation path.
    expect(fakes.insertPending).toHaveBeenCalled();
    expect(fakes.logChatGeneration).toHaveBeenCalled();
  });

  it("records an aborted outcome when the signal fired during the turn", async () => {
    const controller = new AbortController();
    const { harness, context, state } = buildHarness({ signal: controller.signal });
    context.provider = textProvider("Partial") as never;
    controller.abort();

    await harness.run().catch(() => {
      /* an aborted turn may surface as an incomplete run */
    });
    expect(state.conversationOutcome).toBe("aborted");
  });

  it("merges and persists sub-agent snapshots when the turn created a sub-agent", async () => {
    const { harness, context, state } = buildHarness();
    context.provider = textProvider("Delegated") as never;
    state.streamedToolCalls.push({ id: "c1", name: "create_subagent", args: {} } as never);
    fakes.listAllDescendantSubAgents.mockReturnValue([
      { agentId: "new-agent", description: "child", status: "complete" },
    ]);

    await harness.run();

    expect(fakes.listAllDescendantSubAgents).toHaveBeenCalledWith("conv-1");
    expect(fakes.getCollection).toHaveBeenCalled();
    expect(fakes.updateOne).toHaveBeenCalledWith(
      { id: "conv-1", project: "proj", username: "alice" },
      {
        $set: {
          subAgents: [
            { agentId: "old-agent" },
            { agentId: "new-agent", description: "child", status: "complete" },
          ],
          subAgentsUpdatedAt: expect.any(String),
        },
      },
    );
  });

  it("survives a failing sub-agent persistence write", async () => {
    const { harness, context, state } = buildHarness();
    context.provider = textProvider("Delegated") as never;
    state.streamedToolCalls.push({ id: "c1", name: "create_subagent", args: {} } as never);
    fakes.listAllDescendantSubAgents.mockReturnValue([{ agentId: "new-agent" }]);
    fakes.updateOne.mockRejectedValue(new Error("write concern failed"));

    await expect(harness.run()).resolves.toBeDefined();
  });

  it("skips snapshot persistence when no descendant sub-agent exists", async () => {
    const { harness, context, state } = buildHarness();
    context.provider = textProvider("Alone") as never;
    state.streamedToolCalls.push({ id: "c1", name: "create_subagent", args: {} } as never);

    await harness.run();
    const subAgentWrites = fakes.updateOne.mock.calls.filter(
      ([, update]) => (update as { $set?: { subAgents?: unknown } })?.$set?.subAgents,
    );
    expect(subAgentWrites).toEqual([]);
  });
});
