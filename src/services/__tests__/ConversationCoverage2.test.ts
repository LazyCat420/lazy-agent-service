/**
 * Conversation service — getConversationStats aggregation (multi-level
 * descendant discovery, token/cost sums, modality merge, tool counts, error
 * counting) plus the conversation helpers in utils.ts.
 *
 * Mongo is a fake document store; FileService's MinIO boundary is faked.
 * Assertions read the returned stats object and the transformed messages.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getDb: vi.fn(),
  getCollection: vi.fn(),
  discoverDescendantConversationIds: vi.fn(),
  isExternalStorage: vi.fn(),
  uploadFile: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({
  default: { getDb: fakes.getDb, getCollection: fakes.getCollection },
}));
vi.mock("../../utils/ConversationDiscovery.ts", () => ({
  discoverDescendantConversationIds: fakes.discoverDescendantConversationIds,
}));
vi.mock("../FileService.ts", () => ({
  default: { isExternalStorage: fakes.isExternalStorage, uploadFile: fakes.uploadFile },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import ConversationService from "../conversation/ConversationService.ts";
import {
  extractFiles,
  computeModalities,
  extractProviders,
  computeTotalCost,
  buildConversationPatchFields,
  enrichConversationsWithRequestCosts,
  enrichSingleConversationCost,
} from "../conversation/utils.ts";

type Any = Record<string, unknown>;

const requestDoc = (overrides: Any = {}) => ({
  estimatedCost: 0.01,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  reasoningOutputTokens: 0,
  provider: "lm-studio",
  model: "model-x",
  operation: "chat",
  timestamp: "2026-10-30T10:00:00.000Z",
  modalities: { textIn: true },
  toolApiNames: [],
  success: true,
  agentConversationId: "conv-1",
  ...overrides,
});

const fakeDb = (requests: Any[]) => ({
  collection: vi.fn(() => ({
    find: vi.fn(() => ({
      project: vi.fn(() => ({
        toArray: vi.fn(async () => requests),
      })),
    })),
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  fakes.discoverDescendantConversationIds.mockResolvedValue(new Set(["conv-1"]));
  fakes.isExternalStorage.mockReturnValue(false);
  fakes.uploadFile.mockResolvedValue({ ref: "minio://uploaded" });
});

describe("ConversationService.getConversationStats", () => {
  it("returns null without a database", async () => {
    fakes.getDb.mockReturnValue(null);
    expect(await ConversationService.getConversationStats("conv-1", "proj", "alice")).toBeNull();
  });

  it("returns null when no requests exist", async () => {
    fakes.getDb.mockReturnValue(fakeDb([]));
    expect(await ConversationService.getConversationStats("conv-1", "proj", "alice")).toBeNull();
  });

  it("aggregates costs, tokens, modalities, tools, errors and elapsed time", async () => {
    fakes.discoverDescendantConversationIds.mockResolvedValue(new Set(["conv-1", "sub-1"]));
    fakes.getDb.mockReturnValue(
      fakeDb([
        requestDoc({
          estimatedCost: 0.02,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
          reasoningOutputTokens: 1,
          toolApiNames: ["read_file", "read_file", "write_file"],
          modalities: { textIn: true, imageIn: true },
          timestamp: "2026-10-30T10:00:00.000Z",
        }),
        requestDoc({
          estimatedCost: 0.03,
          inputTokens: 20,
          outputTokens: 7,
          provider: "online",
          model: "other-model",
          operation: "agent",
          toolApiNames: ["read_file"],
          success: false,
          timestamp: "2026-10-30T10:00:30.000Z",
          agentConversationId: "sub-1",
        }),
      ]),
    );

    const stats = await ConversationService.getConversationStats("conv-1", "proj", "alice");

    expect(stats).toMatchObject({
      agentConversationId: "conv-1",
      requestCount: 2,
      subAgentRequestCount: 1,
      totalCost: 0.05,
      totalInputTokens: 30,
      totalOutputTokens: 12,
      totalTokens: 42,
      totalCacheReadInputTokens: 3,
      totalCacheCreationInputTokens: 2,
      totalReasoningOutputTokens: 1,
      requestErrorCount: 1,
      totalElapsedTime: 30,
      createdAt: "2026-10-30T10:00:00.000Z",
      updatedAt: "2026-10-30T10:00:30.000Z",
    });
    expect(stats!.providers.sort()).toEqual(["lm-studio", "online"]);
    expect(stats!.models.sort()).toEqual(["model-x", "other-model"]);
    expect(stats!.operations.sort()).toEqual(["agent", "chat"]);
    expect(stats!.modalities).toEqual({ textIn: true, imageIn: true });
    expect(stats!.toolCounts).toEqual({ read_file: 3, write_file: 1 });
    expect(fakes.discoverDescendantConversationIds).toHaveBeenCalledWith(
      expect.anything(),
      "conv-1",
      { project: "proj", username: "alice" },
    );
  });

  it("treats missing optional fields as zero", async () => {
    fakes.getDb.mockReturnValue(
      fakeDb([
        {
          agentConversationId: "conv-1",
          timestamp: "2026-10-30T10:00:00.000Z",
          success: true,
        },
      ]),
    );
    const stats = await ConversationService.getConversationStats("conv-1", "proj", "alice");
    expect(stats).toMatchObject({
      totalCost: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      requestErrorCount: 0,
      subAgentRequestCount: 0,
      providers: [],
      models: [],
      operations: [],
      modalities: {},
      toolCounts: {},
    });
  });
});

describe("extractFiles", () => {
  it("returns the messages untouched without external storage", async () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(await extractFiles(messages as never)).toBe(messages);
  });

  it("uploads data-URL images and audio, keeping existing refs", async () => {
    fakes.isExternalStorage.mockReturnValue(true);
    fakes.uploadFile.mockImplementation(async (data: string) => ({ ref: `minio://${data.length}` }));

    const result = await extractFiles(
      [
        { role: "user", content: "hi", images: ["data:image/png;base64,aaa", "minio://existing", "https://x/y.png"] },
        { role: "assistant", content: "ok", audio: "data:audio/wav;base64,bbb" },
        { role: "user", content: "plain", images: [42] },
      ] as never,
      "proj",
      "alice",
    );

    expect(result[0].images).toEqual(["minio://25", "minio://existing", "https://x/y.png"]);
    expect(result[1].audio).toBe("minio://25");
    expect(result[2].images).toEqual(["42"]);
    expect(fakes.uploadFile).toHaveBeenCalledWith("data:image/png;base64,aaa", expect.any(String), "proj", "alice");
  });

  it("keeps the original image and drops the audio when upload fails", async () => {
    fakes.isExternalStorage.mockReturnValue(true);
    fakes.uploadFile.mockRejectedValue(new Error("minio down"));

    const result = await extractFiles([
      { role: "user", content: "hi", images: ["data:image/png;base64,aaa"], audio: "data:audio/wav;base64,bbb" },
    ] as never);

    expect(result[0].images).toEqual(["data:image/png;base64,aaa"]);
    expect(result[0].audio).toBe("data:audio/wav;base64,bbb");
  });
});

describe("computeModalities", () => {
  it("classifies documents, videos, images and audio", () => {
    const modalities = computeModalities([
      { role: "user", content: "hi", images: ["data:application/pdf;base64,x", "https://x/a.mp4"] },
      { role: "assistant", content: "ok", images: ["https://x/a.png"], audio: "minio://a.wav" },
      { role: "user", content: "doc", images: ["https://x/b.pdf"], documents: ["d1"] },
    ] as never);

    expect(modalities).toMatchObject({
      docIn: true,
      videoIn: true,
      imageOut: true,
      audioOut: true,
    });
  });

  it("flags web search, code execution, function calling and thinking", () => {
    const modalities = computeModalities([
      {
        role: "assistant",
        content: "> **Sources:** x\n```exec-1",
        thinking: "reasoning",
        toolCalls: [{ name: "search_web" }, { name: "code_execution" }, { name: "read_file" }],
      },
      { role: "tool", content: "result" },
    ] as never);

    expect(modalities).toMatchObject({
      webSearch: true,
      codeExecution: true,
      functionCalling: true,
      thinking: true,
      textOut: true,
    });
  });
});

describe("extractProviders and computeTotalCost", () => {
  it("collects providers from messages and settings, skipping deleted messages", () => {
    expect(
      extractProviders(
        [
          { role: "user", content: "a", provider: "LM-Studio" },
          { role: "assistant", content: "b", provider: "online", deleted: true },
        ] as never,
        { provider: "Online" } as never,
      ),
    ).toEqual(["lm-studio", "online"]);
    expect(extractProviders([], null)).toEqual([]);
  });

  it("sums estimated costs ignoring deleted messages", () => {
    expect(
      computeTotalCost([
        { role: "user", content: "a", estimatedCost: 0.5 },
        { role: "assistant", content: "b", estimatedCost: 0.25 },
        { role: "assistant", content: "c", estimatedCost: 1, deleted: true },
        { role: "user", content: "d" },
      ] as never),
    ).toBe(0.75);
    expect(computeTotalCost([])).toBe(0);
  });
});

describe("buildConversationPatchFields", () => {
  it("builds only the updatedAt field for an empty patch", () => {
    const fields = buildConversationPatchFields({});
    expect(Object.keys(fields)).toEqual(["updatedAt"]);
  });

  it("derives modalities, providers, cost and model names from messages", () => {
    const fields = buildConversationPatchFields({
      title: "renamed",
      messages: [
        { role: "user", content: "hi", provider: "lm-studio" },
        { role: "assistant", content: "ok", model: "model-x", estimatedCost: 0.1 },
        { role: "assistant", content: "old", model: "model-y", deleted: true },
      ] as never,
      settings: { model: "fallback-model" } as never,
    });

    expect(fields).toMatchObject({
      title: "renamed",
      providers: ["lm-studio"],
      totalCost: 0.1,
      modelNames: ["model-x"],
      settings: { model: "fallback-model", systemPrompt: "" },
    });
  });

  it("falls back to the settings model when no assistant model is present", () => {
    const fields = buildConversationPatchFields({
      messages: [{ role: "user", content: "hi" }] as never,
      settings: { model: "settings-model" } as never,
      systemPrompt: "be brief",
    });
    expect(fields.modelNames).toEqual(["settings-model"]);
    expect(fields.settings).toEqual({ model: "settings-model", systemPrompt: "be brief" });
  });

  it("passes the system prompt through without settings", () => {
    const fields = buildConversationPatchFields({ systemPrompt: "prompt only" });
    expect(fields.systemPrompt).toBe("prompt only");
    expect(fields.settings).toBeUndefined();
  });
});

describe("request-cost enrichment", () => {
  it("raises totals from request logs and copies error counts", () => {
    const conversations: Any[] = [
      { id: "conv-1", totalCost: 0.1 },
      { id: "conv-2" },
      { id: "conv-3", totalCost: 0.5 },
    ];
    enrichConversationsWithRequestCosts(conversations, [
      { _id: "conv-1", totalCost: 0.3, requestErrorCount: 2 },
      { _id: "conv-2", totalCost: 0, requestErrorCount: 0 },
      { _id: "conv-3", totalCost: 0.2 },
    ]);

    expect(conversations[0]).toEqual({ id: "conv-1", totalCost: 0.3, requestErrorCount: 2 });
    expect(conversations[1]).toEqual({ id: "conv-2" });
    expect(conversations[2]).toEqual({ id: "conv-3", totalCost: 0.5 });
  });

  it("does nothing for an empty conversation list", () => {
    const conversations: Any[] = [];
    enrichConversationsWithRequestCosts(conversations, [{ _id: "conv-1", totalCost: 1 }]);
    expect(conversations).toEqual([]);
  });

  it("enriches a single conversation", () => {
    const conversation: Any = { id: "conv-1", totalCost: 0.1 };
    enrichSingleConversationCost(conversation, [{ _id: "conv-1", totalCost: 0.4, requestErrorCount: 3 }]);
    expect(conversation).toEqual({ id: "conv-1", totalCost: 0.4, requestErrorCount: 3 });

    const untouched: Any = { id: "conv-2" };
    enrichSingleConversationCost(untouched, []);
    expect(untouched).toEqual({ id: "conv-2" });
  });
});

describe("ConversationService.appendMessages", () => {
  const makeCollection = (existing: Any | null) => {
    const updateOne = vi.fn(async () => ({ matchedCount: 1 }));
    const findOne = vi.fn(async () => existing);
    fakes.getCollection.mockReturnValue({ updateOne, findOne });
    return { updateOne, findOne };
  };

  it("auto-creates a conversation with defaults and derives model names", async () => {
    const messages = [
      { role: "user", content: "Explain the deployment pipeline in detail" },
      { role: "assistant", content: "Sure", model: "model-x" },
    ];
    const collection = makeCollection({
      id: "conv-new",
      title: "New Conversation",
      messages,
      settings: {},
    });

    const result = await ConversationService.appendMessages("conv-new", "proj", "alice", messages as never);

    const upsert = collection.updateOne.mock.calls[0] as unknown as Any[];
    const update = upsert[1] as Any;
    expect(update.$set).toEqual({ updatedAt: expect.any(String) });
    expect(update.$setOnInsert).toMatchObject({
      title: "New Conversation",
      systemPrompt: "",
      modalities: expect.objectContaining({ textIn: false, textOut: false, imageIn: false }),
      providers: [],
      totalCost: 0,
      isGenerating: true,
      createdAt: expect.any(String),
    });
    expect(result.modelNames).toEqual(["model-x"]);
    expect(result.title).toBe("Explain the deployment pipeline in detail");
    expect(collection.updateOne).toHaveBeenCalledTimes(2);
  });

  it("applies metadata, lineage and trace fields without duplicating setOnInsert keys", async () => {
    const meta = {
      title: "Given title",
      systemPrompt: "be brief",
      settings: { model: "settings-model", thinking: true },
      traceId: "trace-1",
      parentAgentConversationId: "parent-ac",
      parentConversationId: "parent-conv",
      workspaceRoot: "/ws",
      synthetic: true,
      agent: "CODING",
    };
    const collection = makeCollection({
      id: "conv-2",
      title: "Given title",
      messages: [{ role: "user", content: "hello" }],
      settings: meta.settings,
    });

    const result = await ConversationService.appendMessages(
      "conv-2",
      "proj",
      "alice",
      [{ role: "user", content: "hello" }] as never,
      meta as never,
    );

    const update = (collection.updateOne.mock.calls[0] as unknown as Any[])[1] as Any;
    expect(update.$set).toMatchObject({
      title: "Given title",
      systemPrompt: "be brief",
      traceId: "trace-1",
      parentAgentConversationId: "parent-ac",
      parentConversationId: "parent-conv",
      workspaceRoot: "/ws",
    });
    expect(update.$set.settings).toEqual({ model: "settings-model", thinking: true, systemPrompt: "be brief" });
    expect(update.$setOnInsert).toMatchObject({ synthetic: true, agent: "CODING" });
    expect(update.$setOnInsert).not.toHaveProperty("title");
    expect(update.$setOnInsert).not.toHaveProperty("systemPrompt");
    expect(update.$setOnInsert).not.toHaveProperty("settings");
    expect(update.$setOnInsert).not.toHaveProperty("traceId");
    expect(update.$setOnInsert).not.toHaveProperty("parentAgentConversationId");
    expect(update.$setOnInsert).not.toHaveProperty("parentConversationId");
    expect(update.$setOnInsert).not.toHaveProperty("workspaceRoot");
    expect(result.modelNames).toEqual(["settings-model"]);
  });

  it("throws when the upserted conversation cannot be re-read", async () => {
    makeCollection(null);
    await expect(
      ConversationService.appendMessages("conv-3", "proj", "alice", [{ role: "user", content: "hi" }] as never),
    ).rejects.toThrow("Conversation not found: conv-3");
  });
});

describe("buildResumeMessages", () => {
  it("re-emits each tool call followed by its stored result", async () => {
    const { buildResumeMessages } = await import("../conversation/ConversationService.ts");
    const stored = [
      { role: "system", content: "sys" },
      { role: "user", content: "do it" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [
          { id: "c1", name: "read_file", args: { path: "/a" } },
          { id: "c2", name: "list_dir", args: {} },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "file body" },
      { role: "assistant", content: "done" },
    ];

    const out = buildResumeMessages(stored as never);
    expect(out).toContainEqual({
      role: "assistant",
      content: "working",
      toolCalls: [
        { id: "c1", name: "read_file", args: { path: "/a" } },
        { id: "c2", name: "list_dir", args: {} },
      ],
    });
    expect(out).toContainEqual({ role: "tool", tool_call_id: "c1", content: "file body" });
    expect(out).toContainEqual({ role: "tool", tool_call_id: "c2", content: "[result not recorded]" });
    expect(out[0]).toEqual({ role: "system", content: "sys" });
  });

  it("falls back to the embedded call result and synthesises ids", async () => {
    const { buildResumeMessages } = await import("../conversation/ConversationService.ts");
    const out = buildResumeMessages([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "read_file", result: { ok: true } },
          { name: "list_dir", result: null },
        ],
      },
    ] as never);

    expect(out[0]).toMatchObject({
      role: "assistant",
      toolCalls: [
        { id: "resume_0_0", name: "read_file", args: {} },
        { id: "resume_0_1", name: "list_dir", args: {} },
      ],
    });
    expect(out[1]).toEqual({ role: "tool", tool_call_id: "resume_0_0", content: '{"ok":true}' });
    expect(out[2]).toEqual({ role: "tool", tool_call_id: "resume_0_1", content: "[result not recorded]" });
  });

  it("skips tool calls without names and keeps the plain assistant text", async () => {
    const { buildResumeMessages } = await import("../conversation/ConversationService.ts");
    const out = buildResumeMessages([
      { role: "assistant", content: "plain answer", toolCalls: [{ id: "bad" }] },
      { role: "user", content: "" },
      { role: "assistant", content: null },
    ] as never);

    expect(out).toEqual([{ role: "assistant", content: "plain answer" }]);
  });

  it("normalises role alternation in the emitted history", async () => {
    const { buildResumeMessages } = await import("../conversation/ConversationService.ts");
    const out = buildResumeMessages([
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ] as never);

    expect(out).toEqual([{ role: "user", content: "one\n\ntwo" }]);
  });

  it("getMessages returns the resume history for the conversation", async () => {
    const findOne = vi.fn(async () => ({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    }));
    fakes.getCollection.mockReturnValue({ findOne });

    const out = await ConversationService.getMessages("conv-9", "proj", "alice");
    expect(out).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(findOne).toHaveBeenCalledWith(
      { id: "conv-9", project: "proj", username: "alice" },
      { projection: { messages: 1 } },
    );
  });

  it("getMessages returns an empty history when the document is missing", async () => {
    fakes.getCollection.mockReturnValue({ findOne: vi.fn(async () => null) });
    await expect(ConversationService.getMessages("missing", "proj", "alice")).resolves.toEqual([]);
  });
});
