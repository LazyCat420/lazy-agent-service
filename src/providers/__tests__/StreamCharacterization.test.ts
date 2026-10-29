/**
 * Characterization tests for the streamed completion loops.
 *
 * Pins the chunk contract of each provider's generateTextStream before the
 * CRAP refactor splits the loops into per-provider event reducers: emitted
 * text, tool-call deltas, the final tool call and the final usage object.
 * Every fixture below is a recorded SSE transcript replayed through a stubbed
 * fetch — no live model calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key"; /* # secret-ok */
  process.env.OPENAI_API_KEY = "test-openai-key"; /* # secret-ok */
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = "test-google-key"; /* # secret-ok */
});

import anthropicProvider from "../anthropic.ts";
import openaiProvider from "../openai.ts";
import googleProvider from "../google.ts";
import { createLlamaCppProvider } from "../llama-cpp.ts";

type Chunk = Record<string, unknown> | string;

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * One fetch stub for the whole suite: each SDK client captures `fetch` when it
 * is constructed, so a per-test spy would leave later tests talking to the
 * first test's fixture.
 */
const requests: Array<{ url: string; body: unknown }> = [];

beforeAll(() => {
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
    if (url.includes("llama-box")) return sseResponse(llamaCppSseBody);
    if (url.includes("anthropic")) return sseResponse(anthropicSseBody);
    if (url.includes("/responses")) return sseResponse(openaiResponsesSseBody);
    if (url.includes("generativelanguage")) return sseResponse(googleSseBody);
    if (url.includes("/chat/completions")) return sseResponse(openaiChatSseBody);
    return new Response("unrouted fixture", { status: 404 });
  });
});

afterAll(() => vi.restoreAllMocks());

async function collect(stream: AsyncGenerator<Chunk>): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const textOf = (chunks: Chunk[]) =>
  chunks.filter((chunk): chunk is string => typeof chunk === "string").join("");

const eventsOf = (chunks: Chunk[], type: string) =>
  chunks.filter(
    (chunk): chunk is Record<string, unknown> =>
      typeof chunk === "object" && chunk.type === type,
  );


const ANTHROPIC_SSE = [
  ["message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 1,
        cache_read_input_tokens: 4,
        cache_creation_input_tokens: 0,
      },
    },
  }],
  ["content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  }],
  ["content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  }],
  ["content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: " world" },
  }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
  }],
  ["content_block_delta", {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
  }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 9 },
  }],
  ["message_stop", { type: "message_stop" }],
] as const;

const anthropicSseBody = ANTHROPIC_SSE.map(
  ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
).join("");

describe("anthropic streamed completion", () => {
  it("emits text, tool-call deltas and the final usage", async () => {
    const chunks = await collect(
      anthropicProvider.generateTextStream(
        [{ role: "user", content: "weather?" }],
        "claude-sonnet-4-6",
        {},
      ),
    );

    expect(textOf(chunks)).toBe("Hello world");
    expect(eventsOf(chunks, "toolCallStart")).toEqual([
      { type: "toolCallStart", id: "toolu_1", name: "get_weather" },
    ]);
    expect(eventsOf(chunks, "toolCallDelta")).toEqual([
      { type: "toolCallDelta", characters: 16 },
    ]);
    expect(eventsOf(chunks, "toolCall")).toEqual([
      { type: "toolCall", id: "toolu_1", name: "get_weather", args: { city: "Paris" } },
    ]);
    expect(eventsOf(chunks, "stopReason")).toEqual([
      { type: "stopReason", stopReason: "tool_use" },
    ]);
    expect(eventsOf(chunks, "usage")).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 12,
          outputTokens: 9,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
  });
});

