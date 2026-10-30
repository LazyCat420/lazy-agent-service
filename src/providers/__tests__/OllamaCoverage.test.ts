/**
 * Coverage tests for the Ollama provider.
 *
 * Every fixture is a recorded native-API response replayed through a stubbed
 * fetch — no live model calls, no network.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createOllamaProvider } from "../ollama.ts";
import { ProviderError } from "../../utils/errors.ts";

const BASE = "http://ollama.test";
const provider = createOllamaProvider(BASE);

type Route = (url: string, init: RequestInit | undefined) => Response;

let route: Route = () => new Response("unrouted", { status: 404 });
const requests: Array<{ url: string; body: unknown }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ndjsonResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

/** Stream whose second read rejects — exercises the mid-stream failure path. */
function failingNdjsonResponse(firstLine: string, error: unknown): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(firstLine));
      },
      pull(controller) {
        controller.error(error);
      },
    }),
    { status: 200, headers: { "content-type": "application/x-ndjson" } },
  );
}

vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  let body: unknown = undefined;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  requests.push({ url, body });
  return route(url, init);
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(() => vi.restoreAllMocks());

async function collect(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const chatRequest = () =>
  requests.find((request) => request.url === `${BASE}/api/chat`)?.body as
    | Record<string, unknown>
    | undefined;

describe("ollama generateText", () => {
  it("maps every ProviderOptions field onto the native options block", async () => {
    route = () =>
      jsonResponse({
        message: { role: "assistant", content: "hi", thinking: "pondering" },
        prompt_eval_count: 11,
        eval_count: 7,
      });

    const result = await provider.generateText!(
      [
        { role: "system", content: "identity" },
        { role: "user", content: "hello", images: ["data:image/png;base64,AAAA", "BBBB"] },
      ],
      "llama3:8b",
      {
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        maxTokens: 256,
        stopSequences: ["STOP"],
        seed: "42",
        frequencyPenalty: 1.1,
        presencePenalty: 0.4,
        repeatPenalty: 1.2,
        thinkingEnabled: true,
      },
    );

    expect(result).toEqual({
      text: "hi",
      thinking: "pondering",
      usage: { inputTokens: 11, outputTokens: 7 },
    });
    expect(chatRequest()).toMatchObject({
      model: "llama3:8b",
      stream: false,
      think: true,
      options: {
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        min_p: 0.05,
        num_predict: 256,
        stop: ["STOP"],
        seed: 42,
        frequency_penalty: 1.1,
        presence_penalty: 0.4,
        repeat_penalty: 1.2,
      },
    });
    const messages = chatRequest()!.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "identity" });
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "hello",
      images: ["AAAA", "BBBB"],
    });
  });

  it("drops a non-numeric seed and omits the options block fields that were not set", async () => {
    route = () => jsonResponse({ message: { content: "ok" } });

    const result = await provider.generateText!(
      [{ role: "user", content: "hi" }],
      "llama3",
      { seed: "not-a-number" },
    );

    expect(result).toEqual({
      text: "ok",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(chatRequest()).toMatchObject({ options: {} });
    expect(chatRequest()).not.toHaveProperty("think");
  });

  it("accepts a numeric seed", async () => {
    route = () => jsonResponse({ message: { content: "" } });
    await provider.generateText!([{ role: "user", content: "hi" }], "llama3", {
      seed: 7,
    });
    expect((chatRequest()!.options as Record<string, unknown>).seed).toBe(7);
  });

  it("raises a ProviderError carrying the API status text", async () => {
    route = () => new Response("model not found", { status: 404 });

    await expect(
      provider.generateText!([{ role: "user", content: "hi" }], "missing"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "ollama",
      statusCode: 500,
      message: expect.stringContaining("API error: 404"),
    });
  });

  it("rethrows ProviderErrors unchanged and wraps other failures", async () => {
    route = () => {
      throw new Error("socket hang up");
    };

    const error = await provider
      .generateText!([{ role: "user", content: "hi" }], "llama3")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).originalError).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("socket hang up");
  });
});

