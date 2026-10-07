/**
 * A stream that ends without a finish_reason or [DONE] is a cut-off reply.
 *
 * The boundary probe's cut_stream contract (trading-service
 * app/audit/boundary_probe.py) has the shim send one content delta and close
 * the connection. Prism fails that pass in about a second with "The vllm
 * stream ended before the response completed (no finish_reason)"; until
 * 2026-10-07 our parser returned the partial text as the model's answer.
 */
import { describe, expect, it } from "vitest";

import { parseSSEStream } from "../../utils/openai-compat.ts";
import { ProviderError } from "../../utils/errors.ts";

function reader(frames: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const bytes = new TextEncoder().encode(frames.join(""));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).getReader();
}

const delta = (content: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

async function drain(frames: string[], signal?: AbortSignal) {
  const out: unknown[] = [];
  for await (const chunk of parseSSEStream(reader(frames), { label: "vllm", signal })) out.push(chunk);
  return out;
}

describe("a cut-off stream", () => {
  it("fails as a provider error, not an answer", async () => {
    const error = await drain([delta("probe")]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe(
      "The vllm stream ended before the response completed (no finish_reason)");
    expect((error as ProviderError).statusCode).toBe(502);
  });

  it("a finish_reason completes the reply", async () => {
    const out = await drain([delta("hel"), delta("lo", "stop")]);
    expect(out.filter((c) => typeof c === "string").join("")).toBe("hello");
  });

  it("[DONE] completes the reply", async () => {
    await expect(drain([delta("hi"), "data: [DONE]\n\n"])).resolves.toBeDefined();
  });

  it("a stream the caller aborted is not reported as cut", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(drain([delta("partial")], controller.signal)).resolves.toBeDefined();
  });
});
