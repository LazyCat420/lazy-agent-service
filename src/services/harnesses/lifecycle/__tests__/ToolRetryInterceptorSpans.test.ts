import { describe, expect, it, vi } from "vitest";
import { buildToolRetryGuidance } from "../ToolRetryInterceptor.ts";
import { TraceExporter } from "../../../../platform/trace/TraceExporter.ts";
import { TraceContext } from "../../../../platform/trace/TraceContext.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { ToolCall, ToolResult } from "../../types.ts";

/** Minimal loop state: only `toolErrorCounts` is read by the interceptor. */
function makeState(toolErrorCounts: Record<string, number>): AgenticLoopState {
  return {
    toolErrorCounts: new Map(Object.entries(toolErrorCounts)),
  } as unknown as AgenticLoopState;
}

/** Install a stopped exporter (no periodic timer) and spy on span enqueueing. */
function installExporter(): {
  enqueueSpan: ReturnType<typeof vi.spyOn>;
  stop: () => void;
} {
  const exporter = new TraceExporter({ flushIntervalMs: 60_000 });
  exporter.stop();
  TraceExporter.setGlobalInstance(exporter);
  return {
    enqueueSpan: vi.spyOn(exporter, "enqueueSpan"),
    stop: () => exporter.stop(),
  };
}

const failingCall: ToolCall = {
  id: "call-1",
  name: "web_search",
  args: { query: "nvidia earnings" },
};
const failingResult: ToolResult = {
  id: "call-1",
  name: "web_search",
  result: { error: "upstream 503" },
};

describe("buildToolRetryGuidance retry spans", () => {
  it("emits one retry span per failed call, carrying the trace context", () => {
    const { enqueueSpan, stop } = installExporter();
    try {
      const context = {
        trace_id: "trace-abc",
        run_id: "run-xyz",
        current_span_id: "span-parent",
      };

      const message = TraceContext.run(context, () =>
        buildToolRetryGuidance(
          [failingCall],
          [failingResult],
          makeState({ web_search: 2 }),
          3,
          "en",
        ),
      );

      expect(message).not.toBeNull();
      expect(enqueueSpan).toHaveBeenCalledTimes(1);
      const span = enqueueSpan.mock.calls[0][0];
      expect(span.name).toBe("workflow_retry:web_search");
      expect(span.kind).toBe("retry");
      expect(span.status).toBe("OK");
      expect(span.trace_id).toBe("trace-abc");
      expect(span.run_id).toBe("run-xyz");
      expect(span.parent_span_id).toBe("span-parent");
      expect(span.attributes).toMatchObject({
        tool_name: "web_search",
        error_message: "upstream 503",
        attempt: 2,
        failed_attempt: 2,
        failed_tool_call_id: "call-1",
        failure_span_id: "span-parent",
      });
    } finally {
      stop();
    }
  });

  it("does not emit a span once the tool has hit the circuit breaker", () => {
    const { enqueueSpan, stop } = installExporter();
    try {
      const message = buildToolRetryGuidance(
        [failingCall],
        [failingResult],
        makeState({ web_search: 3 }),
        3,
        "en",
      );

      expect(message).toBeNull();
      expect(enqueueSpan).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("skips successful results and emits nothing", () => {
    const { enqueueSpan, stop } = installExporter();
    try {
      const okResult: ToolResult = {
        id: "call-1",
        name: "web_search",
        result: { results: [] },
      };

      const message = buildToolRetryGuidance(
        [failingCall],
        [okResult],
        makeState({}),
        3,
        "en",
      );

      expect(message).toBeNull();
      expect(enqueueSpan).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
