/**
 * Coverage2 for provider adapters whose hot functions were untested:
 * anthropic (request/response extraction, captioning, tool-call messages).
 *
 * All SDK/network boundaries are fakes; assertions are on the
 * returned values and the payloads sent to those boundaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const credentials = vi.hoisted(() => ({
  anthropic: "test-anthropic-key",
}));

vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ANTHROPIC_API_KEY: credentials.anthropic,
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

