/**
 * Coverage tests for the LM Studio provider.
 *
 * Every fixture is a recorded native /api/v1 payload replayed through a
 * stubbed fetch — no live model calls, no network.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createLmStudioProvider } from "../lm-studio.ts";

const BASE = "http://lm.test";

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

let route: Route = () => new Response("unrouted", { status: 404 });
const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function nativeSse(events: unknown[], extras: string[] = []): Response {
  const body =
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
    extras.join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function compatSse(chunks: unknown[]): Response {
  const body =
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
    "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
  const url = typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
  let body: Record<string, unknown> | null = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      body = null;
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

const nativeRequest = () =>
  requests.filter((request) => request.url === `${BASE}/api/v1/chat`).at(-1)?.body;
const compatRequest = () =>
  requests.find((request) => request.url === `${BASE}/v1/chat/completions`)?.body;
const loadRequest = () =>
  requests.find((request) => request.url === `${BASE}/api/v1/models/load`)?.body;
const unloadRequests = () =>
  requests.filter((request) => request.url === `${BASE}/api/v1/models/unload`);

/** A loaded model entry with the given context size. */
function loadedModel(key: string, contextLength = 8192, maxContext = 8192) {
  return {
    key,
    display_name: key,
    type: "llm",
    max_context_length: maxContext,
    loaded_instances: [{ id: `${key}-inst`, config: { context_length: contextLength } }],
  };
}

function modelsResponse(models: unknown[]): Response {
  return jsonResponse({ models });
}

describe("lm studio listModels enrichment", () => {
  it("fills key, display name, type and architecture metadata", async () => {
    const provider = createLmStudioProvider(BASE);
    route = () =>
      modelsResponse([
        { id: "qwen3-8b" },
        {
          id: "llama-3.1-70b",
          quantization: { bits_per_weight: 6 },
          architecture: "llama",
          params_string: "70B",
          size_bytes: 40_000_000_000,
        },
      ]);

    const result = await provider.listModels();

    expect(result.models[0]).toMatchObject({
      key: "qwen3-8b",
      display_name: "qwen3-8b",
      type: "llm",
    });
    expect(result.models[0].archParams).toBeDefined();
    expect(result.models[1]).toMatchObject({
      key: "llama-3.1-70b",
      display_name: "llama-3.1-70b",
      type: "llm",
    });
    expect(result.data).toEqual(result.models);
  });

  it("wraps API failures in a ProviderError", async () => {
    const provider = createLmStudioProvider(BASE);
    route = () => new Response("models down", { status: 500 });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("API error: 500"),
    });
  });
});

