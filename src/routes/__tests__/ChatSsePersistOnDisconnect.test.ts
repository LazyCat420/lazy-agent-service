// Tests for server-side persistence of /chat on client disconnect.
//
// Contract under test (mirrors /agent, see AgentRoutes.ts):
//  1. When the SSE client disconnects mid-stream, generation must CONTINUE
//     (persistOnDisconnect) and the final user+assistant messages must be
//     persisted via the conversation finalizer.
//  2. When a provider error (including an abort surfaced as a thrown error)
//     interrupts the stream, the user message and any partial assistant
//     output must still be persisted instead of being silently dropped.

import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/FileService.ts", () => ({
  default: { uploadFile: vi.fn(async () => ({ ref: "test-ref" })) },
}));
// vi.mock factories are hoisted and may only reference `vi` — the dynamic
// import here is required by Vitest's factory contract, not runtime selection.
vi.mock("../../services/harnesses/lifecycle/Finalizer.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/harnesses/lifecycle/Finalizer.ts")>();
  return {
    ...actual,
    finalizeTextGeneration: vi.fn(async (context: Record<string, unknown>, result: { text: string }) => {
      // Mirror the real finalizer's persistence contract: append the
      // assistant output to the conversation.
      const { appendAndFinalize } = await import("../../utils/ConversationUtilities.ts");
      await appendAndFinalize(
        (context.conversationId as string) || "",
        context.project as string,
        context.username as string,
        [{ role: "assistant", content: result.text }],
        context.conversationMeta as Record<string, unknown> | null,
        {},
      );
    }),
  };
});
vi.mock("../../providers/index.ts", () => ({ getProvider: vi.fn() }));
vi.mock("../../config.ts", () => ({
  TYPES: { TEXT: "text" },
  getDefaultModels: vi.fn(() => ({ "test-provider": "test-model" })),
  getPricing: vi.fn(() => ({})),
  getModelByName: vi.fn(() => ({ streaming: true })),
  getAgentDefaults: vi.fn(() => ({})),
}));
vi.mock("../../utils/CostCalculator.ts", () => ({
  estimateTokens: vi.fn(() => 1),
  calculateImageCost: vi.fn(() => 0),
  mergeUsage: vi.fn(),
}));
vi.mock("../../services/RequestLogger.ts", () => ({
  default: { logChatGeneration: vi.fn() },
}));
vi.mock("../../services/MediaResolutionService.ts", () => ({
  resolveMessageMediaReferences: vi.fn(async (messages: unknown) => messages),
}));
vi.mock("../../services/ConversationGenerationTracker.ts", () => ({
  default: { start: vi.fn(), end: vi.fn() },
}));
vi.mock("../../services/ToolOrchestratorService.ts", () => ({
  default: { getToolSchemas: vi.fn(() => []), executeTool: vi.fn() },
}));
vi.mock("../../services/LocalModelQueue.ts", () => ({
  default: {
    isLocal: vi.fn(() => false),
    acquire: vi.fn(async () => () => {}),
    _getQueue: vi.fn(() => ({ activeCount: 0, maxConcurrency: 1, pending: 0, totalInflight: 0 })),
  },
}));
vi.mock("../../services/local-provider/index.ts", () => ({
  default: { isNativeMCP: vi.fn(() => false), applyLocalDefaults: vi.fn() },
}));
vi.mock("../../providers/instance-registry.ts", () => ({
  getInstancesByType: vi.fn(() => []),
  getInstanceType: vi.fn(() => null),
  getInstance: vi.fn(() => undefined),
}));
vi.mock("../../utils/ModelResolution.ts", () => ({
  resolveModelForInstances: vi.fn(async () => ({ usable: [], modelOverrides: new Map() })),
}));
vi.mock("../../utils/ConversationUtilities.ts", () => ({
  markGenerating: vi.fn(async () => {}),
  appendAndFinalize: vi.fn(async () => {}),
}));

import chatRouter from "../../routes/ChatRoutes.ts";
import { getProvider } from "../../providers/index.ts";
import { appendAndFinalize, markGenerating } from "../../utils/ConversationUtilities.ts";

type AnyMock = ReturnType<typeof vi.fn>;

interface PersistedMessage {
  role: string;
  content: string;
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = "test-project";
    req.username = "test-user";
    next();
  });
  app.use("/chat", chatRouter);
  return app;
}

function listen(app: express.Express): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, port });
    });
  });
}

async function readUntil(stream: ReadableStream<Uint8Array>, marker: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let received = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value);
    if (received.includes(marker)) return;
  }
}

