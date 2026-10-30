/**
 * Coverage tests for the OpenAI provider.
 *
 * Requests and responses are recorded REST payloads replayed through a stubbed
 * fetch — no live model calls, no network.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.OPENAI_API_KEY = "test-openai-key"; /* # secret-ok */
});

import openaiProvider, { prepareResponsesInput } from "../openai.ts";
import type { OpenAIMessage } from "../openai.ts";

type Route = (url: string, init: RequestInit | undefined) => Response;

let route: Route = () => new Response("unrouted", { status: 404 });
const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function apiError(message: string, status = 400): Response {
  return jsonResponse(
    { error: { message, type: "invalid_request_error", code: null } },
    status,
  );
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

const responsesRequest = () =>
  requests.find((request) => request.url.includes("/responses"))?.body;
const chatRequest = () =>
  requests.find((request) => request.url.includes("/chat/completions"))?.body;

describe("openai prepareResponsesInput", () => {
  it("maps system, media, tool calls and tool results into Responses items", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "sys", name: "ops" },
      {
        role: "user",
        content: "hi",
        images: [
          "data:image/png;base64,QUJD",
          "https://media.test/doc.pdf",
          "data:application/pdf;base64,QUJD",
          "data:text/plain;base64,aGk=",
          "ftp://nope",
        ],
      },
      {
        role: "assistant",
        content: "answer",
        toolCalls: [
          {
            id: "call_1",
            name: "get_weather",
            args: { city: "Paris" },
            reasoningItem: {
              id: "rs_1",
              summary: [{ type: "summary_text", text: "why" }],
            },
            result: { ok: true },
          },
          {
            responsesItemId: "fc_2",
            id: "call_2",
            name: "second",
            args: '{"x":1}',
            result: "done",
          },
          { id: "weird", name: "third", args: {} },
        ],
      },
      { role: "tool", content: "sunny", tool_call_id: "call_1" },
      { role: "tool", content: { ok: true }, id: "call_2" },
      { role: "assistant", toolCalls: [{ id: "fc_3", name: "fourth" }] },
      { role: "user" },
    ];

    const items = prepareResponsesInput(messages);

    expect(items[0]).toEqual({ role: "developer", name: "ops", content: "sys" });
    expect(items[1]).toEqual({
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" },
        { type: "input_file", file_url: "https://media.test/doc.pdf" },
        {
          type: "input_file",
          file_data: "data:application/pdf;base64,QUJD",
          filename: "document.pdf",
        },
        { type: "input_text", text: "[Attached file (text/plain)]:\nhi" },
        { type: "input_text", text: "hi" },
      ],
    });
    expect(items[2]).toEqual({ role: "assistant", content: "answer" });
    expect(items[3]).toEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: "why" }],
    });
    expect(items[4]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"Paris"}',
    });
    expect(items[5]).toEqual({
      type: "function_call",
      id: "fc_2",
      call_id: "call_2",
      name: "second",
      arguments: '{"x":1}',
    });
    expect(items[6]).toMatchObject({
      type: "function_call",
      call_id: "weird",
      name: "third",
      arguments: "{}",
    });
    expect(items[6].id).toMatch(/^fc_weird$/);
    expect(items[7]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: '{"ok":true}',
    });
    expect(items[8]).toEqual({
      type: "function_call_output",
      call_id: "call_2",
      output: "done",
    });
    expect(items[9]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "sunny",
    });
    expect(items[10]).toEqual({
      type: "function_call_output",
      call_id: "call_2",
      output: '{"ok":true}',
    });
    expect(items[11]).toEqual({
      type: "function_call",
      id: "fc_3",
      call_id: "fc_3",
      name: "fourth",
      arguments: "{}",
    });
    expect(items[12]).toEqual({
      role: "user",
      content: "",
    });
  });

  it("falls back to the message id and stringifies object content for tool turns", () => {
    const items = prepareResponsesInput([
      { role: "tool", content: { value: 1 } },
    ]);

    expect(items).toEqual([
      { type: "function_call_output", call_id: undefined, output: '{"value":1}' },
    ]);
  });
});

