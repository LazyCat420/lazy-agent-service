/**
 * Catalog-first reasoning policy for the OpenAI Chat Completions path.
 *
 * The provider must not sniff model names for "o1"/"o3": an operator can load
 * any model id. A known model follows its catalog `thinking` flag; an unknown
 * id is treated as reasoning-capable (omit sampling params, use
 * max_completion_tokens), because sampling params on a reasoning model are a
 * 400 while omitting them on a normal model is harmless.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = "test-openai-key"; /* # secret-ok */
});

import openaiProvider from "../openai.ts";

type RequestBody = {
  model?: string;
  temperature?: number;
  max_completion_tokens?: number;
};

const bodies: RequestBody[] = [];

function completion(): Response {
  return new Response(JSON.stringify({
    id: "c1",
    object: "chat.completion",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

const streamBody = [
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .join("") + "data: [DONE]\n\n";

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as RequestBody & { stream?: boolean }
      : {};
    bodies.push(body);
    return body.stream
      ? new Response(streamBody, { status: 200, headers: { "content-type": "text/event-stream" } })
      : completion();
  });
});

afterAll(() => vi.restoreAllMocks());

const lastBody = () => bodies[bodies.length - 1];

describe("catalog-first reasoning policy", () => {
  it("a catalog model with thinking: true takes the reasoning path", async () => {
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.3-chat-latest",
      { temperature: 0.3, maxTokens: 100 },
    );
    expect(lastBody().max_completion_tokens).toBe(100);
    expect(lastBody().temperature).toBeUndefined();
  });

  it("an unknown model id takes the reasoning path", async () => {
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "some-new-model-2030",
      { temperature: 0.3, maxTokens: 100 },
    );
    expect(lastBody().max_completion_tokens).toBe(100);
    expect(lastBody().temperature).toBeUndefined();
  });

  it("a catalog model with thinking: false takes the sampling path", async () => {
    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-4o",
      { temperature: 0.3, maxTokens: 100 },
    );
    expect(lastBody().temperature).toBe(0.3);
    expect(lastBody().max_completion_tokens).toBe(100);
  });

  it("the streaming path follows the same policy", async () => {
    bodies.length = 0;
    const chunks: unknown[] = [];
    for await (const chunk of openaiProvider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "some-new-model-2030",
      { temperature: 0.3, maxTokens: 100 },
    )) chunks.push(chunk);
    expect(lastBody().max_completion_tokens).toBe(100);
    expect(lastBody().temperature).toBeUndefined();
    expect(chunks).toContain("ok");
  });
});
