/**
 * WorkflowExecutionService — statement coverage of the graph executor and the
 * per-modality node executors. Every external boundary (chat generation,
 * providers, MinIO, media resolution, embeddings) is a deterministic fake;
 * the service itself is real and every assertion checks the state the service
 * returns or emits, not that a fake was touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";

const fakes = vi.hoisted(() => ({
  handleConversation: vi.fn(),
  handleAgent: vi.fn(),
  getProvider: vi.fn(),
  resolveMediaReference: vi.fn(),
  embedGenerate: vi.fn(),
  uploadFile: vi.fn(),
  getBucketUrl: vi.fn(),
}));

vi.mock("../../core/chat/ChatGeneration.ts", () => ({
  handleConversation: fakes.handleConversation,
  handleAgent: fakes.handleAgent,
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../MediaResolutionService.ts", () => ({
  resolveMediaReference: fakes.resolveMediaReference,
}));
vi.mock("../EmbeddingService.ts", () => ({ default: { generate: fakes.embedGenerate } }));
vi.mock("../FileService.ts", () => ({ default: { uploadFile: fakes.uploadFile } }));
vi.mock("../../wrappers/MinioWrapper.ts", () => ({
  default: { getBucketUrl: fakes.getBucketUrl },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import WorkflowExecutionService from "../WorkflowExecutionService.ts";

type Emitted = Record<string, unknown>;
type Node = Record<string, unknown>;
type InputDatum = { type: string; data: unknown; sourceNodeId: string | null };

const context = { project: "proj", username: "alice" };

/** Chat generation fake that replays a fixed event list through the emit callback. */
function replay(events: Emitted[]) {
  return async (_params: unknown, emit: (event: Emitted) => void) => {
    for (const event of events) emit(event);
  };
}

function modelNode(overrides: Node = {}): Node {
  return {
    id: "model-1",
    nodeType: "model",
    provider: "mock",
    modelName: "mock-model",
    outputTypes: ["text"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  fakes.getBucketUrl.mockReturnValue("http://minio.local/bucket");
  fakes.uploadFile.mockResolvedValue({ ref: "minio://generations/out.png" });
  fakes.embedGenerate.mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
  fakes.resolveMediaReference.mockResolvedValue({
    providerRef: "data:image/jpeg;base64,AAAA",
    storageRef: "minio://uploads/a.jpg",
  });
});

describe("topologicalSort", () => {
  it("orders a chain and tolerates edges pointing at unknown nodes", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [
      { sourceNodeId: "a", targetNodeId: "b" },
      { sourceNodeId: "b", targetNodeId: "c" },
      { sourceNodeId: "c", targetNodeId: "ghost" },
    ];
    const sorted = WorkflowExecutionService.topologicalSort(nodes as never, edges as never);
    expect(sorted.slice(0, 3)).toEqual(["a", "b", "c"]);
  });

  it("keeps independent roots in declaration order", () => {
    const nodes = [{ id: "root2" }, { id: "root1" }];
    const sorted = WorkflowExecutionService.topologicalSort(nodes as never, [] as never);
    expect(sorted).toEqual(["root2", "root1"]);
  });
});

describe("resolveEndpoint", () => {
  it("maps every modality combination", () => {
    const audioInput: InputDatum[] = [{ type: "audio", data: "x", sourceNodeId: null }];
    const resolve = (outputTypes: string[] | undefined, inputData: InputDatum[]) =>
      WorkflowExecutionService.resolveEndpoint(
        modelNode({ outputTypes }) as never,
        inputData as never,
      );

    expect(resolve(["embedding", "image"], [])).toBe("modalityToEmbedding");
    expect(resolve(["image"], [])).toBe("textToImage");
    expect(resolve(["text"], audioInput)).toBe("audioToText");
    expect(resolve(["audio"], audioInput)).toBe("textToSpeech");
    expect(resolve(undefined, [])).toBe("textToText");
    expect(resolve(["text"], [])).toBe("textToText");
  });
});

