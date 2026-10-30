/**
 * VisionLanguageHarness.run and ReActHarness.run — coverage of the loop bodies:
 * delegation to the branching strategies, first-iteration hooks, tool turns,
 * thinking-only re-prompts, truncation recovery, exhaustion recovery and the
 * error path. Every lifecycle collaborator (pressure, hooks, tools, planning,
 * reminders, budget, strategies, live frames) is a fake; the harness classes,
 * AgenticLoopState and the loop control flow are real, and assertions read the
 * emitted events, injected messages and mutated loop state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

const fakes = vi.hoisted(() => ({
  createStandardHooks: vi.fn(),
  manageContextPressure: vi.fn(),
  logKVCacheHitRate: vi.fn(),
  handleCodexPlanningResponse: vi.fn(),
  isOutputTruncated: vi.fn(),
  isAtOutputCeiling: vi.fn(),
  runExhaustionRecoveryPass: vi.fn(),
  maybeInjectSystemReminder: vi.fn(),
  cleanupReminderCache: vi.fn(),
  checkCostBudget: vi.fn(),
  buildToolRetryGuidance: vi.fn(),
  executeToolBatch: vi.fn(),
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn(),
  trackToolErrors: vi.fn(),
  validateAfterToolExecution: vi.fn(),
  runPlanningPhase: vi.fn(),
  checkForPlanModeEntry: vi.fn(),
  injectToolDiscoveryNudge: vi.fn(),
  finalizePassTracker: vi.fn(),
  getFrames: vi.fn(),
  injectPlanningInstruction: vi.fn(),
  localeGet: vi.fn(),
  getDefaultLocale: vi.fn(),
  getAvailableLocales: vi.fn(() => ["en"]),
  extractSteps: vi.fn(() => ["step 1"]),
  stripPlanningInstruction: vi.fn(),
  runTreeOfThoughts: vi.fn(),
  runGraphOfThoughts: vi.fn(),
}));

vi.mock("../harnesses/lifecycle/HookInitializer.ts", () => ({ createStandardHooks: fakes.createStandardHooks }));
vi.mock("../harnesses/lifecycle/ContextPressureManager.ts", () => ({ manageContextPressure: fakes.manageContextPressure }));
vi.mock("../harnesses/lifecycle/KVCacheReporter.ts", () => ({ logKVCacheHitRate: fakes.logKVCacheHitRate }));
vi.mock("../harnesses/lifecycle/CodexPlanningDetector.ts", () => ({ handleCodexPlanningResponse: fakes.handleCodexPlanningResponse }));
vi.mock("../harnesses/lifecycle/OutputTruncationRecovery.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isOutputTruncated: fakes.isOutputTruncated,
  isAtOutputCeiling: fakes.isAtOutputCeiling,
}));
vi.mock("../harnesses/lifecycle/ExhaustionRecovery.ts", () => ({ runExhaustionRecoveryPass: fakes.runExhaustionRecoveryPass }));
vi.mock("../harnesses/lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: fakes.maybeInjectSystemReminder,
  cleanupReminderCache: fakes.cleanupReminderCache,
}));
vi.mock("../harnesses/lifecycle/CostBudgetEnforcer.ts", () => ({ checkCostBudget: fakes.checkCostBudget }));
vi.mock("../harnesses/lifecycle/ToolRetryInterceptor.ts", () => ({ buildToolRetryGuidance: fakes.buildToolRetryGuidance }));
vi.mock("../harnesses/lifecycle/ToolExecutor.ts", () => ({ executeToolBatch: fakes.executeToolBatch }));
vi.mock("../harnesses/lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: fakes.emitPostExecutionStatus,
  processToolResultMedia: fakes.processToolResultMedia,
  trackToolErrors: fakes.trackToolErrors,
}));
vi.mock("../harnesses/lifecycle/ValidationInterceptor.ts", () => ({ validateAfterToolExecution: fakes.validateAfterToolExecution }));
vi.mock("../harnesses/lifecycle/PlanModeController.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkForPlanModeEntry: fakes.checkForPlanModeEntry,
  runPlanningPhase: fakes.runPlanningPhase,
}));
vi.mock("../harnesses/lifecycle/ToolDiscoveryNudge.ts", () => ({ injectToolDiscoveryNudge: fakes.injectToolDiscoveryNudge }));
vi.mock("../harnesses/lifecycle/TrackerFinalizer.ts", () => ({ finalizePassTracker: fakes.finalizePassTracker }));
vi.mock("../harnesses/strategies/TreeOfThoughtsStrategy.ts", () => ({ runTreeOfThoughts: fakes.runTreeOfThoughts }));
vi.mock("../harnesses/strategies/GraphOfThoughtsStrategy.ts", () => ({ runGraphOfThoughts: fakes.runGraphOfThoughts }));
vi.mock("../../LiveFrameService.ts", () => ({ default: { getFrames: fakes.getFrames } }));
vi.mock("../PromptLocaleService.ts", () => ({
  default: {
    get: fakes.localeGet,
    getDefaultLocale: fakes.getDefaultLocale,
    getAvailableLocales: fakes.getAvailableLocales,
  },
}));
vi.mock("../PlanningModeService.ts", () => ({
  default: {
    injectPlanningInstruction: fakes.injectPlanningInstruction,
    extractSteps: fakes.extractSteps,
    stripPlanningInstruction: fakes.stripPlanningInstruction,
  },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import VisionLanguageHarness from "../harnesses/VisionLanguageHarness.ts";
import ReActHarness from "../harnesses/ReActHarness.ts";
import AgenticLoopState from "../AgenticLoopState.ts";

type Any = Record<string, unknown>;

const streamOf = (chunks: unknown[]) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

const makePass = (overrides: Any = {}) => ({
  streamedText: "",
  finalStreamedText: "",
  streamedThinking: "",
  thinkingSignature: "",
  pendingToolCalls: [],
  streamedImages: [],
  usage: {},
  options: {},
  requestId: null,
  ...overrides,
});

const makeContext = (overrides: Any = {}) => ({
  options: {},
  messages: [{ role: "user", content: "hi" }],
  project: "proj",
  username: "alice",
  agent: "CODING",
  workspaceRoot: "/ws",
  emit: vi.fn(),
  conversationId: "conv-1",
  agentConversationId: "ac-1",
  requestId: "req-1",
  providerName: "lm-studio",
  resolvedModel: "model-x",
  modelDefinition: { maxInputTokens: 100_000, maxOutputTokens: 8192 },
  hooks: { run: vi.fn() },
  provider: { generateTextStream: vi.fn(() => streamOf([])) },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  fakes.createStandardHooks.mockReturnValue({ hooks: { run: vi.fn() } });
  fakes.manageContextPressure.mockImplementation(async (messages: unknown[]) => ({ messages }));
  fakes.handleCodexPlanningResponse.mockReturnValue({ shouldContinueLoop: false });
  fakes.isOutputTruncated.mockReturnValue(false);
  fakes.isAtOutputCeiling.mockReturnValue(false);
  fakes.runExhaustionRecoveryPass.mockResolvedValue(undefined);
  fakes.maybeInjectSystemReminder.mockResolvedValue(undefined);
  fakes.checkCostBudget.mockResolvedValue(false);
  fakes.buildToolRetryGuidance.mockReturnValue(null);
  fakes.executeToolBatch.mockResolvedValue([]);
  fakes.validateAfterToolExecution.mockResolvedValue([]);
  fakes.runPlanningPhase.mockResolvedValue({ planApproved: true });
  fakes.checkForPlanModeEntry.mockResolvedValue(undefined);
  fakes.injectPlanningInstruction.mockResolvedValue(undefined);
  fakes.getFrames.mockReturnValue([]);
  fakes.localeGet.mockImplementation((_locale: string, key: string) => `locale:${key}`);
  fakes.getDefaultLocale.mockReturnValue("en");
  fakes.extractSteps.mockReturnValue(["step 1"]);
});

describe("VisionLanguageHarness.run", () => {
  const makeVisionHarness = (passes: Any[], overrides: Any = {}) => {
    const context = makeContext(overrides);
    const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: false } as never) as Any;
    state.loadedTools = new Set<string>();
    const tools = { finalTools: [{ name: "read_file" }], resolvedEnabledTools: ["read_file"] };
    const harness = new VisionLanguageHarness(context as never, state as never, tools as never) as Any;

    let index = 0;
    harness.createPassState = vi.fn(() => passes[index++] ?? makePass());
    harness.registerTrackerRequest = vi.fn();
    harness.createProviderStream = vi.fn(async () => streamOf([]));
    harness.consumeStream = vi.fn(async () => {});
    harness.logIteration = vi.fn();
    harness.enforceContextWindow = vi.fn((messages: unknown[]) => messages);
    harness.emitGenerationProgress = vi.fn();
    harness.emitUsageUpdate = vi.fn();
    harness.finalize = vi.fn(async () => {});
    harness.checkAndApplyToolSetChanges = vi.fn();
    return { harness, context, state };
  };

  it("injects the vision instruction, runs a text-only iteration and finalizes", async () => {
    const { harness, context } = makeVisionHarness([makePass({ streamedText: "I see a cat" })], {
      options: { maxIterations: 2, planFirst: true },
    });

    const result = await harness.run();

    expect(context.emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
    expect(result.messages[0]).toEqual({ role: "system", content: "locale:harness.visionFeed.instruction" });
    expect(fakes.handleCodexPlanningResponse).toHaveBeenCalled();
    expect(harness.finalize).toHaveBeenCalledWith(result.messages, expect.any(Object));
    expect(fakes.logKVCacheHitRate).toHaveBeenCalledWith({}, 1, "VisionLanguageHarness");
  });

  it("appends the vision instruction to an existing system message", async () => {
    const { harness, context } = makeVisionHarness([makePass({ streamedText: "done" })], {
      options: { maxIterations: 1 },
      messages: [{ role: "system", content: "existing" }],
    });
    await harness.run();
    expect(context.messages[0].content).toBe("existinglocale:harness.visionFeed.instruction");
  });

  it("re-prompts on a thinking-only pass then breaks on empty output", async () => {
    const { harness, state } = makeVisionHarness(
      [makePass({ streamedThinking: "hmm" }), makePass()],
      { options: { maxIterations: 3 } },
    );
    const result = await harness.run();
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: expect.stringContaining("Do not repeat your reasoning") }),
    );
    expect(state.iterations).toBe(2);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("recovers from truncation by escalating maxTokens", async () => {
    fakes.isOutputTruncated.mockReturnValue(true);
    const { harness, context } = makeVisionHarness([makePass()], { options: { maxIterations: 1, maxTokens: 2048 } });
    await harness.run();
    expect(context.options.maxTokens).toBe(3072);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("executes a tool turn and returns early when the plan is rejected", async () => {
    const { harness, context } = makeVisionHarness(
      [makePass({ pendingToolCalls: [{ id: "t1", name: "exit_plan_mode" }] })],
      { options: { maxIterations: 2, unattended: true } },
    );
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", name: "exit_plan_mode", result: {} }]);
    const result = await harness.run();
    expect(fakes.executeToolBatch).toHaveBeenCalled();
    expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: SERVER_SENT_EVENT_TYPES.DONE }),
    );
    expect(result.messages.length).toBeGreaterThan(0);
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("persists the error path and rethrows", async () => {
    const { harness, state } = makeVisionHarness([], { options: { maxIterations: 1 } });
    harness.createProviderStream.mockRejectedValue(new Error("vision provider down"));
    harness.finalize.mockRejectedValue(new Error("persist failed"));
    await expect(harness.run()).rejects.toThrow("vision provider down");
    expect(state.conversationOutcome).toBe("error");
  });
});

describe("ReActHarness.run", () => {
  const makeReActHarness = (passes: Any[], overrides: Any = {}) => {
    const context = makeContext(overrides);
    const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: false } as never) as Any;
    state.loadedTools = new Set<string>();
    const tools = { finalTools: [{ name: "read_file" }], resolvedEnabledTools: ["read_file"] };
    const harness = new ReActHarness(context as never, state as never, tools as never) as Any;

    let index = 0;
    harness.createPassState = vi.fn(() => passes[index++] ?? makePass());
    harness.registerTrackerRequest = vi.fn();
    harness.createProviderStream = vi.fn(async () => streamOf([]));
    harness.consumeStream = vi.fn(async () => {});
    harness.logIteration = vi.fn();
    harness.enforceContextWindow = vi.fn((messages: unknown[]) => messages);
    harness.emitGenerationProgress = vi.fn();
    harness.emitUsageUpdate = vi.fn();
    harness.finalize = vi.fn(async () => {});
    harness.checkAndApplyToolSetChanges = vi.fn();
    return { harness, context, state };
  };

  it("delegates to Tree of Thoughts when configured", async () => {
    fakes.runTreeOfThoughts.mockResolvedValue({ messages: [{ role: "assistant", content: "tot" }] });
    const { harness } = makeReActHarness([], { options: { thoughtStructure: "tree_of_thoughts" } });
    const result = await harness.run();
    expect(fakes.runTreeOfThoughts).toHaveBeenCalledWith(harness);
    expect(result.messages).toEqual([{ role: "assistant", content: "tot" }]);
  });

  it("delegates to Graph of Thoughts when configured", async () => {
    fakes.runGraphOfThoughts.mockResolvedValue({ messages: [{ role: "assistant", content: "got" }] });
    const { harness } = makeReActHarness([], { options: { thoughtStructure: "graph_of_thoughts" } });
    const result = await harness.run();
    expect(fakes.runGraphOfThoughts).toHaveBeenCalledWith(harness);
    expect(result.messages).toEqual([{ role: "assistant", content: "got" }]);
  });

  it("escalates maxTokens and continues after a truncated pass", async () => {
    fakes.isOutputTruncated.mockReturnValueOnce(true).mockReturnValue(false);
    const { harness, context } = makeReActHarness(
      [makePass({ stopReason: "length" }), makePass({ streamedText: "final answer" })],
      { options: { maxIterations: 2, maxTokens: 2048 } },
    );
    const result = await harness.run();
    expect(context.options.maxTokens).toBe(3072);
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "system", content: "locale:harness.outputTruncation.continuationPrompt" }),
    );
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("gives up when maxTokens is at the model ceiling", async () => {
    fakes.isOutputTruncated.mockReturnValue(true);
    fakes.isAtOutputCeiling.mockReturnValue(true);
    const { harness, context } = makeReActHarness([makePass({ stopReason: "length" })], {
      options: { maxIterations: 2, maxTokens: 8192 },
    });
    const result = await harness.run();
    expect(context.options.maxTokens).toBe(8192);
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "locale:harness.errorAsContext.wrapper", _isErrorIndicator: true }),
    );
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("breaks after the truncation recovery budget is spent", async () => {
    fakes.isOutputTruncated.mockReturnValue(true);
    const { harness, context } = makeReActHarness([], { options: { maxIterations: 6, maxTokens: 2048 } });
    const result = await harness.run();
    expect(context.options.maxTokens).toBe(8192);
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "locale:harness.errorAsContext.wrapper", _isErrorIndicator: true }),
    );
    expect(harness.finalize).toHaveBeenCalled();
  });
});

describe("ReActHarness tool turns", () => {
  const makeReActHarness = (passes: Any[], overrides: Any = {}) => {
    const context = makeContext(overrides);
    const state = new AgenticLoopState({ originalMessageCount: 1, planModeActive: false } as never) as Any;
    state.loadedTools = new Set<string>();
    const tools = { finalTools: [{ name: "read_file" }], resolvedEnabledTools: ["read_file"] };
    const harness = new ReActHarness(context as never, state as never, tools as never) as Any;

    let index = 0;
    harness.createPassState = vi.fn(() => passes[index++] ?? makePass());
    harness.registerTrackerRequest = vi.fn();
    harness.createProviderStream = vi.fn(async () => streamOf([]));
    harness.consumeStream = vi.fn(async () => {});
    harness.logIteration = vi.fn();
    harness.enforceContextWindow = vi.fn((messages: unknown[]) => messages);
    harness.emitGenerationProgress = vi.fn();
    harness.emitUsageUpdate = vi.fn();
    harness.finalize = vi.fn(async () => {});
    harness.checkAndApplyToolSetChanges = vi.fn();
    return { harness, context, state };
  };

  it("appends the assistant tool message and its result, then finishes on the next pass", async () => {
    fakes.executeToolBatch.mockResolvedValue([
      { id: "t1", name: "read_file", result: "file body" },
    ]);
    const { harness, context } = makeReActHarness(
      [
        makePass({ pendingToolCalls: [{ id: "t1", name: "read_file", args: { path: "/a" } }] }),
        makePass({ streamedText: "final answer" }),
      ],
      { options: { maxIterations: 2 } },
    );

    const result = await harness.run();

    expect(fakes.checkForPlanModeEntry).toHaveBeenCalled();
    expect(fakes.injectToolDiscoveryNudge).toHaveBeenCalledWith(
      [{ id: "t1", name: "read_file", args: { path: "/a" } }],
      [{ id: "t1", name: "read_file", result: "file body" }],
      expect.any(Array),
      context,
    );
    expect(fakes.validateAfterToolExecution).toHaveBeenCalled();
    expect(
      result.messages.some(
        (message: Any) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          (message.toolCalls as Any[])[0]?.result === "file body",
      ),
    ).toBe(true);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("returns the messages unchanged when the tool result validation fails", async () => {
    fakes.executeToolBatch.mockResolvedValue([
      { id: "t1", name: "read_file", result: "file body" },
    ]);
    fakes.validateAfterToolExecution.mockResolvedValue([{ toolName: "read_file", message: "bad args" }]);
    const { harness } = makeReActHarness(
      [
        makePass({ pendingToolCalls: [{ id: "t1", name: "read_file", args: { path: "/a" } }] }),
        makePass({ streamedText: "final answer" }),
      ],
      { options: { maxIterations: 2 } },
    );

    const result = await harness.run();

    expect(fakes.validateAfterToolExecution).toHaveBeenCalled();
    expect(
      result.messages.some(
        (message: Any) =>
          message.role === "assistant" &&
          Array.isArray(message.toolCalls) &&
          (message.toolCalls as Any[])[0]?.result === "file body",
      ),
    ).toBe(true);
    expect(harness.finalize).toHaveBeenCalled();
  });
});
