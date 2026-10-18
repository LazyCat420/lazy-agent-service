/**
 * Text-markup tool call recovery in parseSSEStream (2026-10-17).
 *
 * When a model calls a tool absent from the request `tools` array, vLLM
 * cannot parse the call natively: it arrives as plain `delta.content` text
 * (`<tool_call>name<arg_key>k</arg_key><arg_value>v</tool_call>`) with finish_reason "stop". parseSSEStream must
 * recover complete blocks as toolCall chunks; native tool-call streams and
 * plain-text streams behave exactly as before.
 */
import { describe, expect, it } from "vitest";
import { parseSSEStream, type SSEStreamChunk } from "../openai-compat.ts";

function sseStream(body: string): ReadableStreamDefaultReader<Uint8Array> {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    }),
  ).body!.getReader();
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<SSEStreamChunk[]> {
  const chunks: SSEStreamChunk[] = [];
  for await (const chunk of parseSSEStream(reader, { label: "test" })) {
    chunks.push(chunk);
  }
  return chunks;
}

function textChunks(chunks: SSEStreamChunk[]): string {
  return chunks.filter((c): c is string => typeof c === "string").join("");
}

describe("markup tool call recovery in parseSSEStream", () => {
  it("recovers a GLM-format markup call from the lost-tool-call trace", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"Let me check that. <tool_call>html_notes.weather.get<arg_key>location</arg_key><arg_value>Seattle, WA</tool_call>"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";

    const chunks = await collect(sseStream(body));
    const toolCalls = chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => c.type === "toolCall");
    expect(toolCalls).toEqual([
      { type: "toolCall", id: "call_markup_0", name: "html_notes.weather.get", args: { location: "Seattle, WA" } },
    ]);
  });

  it("recovers multiple GLM args with closing tags, JSON-typed values, across chunk boundaries", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"<tool_call>global.web.search<arg_key>query</arg_key><arg_value>nvda price</arg_value><arg_key>max_"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"results</arg_key><arg_value>5</arg_value></tool_call>"},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";

    const chunks = await collect(sseStream(body));
    const toolCalls = chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => c.type === "toolCall");
    expect(toolCalls).toEqual([
      { type: "toolCall", id: "call_markup_0", name: "global.web.search", args: { query: "nvda price", max_results: 5 } },
    ]);
  });

  it("recovers a JSON-format markup call", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"<tool_call>{\\"name\\":\\"html_notes.weather.get\\",\\"arguments\\":{\\"location\\":\\"Austin, TX\\"}}</tool_call>"},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";

    const chunks = await collect(sseStream(body));
    const toolCalls = chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => c.type === "toolCall");
    expect(toolCalls).toEqual([
      { type: "toolCall", id: "call_markup_0", name: "html_notes.weather.get", args: { location: "Austin, TX" } },
    ]);
  });

  it("does not duplicate native tool calls and emits exactly one", async () => {
    const body =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_native_1","function":{"name":"global.web.search","arguments":"{\\"query\\":\\"weather\\"}"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      "data: [DONE]\n\n";

    const chunks = await collect(sseStream(body));
    const toolCalls = chunks.filter((c): c is Extract<SSEStreamChunk, { type: "toolCall" }> => c.type === "toolCall");
    expect(toolCalls).toEqual([
      { type: "toolCall", id: "call_native_1", name: "global.web.search", args: { query: "weather" } },
    ]);
  });

  it("yields zero toolCall chunks for plain-text stop output", async () => {
    const body =
      'data: {"choices":[{"delta":{"content":"Just an answer, no tools."},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";

    const chunks = await collect(sseStream(body));
    expect(chunks.filter((c) => c.type === "toolCall")).toEqual([]);
    expect(textChunks(chunks)).toContain("Just an answer, no tools.");
  });
});
