/**
 * Coverage tests for the Google provider.
 *
 * Every fixture is a recorded REST/SSE payload replayed through a stubbed
 * fetch (and a stubbed Live transport) — no live model calls.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.GOOGLE_CLOUD_GEMINI_API_KEY = "test-google-key"; /* # secret-ok */
});

/**
 * In-memory stand-in for @google/genai's Live transport. The SDK's Live API
 * opens a real WebSocket, which tests must never do; this mock keeps every
 * other SDK surface (generateContent, embedContent, ...) intact and replaces
 * only `live.connect`.
 */
const liveBridge = vi.hoisted(() => ({
  script: [] as Array<{ payload?: unknown; error?: unknown; close?: boolean }>,
  beforeSetup: [] as Array<{ payload?: unknown; error?: unknown; close?: boolean }>,
  sent: [] as unknown[],
  setup: null as null | { model?: string; config?: Record<string, unknown> },
  closeThrows: false,
  failConnect: false,
}));

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  type ScriptedMessage = { payload?: unknown; error?: unknown; close?: boolean };

  const connect = async (params: {
    model?: string;
    config?: Record<string, unknown>;
    callbacks?: {
      onopen?: () => void;
      onmessage?: (message: unknown) => void;
      onerror?: (error: unknown) => void;
      onclose?: () => void;
    };
  }) => {
    if (liveBridge.failConnect) throw new Error("websocket refused");
    liveBridge.setup = params;
    const callbacks = params.callbacks ?? {};
    const emit = (message: ScriptedMessage) => {
      if (message.error !== undefined) callbacks.onerror?.(message.error);
      else if (message.close) callbacks.onclose?.();
      else callbacks.onmessage?.(message.payload);
    };
    callbacks.onopen?.();
    for (const message of liveBridge.beforeSetup) emit(message);
    callbacks.onmessage?.({ setupComplete: {} });
    let scriptDrained = false;
    const drainScript = () => {
      if (scriptDrained) return;
      scriptDrained = true;
      for (const message of liveBridge.script) emit(message);
    };
    return {
      sendClientContent(payload: unknown) {
        liveBridge.sent.push({ clientContent: payload });
      },
      sendRealtimeInput(payload: unknown) {
        liveBridge.sent.push({ realtimeInput: payload });
        drainScript();
      },
      close() {
        if (liveBridge.closeThrows) throw new Error("socket already closed");
        callbacks.onclose?.();
      },
    };
  };

  class LiveTransportMock extends actual.GoogleGenAI {
    constructor(options: ConstructorParameters<typeof actual.GoogleGenAI>[0]) {
      super(options);
      this.live = { connect } as unknown as typeof this.live;
    }
  }
  return { ...actual, GoogleGenAI: LiveTransportMock };
});

import googleProvider, { convertToolsToGoogle } from "../google.ts";

type Route = (url: string, init: RequestInit | undefined) => Response;

let route: Route = () => new Response("unrouted", { status: 404 });
const requests: Array<{ url: string; body: Record<string, unknown> | null }> = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  return new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function apiError(message: string, status = 400): Response {
  return jsonResponse({ error: { code: status, message, status: "INVALID_ARGUMENT" } }, status);
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
  liveBridge.sent = [];
  liveBridge.setup = null;
  liveBridge.script = [];
  liveBridge.beforeSetup = [];
  liveBridge.closeThrows = false;
  liveBridge.failConnect = false;
});

afterAll(() => vi.restoreAllMocks());

