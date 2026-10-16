// Tests for the prism-service ProviderStreamResilience port (ch.06 items 4
// and 5): zero-chunk transient retry, the cut-stream invariant, the stall
// watchdog and context-overflow halving.
import { describe, expect, it } from "vitest";
import { ProviderError } from "../errors.ts";
import {
  parseContextOverflowError,
  reducedMaxTokensForOverflow,
  streamWithRetries,
  withIdleTimeout,
} from "../ProviderStreamResilience.ts";
import { MINIMUM_CLAMPED_OUTPUT_TOKENS, OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS } from "../../constants/TokenBudgetDefaults.ts";

async function* failingStream(error: unknown): AsyncGenerator<string> {
  throw error;
}

async function* singleChunkStream(...chunks: string[]): AsyncGenerator<string> {
  for (const chunk of chunks) yield chunk;
}

function deferredStream(): {
  stream: AsyncGenerator<string>;
  fail: (error: unknown) => void;
} {
  const { promise, reject } = Promise.withResolvers<void>();
  const stream = (async function* () {
    yield "first";
    await promise;
  })();
  return { stream, fail: reject };
}

describe("streamWithRetries", () => {
  it("retries a transient 503 when zero chunks were yielded", async () => {
    let attempts = 0;
    const chunks: string[] = [];
    const stream = streamWithRetries<string>(
      () => {
        attempts++;
        return attempts < 3
          ? failingStream(new ProviderError("vllm", "overloaded", 503))
          : singleChunkStream("ok");
      },
      { baseDelayMilliseconds: 1, label: "test" },
    );
    for await (const chunk of stream) chunks.push(chunk);
    expect(attempts).toBe(3);
    expect(chunks).toEqual(["ok"]);
  });

  it("does not retry once a chunk reached the consumer", async () => {
    const { stream, fail } = deferredStream();
    let attempts = 0;
    const retried = streamWithRetries<string>(
      () => {
        attempts++;
        return stream;
      },
      { baseDelayMilliseconds: 1, label: "test" },
    );
    await expect(async () => {
      for await (const _chunk of retried) {
        fail(new ProviderError("vllm", "dropped", 502));
      }
    }).rejects.toThrow("dropped");
    expect(attempts).toBe(1);
  });

  it("never retries a terminal quota rejection", async () => {
    let attempts = 0;
    const quotaError = new ProviderError("openai", "insufficient quota", 429);
    (quotaError as unknown as Record<string, unknown>).code = "insufficient_quota";
    await expect(async () => {
      for await (const _chunk of streamWithRetries<string>(
        () => {
          attempts++;
          return failingStream(quotaError);
        },
        { baseDelayMilliseconds: 1, label: "test" },
      )) {
        /* unreachable */
      }
    }).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("does not retry a 400 (not transient)", async () => {
    let attempts = 0;
    await expect(async () => {
      for await (const _chunk of streamWithRetries<string>(
        () => {
          attempts++;
          return failingStream(new ProviderError("vllm", "bad request", 400));
        },
        { baseDelayMilliseconds: 1, label: "test" },
      )) {
        /* unreachable */
      }
    }).rejects.toThrow("bad request");
    expect(attempts).toBe(1);
  });
});

describe("withIdleTimeout", () => {
  it("throws a 504 and aborts the request when the stream stalls", async () => {
    let aborted = false;
    const stalled = (async function* () {
      yield "chunk";
      await new Promise(() => {});
    })();
    const watched = withIdleTimeout(stalled, 20, "test", () => {
      aborted = true;
    });
    const received: string[] = [];
    await expect(async () => {
      for await (const chunk of watched) received.push(chunk);
    }).rejects.toThrow(/stalled/);
    expect(received).toEqual(["chunk"]);
    expect(aborted).toBe(true);
  });

  it("passes chunks through when the stream completes", async () => {
    const watched = withIdleTimeout(singleChunkStream("a", "b"), 1_000, "test");
    const received: string[] = [];
    for await (const chunk of watched) received.push(chunk);
    expect(received).toEqual(["a", "b"]);
  });
});

describe("context overflow halving", () => {
  it("parses a vLLM overflow rejection", () => {
    const error = new Error(
      "This model's maximum context length is 90000 tokens. However, you requested 58082 output tokens and your prompt contains at least 31919 input tokens.",
    );
    const overflow = parseContextOverflowError(error);
    expect(overflow).toEqual({
      contextWindow: 90000,
      requestedOutputTokens: 58082,
      inputTokens: 31919,
    });
  });

  it("returns null for unrelated errors", () => {
    expect(parseContextOverflowError(new Error("connection refused"))).toBeNull();
    expect(parseContextOverflowError(undefined)).toBeNull();
  });

  it("halves maxTokens and honours the reported-input bound", () => {
    const overflow = { contextWindow: 90_000, requestedOutputTokens: 58_082, inputTokens: 31919 };
    expect(
      reducedMaxTokensForOverflow(
        58_082,
        overflow,
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
      ),
    ).toBe(29_041);
    expect(
      reducedMaxTokensForOverflow(
        58_082,
        { ...overflow, inputTokens: null },
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
      ),
    ).toBe(29_041);
  });

  it("refuses when the prompt alone fills the window", () => {
    const overflow = { contextWindow: 32_768, requestedOutputTokens: null, inputTokens: 40_000 };
    expect(
      reducedMaxTokensForOverflow(
        8_192,
        overflow,
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
      ),
    ).toBeNull();
  });

  it("refuses to go below the minimum clamped output", () => {
    const overflow = { contextWindow: 90_000, requestedOutputTokens: null, inputTokens: null };
    expect(
      reducedMaxTokensForOverflow(
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
        overflow,
        MINIMUM_CLAMPED_OUTPUT_TOKENS,
        OUTPUT_TOKEN_CLAMP_FIXED_HEADROOM_TOKENS,
      ),
    ).toBeNull();
  });
});