describe("lm studio generateText", () => {
  it("returns text, thinking, tool calls and usage from the compat endpoint", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return jsonResponse({
        choices: [
          {
            message: {
              content: "hi",
              reasoning_content: "why",
              tool_calls: [
                { id: "c1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } },
              ],
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      });
    };

    const result = await provider.generateText(
      [{ role: "user", content: "hi" }],
      "local",
      { systemPrompt: "identity", temperature: 0.2, topK: 40, minP: 0.05, repeatPenalty: 1.1 },
    );

    expect(result).toEqual({
      text: "hi",
      thinking: "why",
      usage: { inputTokens: 5, outputTokens: 2 },
      toolCalls: [{ id: "c1", name: "get_weather", args: { city: "Paris" }, thoughtSignature: undefined }],
    });
    const body = compatRequest()!;
    expect(body).toMatchObject({
      model: "local",
      stream: false,
      temperature: 0.2,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
    });
    expect((body.messages as Array<Record<string, unknown>>)[0]).toEqual({
      role: "system",
      content: "identity",
    });
  });

  it("drops thinking when it is disabled", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return jsonResponse({
        choices: [{ message: { content: "plain", reasoning_content: "why" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    };

    const result = await provider.generateText(
      [{ role: "user", content: "hi" }],
      "local",
      { thinkingEnabled: false },
    );

    expect(result.thinking).toBeUndefined();
    expect(result.text).toBe("plain");
  });

  it("rejects an aborted request before doing any work", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    controller.abort();
    route = () => modelsResponse([loadedModel("local")]);

    await expect(
      provider.generateText([{ role: "user", content: "hi" }], "local", {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("aborted"),
    });
    expect(requests).toEqual([]);
  });

  it("wraps transport failures in a ProviderError", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      throw new Error("connection refused");
    };

    await expect(
      provider.generateText([{ role: "user", content: "hi" }], "local"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("connection refused"),
    });
  });
});

describe("lm studio native streaming", () => {
  const nativeEvents = [
    { type: "chat.start" },
    { type: "model_load.start" },
    { type: "model_load.end" },
    { type: "prompt_processing.start" },
    { type: "prompt_processing.end" },
    { type: "message.start" },
    { type: "model_load.progress", progress: 0.5 },
    { type: "model_load.progress" },
    { type: "prompt_processing.progress", progress: 0.25 },
    { type: "prompt_processing.progress" },
    { type: "reasoning.delta", content: "think" },
    { type: "content.delta", content: "Hel" },
    { type: "message.delta", content: "lo" },
    { type: "tool_call.start" },
    { type: "tool_call.name", tool_name: "get_weather", tool_call_id: "tc1" },
    { type: "tool_call.arguments", arguments: { city: "Paris" } },
    { type: "tool_call.arguments", arguments: '{"x":1}' },
    { type: "tool_call.arguments", tool: "renamed" },
    {
      type: "tool_call.success",
      tool: "get_weather",
      arguments: { city: "Paris" },
      output: '{"temp":20}',
      tool_call_id: "tc1",
    },
    { type: "tool_call.failure", reason: "boom", tool_call_id: "tc2" },
    { type: "tool_call.name", tool_name: "solo" },
    { type: "tool_call.arguments", arguments: {} },
    { type: "tool_call.success", arguments: '{"a":1}', tool_call_id: "tc3" },
    { type: "tool_call.start" },
    { type: "tool_call.name", tool_name: "failing" },
    { type: "tool_call.arguments", arguments: { q: 1 } },
    { type: "tool_call.failure", reason: "nope" },
    { type: "tool_call.start" },
    { type: "tool_call.name", tool_name: "implicit" },
    { type: "tool_call.arguments", arguments: "not-json" },
    { type: "tool_call.success", output: "plain", tool_call_id: "tc4" },
    { type: "error", error: { message: "model died" } },
    {
      type: "chat.end",
      result: {
        stats: {
          input_tokens: 5,
          total_output_tokens: 3,
          tokens_per_second: 10,
          time_to_first_token_seconds: 0.2,
          reasoning_output_tokens: 1,
        },
      },
    },
  ];

  it("maps every native event to a stream chunk", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return nativeSse(nativeEvents, ["data: {broken json\n\n", "not-an-sse-line\n\n"]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        systemPrompt: "identity",
        thinkingEnabled: true,
        temperature: 0.5,
        maxTokens: 100,
        seed: 5,
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.1,
        tools: [{ name: "get_weather", parameters: { type: "object" } }],
      }),
    );

    expect(chunks).toEqual([
      { type: "status", message: "Starting…", phase: "starting" },
      { type: "status", message: "Loading model… 0%", phase: "loading" },
      { type: "status", message: "Loading model… 100%", phase: "loading" },
      { type: "status", message: "Processing prompt…", phase: "prefilling", progress: 0 },
      { type: "status", message: "Processing prompt… done", phase: "prefilling", progress: 1 },
      { type: "status", message: "Generating…", phase: "generating" },
      { type: "status", message: "Loading model… 50%", phase: "loading" },
      { type: "status", message: "Loading model… 0%", phase: "loading" },
      { type: "status", message: "Processing prompt… 25%", phase: "prefilling", progress: 0.25 },
      { type: "status", message: "Processing prompt… 0%", phase: "prefilling", progress: 0 },
      { type: "thinking", content: "think" },
      "Hel",
      "lo",
      { type: "toolCall", id: "tc1", name: "get_weather", args: {}, status: "calling", native: true },
      {
        type: "toolCall",
        id: "tc1",
        name: "get_weather",
        args: { city: "Paris" },
        result: { temp: 20 },
        status: "done",
        native: true,
      },
      {
        type: "toolCall",
        id: "tc2",
        name: "any",
        args: {},
        result: { error: "boom" },
        status: "error",
        native: true,
      },
      { type: "toolCall", id: "", name: "solo", args: {}, status: "calling", native: true },
      {
        type: "toolCall",
        id: "tc3",
        name: "any",
        args: { a: 1 },
        result: undefined,
        status: "done",
        native: true,
      },
      { type: "toolCall", id: "", name: "failing", args: {}, status: "calling", native: true },
      {
        type: "toolCall",
        id: "",
        name: "failing",
        args: { q: 1 },
        result: { error: "nope" },
        status: "error",
        native: true,
      },
      { type: "toolCall", id: "", name: "implicit", args: {}, status: "calling", native: true },
      {
        type: "toolCall",
        id: "tc4",
        name: "implicit",
        args: "not-json",
        result: "plain",
        status: "done",
        native: true,
      },
      "\n\n⚠️ **LM Studio Error:** model died",
      {
        type: "usage",
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          tokensPerSec: 10,
        },
      },
    ]);

    const body = nativeRequest()!;
    expect(body).toMatchObject({
      model: "local",
      input: "hi",
      stream: true,
      store: false,
      system_prompt: "identity",
      temperature: 0.5,
      max_output_tokens: 100,
      seed: 5,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.1,
      reasoning: "on",
    });
    expect(body.integrations).toEqual([
      {
        type: "ephemeral_mcp",
        server_label: "tools",
        server_url: expect.stringContaining("/mcp/sse?project="),
        allowed_tools: ["get_weather"],
      },
    ]);
  });

  it("serialises conversation history and multipart user turns as native input", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return nativeSse([{ type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } }]);
    };

    await collect(
      provider.generateTextStream(
        [
          { role: "user", content: "first" },
          { role: "assistant", content: "" },
          { role: "user", content: "with image", images: ["data:image/png;base64,BBB"] },
          { role: "user", content: "look", images: ["data:image/png;base64,AAA"] },
        ],
        "local",
        {},
      ),
    );

    expect(nativeRequest()!.input).toEqual([
      { type: "text", content: "[Conversation History]\n[User]: first\n[User]: with image\n\n[Current Message]\nlook" },
      { type: "image", data_url: "data:image/png;base64,AAA" },
    ]);

    await collect(
      provider.generateTextStream(
        [{ role: "user", content: "first" }, { role: "user", content: "second" }],
        "local",
        {},
      ),
    );
    expect(nativeRequest()!.input).toBe("[Conversation History]\n[User]: first\n\n[Current Message]\nsecond");

    await collect(
      provider.generateTextStream([{ role: "user", content: "solo" }], "local", {}),
    );
    expect(nativeRequest()!.input).toBe("solo");

    await collect(
      provider.generateTextStream([{ role: "system", content: "only system" }], "local", {}),
    );
    expect(nativeRequest()!.input).toBe("");

    await collect(
      provider.generateTextStream([{ role: "assistant", content: "no user" }], "local", {}),
    );
    expect(nativeRequest()!.input).toBe("");
  });
});

