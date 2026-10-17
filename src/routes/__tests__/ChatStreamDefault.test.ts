/**
 * POST /chat streams SSE by default and answers JSON only on an explicit
 * opt-out (?stream=false, body stream:false, Accept: application/json).
 *
 * The JSON default (lazy-agent 0069260) made trading's tool-less board repair
 * read every /chat reply as empty (trading-service 18582e6c). These pin the
 * route-level choice; the full signal table is in
 * utils/__tests__/StreamNegotiation.test.ts.
 */
import type { Server } from "node:http";

import express from "express";
import type { Response as ExpressResponse } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

const { handleSseRequest, handleJsonRequest } = vi.hoisted(() => ({
  handleSseRequest: vi.fn(async (_req: unknown, res: ExpressResponse) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.end('data: {"type":"done"}\n\n');
  }),
  handleJsonRequest: vi.fn(async (_req: unknown, res: ExpressResponse) => {
    res.json({ text: "ok" });
  }),
}));
vi.mock("../../utils/SseUtilities.ts", () => ({ handleSseRequest, handleJsonRequest }));

// ChatRoutes' module graph, stubbed the same way as ChatSsePersistOnDisconnect.test.ts.
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../services/FileService.ts", () => ({
  default: { uploadFile: vi.fn(async () => ({ ref: "test-ref" })) },
}));
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

import chatRouter from "../ChatRoutes.ts";

const BODY = { provider: "test-provider", model: "test-model", messages: [{ role: "user", content: "hi" }] };

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  handleSseRequest.mockClear();
  handleJsonRequest.mockClear();
});

async function post(query: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = "test-project";
    req.username = "test-user";
    next();
  });
  app.use("/chat", chatRouter);
  server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/chat${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  await res.text();
  return res;
}

function expectSse(res: Response) {
  expect(handleSseRequest).toHaveBeenCalledTimes(1);
  expect(handleJsonRequest).not.toHaveBeenCalled();
  expect(res.headers.get("content-type")).toContain("text/event-stream");
}

function expectJson(res: Response) {
  expect(handleJsonRequest).toHaveBeenCalledTimes(1);
  expect(handleSseRequest).not.toHaveBeenCalled();
  expect(res.headers.get("content-type")).toContain("application/json");
}

describe("POST /chat response mode", () => {
  it("streams SSE when the caller sends no stream signal", async () => {
    expectSse(await post("", BODY));
  });

  it("streams SSE for the fetch default Accept: */*", async () => {
    expectSse(await post("", BODY, { accept: "*/*" }));
  });

  it("answers JSON on ?stream=false", async () => {
    expectJson(await post("?stream=false", BODY));
  });

  it("answers JSON on body stream:false", async () => {
    expectJson(await post("", { ...BODY, stream: false }));
  });

  it("answers JSON on Accept: application/json", async () => {
    expectJson(await post("", BODY, { accept: "application/json" }));
  });

  it("streams on ?stream=true even with Accept: application/json", async () => {
    expectSse(await post("?stream=true", BODY, { accept: "application/json" }));
  });
});
