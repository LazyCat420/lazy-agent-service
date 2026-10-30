/**
 * Orchestrator helpers — SubAgentResultBuilder, SubAgentTelemetryEmitter and
 * InstanceLoadBalancer.
 *
 * All three are exercised as real modules: results are built from fixture
 * SubAgentState objects, the emitter is driven by synthetic SSE events and the
 * load balancer by fixture instance lists. Only the conversation generation
 * tracker (a process-global counter) is faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getConversationStats: vi.fn(),
}));

vi.mock("../ConversationGenerationTracker.ts", () => ({
  default: { getConversationStats: fakes.getConversationStats },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import {
  getLastAssistantText,
  estimateTokens,
  buildSubAgentResult,
  buildToolCallFallbackSummary,
  extractSubtreeMetrics,
} from "../orchestrator/SubAgentResultBuilder.ts";
import { SubAgentTelemetryEmitter } from "../orchestrator/SubAgentTelemetryEmitter.ts";
import { InstanceLoadBalancer } from "../orchestrator/InstanceLoadBalancer.ts";

type Any = Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  fakes.getConversationStats.mockReturnValue({
    totalOutputTokens: 0,
    totalInputTokens: 0,
    totalTokens: 0,
    tokPerSec: 0,
    activeRequests: 0,
    avgTtft: 0,
  });
});

describe("getLastAssistantText", () => {
  it("returns the last assistant text, skipping tool-only turns", () => {
    expect(getLastAssistantText([])).toBe("");
    expect(
      getLastAssistantText([
        { role: "assistant", content: "first answer" },
        { role: "user", content: "again" },
        { role: "assistant", content: "" },
      ] as never),
    ).toBe("first answer");
  });

  it("joins structured text blocks", () => {
    expect(
      getLastAssistantText([
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "block one" },
            { type: "text", text: "block two" },
          ],
        },
      ] as never),
    ).toBe("block one\nblock two");
  });

  it("falls back to text fragments", () => {
    expect(
      getLastAssistantText([{ role: "assistant", content: "", textFragments: ["a", "b"] }] as never),
    ).toBe("a\nb");
  });
});

describe("estimateTokens", () => {
  it("rounds up characters divided by four", () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(5)).toBe(2);
    expect(estimateTokens(400)).toBe(100);
  });
});

describe("buildSubAgentResult", () => {
  const state = (overrides: Any = {}) => ({
    agentId: "agent-1",
    description: "worker",
    status: "complete",
    output: "",
    messages: [],
    toolCalls: [],
    iterations: 0,
    durationMs: 0,
    ...overrides,
  });

  it("maps a completed agent with output and tool usage", () => {
    const result = buildSubAgentResult(
      state({
        output: "final answer",
        messages: [
          { role: "system", content: "sys" },
          { role: "assistant", content: "final answer" },
        ],
        toolCalls: [{ name: "read_file" }, { name: "read_file" }, { name: "write_file" }],
        iterations: 2,
        durationMs: 1500,
        diff: { hasChanges: true, additions: 4, deletions: 1, files: ["a.ts"] },
        recursionDepth: 2,
      }) as never,
    );

    expect(result).toMatchObject({
      agent_id: "agent-1",
      status: "completed",
      result: "final answer",
      toolUses: 3,
      toolNames: { read_file: 2, write_file: 1 },
      iterations: 2,
      durationMs: 1500,
      diff: { additions: 4, deletions: 1, files: ["a.ts"] },
      recursionDepth: 2,
    });
    expect(result.messages).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });

  it("reports a failed agent with its error", () => {
    const result = buildSubAgentResult(state({ status: "failed", error: "boom" }) as never);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe('Agent "worker" failed: boom');
    expect(result.error).toBe("boom");
  });

  it("reports a stopped agent", () => {
    const result = buildSubAgentResult(state({ status: "stopped" }) as never);
    expect(result.summary).toBe('Agent "worker" was stopped');
  });

  it("adds an empty-result diagnostic for a silent completion with no tool use", () => {
    const result = buildSubAgentResult(state({ durationMs: 2000, iterations: 1 }) as never);
    expect(result.summary).toContain("0 tool calls");
    expect(result.error).toContain("Probable causes");
  });

  it("adds a tool-use diagnostic for a silent completion that used tools", () => {
    const result = buildSubAgentResult(
      state({ toolCalls: [{ name: "read_file" }], iterations: 3, durationMs: 1000 }) as never,
    );
    expect(result.summary).toContain("1 tool call(s)");
    expect(result.error).toContain("ended on a tool_use turn");
  });

  it("adds an iteration diagnostic when tools were unused across iterations", () => {
    const result = buildSubAgentResult(state({ iterations: 4, durationMs: 1000 }) as never);
    expect(result.error).toBe("Sub-agent ran 4 iteration(s) (1.0s) but produced no text output.");
  });

  it("falls back to the last assistant message when output is empty", () => {
    const result = buildSubAgentResult(
      state({ messages: [{ role: "assistant", content: "from messages" }] }) as never,
    );
    expect(result.result).toBe("from messages");
  });

  it("attaches subtree metrics from create_subagent tool results", () => {
    const result = buildSubAgentResult(
      state({
        output: "done",
        messages: [
          {
            role: "assistant",
            content: "done",
            toolCalls: [
              {
                name: "create_subagent",
                result: [
                  { agent_id: "child-1", status: "completed", durationMs: 100, toolUses: 2, result: "child output" },
                ],
              },
            ],
          },
        ],
      }) as never,
    );
    expect(result.subtreeMetrics).toEqual(
      expect.objectContaining({ totalDescendants: 1, aggregatedToolUses: 2, aggregatedDurationMs: 100 }),
    );
  });
});

describe("buildToolCallFallbackSummary", () => {
  it("returns null when nothing was executed", () => {
    expect(buildToolCallFallbackSummary({ toolUses: 0, iterations: 0 } as never)).toBeNull();
  });

  it("lists the tool breakdown", () => {
    const summary = buildToolCallFallbackSummary({
      toolUses: 3,
      iterations: 2,
      toolNames: { read_file: 2, write_file: 1 },
    } as never);
    expect(summary).toBe(
      "Agent completed 2 iterations using read_file (2×), write_file (1×) but did not produce a final summary.",
    );
  });

  it("uses the singular iteration label without a breakdown", () => {
    expect(buildToolCallFallbackSummary({ toolUses: 1, iterations: 1 } as never)).toBe(
      "Agent completed 1 iteration with 1 tool call(s) but did not produce a final summary.",
    );
  });
});

describe("extractSubtreeMetrics", () => {
  it("returns null when no child results are present", () => {
    expect(extractSubtreeMetrics([])).toBeNull();
    expect(extractSubtreeMetrics([{ role: "assistant", content: "hi" }] as never)).toBeNull();
    expect(
      extractSubtreeMetrics([{ role: "tool", content: '{"not":"a result"}' }] as never),
    ).toBeNull();
  });

  it("reads Anthropic-style tool messages and aggregates nested metrics", () => {
    const payload = JSON.stringify([
      {
        agent_id: "child-1",
        status: "completed",
        description: "one",
        durationMs: 50,
        toolUses: 2,
        result: "x".repeat(2500),
        subtreeMetrics: { totalDescendants: 2, maxDepthReached: 3, aggregatedCost: 0.5, aggregatedDurationMs: 70, aggregatedToolUses: 4, childResults: [] },
      },
      { agent_id: "child-2", status: "failed", error: "bad", durationMs: 10 },
    ]);
    const metrics = extractSubtreeMetrics([{ role: "tool", content: payload }] as never);

    expect(metrics).toMatchObject({
      totalDescendants: 4,
      maxDepthReached: 3,
      aggregatedCost: 0.5,
      aggregatedDurationMs: 130,
      aggregatedToolUses: 6,
    });
    expect(metrics!.childResults).toHaveLength(2);
    expect(metrics!.childResults[0].result!.endsWith("…")).toBe(true);
    expect(metrics!.childResults[1].result).toBeNull();
    expect(metrics!.childResults[1].error).toBe("bad");
  });

  it("ignores malformed JSON tool messages", () => {
    expect(extractSubtreeMetrics([{ role: "tool_result", content: "agent_id {broken" }] as never)).toBeNull();
  });

  it("reads ReAct-style inline tool calls and ignores unrelated tools", () => {
    const metrics = extractSubtreeMetrics([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "read_file", result: { agent_id: "ignored", status: "completed" } },
          { name: "create_subagents", result: { agent_id: "child-9", status: "completed", toolUses: 1 } },
        ],
      },
    ] as never);
    expect(metrics).toMatchObject({ totalDescendants: 1, aggregatedToolUses: 1 });
    expect(metrics!.childResults[0].agent_id).toBe("child-9");
  });
});

describe("SubAgentTelemetryEmitter", () => {
  const makeEmitter = (parentEmit = vi.fn()) =>
    new SubAgentTelemetryEmitter({
      subAgentId: "sub-1",
      subAgentDescription: "worker",
      parentEmit,
      parentConversationId: "conv-1",
    });

  it("emits phase and progress for text chunks and accumulates output", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    const emit = emitter.createEmitFunction();

    emit({ type: "chunk", content: "hello world" } as never);

    expect(emitter.output).toBe("hello world");
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sub_agent_status", message: "phase", phase: "generating" }),
    );
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "generation_progress", outputTokens: 3, totalOutputTokens: 3 }),
    );
  });

  it("flushes the burst when switching from thinking to generating", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    const emit = emitter.createEmitFunction();

    emit({ type: "thinking", content: "thinking hard" } as never);
    emit({ type: "chunk", content: "answer" } as never);

    expect(emitter.output).toBe("answer");
    const progressCalls = parentEmit.mock.calls.filter(
      (call) => call[0].message === "generation_progress",
    );
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("emits aggregate progress when the tracker has data", () => {
    fakes.getConversationStats.mockReturnValue({
      totalOutputTokens: 40,
      totalInputTokens: 10,
      totalTokens: 50,
      tokPerSec: 12,
      activeRequests: 1,
      avgTtft: 0.4,
    });
    const parentEmit = vi.fn();
    const emit = makeEmitter(parentEmit).createEmitFunction();
    emit({ type: "chunk", content: "x" } as never);

    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "status",
        outputTokens: 40,
        inputTokens: 10,
        totalTokens: 50,
        activeRequests: 1,
      }),
    );
  });

  it("records tool calls and forwards tool execution events", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    const emit = emitter.createEmitFunction();

    emit({
      type: "tool_execution",
      status: "calling",
      tool: { id: "t1", name: "read_file", args: { path: "a" } },
    } as never);

    expect(emitter.toolCalls).toEqual([{ id: "t1", name: "read_file", args: { path: "a" } }]);
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sub_agent_tool_execution", tool: expect.objectContaining({ name: "read_file" }) }),
    );
  });

  it("ignores tool executions without a valid tool payload", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    emitter.createEmitFunction()({ type: "tool_execution", status: "calling", tool: "bad" } as never);
    expect(emitter.toolCalls).toHaveLength(0);
  });

  it("forwards tool output events", () => {
    const parentEmit = vi.fn();
    makeEmitter(parentEmit).createEmitFunction()({
      type: "tool_output",
      toolCallId: "t1",
      name: "read_file",
      event: "data",
      data: { ok: true },
    } as never);
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sub_agent_tool_output", toolCallId: "t1", data: { ok: true } }),
    );
  });

  it("tracks iterations and phase from status events", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    const emit = emitter.createEmitFunction();

    emit({ type: "status", message: "iteration_progress", iteration: 3, maxIterations: 10 } as never);
    emit({ type: "status", message: "generation_started", timeToFirstToken: 0.5 } as never);
    emit({ type: "status", message: "compacting", phase: "compaction", progress: 40 } as never);

    expect(emitter.iterations).toBe(3);
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "iteration_progress", iteration: 3 }),
    );
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "generation_started", timeToFirstToken: 0.5 }),
    );
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "phase", phase: "compaction", label: "compacting", progress: 40 }),
    );
  });

  it("captures cost and usage from the done event", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    emitter.createEmitFunction()({
      type: "done",
      estimatedCost: 0.02,
      usage: { inputTokens: 10, outputTokens: 20 },
      tokensPerSec: 30,
    } as never);

    expect(emitter.totalCost).toBe(0.02);
    expect(emitter.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(parentEmit).toHaveBeenCalledWith(
      expect.objectContaining({ message: "generation_progress", outputTokens: 20, tokPerSec: 30 }),
    );
  });

  it("forwards already-namespaced events and drops unknown ones", () => {
    const parentEmit = vi.fn();
    const emit = makeEmitter(parentEmit).createEmitFunction();
    emit({ type: "usage_update", usage: { totalTokens: 5 } } as never);
    emit({ type: "mystery_event" } as never);
    expect(parentEmit).toHaveBeenCalledTimes(1);
    expect(parentEmit).toHaveBeenCalledWith({ type: "usage_update", usage: { totalTokens: 5 } });
  });

  it("works without a parent emit function", () => {
    const emitter = new SubAgentTelemetryEmitter({
      subAgentId: "sub-2",
      subAgentDescription: "worker",
      parentEmit: null,
      parentConversationId: null,
    });
    const emit = emitter.createEmitFunction();
    expect(() => emit({ type: "chunk", content: "abc" } as never)).not.toThrow();
    expect(emitter.output).toBe("abc");
  });

  it("emits a completion event with tool count", () => {
    const parentEmit = vi.fn();
    const emitter = makeEmitter(parentEmit);
    emitter.createEmitFunction()({ type: "tool_execution", status: "calling", tool: { id: "t1", name: "read_file" } } as never);

    emitter.emitCompletion(1200, { inputTokens: 3 }, 0.01);

    expect(parentEmit).toHaveBeenLastCalledWith({
      type: "sub_agent_status",
      subAgentId: "sub-1",
      message: "complete",
      durationMs: 1200,
      toolCount: 1,
      usage: { inputTokens: 3 },
      estimatedCost: 0.01,
    });
  });
});

describe("InstanceLoadBalancer", () => {
  const instance = (id: string, concurrency: number) => ({ id, concurrency }) as never;

  beforeEach(() => {
    for (const id of InstanceLoadBalancer.getReservations().keys()) {
      InstanceLoadBalancer.getReservations().set(id, 0);
    }
  });

  it("counts reservations and running sub-agents per instance", () => {
    const activeSubAgents = new Map<string, Any>([
      ["a", { providerName: "lm-studio", status: "running" }],
      ["b", { providerName: "lm-studio", status: "completed" }],
      ["c", { providerName: "other", status: "running" }],
    ]);
    expect(InstanceLoadBalancer.getActiveOn("lm-studio", activeSubAgents as never)).toBe(1);
    expect(InstanceLoadBalancer.getActiveOn("other", activeSubAgents as never)).toBe(1);
  });

  it("picks the least-loaded instance and reserves a slot", () => {
    const activeSubAgents = new Map<string, Any>([
      ["a", { providerName: "busy", status: "running" }],
    ]);
    const assignment = InstanceLoadBalancer.selectAndReserveInstance(
      [instance("busy", 2), instance("free", 4)],
      "busy",
      new Map(),
      "model-x",
      activeSubAgents as never,
    );

    expect(assignment).toEqual({ provider: "free", model: "model-x", slotsAvailable: 4 });
    expect(InstanceLoadBalancer.getReservations().get("free")).toBe(1);
  });

  it("prefers the orchestrator instance on equal load", () => {
    const assignment = InstanceLoadBalancer.selectAndReserveInstance(
      [instance("other", 4), instance("orch", 4)],
      "orch",
      new Map(),
      "model-x",
      new Map() as never,
    );
    expect(assignment!.provider).toBe("orch");
  });

  it("prefers the higher concurrency on equal load without an orchestrator match", () => {
    const assignment = InstanceLoadBalancer.selectAndReserveInstance(
      [instance("small", 2), instance("big", 8)],
      "absent",
      new Map(),
      "model-x",
      new Map() as never,
    );
    expect(assignment!.provider).toBe("big");
  });

  it("applies the quant model override", () => {
    const assignment = InstanceLoadBalancer.selectAndReserveInstance(
      [instance("lm-studio", 2)],
      "lm-studio",
      new Map([["lm-studio", "quant-model"]]),
      "default-model",
      new Map() as never,
    );
    expect(assignment!.model).toBe("quant-model");
  });

  it("overflows to the least-loaded instance when all are at capacity", () => {
    const activeSubAgents = new Map<string, Any>([
      ["a", { providerName: "one", status: "running" }],
      ["b", { providerName: "one", status: "running" }],
      ["c", { providerName: "two", status: "running" }],
    ]);
    const assignment = InstanceLoadBalancer.selectAndReserveInstance(
      [instance("one", 2), instance("two", 2)],
      "absent",
      new Map(),
      "model-x",
      activeSubAgents as never,
    );
    expect(assignment).toEqual({ provider: "two", model: "model-x", slotsAvailable: 1 });
  });

  it("returns null when there are no instances", () => {
    expect(
      InstanceLoadBalancer.selectAndReserveInstance([], "orch", new Map(), "model-x", new Map() as never),
    ).toBeNull();
  });

  it("releases a reservation without going negative", () => {
    InstanceLoadBalancer.selectAndReserveInstance([instance("only", 2)], "only", new Map(), "m", new Map() as never);
    expect(InstanceLoadBalancer.getReservations().get("only")).toBe(1);
    InstanceLoadBalancer.releaseReservation("only");
    expect(InstanceLoadBalancer.getReservations().get("only")).toBe(0);
    InstanceLoadBalancer.releaseReservation("only");
    expect(InstanceLoadBalancer.getReservations().get("only")).toBe(0);
  });
});