/** SSE body the test can drive chunk-by-chunk. */
function controllableSse() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    push: (event: unknown) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    fail: (error: unknown) => controller.error(error),
    close: () => controller.close(),
  };
}

/** SSE body that delivers `events`, then errors on the next read. */
function scriptedSse(events: unknown[], error: unknown) {
  const encoder = new TextEncoder();
  let step = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      step += 1;
      if (step === 1) {
        controller.enqueue(
          encoder.encode(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
          ),
        );
        return;
      }
      controller.error(error);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("lm studio openai-compat streaming", () => {
  it("streams thinking, text and usage through _streamOpenAICompat", async () => {
    const provider = createLmStudioProvider(BASE);
    route = () =>
      compatSse([
        { choices: [{ delta: { reasoning_content: "why" }, finish_reason: null }] },
        { choices: [{ delta: { content: "Hi" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        },
      ]);

    const chunks = await collect(
      provider._streamOpenAICompat(
        [{ role: "user", content: "hi" }],
        "local",
        { thinkingEnabled: true, temperature: 0.2, tools: [{ name: "lookup", parameters: {} }] },
        BASE,
      ),
    );

    expect(chunks).toEqual([
      { type: "status", message: "Starting…", phase: "starting" },
      { type: "status", message: "Processing prompt…", phase: "prefilling", progress: 0 },
      { type: "status", message: "Thinking…", phase: "thinking" },
      { type: "thinking", content: "why" },
      "Hi",
      { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const body = compatRequest()!;
    expect(body).toMatchObject({
      model: "local",
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
    });
    expect(body.tools).toHaveLength(1);
  });

  it("wraps a non-200 compat response in a ProviderError", async () => {
    const provider = createLmStudioProvider(BASE);
    route = () => new Response("nope", { status: 503 });

    await expect(
      collect(
        provider._streamOpenAICompat(
          [{ role: "user", content: "hi" }],
          "local",
          {},
          BASE,
        ),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 503,
      message: expect.stringContaining("API error: 503"),
    });
  });

  it("routes agent runs and orchestrator tools to the compat endpoint", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return compatSse([
        { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] },
      ]);
    };

    const agentChunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        agent: "coding",
      }),
    );
    expect(agentChunks).toContainEqual({ type: "status", message: "Starting…", phase: "starting" });
    expect(compatRequest()!.model).toBe("local");

    const toolChunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        tools: [{ name: "create_subagent", parameters: {} }],
      }),
    );
    expect(toolChunks).toContainEqual({ type: "status", message: "Starting…", phase: "starting" });
    expect(nativeRequest()).toBeUndefined();
  });
});