async function collect(stream: AsyncGenerator<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

const generateRequest = () =>
  requests.find((request) => request.url.includes(":generateContent"))?.body;
const streamRequest = () =>
  requests.find((request) => request.url.includes(":streamGenerateContent"))?.body;
const lastGenerateRequest = () =>
  requests.filter((request) => request.url.includes(":generateContent")).at(-1)?.body;

describe("google buildGenerateConfig", () => {
  it("forwards every sampling option and disables thinking explicitly", async () => {
    route = () =>
      jsonResponse({
        candidates: [{ content: { role: "model", parts: [{ text: "hi" }] } }],
        usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
      });

    const result = await googleProvider.generateText(
      [{ role: "user", content: "hello" }],
      "gemini-3-flash-preview",
      {
        temperature: 0.5,
        topP: 0.8,
        topK: 20,
        presencePenalty: 0.3,
        frequencyPenalty: 0.2,
        stopSequences: ["STOP"],
        maxTokens: 100,
        seed: "9",
        responseMimeType: "application/json",
        candidateCount: 2,
        mediaResolution: "MEDIA_RESOLUTION_HIGH",
        responseLogprobs: true,
        logprobs: 3,
        serviceTier: "priority",
        thinkingEnabled: false,
        systemPrompt: "be brief",
      },
    );

    expect(result).toEqual({
      text: "hi",
      usage: { inputTokens: 2, outputTokens: 1 },
    });
    const config = generateRequest()!.generationConfig as Record<string, unknown>;
    expect(config).toMatchObject({
      temperature: 0.5,
      topP: 0.8,
      topK: 20,
      presencePenalty: 0.3,
      frequencyPenalty: 0.2,
      stopSequences: ["STOP"],
      maxOutputTokens: 100,
      seed: 9,
      responseMimeType: "application/json",
      candidateCount: 2,
      mediaResolution: "MEDIA_RESOLUTION_HIGH",
      responseLogprobs: true,
      logprobs: 3,
      thinkingConfig: { thinkingBudget: 0 },
    });
    expect(generateRequest()!.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "be brief" }],
    });
  });

  it("maps responseFormat to JSON mime type and keeps an explicit thinking budget", async () => {
    route = () => jsonResponse({ candidates: [] });

    await googleProvider.generateText(
      [{ role: "user", content: "hello" }],
      "gemini-3-flash-preview",
      {
        maxTokens: 0,
        responseFormat: "json_object",
        candidateCount: 1,
        serviceTier: "auto",
        logprobs: 0,
        thinkingEnabled: true,
        thinkingBudget: "500",
      },
    );

    const config = generateRequest()!.generationConfig as Record<string, unknown>;
    expect(config.responseMimeType).toBe("application/json");
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 500,
    });
    expect(config).not.toHaveProperty("maxOutputTokens");
    expect(config).not.toHaveProperty("candidateCount");
    expect(config).not.toHaveProperty("serviceTier");
  });

  it("uses the catalog thinking level when no budget is given", async () => {
    route = () => jsonResponse({ candidates: [] });

    await googleProvider.generateText(
      [{ role: "user", content: "hello" }],
      "gemini-3-flash-preview",
      { thinkingEnabled: true, thinkingLevel: "high" },
    );

    const config = generateRequest()!.generationConfig as Record<string, unknown>;
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "high",
    });
  });

  it("requests image modalities for image-output models", async () => {
    route = () =>
      jsonResponse({
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
      });

    await googleProvider.generateText(
      [{ role: "user", content: "draw" }],
      "gemini-3-pro-image-preview",
      {},
    );
    expect(generateRequest()!.generationConfig).toMatchObject({
      responseModalities: ["TEXT", "IMAGE"],
    });

    await googleProvider.generateText(
      [{ role: "user", content: "draw" }],
      "gemini-3-pro-image-preview",
      { forceImageGeneration: true },
    );
    expect(lastGenerateRequest()!.generationConfig).toMatchObject({
      responseModalities: ["IMAGE"],
    });
  });

  it("leaves the config bare for a model missing from the catalog", async () => {
    route = () => jsonResponse({ candidates: [] });

    await googleProvider.generateText(
      [{ role: "user", content: "hello" }],
      "some-unknown-model",
      {},
    );

    const body = generateRequest()!;
    expect(body).not.toHaveProperty("generationConfig.temperature");
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
    ]);
  });
});