const openaiChatSseBody = [
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":' } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }, finish_reason: null }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
  { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-5.3-chat-latest", choices: [], usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 } },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .join("") + "data: [DONE]\n\n";

describe("openai chat-completions streamed completion", () => {
  it("emits text, tool-call deltas and the final usage", async () => {
    const chunks = await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "weather?" }],
        "gpt-5.3-chat-latest",
        {},
      ),
    );

    expect(textOf(chunks)).toBe("Hello");
    expect(eventsOf(chunks, "toolCallStart")).toEqual([
      { type: "toolCallStart", id: "call_1", name: "get_weather" },
    ]);
    expect(eventsOf(chunks, "toolCallDelta")).toEqual([
      { type: "toolCallDelta", characters: 8 },
      { type: "toolCallDelta", characters: 8 },
    ]);
    expect(eventsOf(chunks, "toolCall")).toEqual([
      { type: "toolCall", id: "call_1", name: "get_weather", args: { city: "Paris" } },
    ]);
    expect(eventsOf(chunks, "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 10, outputTokens: 7 } },
    ]);
  });
});

const openaiResponsesSseBody = [
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "weighing" },
  { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "get_weather", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"city":"Paris"}' },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"city":"Paris"}' },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 2, content_index: 0, delta: "Hi" },
  {
    type: "response.completed",
    response: {
      id: "resp_1",
      status: "completed",
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    },
  },
]
  .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  .join("");

describe("openai Responses streamed completion", () => {
  it("emits text, reasoning, tool-call deltas and the final usage", async () => {
    const chunks = await collect(
      openaiProvider.generateTextStream(
        [{ role: "user", content: "weather?" }],
        "gpt-5.2",
        {},
      ),
    );

    expect(textOf(chunks)).toBe("Hi");
    expect(eventsOf(chunks, "thinking")).toEqual([
      { type: "thinking", content: "weighing" },
    ]);
    expect(eventsOf(chunks, "toolCallStart")).toEqual([
      { type: "toolCallStart", id: "call_1", name: "get_weather" },
    ]);
    expect(eventsOf(chunks, "toolCallDelta")).toEqual([
      { type: "toolCallDelta", characters: 16 },
    ]);
    expect(eventsOf(chunks, "toolCall")).toEqual([
      {
        type: "toolCall",
        id: "call_1",
        responsesItemId: "fc_1",
        name: "get_weather",
        args: { city: "Paris" },
        reasoningItem: { id: "rs_1", summary: [{ type: "summary_text", text: "weighing" }] },
      },
    ]);
    expect(eventsOf(chunks, "usage")).toEqual([
      {
        type: "usage",
        usage: {
          inputTokens: 3,
          outputTokens: 6,
          cacheReadInputTokens: 2,
          reasoningOutputTokens: 1,
        },
      },
    ]);
  });
});

const googleSseBody = [
  { candidates: [{ content: { parts: [{ text: "Hi" }], role: "model" }, index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } },
  { candidates: [{ content: { parts: [{ text: " there" }], role: "model" }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8, cachedContentTokenCount: 4 } },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .join("");

describe("google streamed completion", () => {
  it("emits text and the final usage", async () => {
    const chunks = await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        {},
      ),
    );

    expect(textOf(chunks)).toBe("Hi there");
    expect(eventsOf(chunks, "usage")).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 4 },
      },
    ]);
  });
});

const llamaCppSseBody = [
  { id: "l1", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
  { id: "l1", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
  { id: "l1", object: "chat.completion.chunk", model: "local", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }, timings: { predicted_per_second: 12.34 } },
]
  .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
  .join("") + "data: [DONE]\n\n";

describe("llama.cpp streamed completion", () => {
  it("emits text and the final usage with timings", async () => {
    const provider = createLlamaCppProvider("http://llama-box:8080");
    const chunks = await collect(
      provider.generateTextStream!(
        [{ role: "user", content: "hi" }],
        "local",
        {},
      ) as AsyncGenerator<Chunk>,
    );

    expect(textOf(chunks)).toBe("Hello");
    expect(eventsOf(chunks, "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 4, outputTokens: 2, tokensPerSec: 12.3 } },
    ]);
  });
});