describe("lm studio native tool attachment limits", () => {
  it("caps the tool list to the context budget", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return nativeSse([{ type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } }]);
    };

    const tools = Array.from({ length: 10 }, (_, index) => ({
      name: `tool_${index}`,
      parameters: { type: "object" },
    }));
    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", { tools }),
    );

    expect(chunks).toContainEqual({
      type: "status",
      message: "Context limit (8192) — using 8 of 10 tools",
    });
    const integrations = nativeRequest()!.integrations as Array<Record<string, unknown>>;
    expect(integrations[0].allowed_tools).toEqual([
      "tool_0",
      "tool_1",
      "tool_2",
      "tool_3",
      "tool_4",
      "tool_5",
      "tool_6",
      "tool_7",
    ]);
  });

  it("refuses tools when the loaded context is too small", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          {
            key: "local",
            loaded_instances: [{ id: "local-inst", config: {} }],
            max_context_length: 8192,
          },
        ]);
      }
      return nativeSse([{ type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } }]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        _loadedContextLength: 2048,
        tools: [{ name: "lookup", parameters: {} }],
      }),
    );

    expect(chunks[0]).toContain("Context too small for function calling");
    expect(nativeRequest()!.integrations).toBeUndefined();
  });
});

describe("lm studio native request fallbacks", () => {
  it("retries without the reasoning field when the model rejects it", async () => {
    const provider = createLmStudioProvider(BASE);
    let chatCalls = 0;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      chatCalls += 1;
      if (chatCalls === 1) {
        return new Response("model does not expose reasoning config", { status: 400 });
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        thinkingEnabled: true,
      }),
    );

    expect(chunks[0]).toBe("ok");
    expect(chatCalls).toBe(2);
    expect(nativeRequest()!.reasoning).toBeUndefined();
  });

  it("raises a diagnostic ProviderError for a non-reasoning failure", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return new Response("engine crashed", { status: 500 });
    };

    await expect(
      collect(
        provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "lm-studio",
      message: expect.stringContaining("API error: 500"),
    });
  });

  it("reports the error code and cause of a transport failure", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      const error = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
        cause: new Error("connection reset by peer"),
      });
      throw error;
    };

    await expect(
      collect(
        provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringMatching(/code=ECONNRESET.*cause=connection reset by peer/),
    });
  });

  it("stops immediately when the caller aborts before streaming", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    controller.abort();
    route = () => modelsResponse([loadedModel("local")]);

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        signal: controller.signal,
      }),
    );

    expect(chunks).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("cancels the native reader when the signal aborts mid-stream", async () => {
    const provider = createLmStudioProvider(BASE);
    const controllable = controllableSse();
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return controllable.response;
    };
    const controller = new AbortController();

    const chunks: unknown[] = [];
    controllable.push({ type: "content.delta", content: "Hi" });
    for await (const chunk of provider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "local",
      { signal: controller.signal },
    )) {
      chunks.push(chunk);
      controller.abort();
    }

    expect(chunks).toEqual([
      "Hi",
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("cancels immediately when the signal was already aborted", async () => {
    const provider = createLmStudioProvider(BASE);
    const controllable = controllableSse();
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return controllable.response;
    };
    const controller = new AbortController();

    const generator = provider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "local",
      { signal: controller.signal },
    );
    controllable.push({ type: "content.delta", content: "never" });
    controller.abort();
    const chunks = await collect(generator);

    expect(chunks).toEqual([]);
  });

  it("emits partial usage before rethrowing a mid-stream failure", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return scriptedSse(
        [
          { type: "reasoning.delta", content: "abcd" },
          { type: "content.delta", content: "12345678" },
        ],
        new Error("stream exploded"),
      );
    };

    const chunks: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of provider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "local",
        {},
      )) {
        chunks.push(chunk);
      }
    } catch (thrown: unknown) {
      error = thrown;
    }

    expect(chunks).toEqual([
      { type: "thinking", content: "abcd" },
      "12345678",
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 3 },
      },
    ]);
    expect(error).toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("stream exploded"),
    });
  });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("lm studio model reload before streaming", () => {
  it("reloads a model that is loaded below the requested context", async () => {
    const provider = createLmStudioProvider(BASE);
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local", 8192)
            : {
                key: "local",
                max_context_length: 8192,
                loaded_instances: [{ id: "local-inst", config: { context_length: 4096 } }],
              },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) return jsonResponse({});
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return jsonResponse({});
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        minContextLength: 8192,
        evalBatchSize: 1024,
      }),
    );

    expect(chunks.slice(0, 4)).toEqual([
      { type: "status", message: "Reloading model with 8k context…" },
      { type: "status", message: "Loading model… 0%", phase: "loading" },
      { type: "status", message: "Loading model… 100%", phase: "loading" },
      "ok",
    ]);
    expect(chunks[4]).toMatchObject({ type: "usage", usage: { inputTokens: 1 } });
    expect(unloadRequests().map((request) => request.body)).toEqual([
      { instance_id: "local-inst" },
    ]);
    expect(loadRequest()).toMatchObject({ context_length: 8192, eval_batch_size: 1024 });
  });

  it("skips the reload when the model is already at its maximum context", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([loadedModel("local", 8192, 8192)]);
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        minContextLength: 16384,
      }),
    );

    expect(chunks[0]).toBe("ok");
    expect(loadRequest()).toBeUndefined();
    expect(unloadRequests()).toEqual([]);
  });

  it("unloads another loaded model before loading the requested one", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loadedModel("other"),
          { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) return jsonResponse({});
      if (url === `${BASE}/api/v1/models/load`) return jsonResponse({});
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );

    expect(chunks.slice(0, 3)).toEqual([
      { type: "status", message: "Unloading previous model…" },
      { type: "status", message: "Loading model… 0%", phase: "loading" },
      { type: "status", message: "Loading model… 100%", phase: "loading" },
    ]);
    expect(unloadRequests().map((request) => request.body)).toEqual([
      { instance_id: "other-inst" },
    ]);
    expect(loadRequest()).toMatchObject({ model: "local", eval_batch_size: 4096 });
  });

  it("keeps a model that is serving an active request loaded", async () => {
    const provider = createLmStudioProvider(BASE);
    const controllable = controllableSse();
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loadedModel("other"),
          { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) return jsonResponse({});
      if (url === `${BASE}/api/v1/models/load`) return jsonResponse({});
      if (url === `${BASE}/api/v1/chat`) {
        const body = requests.at(-1)!.body as Record<string, unknown>;
        if (body.model === "other") return controllable.response;
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const otherStream = provider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "other",
      {},
    );
    controllable.push({ type: "content.delta", content: "busy" });
    const firstChunk = await otherStream.next();
    expect(firstChunk.value).toBe("busy");

    const localChunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );
    expect(localChunks).toContainEqual({
      type: "status",
      message: "Loading model… 0%",
      phase: "loading",
    });
    expect(unloadRequests()).toEqual([]);

    controllable.close();
    await collect(otherStream);
  });

  it("aborts the load preparation when the signal fires during the unload loop", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loadedModel("other"),
          { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) {
        controller.abort();
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        signal: controller.signal,
      }),
    );

    expect(chunks).toEqual([
      { type: "status", message: "Unloading previous model…" },
    ]);
    expect(nativeRequest()).toBeUndefined();
  });
});