describe("google convertMessages", () => {
  it("groups tool results, inlines media and preserves thought signatures", async () => {
    route = (url) => {
      if (url === "http://media.test/img.png") {
        return new Response(Buffer.from([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      if (url === "http://media.test/missing.png") {
        return new Response("gone", { status: 404 });
      }
      if (url === "http://media.test/boom.png") throw new Error("media down");
      return jsonResponse({ candidates: [] });
    };

    await googleProvider.generateText(
      [
        { role: "system", content: "identity" },
        {
          role: "user",
          content: "look",
          images: [
            "data:image/png;base64,AAAA",
            "http://media.test/img.png",
            "http://media.test/missing.png",
            "http://media.test/boom.png",
            "ftp://nope",
          ],
          pdf: ["data:application/pdf;base64,BBBB"],
        },
        {
          role: "assistant",
          content: "answer",
          toolCalls: [
            { name: "get_weather", args: { city: "Paris" }, thoughtSignature: "sig" },
            { name: "plain" },
          ],
        },
        { role: "tool", name: "get_weather", content: "sunny" },
        { role: "tool", content: { ok: true } },
        { role: "system" },
        { role: "user" },
      ],
      "gemini-3-flash-preview",
      {},
    );

    const contents = generateRequest()!.contents as Array<Record<string, unknown>>;
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "identity" }] });
    expect(contents[1]).toEqual({
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: "AAAA" } },
        { inlineData: { mimeType: "image/png", data: "AQID" } },
        { inlineData: { mimeType: "application/pdf", data: "BBBB" } },
        { text: "look" },
      ],
    });
    expect(contents[2]).toEqual({
      role: "model",
      parts: [
        { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "sig" },
        { functionCall: { name: "plain", args: {} } },
        { text: "answer" },
      ],
    });
    expect(contents[3]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "get_weather", response: { result: "sunny" } } },
        { functionResponse: { name: "any", response: { result: '{"ok":true}' } } },
      ],
    });
    expect(contents[4]).toEqual({ role: "user", parts: [] });
  });
});

describe("google extractGoogleTextResult", () => {
  it("collects text, tool calls, thought signatures and capped images", async () => {
    route = () =>
      jsonResponse({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "sig" },
                { text: "Hi" },
                { inlineData: { mimeType: "image/webp", data: "AAA" } },
                { inlineData: { mimeType: "image/png" } },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 2,
          cachedContentTokenCount: 4,
        },
      });

    const result = await googleProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gemini-3-flash-preview",
      { imageCount: 1 },
    );

    expect(result.text).toBe("Hi");
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      cacheReadInputTokens: 4,
    });
    expect(result.images).toEqual([{ data: "AAA", mimeType: "image/webp" }]);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]).toMatchObject({
      name: "get_weather",
      args: { city: "Paris" },
      thoughtSignature: "sig",
    });
  });

  it("returns an empty result when the response has no candidates", async () => {
    route = () => jsonResponse({});

    const result = await googleProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gemini-3-flash-preview",
      {},
    );

    expect(result).toEqual({ text: "", usage: { inputTokens: 0, outputTokens: 0 } });
    expect(result.toolCalls).toBeUndefined();
    expect(result.images).toBeUndefined();
  });
});

describe("google sanitizeSchemaForGoogle", () => {
  it("strips unsupported keywords, converts const and keeps property names", () => {
    const tools = convertToolsToGoogle([
      {
        name: "create_widget",
        description: "make one",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "Widget",
          examples: [{ kind: "a" }],
          additionalProperties: false,
          type: "object",
          properties: {
            title: { type: "string" },
            kind: { const: "round" },
            tags: { type: "array", items: { type: "string" } },
            nested: {
              type: "object",
              properties: { size: { type: "number", default: 1 } },
            },
          },
          required: ["kind"],
        },
      },
    ]);

    expect(tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "create_widget",
            description: "make one",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string" },
                kind: { enum: ["round"] },
                tags: { type: "array", items: { type: "string" } },
                nested: {
                  type: "object",
                  properties: { size: { type: "number" } },
                },
              },
              required: ["kind"],
            },
          },
        ],
      },
    ]);
  });

  it("returns null for an empty tool list and passes primitives through", () => {
    expect(convertToolsToGoogle(undefined)).toBeNull();
    expect(convertToolsToGoogle([])).toBeNull();
    expect(
      convertToolsToGoogle([{ name: "bare" }]),
    ).toEqual([
      {
        functionDeclarations: [
          { name: "bare", description: "", parameters: {} },
        ],
      },
    ]);
  });
});