describe("resolveMinioRefToUrl", () => {
  it("rewrites minio references through the bucket base URL", () => {
    expect(WorkflowExecutionService.resolveMinioRefToUrl("minio://a/b.png")).toBe(
      "http://minio.local/bucket/a/b.png",
    );
  });

  it("returns null when no bucket base is configured", () => {
    fakes.getBucketUrl.mockReturnValue(null);
    expect(WorkflowExecutionService.resolveMinioRefToUrl("minio://a/b.png")).toBeNull();
  });

  it("passes through data and http references and rejects the rest", () => {
    expect(WorkflowExecutionService.resolveMinioRefToUrl("data:image/png;base64,AA")).toBe(
      "data:image/png;base64,AA",
    );
    expect(WorkflowExecutionService.resolveMinioRefToUrl("https://example.test/x.png")).toBe(
      "https://example.test/x.png",
    );
    expect(WorkflowExecutionService.resolveMinioRefToUrl("s3://nope")).toBeNull();
    expect(WorkflowExecutionService.resolveMinioRefToUrl(42)).toBeNull();
  });
});

describe("resolveToDataUrl", () => {
  it("returns null for empty references", async () => {
    expect(await WorkflowExecutionService.resolveToDataUrl(null)).toBeNull();
    expect(await WorkflowExecutionService.resolveToDataUrl("")).toBeNull();
  });

  it("resolves object references by minio key, base64 payload or mime", async () => {
    expect(
      await WorkflowExecutionService.resolveToDataUrl({ minioRef: "minio://img.png" }),
    ).toBe("http://minio.local/bucket/img.png");
    expect(await WorkflowExecutionService.resolveToDataUrl({ data: "QUJD" })).toBe(
      "data:image/png;base64,QUJD",
    );
    expect(
      await WorkflowExecutionService.resolveToDataUrl({ imageData: "QUJD", mimeType: "image/webp" }),
    ).toBe("data:image/webp;base64,QUJD");
    expect(await WorkflowExecutionService.resolveToDataUrl({ mimeType: "image/png" })).toBeNull();
    expect(await WorkflowExecutionService.resolveToDataUrl({})).toBeNull();
  });

  it("resolves string references", async () => {
    expect(await WorkflowExecutionService.resolveToDataUrl("data:image/png;base64,QQ==")).toBe(
      "data:image/png;base64,QQ==",
    );
    expect(await WorkflowExecutionService.resolveToDataUrl("minio://k.png")).toBe(
      "http://minio.local/bucket/k.png",
    );
    expect(await WorkflowExecutionService.resolveToDataUrl(17)).toBeNull();
  });
});