describe("POST /chat — server-side persistence on client disconnect", () => {
  let fakeProvider: { generateTextStream: AnyMock };
  let servers: Server[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    fakeProvider = { generateTextStream: vi.fn() };
    (getProvider as AnyMock).mockReturnValue(fakeProvider);
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
    vi.restoreAllMocks();
  });

  afterAll(() => {
    // no-op placeholder to keep hooks balanced
  });

  it("without a conversationId a disconnect aborts generation — nothing could stop it otherwise (audit D9)", async () => {
    let observedSignal: AbortSignal | undefined;
    fakeProvider.generateTextStream.mockImplementation(async function* (
      _messages: unknown,
      _model: string,
      opts: { signal?: AbortSignal },
    ) {
      observedSignal = opts?.signal;
      yield "partial";
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) return resolve();
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        setTimeout(resolve, 3_000);
      });
    });
    const { server, port } = await listen(createApp());
    servers.push(server);
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ provider: "test-provider", model: "test-model", messages: [{ role: "user", content: "Hi" }] }),
      signal: controller.signal,
    });
    await readUntil(response.body!, "partial");
    controller.abort();
    await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true), { timeout: 2_000 });
  });

  it("continues generating and persists the final messages after the client disconnects mid-stream", async () => {
    // Provider stream: emit a chunk, wait until the client has disconnected,
    // then finish generation. With persistOnDisconnect the handler signal
    // must NOT abort, so the full text is produced and persisted.
    const gate = Promise.withResolvers<void>();
    fakeProvider.generateTextStream.mockImplementation(async function* (
      _messages: unknown,
      _model: string,
      opts: { signal?: AbortSignal },
    ) {
      yield "partial";
      // Resume only once the handler's signal has actually observed the
      // disconnect (red path) or the test releases the gate (green path).
      await new Promise<void>((resolve) => {
        const signal = opts?.signal;
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
        void gate.promise.then(resolve);
      });
      yield " world full";
    });

    const app = createApp();
    const { server, port } = await listen(app);
    servers.push(server);

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "test-provider",
        model: "test-model",
        conversationId: "conv-persist-test",
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);

    // Read until the first chunk arrives, then disconnect mid-stream.
    await readUntil(response.body!, "partial");
    controller.abort();

    // On the legacy (disconnect-aborts) path the handler finalizes early
    // with the partial text; on the fixed path nothing persists yet.
    // Either way, release the gate afterwards and wait for the final state.
    await vi
      .waitFor(() => {
        expect(appendAndFinalize as AnyMock).toHaveBeenCalled();
      }, { timeout: 300 })
      .catch(() => {});
    const earlyPersistedText = ((appendAndFinalize as AnyMock).mock.calls.at(0) as unknown as [
      string,
      string,
      string,
      PersistedMessage[],
    ] | undefined)?.[3]
      ?.filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("");
    gate.resolve();

    // The handler must finish generating and persist the FULL text.
    await vi.waitFor(() => {
      expect(appendAndFinalize as AnyMock).toHaveBeenCalled();
    });
    const calls = (appendAndFinalize as AnyMock).mock.calls;
    const lastCall = calls.at(-1) as unknown as [
      string,
      string,
      string,
      PersistedMessage[],
      Record<string, unknown> | null,
    ];
    const [persistedConversationId, , , messages] = lastCall;
    expect(persistedConversationId).toBe("conv-persist-test");
    const assistantText = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("");
    // The disconnect must NOT have truncated generation: the full text is
    // persisted, not the pre-disconnect partial.
    expect(assistantText).toBe("partial world full");
    // If anything was persisted before the gate released, it must already be
    // the full text (the legacy path would have persisted only "partial").
    if (earlyPersistedText !== undefined) {
      expect(earlyPersistedText).toBe("partial world full");
    }
  });

  it("persists the user message and partial assistant output when the provider throws mid-stream", async () => {
    fakeProvider.generateTextStream.mockImplementation(async function* () {
      yield "partial answer";
      throw new Error("upstream connection reset");
    });

    const app = createApp();
    const { server, port } = await listen(app);
    servers.push(server);

    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "test-provider",
        model: "test-model",
        conversationId: "conv-error-test",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    expect(response.status).toBe(200);
    await response.text(); // drain the SSE stream (includes the error event)

    await vi.waitFor(() => {
      expect(appendAndFinalize as AnyMock).toHaveBeenCalled();
    });
    const calls = (appendAndFinalize as AnyMock).mock.calls;
    const lastCall = calls.at(-1) as unknown as [string, string, string, PersistedMessage[]];
    const [persistedConversationId, , , messages] = lastCall;
    expect(persistedConversationId).toBe("conv-error-test");
    const roles = messages.map((m) => m.role);
    expect(roles).toContain("user");
    const assistantText = messages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .join("");
    expect(assistantText).toContain("partial answer");
    // Generating flag must be cleared after the failure.
    const markCalls = (markGenerating as AnyMock).mock.calls as unknown as Array<
      [string, string, string, boolean, unknown]
    >;
    expect(markCalls.at(-1)?.[0]).toBe("conv-error-test");
    expect(markCalls.at(-1)?.[3]).toBe(false);
  });
});