describe("google generateTextStream", () => {
  it("streams text, thinking, images and code events plus final usage", async () => {
    route = () =>
      sseResponse([
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [
                  { thought: true, text: "pondering" },
                  { text: "Hi" },
                  { inlineData: { mimeType: "image/png", data: "AAA" } },
                  { executableCode: { code: "print(1)" } },
                  { codeExecutionResult: { output: "1", outcome: "OK" } },
                  { inlineData: { mimeType: "image/png", data: "BBB" } },
                ],
              },
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
        },
        {
          candidates: [
            {
              content: { role: "model", parts: [{ text: " there" }] },
              finishReason: "MAX_TOKENS",
              index: 0,
            },
          ],
          usageMetadata: {
            promptTokenCount: 5,
            candidatesTokenCount: 4,
            cachedContentTokenCount: 2,
          },
        },
      ]);

    const chunks = await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        { imageCount: 1, webSearch: true, codeExecution: true, urlContext: true },
      ),
    );

    expect(chunks).toEqual([
      { type: "thinking", content: "pondering" },
      "Hi",
      { type: "image", data: "AAA", mimeType: "image/png" },
      { type: "executableCode", code: "print(1)", language: "python" },
      { type: "codeExecutionResult", output: "1", outcome: "OK" },
      " there",
      { type: "stopReason", stopReason: "max_tokens" },
      {
        type: "usage",
        usage: { inputTokens: 5, outputTokens: 4, cacheReadInputTokens: 2 },
      },
    ]);

    const tools = streamRequest()!.tools as unknown[];
    expect(tools).toEqual([
      { googleSearch: {} },
      { codeExecution: {} },
      { urlContext: {} },
    ]);
  });

  it("attaches custom function declarations and image modalities", async () => {
    route = () => sseResponse([]);

    await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "draw" }],
        "gemini-3-pro-image-preview",
        {
          forceImageGeneration: true,
          tools: [{ name: "draw", parameters: { type: "object" } }],
        },
      ),
    );

    const body = streamRequest()!;
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: "draw", description: "", parameters: { type: "OBJECT" } },
        ],
      },
    ]);
    expect((body.generationConfig as Record<string, unknown>).responseModalities).toEqual([
      "IMAGE",
    ]);
  });

  it("stops early when the signal is already aborted", async () => {
    route = () => sseResponse([{ candidates: [{ content: { parts: [{ text: "never" }] } }] }]);
    const controller = new AbortController();
    controller.abort();

    const chunks = await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        { signal: controller.signal },
      ),
    );

    expect(chunks).toEqual([
      { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
  });

  it("reports content safety blocks as a usage chunk instead of throwing", async () => {
    route = () => apiError("The response was blocked by safety filters");

    const chunks = await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        {},
      ),
    );

    expect(chunks).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 0, outputTokens: 0 },
        safetyBlock: true,
      },
    ]);
  });

  it("returns quietly on AbortError and wraps other failures", async () => {
    route = () => {
      throw new DOMException("aborted", "AbortError");
    };
    const aborted = await collect(
      googleProvider.generateTextStream(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        {},
      ),
    );
    expect(aborted).toEqual([]);

    route = () => {
      throw new TypeError("network down");
    };
    await expect(
      collect(
        googleProvider.generateTextStream(
          [{ role: "user", content: "hi" }],
          "gemini-3-flash-preview",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "google",
      message: expect.stringContaining("network down"),
    });
  });
});

describe("google generateText failures", () => {
  it("returns an empty safetyBlock result for policy refusals", async () => {
    route = () => apiError("PROHIBITED_CONTENT: request rejected");

    const result = await googleProvider.generateText(
      [{ role: "user", content: "hi" }],
      "gemini-3-flash-preview",
      {},
    );

    expect(result).toEqual({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      safetyBlock: true,
    });
  });

  it("wraps non-safety errors in a ProviderError", async () => {
    route = () => apiError("quota exceeded", 429);

    await expect(
      googleProvider.generateText(
        [{ role: "user", content: "hi" }],
        "gemini-3-flash-preview",
        {},
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "google",
      message: expect.stringContaining("quota exceeded"),
    });
  });
});

