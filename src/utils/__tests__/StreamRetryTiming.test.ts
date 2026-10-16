import { describe, it, expect, vi, afterEach } from "vitest";
import {
  streamWithRetries,
  streamEndedEarlyError,
} from "../ProviderStreamResilience.ts";
import { parseSSEStream, fetchOpenAICompat } from "../openai-compat.ts";
import { ProviderError } from "../errors.ts";

// The boundary probe's cut_stream timing contract: a stream the provider cut
// after deltas already streamed must fail in about a second (prism's rule),
// not after a retry cycle that replays text the consumer already saw.

function readerFrom(
  frames: string[],
  { closeEarly = false }: { closeEarly?: boolean } = {},
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index++]));
      } else if (closeEarly) {
        controller.close(); // no finish_reason, no [DONE] — a cut stream
      } else {
        controller.close();
      }
    },
  });
  return body.getReader();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("stream retry timing", () => {
  it("fails a stream cut after deltas within 2s, with no retry", async () => {
    let createCalls = 0;
    const factory = async () => {
      createCalls++;
      return (async function* () {
        const reader = readerFrom(
          ['data: {"choices":[{"delta":{"content":"probe"}}]}\n\n'],
          { closeEarly: true },
        );
        yield* parseSSEStream(reader, { label: "vllm" });
      })();
    };

    const start = Date.now();
    const stream = streamWithRetries(factory, { label: "vllm" });
    const chunks: unknown[] = [];
    await expect(async () => {
      for await (const chunk of stream) chunks.push(chunk);
    }).rejects.toMatchObject({ statusCode: 502 });

    expect(Date.now() - start).toBeLessThan(2000);
    expect(createCalls).toBe(1); // zero retries: output already reached the consumer
    expect(chunks.filter((chunk) => typeof chunk === "string")).toContain(
      "probe",
    );
  });

  it("retries a 503 with Retry-After before any output and succeeds", async () => {
    const delta =
      'data: {"choices":[{"delta":{"content":"ok"}}],"finish_reason":null}\n\n' +
      'data: {"choices":[{"delta":{}}],"finish_reason":"stop"}\n\n' +
      "data: [DONE]\n\n";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("saturation", {
          status: 503,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(delta));
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const factory = async () =>
      (async function* () {
        const response = await fetchOpenAICompat(
          "http://vllm-shim.test/v1/chat/completions",
          { model: "test" },
        );
        yield* parseSSEStream(response.body!.getReader(), {
          label: "vllm",
        });
      })();

    const start = Date.now();
    const stream = streamWithRetries(factory, { label: "vllm" });
    const text: string[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === "string") text.push(chunk);
    }
    const elapsed = Date.now() - start;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text.join("")).toContain("ok");
    // Retry-After: 1 honoured (not the default jittered backoff floor of 0.5s,
    // not instant) and capped well under the 60s ceiling.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it("surfaces a cut stream as a 502 ProviderError", () => {
    const error = streamEndedEarlyError("vllm");
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.statusCode).toBe(502);
  });
});
