/**
 * POST /agent streams SSE by default and answers JSON only on an explicit
 * opt-out (?stream=false, body stream:false, Accept: application/json).
 *
 * The JSON default (lazy-agent 0069260) broke two trading callers silently
 * (trading-service 18582e6c, b50eaca7). These pin the route-level choice; the
 * full signal table is in utils/__tests__/StreamNegotiation.test.ts.
 */
import http from "node:http";

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
vi.mock("../../core/chat/ChatGeneration.ts", () => ({ handleAgent: vi.fn(async () => {}) }));

import agentRouter from "../AgentRoutes.ts";

const BODY = { provider: "vllm", model: "m", messages: [{ role: "user", content: "hi" }] };

let server: http.Server | undefined;
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
    req.project = "html-notes";
    req.username = "test-user";
    next();
  });
  app.use("/agent", agentRouter);
  server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}/agent${query}`, {
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

describe("POST /agent response mode", () => {
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