describe("google generateImage", () => {
  it("returns the first inline image and accumulates preceding text", async () => {
    route = () =>
      sseResponse([
        { candidates: [{ content: { parts: [{ text: "sketching" }] } }] },
        { candidates: [] },
        {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: "AAA", mimeType: "image/webp" } }],
              },
            },
          ],
        },
      ]);

    const result = await googleProvider.generateImage(
      "a cat",
      ["data:image/png;base64,QUJD", { imageData: "REVG", mimeType: "image/jpeg" }, "not-a-data-url"],
      "gemini-3-pro-image-preview",
      "be vivid",
    );

    expect(result).toEqual({
      imageData: "AAA",
      mimeType: "image/webp",
      text: "sketching",
    });
    const body = streamRequest()!;
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { text: "a cat" },
          { inlineData: { mimeType: "image/png", data: "QUJD" } },
          { inlineData: { mimeType: "image/jpeg", data: "REVG" } },
        ],
      },
    ]);
    expect(body.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "be vivid" }],
    });
  });

  it("raises when the model flags prohibited content", async () => {
    route = () =>
      sseResponse([
        {
          candidates: [
            { content: { parts: [{ text: "nope" }] }, finishReason: "PROHIBITED_CONTENT" },
          ],
        },
      ]);

    await expect(
      googleProvider.generateImage("a cat", [], "gemini-3-pro-image-preview"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("flagged as prohibited"),
    });
  });

  it("raises when no image comes back", async () => {
    route = () => sseResponse([{ candidates: [{ content: { parts: [{ text: "text only" }] } }] }]);

    await expect(
      googleProvider.generateImage("a cat", [], "gemini-3-pro-image-preview"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("No image data received"),
    });
  });
});

describe("google generateSpeech", () => {
  it("returns an mp3 stream for audio/mpeg payloads", async () => {
    route = () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: Buffer.from("MP3").toString("base64"), mimeType: "audio/mpeg" } }],
            },
          },
        ],
      });

    const result = await googleProvider.generateSpeech("hello", "Kore", {
      prompt: "say it warmly",
      model: "gemini-2.5-flash-preview-tts",
    });

    expect(result.contentType).toBe("audio/mpeg");
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("MP3");
    expect(requests.at(-1)!.url).toContain("gemini-2.5-flash-preview-tts");
    const body = generateRequest()!;
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "say it warmly\n\nhello" }] },
    ]);
  });

  it("wraps non-mp3 audio in a WAV container", async () => {
    route = () =>
      jsonResponse({
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64"), mimeType: "audio/L16" } }],
            },
          },
        ],
      });

    const result = await googleProvider.generateSpeech("hello");
    expect(result.contentType).toBe("audio/wav");
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(chunk as Buffer);
    const wav = Buffer.concat(chunks);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(44).toString("hex")).toBe("0102");
  });

  it("raises when the response carries no audio and wraps transport errors", async () => {
    route = () => jsonResponse({ candidates: [{ content: { parts: [{ text: "no audio" }] } }] });
    await expect(googleProvider.generateSpeech("hello")).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("No audio content"),
    });

    route = () => apiError("speech failed", 500);
    await expect(googleProvider.generateSpeech("hello")).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("speech failed"),
    });
  });
});

describe("google transcribeAudio", () => {
  it("inlines the audio and returns text plus cached usage", async () => {
    route = () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "hello world" }] } }],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 3,
          cachedContentTokenCount: 2,
        },
      });

    const result = await googleProvider.transcribeAudio(
      Buffer.from("RIFF"),
      "audio/wav",
      "gemini-3.5-flash",
      { language: "French", prompt: "Transcribe verbatim." },
    );

    expect(result).toEqual({
      text: "hello world",
      usage: { inputTokens: 9, outputTokens: 3, cacheReadInputTokens: 2 },
    });
    const body = generateRequest()!;
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: "audio/wav", data: Buffer.from("RIFF").toString("base64") } },
          { text: "Transcribe verbatim." },
        ],
      },
    ]);
    expect(body.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "Transcribe in French." }],
    });
  });

  it("uses the default prompt and zero usage when the response is empty", async () => {
    route = () => jsonResponse({ candidates: [] });

    const result = await googleProvider.transcribeAudio(Buffer.from("x"), "audio/mpeg");
    expect(result).toEqual({
      text: "",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const parts = (generateRequest()!.contents as Array<{ parts: Array<{ text?: string }> }>)[0].parts;
    expect(parts[1].text).toContain("Transcribe the following audio accurately");
  });

  it("wraps failures in a ProviderError", async () => {
    route = () => apiError("bad audio", 400);
    await expect(
      googleProvider.transcribeAudio(Buffer.from("x"), "audio/wav"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("bad audio"),
    });
  });
});