describe("executeModelNode — text to text", () => {
  it("streams chunks into outputs.text and resolves image events", async () => {
    fakes.handleConversation.mockImplementation(
      replay([
        { type: "chunk", content: "Hello " },
        { type: "chunk", content: "world" },
        { type: "image", minioRef: "minio://gen/chart.png" },
      ]),
    );

    const { outputs, conversationId } = await WorkflowExecutionService.executeModelNode(
      modelNode({ label: "Writer", systemPrompt: "Be terse" }) as never,
      [{ type: "text", data: "Summarise", sourceNodeId: "in-1" }] as never,
      context as never,
    );

    expect(outputs.text).toBe("Hello world");
    expect(outputs.image).toBe("http://minio.local/bucket/gen/chart.png");
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);

    const params = fakes.handleConversation.mock.calls[0][0];
    expect(params.messages).toEqual([{ role: "user", content: "Summarise" }]);
    expect(params.conversationMeta.title).toBe("🔀 Writer · mock/mock-model");
    expect(params.conversationMeta.systemPrompt).toBe("Be terse");
  });

  it("uses handleAgent and enables the tool schemas when tools are piped in", async () => {
    fakes.handleAgent.mockImplementation(replay([{ type: "chunk", content: "done" }]));
    const schemas = [
      { type: "function", function: { name: "read_file", description: "read" } },
      { type: "function", function: { name: "" } },
    ];

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode() as never,
      [] as never,
      context as never,
      { toolSchemas: schemas as never },
    );

    expect(outputs.text).toBe("done");
    expect(fakes.handleAgent).toHaveBeenCalledTimes(1);
    const params = fakes.handleAgent.mock.calls[0][0];
    expect(params.enabledTools).toEqual(["read_file", ""]);
    expect(params.functionCallingEnabled).toBe(true);
    expect(params.agenticLoopEnabled).toBe(true);
    expect(params.autoApprove).toBe(true);
    expect(params.maxIterations).toBe(10);
  });

  it("throws the model's error event", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "error", message: "boom" }]));
    await expect(
      WorkflowExecutionService.executeModelNode(modelNode() as never, [] as never, context as never),
    ).rejects.toThrow("boom");
  });

  it("falls back to a generic message when the error event has no message", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "error" }]));
    await expect(
      WorkflowExecutionService.executeModelNode(modelNode() as never, [] as never, context as never),
    ).rejects.toThrow("Model generation failed");
  });

  it("keeps an inline base64 image event and ignores images with no payload", async () => {
    fakes.handleConversation.mockImplementation(
      replay([{ type: "image", data: "QUJD", mimeType: "image/webp" }]),
    );
    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode() as never,
      [] as never,
      context as never,
    );
    expect(outputs.image).toBe("data:image/webp;base64,QUJD");

    fakes.handleConversation.mockImplementation(replay([{ type: "image" }]));
    const second = await WorkflowExecutionService.executeModelNode(
      modelNode() as never,
      [] as never,
      context as never,
    );
    expect(second.outputs.image).toBeUndefined();
  });

  it("merges piped text and media into the node's own conversation", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "ok" }]));
    const node = modelNode({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "first" },
        { role: "user", content: "second" },
        { role: "user", content: "" },
        { role: "assistant", content: "", images: [] },
      ],
    });

    await WorkflowExecutionService.executeModelNode(
      node as never,
      [
        { type: "text", data: "piped", sourceNodeId: "a" },
        { type: "text", data: "more", sourceNodeId: "b" },
        { type: "image", data: "minio://x/y.png", sourceNodeId: "c" },
        { type: "video", data: "minio://v.mp4", sourceNodeId: "e" },
        { type: "pdf", data: "minio://p.pdf", sourceNodeId: "f" },
      ] as never,
      context as never,
    );

    const messages = fakes.handleConversation.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({ role: "system", content: "sys" });
    expect(messages[1]).toEqual({ role: "user", content: "first" });
    expect(messages[2]).toEqual({ role: "user", content: "second" });
    expect(messages[3]).toEqual({
      role: "user",
      content: "piped\n\nmore",
      images: ["minio://x/y.png"],
      video: ["minio://v.mp4"],
      pdf: ["minio://p.pdf"],
    });
    // Empty assistant message is normalised to empty content.
    expect(messages[4]).toEqual({ role: "assistant", content: "" });
  });

  it("uses a piped conversation transcript, appending a user turn when none exists", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "ok" }]));
    await WorkflowExecutionService.executeModelNode(
      modelNode() as never,
      [
        {
          type: "conversation",
          data: [
            { role: "assistant", content: "hi" },
            { role: "assistant", content: "", images: [] },
          ],
          sourceNodeId: "conv",
        },
        { type: "text", data: "follow-up", sourceNodeId: "t" },
      ] as never,
      context as never,
    );

    const messages = fakes.handleConversation.mock.calls[0][0].messages;
    expect(messages).toEqual([
      { role: "assistant", content: "hi" },
      { role: "user", content: "follow-up" },
    ]);
  });
});

describe("executeModelNode — text to image", () => {
  it("builds system + user messages from node messages, piped text and images", async () => {
    fakes.handleConversation.mockImplementation(
      replay([
        { type: "chunk", content: "rendered" },
        { type: "image", data: "QUJD", mimeType: "image/png" },
      ]),
    );

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({
        outputTypes: ["image"],
        messages: [
          { role: "system", content: "Paint it" },
          { role: "user", content: "a cat", images: ["minio://in/cat.png"] },
        ],
      }) as never,
      [{ type: "text", data: "in watercolour", sourceNodeId: "t" }] as never,
      context as never,
    );

    expect(outputs.image).toBe("data:image/png;base64,QUJD");
    expect(outputs.text).toBe("rendered");

    const messages = fakes.handleConversation.mock.calls[0][0].messages;
    expect(messages[0]).toEqual({ role: "system", content: "Paint it" });
    expect(messages[1]).toEqual({
      role: "user",
      content: "a cat\n\nin watercolour",
      images: ["minio://in/cat.png"],
    });
  });

  it("falls back to the raw piped prompt when the node carries no messages", async () => {
    fakes.handleConversation.mockImplementation(replay([]));
    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["image"] }) as never,
      [
        { type: "text", data: "draw a tree", sourceNodeId: "t" },
        { type: "image", data: "minio://ref/tree.png", sourceNodeId: "i" },
      ] as never,
      context as never,
    );

    expect(outputs.image).toBeUndefined();
    expect(outputs.text).toBeUndefined();
    const messages = fakes.handleConversation.mock.calls[0][0].messages;
    expect(messages).toEqual([
      { role: "user", content: "draw a tree", images: ["minio://ref/tree.png"] },
    ]);
  });

  it("throws on an error event and keeps media-bearing conversation transcripts", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "error", message: "no gpu" }]));
    await expect(
      WorkflowExecutionService.executeModelNode(
        modelNode({ outputTypes: ["image"] }) as never,
        [] as never,
        context as never,
      ),
    ).rejects.toThrow("no gpu");

    fakes.handleConversation.mockImplementation(replay([]));
    await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["image"] }) as never,
      [
        {
          type: "conversation",
          data: [
            { role: "assistant", content: "", images: [] },
            { role: "user", content: "", images: ["minio://a.png"] },
          ],
          sourceNodeId: "conv",
        },
      ] as never,
      context as never,
    );
    const messages = fakes.handleConversation.mock.calls[1][0].messages;
    expect(messages).toEqual([{ role: "user", content: "", images: ["minio://a.png"] }]);
  });
});

