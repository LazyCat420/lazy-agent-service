/**
 * Tool failures return to the model (2026-10-17): a failed global capability
 * (e.g. read_page HTTP error) must reach the model as an observation, not
 * throw out of the agentic loop and kill the whole run. The run still
 * completes and a tool.failed event is emitted for clients.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return null;
    }
    static getCollection() {
      return null;
    }
  }
  return { default: MongoWrapper };
});

vi.mock("../DynamicModelResolver.ts", () => ({
  DynamicModelResolver: {
    queryLiveHosts: async () => [],
    resolveProviderAndModel: () => ({}),
  },
}));

type LoopContext = {
  runtimeToolExecutor?: (call: { name: string; args?: Record<string, unknown> }) => Promise<unknown>;
};
let executorObservation: { value?: unknown; error?: unknown } = {};
const runAgenticLoop = vi.fn(async (context: LoopContext) => {
  try {
    executorObservation.value = await context.runtimeToolExecutor?.({
      name: "global.web.read_page",
      args: { url: "https://example.com" },
    });
  } catch (err) {
    executorObservation.error = err;
  }
  return { messages: [{ role: "assistant", content: "done" }] };
});
vi.mock("../AgenticLoopService.ts", () => ({
  default: { runAgenticLoop: (...args: Parameters<typeof runAgenticLoop>) => runAgenticLoop(...args) },
}));

import { RunExecutionEngine } from "../RunExecutionEngine.ts";
import { GlobalCapabilityExecutor } from "../GlobalCapabilityExecutor.ts";
import type { RunEvent } from "../../types/run.ts";

describe("tool failures return to the model", () => {
  beforeEach(() => {
    executorObservation = {};
    vi.spyOn(GlobalCapabilityExecutor, "execute").mockResolvedValue({
      success: false,
      error: { code: "HTTP_ERROR", message: "HTTP 404" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the executor observation instead of throwing, emits tool.failed, and completes the run", async () => {
    const events: RunEvent[] = [];
    const result = await RunExecutionEngine.startRun(
      "run-tool-failure-as-result",
      {
        profile_id: "trading-strategy-chat-v1",
        app_id: "trading",
        session_id: "sess-tool-failure",
        input: [{ role: "user" as const, content: "read example.com" }],
        identity: { project: "trading", username: "strategy-chat" },
        budget: { max_tool_calls: 2, max_tokens: 1024, max_duration_ms: 30000 },
        runtime_overrides: {},
      } as never,
      (event: RunEvent) => events.push(event),
    );

    expect(executorObservation.error).toBeUndefined();
    expect(executorObservation.value).toMatchObject({ error: "HTTP_ERROR", message: "HTTP 404" });
    expect(events.some((e) => e.type === "tool.failed")).toBe(true);
    expect(result.status).toBe("completed");
  });
});