describe("ollama generateTextStream", () => {
  it("unloads other running models, then streams thinking, text and final usage", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) {
        return jsonResponse({
          models: [
            { model: "llama3:8b" },
            { name: "qwen3:latest", size_vram: 1 },
          ],
        });
      }
      if (url === `${BASE}/api/generate`) return jsonResponse({ done: true });
      return ndjsonResponse([
        '{"message":{"thinking":"hmm"}}\n',
        "\n",
        '{"message":{"content":"Hel"}}\n',
        "not-json\n",
        '{"message":{"content":"lo"},"done":true,"prompt_eval_count":4,"eval_count":2,"eval_duration":1000000000}\n',
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3:8b"),
    );

    expect(chunks).toEqual([
      { type: "status", message: "Unloading qwen3:latest…" },
      { type: "thinking", content: "hmm" },
      "Hel",
      "lo",
      {
        type: "usage",
        usage: { inputTokens: 4, outputTokens: 2 },
      },
    ]);
    const unload = requests.find((request) => request.url === `${BASE}/api/generate`);
    expect(unload?.body).toEqual({ model: "qwen3:latest", keep_alive: 0 });
    expect(chatRequest()).toMatchObject({ model: "llama3:8b", stream: true });
  });

  it("skips the unload pass when the process list is unavailable", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) return new Response("down", { status: 503 });
      return ndjsonResponse(['{"message":{"content":"ok"},"done":true}\n']);
    };

    const chunks = await collect(
      provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3"),
    );

    expect(chunks).toEqual([
      "ok",
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("swallows unload lookup failures", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) throw new Error("ps exploded");
      return ndjsonResponse(['{"message":{"content":"ok"}}\n']);
    };

    const chunks = await collect(
      provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3"),
    );

    expect(chunks[0]).toBe("ok");
  });

  it("estimates usage from partial output when the stream dies mid-flight", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) return jsonResponse({ models: [] });
      return failingNdjsonResponse(
        '{"message":{"thinking":"abcd","content":"12345678"}}\n',
        new Error("connection reset"),
      );
    };

    const chunks: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of provider.generateTextStream!(
        [{ role: "user", content: "hi" }],
        "llama3",
      )) {
        chunks.push(chunk);
      }
    } catch (thrown: unknown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("connection reset");
    // 8 output characters + 4 thinking characters → 2 + 1 estimated tokens.
    expect(chunks).toEqual([
      { type: "thinking", content: "abcd" },
      "12345678",
      { type: "usage", usage: { inputTokens: 0, outputTokens: 3 } },
    ]);
  });

  it("returns quietly on an AbortError and on an aborted signal", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) return jsonResponse({ models: [] });
      return failingNdjsonResponse(
        "",
        new DOMException("The user aborted a request.", "AbortError"),
      );
    };

    const chunks = await collect(
      provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3"),
    );
    expect(chunks).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    route = (url) => {
      if (url === `${BASE}/api/ps`) return jsonResponse({ models: [] });
      return ndjsonResponse(['{"message":{"content":"never"}}\n']);
    };
    const abortedChunks = await collect(
      provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3", {
        signal: controller.signal,
      }),
    );
    expect(abortedChunks).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("raises a ProviderError for a non-200 chat response", async () => {
    route = (url) => {
      if (url === `${BASE}/api/ps`) return jsonResponse({ models: [] });
      return new Response("boom", { status: 500 });
    };

    await expect(
      collect(
        provider.generateTextStream!([{ role: "user", content: "hi" }], "llama3"),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("API error: 500"),
    });
  });
});

describe("ollama captionImage", () => {
  it("strips data URL prefixes and sends the system prompt", async () => {
    route = () =>
      jsonResponse({
        message: { content: "a cat" },
        prompt_eval_count: 3,
        eval_count: 2,
      });

    const result = await provider.captionImage!(
      ["data:image/png;base64,QUJD", "rawbase64"],
      "What is this?",
      "llava",
      "Be brief.",
    );

    expect(result).toEqual({
      text: "a cat",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    const body = chatRequest() as Record<string, unknown>;
    expect(body).toMatchObject({ model: "llava", stream: false });
    expect(body.messages).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "What is this?", images: ["QUJD", "rawbase64"] },
    ]);
  });

  it("defaults usage to zero when the response omits counts", async () => {
    route = () => jsonResponse({});

    const result = await provider.captionImage!(["img"], "Describe", "llava");
    expect(result).toEqual({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const body = chatRequest() as Record<string, unknown>;
    expect(body.messages).toEqual([
      { role: "user", content: "Describe", images: ["img"] },
    ]);
  });

  it("wraps a non-200 response in a ProviderError", async () => {
    route = () => new Response("nope", { status: 400 });

    await expect(
      provider.captionImage!(["img"], "Describe", "llava"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("API error: 400"),
    });
  });
});