describe("lm studio load retries and failures", () => {
  it("retries a failed load with progressively smaller fallback tiers", async () => {
    const provider = createLmStudioProvider(BASE);
    let loaded = false;
    let loadCalls = 0;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local", 65000, 131072)
            : { key: "local", max_context_length: 131072, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loadCalls += 1;
        if (loadCalls <= 2) return new Response("out of memory", { status: 500 });
        loaded = true;
        return jsonResponse({});
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
        minContextLength: 131072,
        evalBatchSize: 1024,
      }),
    );

    expect(chunks.slice(0, 5)).toEqual([
      { type: "status", message: "Loading model… 0%", phase: "loading" },
      { type: "status", message: "Load failed — retrying with 131k context, batch 512…", phase: "loading" },
      { type: "status", message: "Load failed — retrying with 65k context, batch 1024…", phase: "loading" },
      { type: "status", message: "Loading model… 100%", phase: "loading" },
      "ok",
    ]);
    expect(loadCalls).toBe(3);
  });

  it("propagates a fatal load failure after every tier fails", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          { key: "local", max_context_length: 131072, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        return new Response("cannot allocate", { status: 500 });
      }
      return jsonResponse({});
    };

    await expect(
      collect(
        provider.generateTextStream([{ role: "user", content: "hi" }], "local", {
          minContextLength: 65536,
        }),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("API error: 500"),
    });
  });

  it("unloads the model when the caller aborts during loading", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local")
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) return jsonResponse({});
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return new Promise<Response>(() => {
          /* never settles — the abort path must give up */
        });
      }
      return jsonResponse({});
    };

    const chunks: unknown[] = [];
    for await (const chunk of provider.generateTextStream(
      [{ role: "user", content: "hi" }],
      "local",
      { signal: controller.signal },
    )) {
      chunks.push(chunk);
      if (chunk && typeof chunk === "object" && "message" in chunk) {
        controller.abort();
      }
    }

    expect(chunks).toEqual([
      { type: "status", message: "Loading model… 0%", phase: "loading" },
    ]);
    expect(unloadRequests().map((request) => request.body)).toEqual([
      { instance_id: "local-inst" },
    ]);
  });

  it("continues without a model when the readiness probe fails non-fatally", async () => {
    const provider = createLmStudioProvider(BASE);
    let modelCalls = 0;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        modelCalls += 1;
        if (modelCalls === 1) throw new TypeError("network down");
        return modelsResponse([loadedModel("local")]);
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );

    expect(chunks[0]).toBe("ok");
  });

  it("raises a ProviderError when the readiness probe reports a fatal load error", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return new Response("Failed to load model", { status: 500 });
      }
      return jsonResponse({});
    };

    await expect(
      collect(
        provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("Failed to load model"),
    });
  });

  it("emits zeroed usage when chat.end carries no stats", async () => {
    const provider = createLmStudioProvider(BASE);
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) return modelsResponse([loadedModel("local")]);
      return nativeSse([{ type: "content.delta", content: "ok" }, { type: "chat.end" }]);
    };

    const chunks = await collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );

    expect(chunks).toEqual([
      "ok",
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });
});

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("lm studio ensureModelLoaded", () => {
  it("reports an already loaded model without touching it", async () => {
    const provider = createLmStudioProvider(BASE);
    route = () => modelsResponse([loadedModel("local", 4096)]);

    const result = await provider.ensureModelLoaded("local");

    expect(result).toEqual({ alreadyLoaded: true, contextLength: 4096 });
    expect(loadRequest()).toBeUndefined();
  });

  it("unloads other models, loads, and reports the status transitions", async () => {
    const provider = createLmStudioProvider(BASE);
    const statuses: string[] = [];
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loadedModel("other"),
          loaded
            ? loadedModel("local", 4096)
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) return jsonResponse({});
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const result = await provider.ensureModelLoaded(
      "local",
      { context_length: 8192 },
      undefined,
      (status) => statuses.push(status),
    );

    expect(result).toEqual({ alreadyLoaded: false, contextLength: 4096 });
    expect(statuses).toEqual([
      "Unloading previous model…",
      "Loading model… 0%",
      "Loading model… 100%",
    ]);
    expect(unloadRequests().map((request) => request.body)).toEqual([
      { instance_id: "other-inst" },
    ]);
    expect(loadRequest()).toMatchObject({ context_length: 8192 });
  });

  it("keeps going when unloading another model fails", async () => {
    const provider = createLmStudioProvider(BASE);
    const statuses: string[] = [];
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loadedModel("other"),
          loaded
            ? loadedModel("local")
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/unload`) {
        return new Response("unload refused", { status: 500 });
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const result = await provider.ensureModelLoaded(
      "local",
      { context_length: 8192 },
      undefined,
      (status) => statuses.push(status),
    );

    expect(result).toEqual({ alreadyLoaded: false, contextLength: 8192 });
    expect(statuses[0]).toBe("Unloading previous model…");
    expect(loadRequest()).toMatchObject({ context_length: 8192 });
  });

  it("caps a later load at the recorded GPU ceiling", async () => {
    const provider = createLmStudioProvider(BASE);
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local", 4096)
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    await provider.ensureModelLoaded("local", { context_length: 8192 });
    loaded = false;
    requests.length = 0;

    const second = await provider.ensureModelLoaded("local", { context_length: 8192 });

    expect(second).toEqual({ alreadyLoaded: false, contextLength: 4096 });
    expect(loadRequest()).toMatchObject({ context_length: 4096 });
  });

  it("returns immediately when the signal is already aborted", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    controller.abort();
    route = () => modelsResponse([{ key: "local" }]);

    const result = await provider.ensureModelLoaded(
      "local",
      { context_length: 8192 },
      controller.signal,
    );

    expect(result).toEqual({ alreadyLoaded: false, contextLength: null });
    expect(requests).toEqual([]);
  });

  it("stops unloading when the signal aborts mid-loop", async () => {
    const provider = createLmStudioProvider(BASE);
    const controller = new AbortController();
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([loadedModel("other"), { key: "local", loaded_instances: [] }]);
      }
      if (url === `${BASE}/api/v1/models/unload`) {
        controller.abort();
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    const result = await provider.ensureModelLoaded(
      "local",
      { context_length: 8192 },
      controller.signal,
    );

    expect(result).toEqual({ alreadyLoaded: false, contextLength: null });
    expect(loadRequest()).toBeUndefined();
  });

  it("waits for an inflight load before deciding", async () => {
    const provider = createLmStudioProvider(BASE);
    const gate = createDeferred();
    let loaded = false;
    const statuses: string[] = [];
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local")
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loaded = true;
        return gate.promise.then(() => jsonResponse({}));
      }
      return jsonResponse({});
    };

    const first = provider.ensureModelLoaded("local", { context_length: 8192 });
    await waitFor(
      () => requests.some((request) => request.url === `${BASE}/api/v1/models/load`),
      "load request",
    );
    const second = provider.ensureModelLoaded("local", {}, undefined, (status) =>
      statuses.push(status),
    );
    await waitFor(() => statuses.includes("Waiting for model load…"), "inflight status");
    gate.resolve();

    await expect(first).resolves.toEqual({ alreadyLoaded: false, contextLength: 8192 });
    await expect(second).resolves.toEqual({ alreadyLoaded: true, contextLength: 8192 });
  });

  it("clears the inflight entry after a failed load", async () => {
    const provider = createLmStudioProvider(BASE);
    let loadCalls = 0;
    let loaded = false;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local")
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loadCalls += 1;
        if (loadCalls === 1) return new Response("no memory", { status: 500 });
        loaded = true;
        return jsonResponse({});
      }
      return jsonResponse({});
    };

    await expect(
      provider.ensureModelLoaded("local", { context_length: 8192 }),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("API error: 500"),
    });

    await expect(
      provider.ensureModelLoaded("local", { context_length: 8192 }),
    ).resolves.toEqual({ alreadyLoaded: false, contextLength: 8192 });
    expect(loadCalls).toBe(2);
  });
});

describe("lm studio stream model load singleflight", () => {
  it("waits for another stream's load instead of loading twice", async () => {
    const provider = createLmStudioProvider(BASE);
    const gate = createDeferred();
    let loaded = false;
    let loadCalls = 0;
    route = (url) => {
      if (url === `${BASE}/api/v1/models`) {
        return modelsResponse([
          loaded
            ? loadedModel("local")
            : { key: "local", max_context_length: 8192, loaded_instances: [] },
        ]);
      }
      if (url === `${BASE}/api/v1/models/load`) {
        loadCalls += 1;
        loaded = true;
        return gate.promise.then(() => jsonResponse({}));
      }
      return nativeSse([
        { type: "content.delta", content: "ok" },
        { type: "chat.end", stats: { input_tokens: 1, total_output_tokens: 1 } },
      ]);
    };

    const first = collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );
    await waitFor(
      () => requests.some((request) => request.url === `${BASE}/api/v1/models/load`),
      "load request",
    );

    const second = collect(
      provider.generateTextStream([{ role: "user", content: "hi" }], "local", {}),
    );
    await waitFor(
      () =>
        requests.filter((request) => request.url === `${BASE}/api/v1/chat`).length === 0,
      "second stream to block",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();

    const [firstChunks, secondChunks] = await Promise.all([first, second]);

    expect(firstChunks).toContainEqual("ok");
    expect(secondChunks).toContainEqual({
      type: "status",
      message: "Waiting for model load…",
      phase: "loading",
    });
    expect(secondChunks).toContainEqual("ok");
    expect(loadCalls).toBe(1);
  });
});