describe("executeModelNode — audio to text", () => {
  const transcribeAudio = vi.fn();

  it("transcribes a data URL audio payload and forwards the prompt", async () => {
    transcribeAudio.mockResolvedValue({ text: "spoken words" });
    fakes.resolveMediaReference.mockResolvedValue({
      providerRef: "data:audio/wav;base64,AAAA",
      storageRef: "minio://uploads/clip.wav",
    });
    fakes.getProvider.mockReturnValue({ transcribeAudio });

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["text"], userPrompt: "Transcribe" }) as never,
      [{ type: "audio", data: "minio://audio/clip.mp3", sourceNodeId: "a" }] as never,
      context as never,
    );

    expect(outputs.text).toBe("spoken words");
    expect(fakes.resolveMediaReference).toHaveBeenCalledWith("minio://audio/clip.mp3", "proj", "alice");
    const [buffer, mimeType, model, options] = transcribeAudio.mock.calls[0];
    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.toString("base64")).toBe("AAAA");
    expect(mimeType).toBe("audio/wav");
    expect(model).toBe("mock-model");
    expect(options).toEqual({ prompt: "Transcribe" });
  });

  it("defaults the mime type to audio/mpeg and omits the prompt", async () => {
    transcribeAudio.mockResolvedValue({});
    fakes.getProvider.mockReturnValue({ transcribeAudio });
    fakes.resolveMediaReference.mockResolvedValue({ providerRef: "QUJD", storageRef: "minio://x" });

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["text"], systemPrompt: undefined, userPrompt: undefined }) as never,
      [{ type: "audio", data: "minio://audio/x.mp3", sourceNodeId: "a" }] as never,
      context as never,
    );

    expect(outputs.text).toBe("");
    const [, mimeType, , options] = transcribeAudio.mock.calls[0];
    expect(mimeType).toBe("audio/mpeg");
    expect(options).toEqual({});
  });

  it("rejects a provider without transcription support", async () => {
    fakes.getProvider.mockReturnValue({});
    await expect(
      WorkflowExecutionService.executeModelNode(
        modelNode({ outputTypes: ["text"], provider: "stub" }) as never,
        [{ type: "audio", data: "x", sourceNodeId: "a" }] as never,
        context as never,
      ),
    ).rejects.toThrow('Provider "stub" does not support audio transcription');
  });
});

