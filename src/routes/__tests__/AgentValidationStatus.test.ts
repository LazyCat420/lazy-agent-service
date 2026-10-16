/**
 * A malformed non-streaming /agent request is the caller's fault and must be a
 * 4xx. Found 2026-10-16: `{messages}` without `provider` answered
 * `{"message":"Missing required field: provider","statusCode":500}` because
 * handleAgent flattened the ProviderError(400) into an error event and
 * buildJsonResponseFromEvents rebuilt it as a 500.
 */
import http from "node:http";

import express from "express";
import { afterEach, describe, expect, it } from "vitest";

import agentRouter from "../AgentRoutes.ts";
import { errorHandler } from "../../utils/errors.ts";

let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function post(body: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.project = "music-player";
    req.username = "test-user";
    next();
  });
  app.use("/agent", agentRouter);
  app.use(errorHandler);
  server = await new Promise<http.Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  const { port } = server.address() as { port: number };
  return fetch(`http://127.0.0.1:${port}/agent?stream=false`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("non-streaming /agent validation errors", () => {
  it("answers a request without a provider with 400, not 500", async () => {
    const res = await post({ messages: [{ role: "user", content: "hi" }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: "Missing required field: provider", statusCode: 400 });
  });

  it("answers a request whose messages are not an array with 400", async () => {
    const res = await post({ provider: "vllm", messages: "hi" });
    expect(res.status).toBe(400);
  });
});