describe("google generateEmbedding", () => {
  it("embeds plain text and forwards task type and dimensions", async () => {
    route = () => jsonResponse({ embeddings: [{ values: [0.1, 0.2, 0.3] }] });

    const result = await googleProvider.generateEmbedding!("hello", "gemini-embedding-2-preview", {
      taskType: "RETRIEVAL_DOCUMENT",
      dimensions: 3,
    });

    expect(result).toEqual({ embedding: [0.1, 0.2, 0.3], dimensions: 3 });
    const body = requests.at(-1)!.body!;
    expect((body.requests as Array<Record<string, unknown>>)[0]).toMatchObject({
      content: { parts: [{ text: "hello" }] },
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 3,
    });
  });

  it("embeds a multimodal parts array without a config", async () => {
    route = () => jsonResponse({ embeddings: [{ values: [1] }] });

    const result = await googleProvider.generateEmbedding!(
      [{ text: "describe" }, { inlineData: { mimeType: "image/png", data: "AAA" } }],
    );

    expect(result).toEqual({ embedding: [1], dimensions: 1 });
    expect(requests.at(-1)!.body).not.toHaveProperty("config");
  });

  it("passes an already-built contents object through", async () => {
    route = () => jsonResponse({ embeddings: [{ values: [2, 4] }] });

    const result = await googleProvider.generateEmbedding!({
      role: "user",
      parts: [{ text: "raw" }],
    });

    expect(result).toEqual({ embedding: [2, 4], dimensions: 2 });
  });

  it("raises a ProviderError when the response has no embeddings", async () => {
    route = () => jsonResponse({});

    await expect(
      googleProvider.generateEmbedding!("hello"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("No embedding data"),
    });
  });

  it("preserves the HTTP status of SDK failures", async () => {
    route = () => apiError("invalid model", 404);

    await expect(
      googleProvider.generateEmbedding!("hello"),
    ).rejects.toMatchObject({
      name: "ProviderError",
      statusCode: 404,
    });
  });
});

describe("google captionImage", () => {
  it("inlines remote and data URL images with the detected mime types", async () => {
    route = (url) => {
      if (url === "https://media.test/cat.png") {
        return new Response(Buffer.from([9, 9]), {
          status: 200,
          headers: { "content-type": "image/webp" },
        });
      }
      return jsonResponse({
        candidates: [{ content: { parts: [{ text: "a cat" }] } }],
        usageMetadata: {
          promptTokenCount: 4,
          candidatesTokenCount: 2,
          cachedContentTokenCount: 1,
        },
      });
    };

    const result = await googleProvider.captionImage(
      ["https://media.test/cat.png", "data:image/png;base64,QUJD", "PLAIN"],
      "What is this?",
      "gemini-3-flash-preview",
      "Be terse.",
    );

    expect(result).toEqual({
      text: "a cat",
      usage: { inputTokens: 4, outputTokens: 2, cacheReadInputTokens: 1 },
    });
    const body = generateRequest()!;
    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [
          { inlineData: { data: Buffer.from([9, 9]).toString("base64"), mimeType: "image/webp" } },
          { inlineData: { data: "QUJD", mimeType: "image/png" } },
          { inlineData: { data: "PLAIN", mimeType: "image/jpeg" } },
          { text: "What is this?" },
        ],
      },
    ]);
    expect(body.systemInstruction).toEqual({
      role: "user",
      parts: [{ text: "Be terse." }],
    });
  });

  it("fails when a remote image cannot be fetched", async () => {
    route = () => new Response("missing", { status: 404 });

    await expect(
      googleProvider.captionImage(["https://media.test/gone.png"]),
    ).rejects.toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("Failed to fetch image"),
    });
  });
});