describe("openai sanitizeSchemaForOpenAI", () => {
  it("enforces strict objects, nullable properties and anyOf types", async () => {
    route = () =>
      jsonResponse({
        id: "resp_1",
        object: "response",
        output: [],
        output_text: "",
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });

    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.2",
      {
        tools: [
          {
            name: "create_widget",
            parameters: {
              type: "object",
              title: "Widget",
              default: 1,
              properties: {
                name: { type: "string" },
                count: { type: "number", minimum: 0 },
                mode: { type: ["string", "number"] },
                choice: { anyOf: [{ type: "string" }, { type: "null" }] },
                flag: true,
              },
              required: ["name"],
            },
          },
          {
            name: "nullable_root",
            parameters: { type: ["object", "null"], properties: {} },
          },
          {
            name: "bare_object",
            parameters: { type: "object" },
          },
        ],
      },
    );

    const tools = responsesRequest()!.tools as Array<Record<string, unknown>>;
    expect(tools[0].parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        count: { anyOf: [{ type: "number" }, { type: "null" }] },
        mode: { anyOf: [{ type: "string" }, { type: "number" }] },
        choice: { anyOf: [{ type: "string" }, { type: "null" }] },
        flag: true,
      },
      required: ["name", "count", "mode", "choice", "flag"],
    });
    expect(tools[1].parameters).toEqual({
      anyOf: [
        { type: "object", properties: {}, additionalProperties: false },
        { type: "null" },
      ],
    });
    expect(tools[2].parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(tools[0]).toMatchObject({ strict: true, type: "function" });
  });
});

describe("openai extractResponsesOutput", () => {
  it("collects images, pairs reasoning with function calls and tolerates bad JSON", async () => {
    route = () =>
      jsonResponse({
        id: "resp_1",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Hi" }],
          },
          { type: "image_generation_call", result: "BASE64IMAGE" },
          { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "why" }] },
          { type: "function_call", call_id: "call_1", id: "fc_1", name: "get_weather", arguments: '{"city":"Paris"}' },
          { type: "function_call", call_id: "call_2", id: "fc_2", name: "broken", arguments: "{not json" },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      });

    const result = await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.2",
      {},
    );

    expect(result.text).toBe("Hi");
    expect(result.images).toEqual([
      { type: "image", data: "BASE64IMAGE", mimeType: "image/png" },
    ]);
    expect(result.toolCalls).toEqual([
      {
        id: "call_1",
        responsesItemId: "fc_1",
        name: "get_weather",
        args: { city: "Paris" },
        reasoningItem: { id: "rs_1", summary: [{ type: "summary_text", text: "why" }] },
      },
      {
        id: "call_2",
        responsesItemId: "fc_2",
        name: "broken",
        args: {},
      },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 8,
      outputTokens: 4,
      cacheReadInputTokens: 2,
      reasoningOutputTokens: 1,
    });
  });

  it("returns empty collections when the response has no output", async () => {
    route = () =>
      jsonResponse({
        id: "resp_2",
        object: "response",
        output: [],
        usage: null,
      });

    const result = await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.2",
      {},
    );

    expect(result.images).toEqual([]);
    expect(result.toolCalls).toBeUndefined();
    expect(result.text).toBe("");
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("openai generateImage", () => {
  it("generates a new image when no input images are supplied", async () => {
    route = () =>
      jsonResponse({ data: [{ b64_json: "AAA", revised_prompt: "a nicer cat" }] });

    const result = await openaiProvider.generateImage(
      "a cat",
      [],
      "gpt-image-1.5",
    );

    expect(result).toEqual({
      imageData: "AAA",
      mimeType: "image/png",
      text: "a nicer cat",
    });
    const body = chatlessImageRequest();
    expect(body).toMatchObject({
      model: "gpt-image-1.5",
      prompt: "a cat",
      output_format: "png",
      size: "1024x1024",
      quality: "high",
    });
  });

  it("edits the last data URL image", async () => {
    route = () => jsonResponse({ data: [{ b64_json: "BBB" }] });

    const result = await openaiProvider.generateImage("edit it", [
      "data:image/png;base64,QUJD",
      "data:image/webp;base64,REVG",
    ]);

    expect(result).toEqual({ imageData: "BBB", mimeType: "image/png", text: "" });
    expect(requests.at(-1)!.url).toContain("/images/edits");
  });

  it("edits an { imageData, mimeType } object image", async () => {
    route = () => jsonResponse({ data: [{ b64: "CCC" }] });

    const result = await openaiProvider.generateImage("edit it", [
      { imageData: "QUJD", mimeType: "image/jpeg" },
    ]);

    expect(result.imageData).toBe("CCC");
    expect(requests.at(-1)!.url).toContain("/images/edits");
  });

  it("rejects an unusable image reference", async () => {
    route = () => jsonResponse({ data: [] });

    await expect(
      openaiProvider.generateImage("edit it", ["not-a-data-url"]),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("Invalid image data format"),
    });
  });

  it("rejects a response without image bytes and wraps API errors", async () => {
    route = () => jsonResponse({ data: [{}] });
    await expect(
      openaiProvider.generateImage("a cat"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("No image data received"),
    });

    route = () => apiError("image generation refused", 500);
    await expect(
      openaiProvider.generateImage("a cat"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("image generation refused"),
    });
  });
});