describe("executeModelNode — text to speech", () => {
  const generateSpeech = vi.fn();

  it("uploads node-stream audio and reports the MinIO reference", async () => {
    generateSpeech.mockResolvedValue({
      stream: Readable.from([Buffer.from("one"), Buffer.from("two")]),
      contentType: "audio/wav",
    });
    fakes.getProvider.mockReturnValue({ generateSpeech });

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["audio"] }) as never,
      [{ type: "text", data: "say this", sourceNodeId: "t" }] as never,
      context as never,
    );

    expect(generateSpeech).toHaveBeenCalledWith("say this", undefined, { model: "mock-model" });
    expect(fakes.uploadFile).toHaveBeenCalledWith(
      "data:audio/wav;base64,b25ldHdv",
      "generations",
      "proj",
      "alice",
    );
    expect(outputs.audio).toBe("http://minio.local/bucket/generations/out.png");
  });

  it("consumes web ReadableStream audio and falls back to the data URL when the upload fails", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    generateSpeech.mockResolvedValue({ stream });
    fakes.getProvider.mockReturnValue({ generateSpeech });
    fakes.uploadFile.mockRejectedValue(new Error("minio down"));

    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["audio"] }) as never,
      [] as never,
      context as never,
    );

    expect(outputs.audio).toBe("data:audio/mpeg;base64,AQID");
  });

  it("rejects a missing stream and a provider without speech support", async () => {
    generateSpeech.mockResolvedValue({ stream: null });
    fakes.getProvider.mockReturnValue({ generateSpeech });
    await expect(
      WorkflowExecutionService.executeModelNode(
        modelNode({ outputTypes: ["audio"] }) as never,
        [] as never,
        context as never,
      ),
    ).rejects.toThrow("Speech generation returned no stream");

    fakes.getProvider.mockReturnValue({});
    await expect(
      WorkflowExecutionService.executeModelNode(
        modelNode({ outputTypes: ["audio"], provider: "stub" }) as never,
        [] as never,
        context as never,
      ),
    ).rejects.toThrow('Provider "stub" does not support text-to-speech');
  });
});

describe("executeModelNode — modality to embedding", () => {
  it("embeds plain text, prefixing the node's user prompt", async () => {
    const { outputs } = await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["embedding"], userPrompt: "Index:" }) as never,
      [
        { type: "text", data: "alpha", sourceNodeId: "a" },
        { type: "text", data: "beta", sourceNodeId: "b" },
      ] as never,
      context as never,
    );

    expect(outputs.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(fakes.embedGenerate).toHaveBeenCalledWith("Index:\n\nalpha\n\nbeta", {
      provider: "mock",
      model: "mock-model",
      project: "proj",
      username: "alice",
      source: "workflow",
      endpoint: "/workflows/run",
    });
  });

  it("embeds only the node prompt when nothing is piped", async () => {
    await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["embedding"], userPrompt: "solo" }) as never,
      [] as never,
      context as never,
    );
    expect(fakes.embedGenerate.mock.calls[0][0]).toBe("solo");
  });

  it("builds multimodal parts for images and audio", async () => {
    fakes.resolveMediaReference
      .mockResolvedValueOnce({ providerRef: "data:image/png;base64,SU1H", storageRef: "minio://a" })
      .mockResolvedValueOnce({ providerRef: "raw-audio-base64", storageRef: "minio://b" });

    await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["embedding"] }) as never,
      [
        { type: "text", data: "caption", sourceNodeId: "t" },
        { type: "image", data: "minio://img.png", sourceNodeId: "i" },
        { type: "audio", data: "minio://clip.mp3", sourceNodeId: "a" },
      ] as never,
      context as never,
    );

    expect(fakes.embedGenerate.mock.calls[0][0]).toEqual([
      { text: "caption" },
      { inlineData: { data: "SU1H", mimeType: "image/png" } },
      { inlineData: { data: "raw-audio-base64", mimeType: "audio/mpeg" } },
    ]);
  });

  it("passes an empty multimodal part list when there is no text or media", async () => {
    await WorkflowExecutionService.executeModelNode(
      modelNode({ outputTypes: ["embedding"] }) as never,
      [] as never,
      context as never,
    );
    expect(fakes.embedGenerate.mock.calls[0][0]).toEqual([]);
  });
});

