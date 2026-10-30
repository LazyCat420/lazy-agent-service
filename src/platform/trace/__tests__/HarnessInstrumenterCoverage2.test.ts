/**
 * Coverage2 for HarnessInstrumenter.traceModelCall: span naming/attributes,
 * usage token accounting, parent-span inheritance and error propagation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Span } from "../Span.ts";

const fakes = vi.hoisted(() => ({
  spans: [] as Array<Record<string, unknown>>,
}));

vi.mock("../TraceExporter.ts", () => ({
  TraceExporter: {
    getGlobalInstance: () => ({
      enqueueSpan: (span: Record<string, unknown>) => {
        fakes.spans.push(span);
      },
    }),
  },
}));

import { HarnessInstrumenter } from "../HarnessInstrumenter.ts";

describe("HarnessInstrumenter.traceModelCall", () => {
  beforeEach(() => {
    fakes.spans.length = 0;
  });

  it("records usage tokens on a successful call", async () => {
    const result = await HarnessInstrumenter.traceModelCall(
      "openai/gpt-4o",
      "hello world",
      undefined,
      async () => ({ text: "hi", usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    );

    expect(result).toEqual({ text: "hi", usage: { prompt_tokens: 7, completion_tokens: 3 } });
    expect(fakes.spans).toHaveLength(1);
    const span = fakes.spans[0];
    expect(span.name).toBe("model_call:openai/gpt-4o");
    expect(span.kind).toBe("model_call");
    expect(span.status).toBe("OK");
    expect(span.run_id).toBe("unassigned_run");
    expect(span.parent_span_id).toBeNull();
    expect(span.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(span.attributes).toMatchObject({
      model: "openai/gpt-4o",
      tokens_input: 7,
      tokens_output: 3,
      total_tokens: 10,
    });
  });

  it("omits token attributes when the call reports no usage", async () => {
    await HarnessInstrumenter.traceModelCall("local/qwen", "prompt", undefined, async () => ({
      text: "done",
    }));

    const span = fakes.spans[0];
    expect(span.status).toBe("OK");
    expect(span.attributes).not.toHaveProperty("tokens_input");
    expect(span.attributes).toMatchObject({ model: "local/qwen" });
  });

  it("inherits the parent span identifiers", async () => {
    const parentSpan = new Span({
      trace_id: "trace-abc",
      span_id: "span-parent",
      run_id: "run-1",
      name: "parent",
      kind: "agent_run",
    });

    await HarnessInstrumenter.traceModelCall(
      "openai/gpt-4o",
      "prompt",
      parentSpan,
      async () => ({ text: "ok" }),
    );

    expect(fakes.spans[0]).toMatchObject({
      trace_id: "trace-abc",
      parent_span_id: "span-parent",
      run_id: "run-1",
    });
  });

  it("ends the span as ERROR and rethrows when the call fails", async () => {
    await expect(
      HarnessInstrumenter.traceModelCall("openai/gpt-4o", "prompt", undefined, async () => {
        throw new Error("provider exploded");
      }),
    ).rejects.toThrow("provider exploded");

    expect(fakes.spans).toHaveLength(1);
    expect(fakes.spans[0]).toMatchObject({
      status: "ERROR",
      status_message: "provider exploded",
      name: "model_call:openai/gpt-4o",
    });
  });
});