describe("openai transcribeAudio", () => {
  it("sends language and prompt and maps token usage", async () => {
    route = () =>
      jsonResponse({
        text: "hello world",
        usage: { type: "tokens", input_tokens: 12, output_tokens: 3 },
      });

    const result = await openaiProvider.transcribeAudio(
      Buffer.from("RIFF"),
      "audio/wav",
      "gpt-4o-transcribe",
      { language: "en", prompt: "Verbatim." },
    );

    expect(result).toEqual({
      text: "hello world",
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(requests.at(-1)!.url).toContain("/audio/transcriptions");
  });

  it("maps duration usage", async () => {
    route = () =>
      jsonResponse({
        text: "clip",
        usage: { type: "duration", seconds: 3.5 },
      });

    const result = await openaiProvider.transcribeAudio(
      Buffer.from("RIFF"),
      "audio/mpeg",
    );

    expect(result).toEqual({
      text: "clip",
      usage: { durationSeconds: 3.5 },
    });
  });

  it("falls back to a wav extension for unknown subtypes and omits usage", async () => {
    route = () => jsonResponse({ text: "plain" });

    const result = await openaiProvider.transcribeAudio(
      Buffer.from("x"),
      "application/octet-stream",
    );

    expect(result).toEqual({ text: "plain", usage: {} });
  });

  it("wraps API failures in a ProviderError", async () => {
    route = () => apiError("audio too long", 413);

    await expect(
      openaiProvider.transcribeAudio(Buffer.from("x"), "audio/wav"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("audio too long"),
    });
  });
});

/** Body of the most recent images endpoint call. */
function chatlessImageRequest(): Record<string, unknown> | null {
  return requests.at(-1)!.body;
}

describe("openai responses payload wiring", () => {
  it("forwards reasoning, text config, sampling and tools for gpt-5.2", async () => {
    route = () =>
      jsonResponse({
        id: "resp_1",
        object: "response",
        output_text: "ok",
        output: [],
        usage: { input_tokens: 1, output_tokens: 1 },
      });

    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.2",
      {
        reasoningEffort: "none",
        reasoningSummary: "concise",
        verbosity: "low",
        responseFormat: "json_object",
        maxTokens: 64,
        seed: "7",
        serviceTier: "priority",
        temperature: 0.3,
        topP: 0.9,
        frequencyPenalty: 0.1,
        presencePenalty: 0.2,
        stopSequences: ["STOP"],
        webSearch: true,
        parallelToolCalls: false,
        store: false,
        topLogprobs: 2,
        tools: [{ name: "lookup", parameters: { type: "object", properties: {} } }],
      },
    );

    const body = responsesRequest()!;
    expect(body).toMatchObject({
      model: "gpt-5.2",
      reasoning: { effort: "none", summary: "concise" },
      text: { format: { type: "json_object" }, verbosity: "low" },
      max_output_tokens: 64,
      seed: 7,
      service_tier: "priority",
      temperature: 0.3,
      top_p: 0.9,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ["STOP"],
      parallel_tool_calls: false,
      store: false,
      top_logprobs: 2,
    });
    expect((body.tools as unknown[])[0]).toEqual({ type: "web_search" });
    expect((body.tools as unknown[])[1]).toMatchObject({
      type: "function",
      name: "lookup",
      strict: true,
    });
    expect(body).not.toHaveProperty("stream");
  });

  it("maps json_schema response format", async () => {
    route = () =>
      jsonResponse({ id: "resp_1", object: "response", output: [], usage: null });

    await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-5.2",
      {
        responseFormat: "json_schema",
        responseSchema: { name: "out", schema: { type: "object", properties: {} } },
        reasoningEffort: "high",
      },
    );

    const body = responsesRequest()!;
    expect(body.text).toEqual({
      format: {
        type: "json_schema",
        json_schema: { name: "out", schema: { type: "object", properties: {} } },
      },
    });
    expect(body.reasoning).toEqual({ effort: "high", summary: "auto" });
  });
});

describe("openai chat-completions path", () => {
  it("maps tool calls and usage from a chat completion", async () => {
    route = () =>
      jsonResponse({
        id: "c1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "calling",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "get_weather", arguments: '{"city":"Paris"}' },
                },
                { id: "call_2", type: "custom", function: { name: "", arguments: "" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      });

    const result = await openaiProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gpt-4o",
      { temperature: 0.2, maxTokens: 32, seed: 5, serviceTier: "auto", responseFormat: "json_object" },
    );

    expect(result.text).toBe("calling");
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "get_weather", args: { city: "Paris" } },
      { id: "call_2", name: "", args: {} },
    ]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
    const body = chatRequest()!;
    expect(body).toMatchObject({
      model: "gpt-4o",
      temperature: 0.2,
      max_completion_tokens: 32,
      seed: 5,
      service_tier: "auto",
      response_format: { type: "json_object" },
    });
  });
});