describe("executeWorkflow — graph execution", () => {
  const edge = (sourceNodeId: string, targetNodeId: string, sourceModality: string, targetModality: string) => ({
    sourceNodeId,
    targetNodeId,
    sourceModality,
    targetModality,
  });

  it("executes input, tools, model and viewer nodes and reports every completion", async () => {
    fakes.handleAgent.mockImplementation(replay([{ type: "chunk", content: "answer" }]));
    const completed: Array<{ id: string; outputs: Record<string, unknown> }> = [];
    const partials: Array<{ id: string; outputs: Record<string, unknown> }> = [];

    const nodes = [
      { id: "prompt", nodeType: "input", modality: "text", content: "hello" },
      {
        id: "tools",
        nodeType: "tools",
        builtInTools: [{ name: "search", description: "find" }],
        customTools: [
          {
            name: "lookup",
            description: "custom lookup",
            parameters: [
              { name: "query", type: "string", description: "q", required: true },
              { name: "mode", enum: ["fast", "slow"] },
              { type: "string" },
            ],
          },
          { name: "disabled_tool", _id: "disabled_tool" },
        ],
        disabledTools: ["disabled_tool"],
      },
      modelNode({ id: "writer", label: "Writer", outputTypes: ["text"] }),
      { id: "view", nodeType: "viewer" },
    ];
    const edges = [
      edge("prompt", "writer", "text", "text"),
      edge("tools", "writer", "tools", "tools"),
      edge("writer", "view", "text", "final"),
    ];

    const result = await WorkflowExecutionService.executeWorkflow(
      nodes as never,
      edges as never,
      context as never,
      {
        onNodeStart: (nodeId) => completed.push({ id: nodeId, outputs: {} }),
        onNodeComplete: (nodeId, outputs) => completed.push({ id: nodeId, outputs }),
        onViewerPartial: (nodeId, outputs) => partials.push({ id: nodeId, outputs }),
      },
    );

    expect(result.nodeOutputs.prompt).toEqual({ text: "hello" });
    expect(result.nodeOutputs.writer).toEqual({ text: "answer" });
    expect(result.nodeOutputs.view).toEqual({ final: "answer" });
    expect(result.conversationIds).toHaveLength(1);

    const tools = result.nodeOutputs.tools as {
      tools: { schemas: Array<Record<string, unknown>>; customMap: Map<string, unknown> };
    };
    expect(tools.tools.schemas).toHaveLength(2);
    expect(tools.tools.schemas[0]).toEqual({
      type: "function",
      function: { name: "search", description: "find", parameters: { type: "object", properties: {}, required: [] } },
    });
    expect(tools.tools.schemas[1]).toEqual({
      type: "function",
      function: {
        name: "lookup",
        description: "custom lookup",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "q" },
            mode: { type: "string", description: "", enum: ["fast", "slow"] },
          },
          required: ["query"],
        },
      },
    });
    expect([...tools.tools.customMap.keys()]).toEqual(["lookup"]);

    // The model received the piped prompt and the tools node's schemas.
    const agentParams = fakes.handleAgent.mock.calls[0][0];
    expect(agentParams.enabledTools).toEqual(["search", "lookup"]);
    expect(agentParams.messages).toEqual([{ role: "user", content: "hello" }]);

    expect(partials).toEqual([{ id: "view", outputs: { final: "answer" } }]);
    expect(completed.map((entry) => entry.id)).toEqual([
      "prompt", "prompt", "tools", "tools", "writer", "writer", "view", "view",
    ]);
  });

  it("returns an empty tools output when every tool is disabled and no custom tool has a name", async () => {
    const nodes = [
      { id: "tools", nodeType: "tools", disabledTools: ["only"] },
      { id: "tools2", nodeType: "tools", customTools: [{ _id: "x", description: "no name" }] },
    ];
    const result = await WorkflowExecutionService.executeWorkflow(
      nodes as never,
      [] as never,
      context as never,
      {},
    );
    expect(result.nodeOutputs.tools).toEqual({
      tools: { schemas: [], customMap: new Map() },
    });
    const schemas = (result.nodeOutputs.tools2 as { tools: { schemas: Array<{ function: { name?: string } }> } })
      .tools.schemas;
    expect(schemas).toHaveLength(1);
    expect(schemas[0].function.name).toBeUndefined();
  });

  it("applies conversation input connections for text and every media modality", async () => {
    const nodes = [
      { id: "textIn", nodeType: "input", modality: "text", content: "piped" },
      { id: "imageIn", nodeType: "input", modality: "image", content: "minio://img.png" },
      { id: "audioIn", nodeType: "input", modality: "audio", content: "minio://a.mp3" },
      { id: "videoIn", nodeType: "input", modality: "video", content: "minio://v.mp4" },
      { id: "pdfIn", nodeType: "input", modality: "pdf", content: "minio://d.pdf" },
      { id: "emptyIn", nodeType: "input" },
      {
        id: "conv",
        nodeType: "input",
        modality: "conversation",
        messages: [{ role: "user", content: "seed" }, { role: "assistant", content: "reply" }],
      },
    ];
    const edges = [
      edge("textIn", "conv", "text", "0.text"),
      edge("imageIn", "conv", "image", "0.image"),
      edge("audioIn", "conv", "audio", "0.audio"),
      edge("videoIn", "conv", "video", "1.video"),
      edge("pdfIn", "conv", "pdf", "1.pdf"),
      edge("emptyIn", "conv", "nothing", "0.text"),
      edge("textIn", "conv", "text", "5.text"),
      edge("textIn", "conv", "text", "nodot"),
      edge("textIn", "conv", "text", "-1.text"),
    ];

    const result = await WorkflowExecutionService.executeWorkflow(
      nodes as never,
      edges as never,
      context as never,
      {},
    );

    expect(result.nodeOutputs.emptyIn).toEqual({});
    expect(result.nodeOutputs.conv).toEqual({
      conversation: [
        {
          role: "user",
          content: "seed\n\npiped",
          images: ["minio://img.png"],
          audio: ["minio://a.mp3"],
        },
        { role: "assistant", content: "reply", video: ["minio://v.mp4"], pdf: ["minio://d.pdf"] },
      ],
    });
  });

  it("records an erroring node, its error callback, and skips downstream nodes", async () => {
    fakes.handleConversation.mockRejectedValue(new Error("provider offline"));
    const errors: Array<{ id: string; error: string }> = [];
    const starts: string[] = [];

    const nodes = [
      { id: "prompt", nodeType: "input", modality: "text", content: "go" },
      modelNode({ id: "bad" }),
      modelNode({ id: "downstream" }),
    ];
    const edges = [edge("prompt", "bad", "text", "text"), edge("bad", "downstream", "text", "text")];

    const result = await WorkflowExecutionService.executeWorkflow(
      nodes as never,
      edges as never,
      context as never,
      {
        onNodeStart: (nodeId) => starts.push(nodeId),
        onNodeError: (nodeId, error) => errors.push({ id: nodeId, error }),
      },
    );

    expect(errors).toEqual([{ id: "bad", error: "provider offline" }]);
    expect(result.nodeOutputs.bad).toEqual({});
    expect(result.nodeOutputs.downstream).toEqual({});
    expect(starts).toEqual(["prompt", "bad"]);
    expect(result.conversationIds).toEqual([]);
  });

  it("stops before the next node when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const starts: string[] = [];
    const result = await WorkflowExecutionService.executeWorkflow(
      [{ id: "prompt", nodeType: "input", modality: "text", content: "x" }] as never,
      [] as never,
      context as never,
      { signal: controller.signal, onNodeStart: (nodeId) => starts.push(nodeId) },
    );
    expect(starts).toEqual([]);
    expect(result.nodeOutputs).toEqual({});
  });

  it("skips edge targets that are not declared nodes", async () => {
    const nodes = [{ id: "prompt", nodeType: "input", modality: "text", content: "x" }];
    const result = await WorkflowExecutionService.executeWorkflow(
      nodes as never,
      [edge("prompt", "ghost", "text", "text")] as never,
      context as never,
      {},
    );
    expect(Object.keys(result.nodeOutputs)).toEqual(["prompt"]);
  });

  it("merges static inputs and ignores empty static modalities", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "ok" }]));
    const result = await WorkflowExecutionService.executeWorkflow(
      [modelNode({ id: "writer", staticInputs: { text: "static prompt", image: "" } })] as never,
      [] as never,
      context as never,
      {},
    );
    expect(result.nodeOutputs.writer).toEqual({ text: "ok" });
    expect(fakes.handleConversation.mock.calls[0][0].messages).toEqual([
      { role: "user", content: "static prompt" },
    ]);
  });

  it("emits viewer partials only for modalities the source actually produced", async () => {
    fakes.handleConversation.mockImplementation(replay([{ type: "chunk", content: "text only" }]));
    const partials: Array<{ id: string; outputs: Record<string, unknown> }> = [];
    await WorkflowExecutionService.executeWorkflow(
      [modelNode({ id: "writer" }), { id: "view", nodeType: "viewer" }, { id: "input", nodeType: "input" }] as never,
      [edge("writer", "view", "image", "picture"), edge("writer", "view", "text", "text")] as never,
      context as never,
      { onViewerPartial: (nodeId, outputs) => partials.push({ id: nodeId, outputs }) },
    );
    expect(partials).toEqual([{ id: "view", outputs: { text: "text only" } }]);
  });
});