describe("google generateTextStreamLive", () => {
  const liveOptions = {
    temperature: 0.4,
    topP: 0.9,
    topK: 30,
    maxTokens: 512,
    webSearch: true,
    thinkingEnabled: true,
    thinkingBudget: "1000",
    tools: [{ name: "lookup", parameters: { type: "object" } }],
  };

  const liveMessages = [
    { role: "system", content: "identity" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "assistant" },
    { role: "user", content: "last" },
  ];

  it("bridges setup, history, realtime input and every server event", async () => {
    liveBridge.script = [
      {
        payload: {
          serverContent: {
            modelTurn: {
              parts: [
                { thought: true, text: "think" },
                { text: "hello" },
                { inlineData: { data: "AAA", mimeType: "audio/pcm" } },
                { functionCall: { name: "f", args: { a: 1 } }, thoughtSignature: "sig" },
              ],
            },
          },
        },
      },
      { payload: { serverContent: { outputTranscription: { text: "transcript" } } } },
      { payload: { toolCall: { functionCalls: [{ name: "g", args: { b: 2 } }] } } },
      {
        payload: {
          usageMetadata: { promptTokenCount: 3, responseTokenCount: 2, cachedContentTokenCount: 1 },
        },
      },
      { payload: { serverContent: { turnComplete: true } } },
    ];

    const chunks = await collect(
      googleProvider.generateTextStreamLive(
        liveMessages,
        "gemini-3.1-flash-live-preview",
        liveOptions,
      ),
    );

    expect(chunks).toEqual([
      { type: "thinking", content: "think" },
      "hello",
      { type: "audio", data: "AAA", mimeType: "audio/pcm" },
      { type: "toolCall", id: expect.stringMatching(/^google-toolCall-/), name: "f", args: { a: 1 }, thoughtSignature: "sig" },
      "transcript",
      { type: "toolCall", id: expect.stringMatching(/^google-toolCall-/), name: "g", args: { b: 2 } },
      {
        type: "usage",
        usage: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 1 },
      },
    ]);

    expect(liveBridge.setup!.model).toBe("gemini-3.1-flash-live-preview");
    const config = liveBridge.setup!.config!;
    expect(config).toMatchObject({
      responseModalities: ["AUDIO"],
      outputAudioTranscription: {},
      temperature: 0.4,
      topP: 0.9,
      topK: 30,
      maxOutputTokens: 512,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 1000 },
      systemInstruction: "identity",
    });
    expect(config.tools).toEqual([
      { googleSearch: {} },
      {
        functionDeclarations: [
          { name: "lookup", description: "", parameters: { type: "object" } },
        ],
      },
    ]);

    const history = liveBridge.sent[0] as {
      clientContent: { turns: Array<Record<string, unknown>>; turnComplete: boolean };
    };
    expect(history.clientContent.turnComplete).toBe(false);
    expect(history.clientContent.turns).toEqual([
      { role: "user", parts: [{ text: "first" }] },
      { role: "model", parts: [{ text: "reply" }] },
    ]);
    expect(liveBridge.sent[1]).toEqual({
      realtimeInput: { text: "last" },
    });
  });

  it("omits thinking and tools when disabled", async () => {
    liveBridge.script = [
      { payload: { serverContent: { turnComplete: true } } },
    ];

    const chunks = await collect(
      googleProvider.generateTextStreamLive(
        [{ role: "user", content: "solo" }],
        "gemini-3.1-flash-live-preview",
        { thinkingEnabled: false },
      ),
    );

    expect(chunks).toEqual([]);
    const config = liveBridge.setup!.config!;
    expect(config).not.toHaveProperty("thinkingConfig");
    expect(config).not.toHaveProperty("tools");
    expect(liveBridge.sent).toEqual([{ realtimeInput: { text: "solo" } }]);
  });

  it("uses the catalog thinking level and skips an empty max token budget", async () => {
    liveBridge.script = [
      { payload: { serverContent: { turnComplete: true } } },
    ];

    await collect(
      googleProvider.generateTextStreamLive(
        [{ role: "user", content: "solo" }],
        "gemini-3.1-flash-live-preview",
        { thinkingEnabled: true, thinkingLevel: "high", maxTokens: 0, topP: 0.5 },
      ),
    );

    const config = liveBridge.setup!.config!;
    expect(config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "high",
    });
    expect(config).not.toHaveProperty("maxOutputTokens");
  });

  it("throws the inner error message when the session fails before setup", async () => {
    liveBridge.beforeSetup = [{ error: { error: { message: "live boom" } } }];

    await expect(
      collect(
        googleProvider.generateTextStreamLive(
          [{ role: "user", content: "hi" }],
          "gemini-3.1-flash-live-preview",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "google",
      message: "live boom",
    });
    expect(liveBridge.sent).toEqual([]);
  });

  it("falls back to the outer error message and to 'unknown error'", async () => {
    liveBridge.beforeSetup = [{ error: { message: "outer only" } }];
    await expect(
      collect(
        googleProvider.generateTextStreamLive(
          [{ role: "user", content: "hi" }],
          "gemini-3.1-flash-live-preview",
          {},
        ),
      ),
    ).rejects.toMatchObject({ message: "outer only" });

    liveBridge.beforeSetup = [{ error: "just a string" }];
    await expect(
      collect(
        googleProvider.generateTextStreamLive(
          [{ role: "user", content: "hi" }],
          "gemini-3.1-flash-live-preview",
          {},
        ),
      ),
    ).rejects.toMatchObject({ message: "unknown error" });
  });

  it("raises an error delivered mid-conversation", async () => {
    liveBridge.script = [
      { payload: { serverContent: { outputTranscription: { text: "partial" } } } },
      { error: { error: { message: "dropped mid-turn" } } },
    ];

    const chunks: unknown[] = [];
    let error: unknown = null;
    try {
      for await (const chunk of googleProvider.generateTextStreamLive(
        [{ role: "user", content: "hi" }],
        "gemini-3.1-flash-live-preview",
        {},
      )) {
        chunks.push(chunk);
      }
    } catch (thrown: unknown) {
      error = thrown;
    }

    expect(chunks).toEqual(["partial"]);
    expect(error).toMatchObject({
      name: "ProviderError",
      message: "dropped mid-turn",
    });
  });

  it("returns without sending when the session closes before setup", async () => {
    liveBridge.beforeSetup = [{ close: true }];

    const chunks = await collect(
      googleProvider.generateTextStreamLive(
        [{ role: "user", content: "hi" }],
        "gemini-3.1-flash-live-preview",
        {},
      ),
    );

    expect(chunks).toEqual([]);
    expect(liveBridge.sent).toEqual([]);
  });

  it("stops draining when the caller aborts mid-stream", async () => {
    liveBridge.script = [
      { payload: { serverContent: { outputTranscription: { text: "first" } } } },
      { payload: { serverContent: { outputTranscription: { text: "second" } } } },
    ];
    const controller = new AbortController();

    const chunks: unknown[] = [];
    for await (const chunk of googleProvider.generateTextStreamLive(
      [{ role: "user", content: "hi" }],
      "gemini-3.1-flash-live-preview",
      { signal: controller.signal },
    )) {
      chunks.push(chunk);
      controller.abort();
    }

    expect(chunks).toEqual(["first"]);
  });

  it("swallows a close failure on an already-closed session", async () => {
    liveBridge.script = [
      { payload: { serverContent: { outputTranscription: { text: "bye" } } } },
      { payload: { serverContent: { turnComplete: true } } },
    ];

    const chunks: unknown[] = [];
    for await (const chunk of googleProvider.generateTextStreamLive(
      [{ role: "user", content: "hi" }],
      "gemini-3.1-flash-live-preview",
      {},
    )) {
      chunks.push(chunk);
      liveBridge.closeThrows = true;
    }

    expect(chunks).toEqual(["bye"]);
  });

  it("wraps connection failures in a ProviderError", async () => {
    liveBridge.failConnect = true;

    await expect(
      collect(
        googleProvider.generateTextStreamLive(
          [{ role: "user", content: "hi" }],
          "gemini-3.1-flash-live-preview",
          {},
        ),
      ),
    ).rejects.toMatchObject({
      name: "ProviderError",
      provider: "google",
      message: expect.stringContaining("websocket refused"),
    });
  });
});
