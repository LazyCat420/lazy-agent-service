/**
 * Coverage2 for provider adapters whose hot functions were untested:
 * anthropic (request/response extraction, captioning, tool-call messages),
 * inworld (NDJSON TTS), llama-cpp (chat completions + health) and
 * elevenlabs (WebSocket speech stream).
 *
 * All SDK/network/WebSocket boundaries are fakes; assertions are on the
 * returned values and the payloads sent to those boundaries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const credentials = vi.hoisted(() => ({
  anthropic: "test-anthropic-key",
  inworld: "dGVzdDp0ZXN0",
  elevenlabs: "test-elevenlabs-key",
}));

vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ANTHROPIC_API_KEY: credentials.anthropic,
  INWORLD_BASIC: credentials.inworld,
  ELEVENLABS_API_KEY: credentials.elevenlabs,
}));

// ── Anthropic SDK fake ─────────────────────────────────────

interface FakeAnthropicMessage {
  content: Array<Record<string, unknown>>;
  usage: Record<string, unknown>;
  stop_reason?: string;
  stop_details?: Record<string, unknown>;
}

const anthropicSdk = vi.hoisted(() => ({
  create: null as
    | ((payload: Record<string, unknown>) => FakeAnthropicMessage)
    | null,
  calls: [] as Array<Record<string, unknown>>,
  rateLimitHeaders: {
    headers: {
      get: (name: string) =>
        name === "anthropic-ratelimit-requests-limit" ? "4000" : null,
    },
  },
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class FakeAnthropicClient {
    messages = {
      create: (payload: Record<string, unknown>) => {
        anthropicSdk.calls.push(payload);
        if (!anthropicSdk.create) throw new Error("no fake create configured");
        const message = anthropicSdk.create(payload);
        // `requestAnthropicMessage` calls `.withResponse()`; `captionImage`
        // awaits the return value directly. A thenable serves both.
        return {
          withResponse: async () => ({
            data: message,
            response: anthropicSdk.rateLimitHeaders,
          }),
          then: (
            resolve: (value: FakeAnthropicMessage) => unknown,
            reject: (reason: unknown) => unknown,
          ) => Promise.resolve(message).then(resolve, reject),
        };
      },
      stream: () => {
        throw new Error("stream not used in these tests");
      },
    };
  },
}));

import anthropicProvider from "../anthropic.ts";
import type { ChatMessage } from "../../types/ProviderTypes.ts";
import { getModelByName } from "../../config.ts";

const fakeMessage = (
  message: FakeAnthropicMessage,
  withResponse = true,
) =>
  withResponse
    ? {
        ...message,
        withResponse: async () => ({
          data: message,
          response: anthropicSdk.rateLimitHeaders,
        }),
      }
    : message;

describe("anthropic.requestAnthropicMessage", () => {
  beforeEach(() => {
    anthropicSdk.calls.length = 0;
    anthropicSdk.create = null;
  });

  it("maps text, thinking, citations, tool calls, usage and stop details", async () => {
    anthropicSdk.create = () =>
      fakeMessage({
        content: [
          {
            type: "text",
            text: "Hello there",
            citations: [
              {
                type: "web_search_result_location",
                url: "https://example.test/a",
                title: "A",
                cited_text: "quote",
              },
              { type: "char_location" },
            ],
          },
          { type: "thinking", thinking: "reasoning", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "search", input: { q: "x" } },
          { type: "server_tool_use" },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 3,
        },
        stop_reason: "tool_use",
        stop_details: { reason: "call" },
      });

    const result = await anthropicProvider.generateText(
      [{ role: "user", content: "hi" }],
      "claude-test",
    );

    expect(result.text).toBe("Hello there");
    expect(result.thinking).toBe("reasoning");
    expect(result.thinkingSignature).toBe("sig-1");
    expect(result.citations).toEqual([
      {
        url: "https://example.test/a",
        title: "A",
        citedText: "quote",
      },
    ]);
    expect(result.toolCalls).toEqual([
      { id: "toolu_1", name: "search", args: { q: "x" } },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 11,
      outputTokens: 7,
      cacheReadInputTokens: 2,
      cacheCreationInputTokens: 3,
    });
    expect(result.stopReason).toBe("tool_use");
    expect(result.stopDetails).toEqual({ reason: "call" });
    expect(result.rateLimits).toMatchObject({ provider: "anthropic" });

    expect(anthropicSdk.calls[0]).toMatchObject({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("omits optional result fields for a plain text answer", async () => {
    anthropicSdk.create = () =>
      fakeMessage({
        content: [{ type: "text", text: "plain" }],
        usage: { input_tokens: 1, output_tokens: 2 },
      });

    const result = await anthropicProvider.generateText(
      [{ role: "user", content: "hi" }],
      "claude-test",
    );
    expect(result).toEqual({
      text: "plain",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      rateLimits: expect.objectContaining({ provider: "anthropic" }),
    });
  });

  it("wraps non-retryable failures in a ProviderError with the SDK status", async () => {
    anthropicSdk.create = () => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    };
    await expect(
      anthropicProvider.generateText([{ role: "user", content: "hi" }], "claude-test"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "anthropic",
      statusCode: 400,
      message: "bad request",
    });
  });

  it("retries overloaded responses and then succeeds", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    anthropicSdk.create = () => {
      attempts += 1;
      if (attempts < 3) {
        throw Object.assign(new Error("overloaded"), {
          status: 529,
          error: { type: "overloaded_error" },
        });
      }
      return fakeMessage({
        content: [{ type: "text", text: "after retry" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };

    const pending = anthropicProvider.generateText(
      [{ role: "user", content: "hi" }],
      "claude-test",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.text).toBe("after retry");
    expect(attempts).toBe(3);
    vi.useRealTimers();
  });

  it("gives up after the retry budget is exhausted", async () => {
    vi.useFakeTimers();
    anthropicSdk.create = () => {
      throw Object.assign(new Error("still overloaded"), {
        status: 529,
        type: "overloaded_error",
      });
    };
    const pending = anthropicProvider.generateText(
      [{ role: "user", content: "hi" }],
      "claude-test",
    );
    const assertion = expect(pending).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 529,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    vi.useRealTimers();
  });
});

describe("anthropic message preparation", () => {
  beforeEach(() => {
    anthropicSdk.calls.length = 0;
    anthropicSdk.create = () =>
      fakeMessage({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
  });

  it("serializes assistant tool calls as tool_use blocks", async () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "search please" },
      {
        role: "assistant",
        content: "let me look",
        thinking: "need to search",
        thinkingSignature: "sig",
        toolCalls: [
          { id: "toolu_9", name: "search", args: { q: "cats" } },
          { name: "fallback_name", args: {} },
        ],
      },
      { role: "tool", tool_call_id: "toolu_9", content: "found cats" },
    ];

    await anthropicProvider.generateText(messages, "claude-test");
    const payload = anthropicSdk.calls[0];
    const sent = payload.messages as Array<Record<string, unknown>>;
    expect(sent[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "need to search", signature: "sig" },
        { type: "text", text: "let me look" },
        { type: "tool_use", id: "toolu_9", name: "search", input: { q: "cats" } },
        { type: "tool_use", name: "fallback_name", input: {} },
      ],
    });
    expect(sent[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_9", content: "found cats" },
      ],
    });
  });
});

describe("anthropic.captionImage", () => {
  beforeEach(() => {
    anthropicSdk.calls.length = 0;
  });

  it("builds image blocks for data URLs and http URLs", async () => {
    anthropicSdk.create = () =>
      fakeMessage(
        {
          content: [{ type: "text", text: "a cat" }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
        false,
      );

    const result = await anthropicProvider.captionImage(
      [
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        "https://example.test/cat.png",
        "unrecognized-input",
      ],
      "What is this?",
      "claude-vision",
      "You are a describer",
    );

    expect(result.text).toBe("a cat");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    const payload = anthropicSdk.calls[0];
    expect(payload.model).toBe("claude-vision");
    expect(payload.max_tokens).toBe(1000);
    expect(payload.system).toBe("You are a describer");
    expect(payload.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUg==",
            },
          },
          {
            type: "image",
            source: { type: "url", url: "https://example.test/cat.png" },
          },
          { type: "text", text: "What is this?" },
        ],
      },
    ]);
  });

  it("detects the media type from the base64 prefix", async () => {
    anthropicSdk.create = () =>
      fakeMessage(
        { content: [{ type: "text", text: "jpeg" }], usage: {} },
        false,
      );
    await anthropicProvider.captionImage(
      ["data:image/unknown;base64,/9j/4AAQSkZJRg=="],
      "Describe",
      "claude-vision",
    );
    const payload = anthropicSdk.calls[0];
    const blocks = (payload.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
      .content;
    expect(blocks[0]).toMatchObject({
      source: { media_type: "image/jpeg", data: "/9j/4AAQSkZJRg==" },
    });
  });

  it("wraps caption failures in a ProviderError", async () => {
    anthropicSdk.create = () => {
      throw Object.assign(new Error("vision unavailable"), { status: 503 });
    };
    await expect(
      anthropicProvider.captionImage(["https://example.test/x.png"], "Describe"),
    ).rejects.toMatchObject({
      provider: "anthropic",
      statusCode: 503,
      message: "vision unavailable",
    });
  });
});

// ── Inworld TTS ────────────────────────────────────────────

import inworldProvider from "../inworld.ts";

const ndjson = (lines: Array<unknown>) =>
  lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

const collectStream = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

describe("inworld.generateSpeech", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collects NDJSON audio chunks into a readable MP3 stream", async () => {
    const requested: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requested.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        ndjson([
          { result: { audioContent: Buffer.from("first").toString("base64") } },
          { result: { timestampInfo: { word: "x" } } },
          { result: { audioContent: Buffer.from("second").toString("base64") } },
          { notAResult: true },
          "this line is not json",
        ]),
        { status: 200 },
      );
    });

    const result = await inworldProvider.generateSpeech("hello", "voice-1", {
      model: "inworld-tts-1",
      deliveryMode: "BALANCED",
    });

    expect(result.contentType).toBe("audio/mpeg");
    expect(await collectStream(result.stream)).toBe("firstsecond");
    expect(requested[0].url).toBe("https://api.inworld.ai/tts/v1/voice:stream");
    expect(requested[0].body).toMatchObject({
      text: "hello",
      voice_id: "voice-1",
      model_id: "inworld-tts-1",
      delivery_mode: "BALANCED",
      audio_config: { audio_encoding: "MP3", sample_rate_hertz: 24000 },
    });
  });

  it("sends temperature steering for models that do not use delivery_mode", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(ndjson([{ result: { audioContent: "" } }]), {
        status: 200,
      });
    });

    // The catalog marks 1.5-max as temperature-steered; unknown names default
    // to delivery_mode.
    const definition = getModelByName("inworld-tts-1.5-max") as
      | { ttsSteering?: string }
      | null;
    expect(definition?.ttsSteering).toBe("temperature");

    await inworldProvider.generateSpeech("hello", "voice-1", {
      model: "inworld-tts-1.5-max",
      temperature: 0.7,
    });
    expect(body).toMatchObject({ temperature: 0.7 });
    expect(body).not.toHaveProperty("delivery_mode");
  });

  it("throws a ProviderError when the API rejects the request", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("quota exceeded", { status: 429 }),
    );
    await expect(
      inworldProvider.generateSpeech("hello", "voice-1"),
    ).rejects.toMatchObject({
      provider: "inworld",
      statusCode: 500,
      message: expect.stringContaining("Inworld TTS API error: 429"),
    });
  });
});

describe("inworld.generateSpeechStream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function* textOf(...chunks: string[]) {
    for (const chunk of chunks) yield chunk;
  }

  it("yields LINEAR16 audio chunks for accumulated text", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        ndjson([
          { result: { audioContent: Buffer.from("pcm-a").toString("base64") } },
          { result: { audioContent: Buffer.from("pcm-b").toString("base64") } },
        ]),
        { status: 200 },
      );
    });

    const chunks: string[] = [];
    for await (const chunk of inworldProvider.generateSpeechStream(
      textOf("Hello ", "world"),
      "voice-1",
    )) {
      chunks.push(Buffer.from(chunk).toString());
    }
    expect(chunks).toEqual(["pcm-a", "pcm-b"]);
    expect(bodies[0]).toMatchObject({
      text: "Hello world",
      audio_config: { audio_encoding: "LINEAR16", sample_rate_hertz: 24000 },
      timestampType: "WORD",
    });
  });

  it("yields nothing for blank input", async () => {
    const chunks: unknown[] = [];
    for await (const chunk of inworldProvider.generateSpeechStream(
      textOf("   "),
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it("wraps stream failures in a ProviderError", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("down", { status: 503 }),
    );
    await expect(
      (async () => {
        for await (const _chunk of inworldProvider.generateSpeechStream(
          textOf("hello"),
        )) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      provider: "inworld",
      message: expect.stringContaining("Inworld TTS API error: 503"),
    });
  });
});

// ── llama.cpp ──────────────────────────────────────────────

import { createLlamaCppProvider } from "../llama-cpp.ts";

const llamaProvider = createLlamaCppProvider("http://llama.test", "llama-test");

describe("llama-cpp.generateText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns text, usage, tok/s and tool calls from the completion", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        choices: [
          {
            message: {
              content: "hello from llama",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "search", arguments: '{"q":"x"}' },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 5 },
        timings: { predicted_per_second: 42.987 },
      });
    });

    const result = await llamaProvider.generateText(
      [{ role: "user", content: "hi" }],
      "llama-model",
      {
        systemPrompt: "be brief",
        topK: 40,
        minP: 0.05,
        repeatPenalty: 1.2,
        tools: [
          { name: "search", description: "look up", parameters: { type: "object" } },
        ],
      },
    );

    expect(result.text).toBe("hello from llama");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "search", args: { q: "x" } },
    ]);

    expect(bodies[0]).toMatchObject({
      model: "llama-model",
      stream: false,
      top_k: 40,
      min_p: 0.05,
      repeat_penalty: 1.2,
      tool_choice: "auto",
    });
    const sentMessages = bodies[0].messages as Array<{ role: string }>;
    expect(sentMessages[0].role).toBe("system");
  });

  it("omits llama.cpp extension fields when they are defaulted", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: "plain" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      });
    });

    const result = await llamaProvider.generateText(
      [{ role: "user", content: "hi" }],
      "llama-model",
      { topK: 0, repeatPenalty: 1 },
    );
    expect(result.text).toBe("plain");
    expect(result.thinking).toBeUndefined();
    expect(body).not.toHaveProperty("top_k");
    expect(body).not.toHaveProperty("min_p");
    expect(body).not.toHaveProperty("repeat_penalty");
    expect(body).not.toHaveProperty("tools");
  });

  it("wraps API failures in a ProviderError", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { message: "model not loaded" } }, { status: 503 }),
    );
    await expect(
      llamaProvider.generateText([{ role: "user", content: "hi" }], "llama-model"),
    ).rejects.toMatchObject({
      provider: "llama-cpp",
      statusCode: 500,
      message: "model not loaded",
    });
  });
});

describe("llama-cpp.captionImage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends image_url parts and returns the caption", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        choices: [{ message: { content: "a red square" } }],
        usage: { prompt_tokens: 20, completion_tokens: 4 },
      });
    });

    const result = await llamaProvider.captionImage(
      ["data:image/png;base64,AAAA"],
      "What is it?",
      "llava-model",
      "You describe images",
    );

    expect(result).toEqual({
      text: "a red square",
      usage: { inputTokens: 20, outputTokens: 4 },
    });
    expect(body.model).toBe("llava-model");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({
      role: "system",
      content: "You describe images",
    });
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "What is it?" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
      ],
    });
  });

  it("wraps failures in a ProviderError", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    await expect(
      llamaProvider.captionImage(["data:image/png;base64,AAAA"]),
    ).rejects.toMatchObject({ provider: "llama-cpp", statusCode: 500 });
  });
});

describe("llama-cpp.checkHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports a healthy server with slot counts", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ status: "ok", slots_idle: 2, slots_processing: 1 }),
    );
    await expect(llamaProvider.checkHealth()).resolves.toEqual({
      ok: true,
      status: "ok",
      slotsIdle: 2,
      slotsProcessing: 1,
    });
  });

  it("reports a loading server as not ok", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ status: "loading model" }, { status: 503 }),
    );
    await expect(llamaProvider.checkHealth()).resolves.toEqual({
      ok: false,
      status: "loading model",
      slotsIdle: null,
      slotsProcessing: null,
    });
  });

  it("reports unreachable servers without throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(llamaProvider.checkHealth()).resolves.toEqual({
      ok: false,
      status: "unreachable",
      error: "ECONNREFUSED",
    });
  });
});

// ── ElevenLabs (WebSocket stream) ──────────────────────────

type WsHandler = (payload?: unknown) => void;

interface FakeSocket {
  readyState: number;
  sent: string[];
  on(event: string, handler: WsHandler): void;
  send(data: string): void;
  close(): void;
  emit(event: string, payload?: unknown): void;
}

const wsFake = vi.hoisted(() => {
  const state = {
    mode: "audio" as "audio" | "error" | "close",
    instances: [] as FakeSocket[],
  };

  class FakeWebSocket implements FakeSocket {
    static readonly OPEN = 1;
    static readonly CONNECTING = 0;
    static readonly CLOSED = 3;

    readyState = FakeWebSocket.OPEN;
    sent: string[] = [];
    private handlers = new Map<string, WsHandler[]>();
    private finalSent = false;

    constructor() {
      state.instances.push(this);
      queueMicrotask(() => this.emit("open"));
    }

    on(event: string, handler: WsHandler) {
      const existing = this.handlers.get(event) ?? [];
      existing.push(handler);
      this.handlers.set(event, existing);
    }

    emit(event: string, payload?: unknown) {
      for (const handler of this.handlers.get(event) ?? []) handler(payload);
    }

    send(data: string) {
      this.sent.push(data);
      if (state.mode === "error") {
        queueMicrotask(() => this.emit("error", new Error("ws down")));
        return;
      }
      if (state.mode === "close") {
        queueMicrotask(() => {
          this.readyState = FakeWebSocket.CLOSED;
          this.emit("close");
        });
        return;
      }
      if (this.finalSent) return;
      this.finalSent = true;
      const audio = Buffer.from("eleven-audio").toString("base64");
      queueMicrotask(() => {
        this.emit("message", Buffer.from(JSON.stringify({ audio })));
        this.emit("message", Buffer.from(JSON.stringify({ isFinal: true })));
      });
    }

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close");
    }
  }

  return { state, FakeWebSocket };
});

vi.mock("ws", () => ({ default: wsFake.FakeWebSocket }));

import elevenlabsProvider from "../elevenlabs.ts";

describe("elevenlabs.generateSpeechStream", () => {
  beforeEach(() => {
    wsFake.state.instances.length = 0;
    wsFake.state.mode = "audio";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function* textOf(...chunks: string[]) {
    for (const chunk of chunks) yield chunk;
  }

  it("streams audio over the WebSocket and closes it", async () => {
    const chunks: string[] = [];
    for await (const chunk of elevenlabsProvider.generateSpeechStream(
      textOf("Hello there. ", "Second sentence."),
      "voice-1",
    )) {
      chunks.push(Buffer.from(chunk).toString());
    }
    expect(chunks).toEqual(["eleven-audio"]);

    const socket = wsFake.state.instances[0];
    // The initial config is always sent before any text.
    expect(socket.sent.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(socket.sent[0])).toMatchObject({
      text: " ",
      xi_api_key: credentials.elevenlabs,
    });
    expect(socket.readyState).toBe(wsFake.FakeWebSocket.CLOSED);
  });

  it("wraps WebSocket errors in a ProviderError", async () => {
    wsFake.state.mode = "error";
    await expect(
      (async () => {
        for await (const _chunk of elevenlabsProvider.generateSpeechStream(
          textOf("hello"),
        )) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({
      provider: "elevenlabs",
      message: "ws down",
    });
  });

  it("ends cleanly when the socket closes without audio", async () => {
    wsFake.state.mode = "close";
    const chunks: unknown[] = [];
    for await (const chunk of elevenlabsProvider.generateSpeechStream(
      textOf("hello"),
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);
  });

  it("flushes unterminated text and sends the end-of-stream marker", async () => {
    const chunks: string[] = [];
    for await (const chunk of elevenlabsProvider.generateSpeechStream(
      textOf("no punctuation here"),
      "voice-1",
    )) {
      chunks.push(Buffer.from(chunk).toString());
    }

    const socket = wsFake.state.instances[0];
    const payloads = socket.sent.map((entry) => JSON.parse(entry));
    expect(payloads).toContainEqual({
      text: "no punctuation here",
      try_trigger_generation: true,
    });
    expect(payloads[payloads.length - 1]).toEqual({ text: "" });
    expect(chunks).toEqual(["eleven-audio"]);
  });

  it("closes the socket when the text stream throws", async () => {
    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("text stream broke");
        },
      }),
    };

    const chunks: string[] = [];
    for await (const chunk of elevenlabsProvider.generateSpeechStream(
      failingStream,
      "voice-1",
    )) {
      chunks.push(Buffer.from(chunk).toString());
    }

    const socket = wsFake.state.instances[0];
    expect(socket.sent.some((entry) => JSON.parse(entry).text === "")).toBe(false);
    expect(socket.readyState).toBe(wsFake.FakeWebSocket.CLOSED);
  });
});

describe("elevenlabs.generateSpeech", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the HTTP audio stream", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(Buffer.from("mp3"), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });

    const result = await elevenlabsProvider.generateSpeech("hello", "voice-1", {
      stability: 0.4,
      similarityBoost: 0.7,
    });
    expect(result.contentType).toBe("audio/mpeg");
    expect(result.stream).not.toBeNull();
    expect(body).toMatchObject({
      text: "hello",
      voice_settings: { stability: 0.4, similarity_boost: 0.7 },
    });
  });

  it("wraps API errors in a ProviderError", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("invalid voice", { status: 400 }),
    );
    await expect(
      elevenlabsProvider.generateSpeech("hello", "voice-1"),
    ).rejects.toMatchObject({
      provider: "elevenlabs",
      message: expect.stringContaining("ElevenLabs API error: 400"),
    });
  });
});
