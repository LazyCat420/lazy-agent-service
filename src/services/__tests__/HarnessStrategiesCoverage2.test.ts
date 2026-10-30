/**
 * Tree of Thoughts / Graph of Thoughts / shared branching plumbing — coverage
 * of branch generation, multi-criteria scoring, BFS/DFS exploration, the ToT
 * validation-failure fallbacks and the GoT synthesis pass. Lifecycle helpers
 * (tool execution, validation, truncation recovery, sandbox, planning, hooks,
 * budget) are fakes; the strategies, their loop control flow, scoring parsers
 * and the branch wrappers are real, and assertions read the emitted SSE events,
 * the returned messages and the mutated AgenticLoopState.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

const fakes = vi.hoisted(() => ({
  createStandardHooks: vi.fn(),
  executeToolBatch: vi.fn(),
  emitPostExecutionStatus: vi.fn(),
  processToolResultMedia: vi.fn(),
  trackToolErrors: vi.fn(),
  runExhaustionRecoveryPass: vi.fn(),
  runPlanningPhase: vi.fn(),
  checkForPlanModeEntry: vi.fn(),
  validateAfterToolExecution: vi.fn(),
  buildToolRetryGuidance: vi.fn(),
  isOutputTruncated: vi.fn(),
  isAtOutputCeiling: vi.fn(),
  injectContinuationContext: vi.fn(),
  injectErrorAsConversationMessage: vi.fn(),
  buildExhaustedRecoveryMessage: vi.fn(),
  buildProviderErrorMessage: vi.fn(),
  manageContextPressure: vi.fn(),
  logKVCacheHitRate: vi.fn(),
  injectToolDiscoveryNudge: vi.fn(),
  finalizePassTracker: vi.fn(),
  handleCodexPlanningResponse: vi.fn(),
  maybeInjectSystemReminder: vi.fn(),
  cleanupReminderCache: vi.fn(),
  checkCostBudget: vi.fn(),
  createSandboxCheckpoint: vi.fn(),
  restoreSandboxCheckpoint: vi.fn(),
  localeGet: vi.fn(),
  getDefaultLocale: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
}));

vi.mock("../harnesses/lifecycle/HookInitializer.ts", () => ({
  createStandardHooks: fakes.createStandardHooks,
}));
vi.mock("../harnesses/lifecycle/ToolExecutor.ts", () => ({
  executeToolBatch: fakes.executeToolBatch,
}));
vi.mock("../harnesses/lifecycle/PostExecutionEmitter.ts", () => ({
  emitPostExecutionStatus: fakes.emitPostExecutionStatus,
  processToolResultMedia: fakes.processToolResultMedia,
  trackToolErrors: fakes.trackToolErrors,
}));
vi.mock("../harnesses/lifecycle/ExhaustionRecovery.ts", () => ({
  runExhaustionRecoveryPass: fakes.runExhaustionRecoveryPass,
}));
vi.mock("../harnesses/lifecycle/PlanModeController.ts", () => ({
  runPlanningPhase: fakes.runPlanningPhase,
  checkForPlanModeEntry: fakes.checkForPlanModeEntry,
}));
vi.mock("../harnesses/lifecycle/ValidationInterceptor.ts", () => ({
  validateAfterToolExecution: fakes.validateAfterToolExecution,
}));
vi.mock("../harnesses/lifecycle/ToolRetryInterceptor.ts", () => ({
  buildToolRetryGuidance: fakes.buildToolRetryGuidance,
}));
vi.mock("../harnesses/lifecycle/OutputTruncationRecovery.ts", () => ({
  isOutputTruncated: fakes.isOutputTruncated,
  isAtOutputCeiling: fakes.isAtOutputCeiling,
  injectContinuationContext: fakes.injectContinuationContext,
  injectErrorAsConversationMessage: fakes.injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage: fakes.buildExhaustedRecoveryMessage,
  buildProviderErrorMessage: fakes.buildProviderErrorMessage,
  MAX_OUTPUT_TRUNCATION_RECOVERIES: 3,
}));
vi.mock("../harnesses/lifecycle/ContextPressureManager.ts", () => ({
  manageContextPressure: fakes.manageContextPressure,
}));
vi.mock("../harnesses/lifecycle/KVCacheReporter.ts", () => ({
  logKVCacheHitRate: fakes.logKVCacheHitRate,
}));
vi.mock("../harnesses/lifecycle/ToolDiscoveryNudge.ts", () => ({
  injectToolDiscoveryNudge: fakes.injectToolDiscoveryNudge,
}));
vi.mock("../harnesses/lifecycle/TrackerFinalizer.ts", () => ({
  finalizePassTracker: fakes.finalizePassTracker,
}));
vi.mock("../harnesses/lifecycle/CodexPlanningDetector.ts", () => ({
  handleCodexPlanningResponse: fakes.handleCodexPlanningResponse,
}));
vi.mock("../harnesses/lifecycle/SystemReminderInjector.ts", () => ({
  maybeInjectSystemReminder: fakes.maybeInjectSystemReminder,
  cleanupReminderCache: fakes.cleanupReminderCache,
}));
vi.mock("../harnesses/lifecycle/CostBudgetEnforcer.ts", () => ({
  checkCostBudget: fakes.checkCostBudget,
}));
vi.mock("../harnesses/lifecycle/SandboxExecutor.ts", () => ({
  createSandboxCheckpoint: fakes.createSandboxCheckpoint,
  restoreSandboxCheckpoint: fakes.restoreSandboxCheckpoint,
}));
vi.mock("../PromptLocaleService.ts", () => ({
  default: { get: fakes.localeGet, getDefaultLocale: fakes.getDefaultLocale },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import {
  applyDefaultBranchScore,
  applyProactiveBacktrack,
  applyScoreFallbacks,
  buildScoringPrompt,
  buildToolCallAssistantMessage,
  exploreBfsBranches,
  exploreDfsBranches,
  formatCandidateSummaries,
  formatValidationErrorBlock,
  generateBranch,
  parseMultiCriteriaScores,
  resolveBranchConfig,
  resolveMaxIterations,
  restoreCheckpointIfPresent,
  runBeforePromptPhase,
  scoreBranchesMultiCriteria,
  type ScoredBranch,
} from "../harnesses/strategies/shared.ts";
import { runTreeOfThoughts } from "../harnesses/strategies/TreeOfThoughtsStrategy.ts";
import { runGraphOfThoughts } from "../harnesses/strategies/GraphOfThoughtsStrategy.ts";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

type Any = Record<string, unknown>;

const makePass = (overrides: Any = {}) => ({
  streamedText: "",
  finalStreamedText: "",
  streamedThinking: "",
  thinkingSignature: "",
  pendingToolCalls: [],
  streamedImages: [],
  start: 0,
  firstTokenTime: null,
  generationEnd: null,
  outputCharacters: 0,
  usage: {},
  options: {},
  requestId: null,
  pendingRequestDocumentIdPromise: Promise.resolve(null),
  ...overrides,
});

const makeBranch = (index: number, score: number, overrides: Any = {}): ScoredBranch => ({
  branchIndex: index,
  text: `branch ${index} text`,
  thinking: "",
  thinkingSignature: "",
  score,
  criteriaScores: { correctness: score, risk: score, efficiency: score, completeness: score },
  pass: makePass({ streamedText: `branch ${index} text` }),
  ...overrides,
}) as unknown as ScoredBranch;

const streamOf = (chunks: unknown[]) =>
  (async function* () {
    for (const chunk of chunks) yield chunk;
  })();

interface HarnessOptions {
  options?: Any;
  signal?: { aborted: boolean };
  passFactory?: (index: number) => Any;
  scoreChunks?: unknown[];
  onConsume?: (pass: Any, index: number) => void;
  finalizeThrows?: boolean;
  stateOverrides?: Any;
}

function makeHarness(config: HarnessOptions = {}) {
  const emit = vi.fn();
  const context: Any = {
    options: config.options ?? {},
    messages: [{ role: "user", content: "solve the task" }],
    project: "proj",
    username: "alice",
    agent: "CODING",
    workspaceRoot: "/ws",
    emit,
    signal: config.signal,
    agentConversationId: "ac-1",
    conversationId: "conv-1",
    requestId: "req-1",
    providerName: "lm-studio",
    resolvedModel: "model-x",
    modelDefinition: { maxOutputTokens: 8192 },
    conversationMeta: {},
    parentAgentConversationId: null,
    provider: { generateTextStream: vi.fn(() => streamOf(config.scoreChunks ?? [])) },
  };
  const state: Any = {
    iterations: 0,
    branchesExplored: 0,
    branchesBacktracked: 0,
    proactiveBacktracks: 0,
    frontierCandidates: [],
    selectedBranchScores: [],
    streamedToolCalls: [],
    conversationOutcome: null,
    planModeActive: false,
    originalMessageCount: 1,
    finalStreamedText: "",
    streamedThinking: "",
    ...config.stateOverrides,
  };
  const tools: Any = {
    finalTools: [{ name: "read_file" }],
    resolvedEnabledTools: ["read_file"],
  };

  let passCount = 0;
  const passes: Any[] = [];
  const harness: Any = {
    context,
    state,
    tools,
    createPassState: vi.fn(() => {
      const pass = config.passFactory ? config.passFactory(passCount) : makePass();
      passCount += 1;
      passes.push(pass);
      return pass;
    }),
    registerTrackerRequest: vi.fn(),
    createProviderStream: vi.fn(async () => streamOf([])),
    consumeStream: vi.fn(async (_stream: unknown, pass: Any) => {
      if (config.onConsume) config.onConsume(pass, passes.indexOf(pass));
    }),
    logIteration: vi.fn(),
    enforceContextWindow: vi.fn((messages: unknown[]) => messages),
    emitGenerationProgress: vi.fn(),
    emitUsageUpdate: vi.fn(),
    checkAndApplyToolSetChanges: vi.fn(),
    finalize: config.finalizeThrows
      ? vi.fn(async () => {
          throw new Error("persist failed");
        })
      : vi.fn(async () => {}),
  };
  return { harness, emit, context, state, tools, passes };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakes.createStandardHooks.mockReturnValue({ hooks: { run: vi.fn() } });
  fakes.executeToolBatch.mockResolvedValue([]);
  fakes.processToolResultMedia.mockResolvedValue(undefined);
  fakes.runExhaustionRecoveryPass.mockResolvedValue(undefined);
  fakes.runPlanningPhase.mockResolvedValue({ planApproved: true });
  fakes.checkForPlanModeEntry.mockResolvedValue(undefined);
  fakes.validateAfterToolExecution.mockResolvedValue([]);
  fakes.buildToolRetryGuidance.mockReturnValue(null);
  fakes.isOutputTruncated.mockReturnValue(false);
  fakes.isAtOutputCeiling.mockReturnValue(false);
  fakes.injectContinuationContext.mockReturnValue(4096);
  fakes.buildExhaustedRecoveryMessage.mockReturnValue("exhausted");
  fakes.buildProviderErrorMessage.mockReturnValue("provider error");
  fakes.manageContextPressure.mockImplementation(async (messages: unknown[]) => ({ messages }));
  fakes.handleCodexPlanningResponse.mockReturnValue({ shouldContinueLoop: false });
  fakes.maybeInjectSystemReminder.mockResolvedValue(undefined);
  fakes.checkCostBudget.mockResolvedValue(false);
  fakes.createSandboxCheckpoint.mockReturnValue("checkpoint-1");
  fakes.localeGet.mockImplementation((_locale: string, key: string) => `locale:${key}`);
  fakes.getDefaultLocale.mockReturnValue("en");
  fakes.logBackgroundLlmCall.mockResolvedValue(undefined);
});

// ─── shared.ts — config resolution ────────────────────────────────────────────

describe("shared — config resolution", () => {
  it("resolves iteration budgets", () => {
    expect(resolveMaxIterations(0)).toBe(Infinity);
    expect(resolveMaxIterations(500)).toBe(100);
    expect(resolveMaxIterations(-3)).toBe(1);
    expect(resolveMaxIterations(undefined)).toBeGreaterThan(1);
  });

  it("resolves branch count and value threshold with clamping", () => {
    expect(resolveBranchConfig({})).toEqual({ initialBranchCount: 3, valueThreshold: 5 });
    expect(resolveBranchConfig({ branchCount: 9, valueThreshold: 2.5 })).toEqual({
      initialBranchCount: 5,
      valueThreshold: 2.5,
    });
    expect(resolveBranchConfig({ branchCount: -2 })).toEqual({ initialBranchCount: 1, valueThreshold: 5 });
  });
});

// ─── shared.ts — scoring ──────────────────────────────────────────────────────

describe("shared — multi-criteria scoring", () => {
  it("parses the 4-criteria rubric and weights the score", () => {
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    parseMultiCriteriaScores(
      "1: correctness=8, risk=7, efficiency=6, completeness=9\n2: correctness=11, risk=0, efficiency=5, completeness=5",
      branches,
    );
    expect(branches[0].criteriaScores).toEqual({ correctness: 8, risk: 7, efficiency: 6, completeness: 9 });
    expect(branches[0].score).toBeCloseTo(8 * 0.4 + 7 * 0.25 + 6 * 0.15 + 9 * 0.2, 5);
    expect(branches[1].criteriaScores.correctness).toBe(10);
  });

  it("ignores out-of-range candidate indices", () => {
    const branches = [makeBranch(0, 0)];
    parseMultiCriteriaScores("5: correctness=9, risk=9, efficiency=9, completeness=9", branches);
    expect(branches[0].score).toBe(0);
  });

  it("falls back to single scores when the rubric was ignored", () => {
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    applyScoreFallbacks("1: 7\n2: 11", branches);
    expect(branches[0].score).toBe(7);
    expect(branches[0].criteriaScores).toEqual({ correctness: 7, risk: 7, efficiency: 7, completeness: 7 });
    expect(branches[1].score).toBe(5);
  });

  it("keeps rubric scores and only defaults branches left at zero", () => {
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    branches[0].criteriaScores = { correctness: 9, risk: 9, efficiency: 9, completeness: 9 };
    branches[0].score = 9;
    applyScoreFallbacks("2: 4", branches);
    expect(branches[0].score).toBe(9);
    expect(branches[1].score).toBe(5);
  });

  it("builds the scoring prompt and candidate summaries", () => {
    const branch = makeBranch(0, 0, {
      text: "",
      thinking: "thinking only",
      pass: makePass({ pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    expect(formatCandidateSummaries([branch])).toContain("[Candidate 1] 1 tool call(s) (read_file).");
    expect(formatCandidateSummaries([branch])).toContain("Output: thinking only");
    const prompt = buildScoringPrompt([branch]);
    expect(prompt).toContain("CORRECTNESS");
    expect(prompt).toContain("[Candidate 1]");
  });

  it("formats the validation error block", () => {
    expect(
      formatValidationErrorBlock([
        { filePath: "a.ts", validatorType: "tsc", rawOutput: "error 1" },
        { filePath: "b.ts", validatorType: "eslint", rawOutput: "error 2" },
      ]),
    ).toBe("### a.ts (tsc)\nerror 1\n\n### b.ts (eslint)\nerror 2");
  });

  it("builds the tool-call assistant message with matching results", () => {
    const pass = makePass({
      streamedText: "running tools",
      streamedThinking: "  plan  ",
      thinkingSignature: "sig",
      pendingToolCalls: [
        { id: "t1", name: "read_file", args: { path: "a" } },
        { id: "t2", name: "write_file", args: { path: "b" } },
      ],
    });
    const message = buildToolCallAssistantMessage(pass as never, [
      { id: "t1", result: "contents", durationMs: 4 },
    ] as never);
    expect(message).toMatchObject({ role: "assistant", content: "running tools", thinking: "plan", thinkingSignature: "sig" });
    expect(message.toolCalls).toEqual([
      { id: "t1", name: "read_file", args: { path: "a" }, responsesItemId: undefined, thoughtSignature: undefined, reasoningItem: undefined, result: "contents", durationMs: 4 },
      { id: "t2", name: "write_file", args: { path: "b" }, responsesItemId: undefined, thoughtSignature: undefined, reasoningItem: undefined, result: null, durationMs: undefined },
    ]);
  });

  it("only restores a checkpoint when a reference exists", () => {
    const emit = vi.fn();
    restoreCheckpointIfPresent("/ws", null, emit);
    expect(fakes.restoreSandboxCheckpoint).not.toHaveBeenCalled();
    restoreCheckpointIfPresent("/ws", "checkpoint-1", emit);
    expect(fakes.restoreSandboxCheckpoint).toHaveBeenCalledWith("/ws", "checkpoint-1", emit);
  });

  it("scores a single branch at the ceiling without calling the model", async () => {
    const { harness } = makeHarness();
    const branches = [makeBranch(0, 0)];
    const scored = await scoreBranchesMultiCriteria(harness as never, branches, "[test]");
    expect(scored[0].score).toBe(10);
    expect(harness.context.provider.generateTextStream).not.toHaveBeenCalled();
  });

  it("scores multiple branches from the model's rubric and logs the call", async () => {
    const { harness } = makeHarness({
      scoreChunks: ["1: correctness=8, risk=8, efficiency=8, completeness=8\n", "2: correctness=4, risk=4, efficiency=4, completeness=4"],
    });
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    const scored = await scoreBranchesMultiCriteria(harness as never, branches, "[test]");
    expect(scored[0].score).toBeCloseTo(8, 5);
    expect(scored[1].score).toBeCloseTo(4, 5);
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "agent:scoring", resultText: expect.stringContaining("correctness=8") }),
    );
  });

  it("gives every branch an equal score when scoring throws", async () => {
    const { harness } = makeHarness();
    harness.context.provider.generateTextStream = vi.fn(() => {
      throw new Error("scoring model down");
    });
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    const scored = await scoreBranchesMultiCriteria(harness as never, branches, "[test]");
    expect(scored.map((branch) => branch.score)).toEqual([5, 5]);
  });

  it("survives a failing scoring telemetry log", async () => {
    const { harness } = makeHarness({ scoreChunks: ["1: 9\n2: 3"] });
    fakes.logBackgroundLlmCall.mockRejectedValue(new Error("mongo down"));
    const branches = [makeBranch(0, 0), makeBranch(1, 0)];
    const scored = await scoreBranchesMultiCriteria(harness as never, branches, "[test]");
    expect(scored[0].score).toBe(9);
  });

  it("applies a default score to a branch", () => {
    const branch = makeBranch(0, 0);
    applyDefaultBranchScore(branch, 4);
    expect(branch).toMatchObject({ score: 4, criteriaScores: { correctness: 4, risk: 4, efficiency: 4, completeness: 4 } });
  });
});

// ─── shared.ts — branch generation, hook phase, exploration ───────────────────

describe("shared — generateBranch and exploration", () => {
  it("generates the first branch without a diversity instruction", async () => {
    const { harness } = makeHarness({ passFactory: () => makePass({ streamedText: "first", streamedThinking: "think" }) });
    const branch = await generateBranch(
      harness as never,
      0,
      3,
      [{ role: "user", content: "solve" }],
      { project: "proj", username: "alice" } as never,
      new Set(["read_file"]),
    );
    expect(branch).toMatchObject({ branchIndex: 0, text: "first", thinking: "think", score: 0 });
    expect(branch.pass.requestId).toBe("req-1-iter-0-branch-0");
    expect(harness.registerTrackerRequest).toHaveBeenCalledWith("req-1-iter-0-branch-0");
    expect(harness.createProviderStream).toHaveBeenCalledWith([{ role: "user", content: "solve" }], expect.any(Object));
  });

  it("adds the strategy descriptor and the failed-approach list to later branches", async () => {
    const { harness } = makeHarness();
    await generateBranch(
      harness as never,
      2,
      3,
      [{ role: "user", content: "solve" }],
      { project: "proj", username: "alice" } as never,
      new Set(),
      ["tried A", "tried B"],
    );
    const messages = harness.createProviderStream.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain("[BRANCH 3/3]");
    expect(messages[1].content).toContain("1. tried A");
    expect(messages[1].content).toContain("fundamentally different strategy");
  });

  it("runs the beforePrompt hook phase and stores the assembled prompt", async () => {
    const { harness, emit } = makeHarness();
    const hooks = {
      run: vi.fn(async (_name: string, hookContext: Any) => {
        hookContext._assembledSystemPrompt = "assembled";
        hookContext._injectedSkills = ["skill-a"];
      }),
    };
    const options: Any = { planFirst: true };
    harness.context.options = options;
    await runBeforePromptPhase(harness as never, [{ role: "user", content: "hi" }], hooks as never, "ac-1");
    expect(emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.PLAN_MODE_ENTERED,
    });
    expect(emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SKILLS_INJECTED,
      skills: ["skill-a"],
    });
    expect(options.systemPrompt).toBe("assembled");
    expect(harness.context.conversationMeta).toEqual({ systemPrompt: "assembled" });
    expect(hooks.run).toHaveBeenCalledWith(
      "beforePrompt",
      expect.objectContaining({
        messages: [{ role: "user", content: "hi" }],
        agentConversationId: "ac-1",
        resolvedToolNames: ["read_file"],
        workspaceRoot: "/ws",
      }),
    );
  });

  it("keeps an explicit system prompt and ignores empty skill lists", async () => {
    const { harness, emit } = makeHarness();
    const hooks = {
      run: vi.fn(async (_name: string, hookContext: Any) => {
        hookContext._assembledSystemPrompt = "assembled";
        hookContext._injectedSkills = [];
      }),
    };
    const options: Any = { systemPrompt: "explicit" };
    harness.context.options = options;
    await runBeforePromptPhase(harness as never, [], hooks as never, "ac-1");
    expect(options.systemPrompt).toBe("explicit");
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ message: STATUS_MESSAGES.SKILLS_INJECTED }));
  });

  it("explores BFS branches in parallel, scores and ranks them", async () => {
    const { harness, emit, state } = makeHarness({
      scoreChunks: ["1: correctness=4, risk=4, efficiency=4, completeness=4\n2: correctness=9, risk=9, efficiency=9, completeness=9"],
      passFactory: (index) => makePass({ streamedText: `branch ${index}` }),
    });
    const outcome = await exploreBfsBranches(
      harness as never,
      2,
      [{ role: "user", content: "solve" }],
      { project: "proj", username: "alice" } as never,
      new Set(),
      undefined,
      "bfs",
      "[test]",
    );
    expect(outcome.aborted).toBe(false);
    expect(outcome.scoredBranches.map((branch) => branch.score)).toEqual([9, 4]);
    expect(outcome.selectedBranch.branchIndex).toBe(1);
    expect(state.branchesExplored).toBe(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCHING_STARTED, branchCount: 2, searchStrategy: "bfs" }),
    );
  });

  it("reports an aborted BFS exploration", async () => {
    const signal = { aborted: true };
    const { harness } = makeHarness({ signal, passFactory: () => makePass({ streamedText: "x" }) });
    const outcome = await exploreBfsBranches(
      harness as never,
      2,
      [],
      { project: "proj", username: "alice" } as never,
      new Set(),
      undefined,
      undefined,
      "[test]",
    );
    expect(outcome.aborted).toBe(true);
    expect(outcome.scoredBranches).toEqual([]);
  });

  it("accepts the first DFS sibling above the threshold", async () => {
    const { harness, emit, state } = makeHarness({
      passFactory: () => makePass({ streamedText: "sibling" }),
    });
    const failed: string[] = [];
    const outcome = await exploreDfsBranches(
      harness as never,
      3,
      5,
      [],
      { project: "proj", username: "alice" } as never,
      new Set(),
      failed,
      "[test]",
    );
    expect(outcome.selectedBranch.score).toBe(10);
    expect(state.branchesExplored).toBe(1);
    expect(state.branchesBacktracked).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ searchStrategy: "dfs" }));
  });

  it("prunes DFS siblings below the threshold and records them as failed approaches", async () => {
    const { harness, emit, state } = makeHarness({
      scoreChunks: ["1: 2"],
      passFactory: () => makePass({ streamedText: "weak sibling" }),
    });
    const failed: string[] = [];
    // Single-branch scoring always returns 10, so drive the threshold above it.
    const outcome = await exploreDfsBranches(
      harness as never,
      2,
      20,
      [],
      { project: "proj", username: "alice" } as never,
      new Set(),
      failed,
      "[test]",
    );
    expect(outcome.selectedBranch.score).toBe(10);
    expect(state.branchesBacktracked).toBe(2);
    expect(failed).toEqual(["weak sibling", "weak sibling"]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_BACKTRACKED, reason: "dfs_sibling_pruned" }),
    );
  });

  it("applies a proactive backtrack with the reflexion prompt", () => {
    const emit = vi.fn();
    const state: Any = { proactiveBacktracks: 0, branchesBacktracked: 0 };
    const messages: Array<{ role: string; content: string }> = [];
    applyProactiveBacktrack({
      state: state as never,
      emit,
      currentMessages: messages as never,
      options: { locale: "de" },
      localeKey: "harness.treeOfThoughts.proactiveBacktrack",
      branchIndex: 1,
      bestScore: 3.25,
      threshold: 5,
      extraLocaleVars: { branchCount: "2" },
      logPrefix: "[test]",
    });
    expect(state).toMatchObject({ proactiveBacktracks: 1, branchesBacktracked: 1 });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
        reason: "proactive_value_threshold",
        bestScore: 3.25,
        threshold: 5,
      }),
    );
    expect(messages).toEqual([{ role: "system", content: "locale:harness.treeOfThoughts.proactiveBacktrack" }]);
    expect(fakes.localeGet).toHaveBeenCalledWith("de", "harness.treeOfThoughts.proactiveBacktrack", {
      branchCount: "2",
      bestScore: "3.3",
      threshold: "5",
    });
  });
});

// ─── Tree of Thoughts ─────────────────────────────────────────────────────────

const twoBranchScores = (first: number, second: number) =>
  [`1: correctness=${first}, risk=${first}, efficiency=${first}, completeness=${first}\n`,
    `2: correctness=${second}, risk=${second}, efficiency=${second}, completeness=${second}`];

describe("runTreeOfThoughts", () => {
  it("selects the best BFS branch and stops on a clean text answer", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      scoreChunks: twoBranchScores(9, 4),
      passFactory: (index) => makePass({ streamedText: `answer ${index}`, finalStreamedText: `answer ${index}` }),
    });

    const result = await runTreeOfThoughts(harness as never);

    expect(state.iterations).toBe(1);
    expect(state.branchesExplored).toBe(2);
    expect(state.selectedBranchScores).toEqual([9]);
    expect(state.finalStreamedText).toBe("answer 0");
    expect(state.frontierCandidates).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_SELECTED, branchIndex: 0, score: 9 }),
    );
    expect(fakes.handleCodexPlanningResponse).toHaveBeenCalled();
    expect(fakes.cleanupReminderCache).toHaveBeenCalledWith("ac-1");
    expect(harness.finalize).toHaveBeenCalledWith(result.messages, expect.any(Object));
  });

  it("re-branches when every branch scores below the value threshold", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 2, valueThreshold: 5 },
      stateOverrides: { iterations: 1 },
      scoreChunks: twoBranchScores(1, 1),
      passFactory: () => makePass({ streamedText: "weak" }),
    });

    const result = await runTreeOfThoughts(harness as never);

    expect(state.proactiveBacktracks).toBe(1);
    expect(state.branchesBacktracked).toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_BACKTRACKED, reason: "proactive_value_threshold" }),
    );
    expect(result.messages.some((message) => message.role === "system")).toBe(true);
  });

  it("explores DFS siblings sequentially and accepts the first above the threshold", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 3, searchStrategy: "dfs" },
      passFactory: () => makePass({ streamedText: "dfs answer" }),
    });

    await runTreeOfThoughts(harness as never);

    expect(state.branchesExplored).toBe(1);
    expect(state.branchesBacktracked).toBe(0);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ searchStrategy: "dfs" }));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_SELECTED, searchStrategy: "dfs", score: 10 }),
    );
  });

  it("stops without selecting a branch when the run is aborted", async () => {
    const { harness, emit } = makeHarness({
      options: { maxIterations: 3, branchCount: 2 },
      signal: { aborted: true },
      passFactory: () => makePass({ streamedText: "answer" }),
    });

    await runTreeOfThoughts(harness as never);

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_SELECTED }));
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("returns before the loop when the entry plan is rejected", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 3 },
      stateOverrides: { planModeActive: true },
    });
    fakes.runPlanningPhase.mockResolvedValue({ planApproved: false });

    const result = await runTreeOfThoughts(harness as never);

    expect(result.messages).toEqual([{ role: "user", content: "solve the task" }]);
    expect(state.iterations).toBe(0);
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("falls back to the next frontier candidate when the best branch fails validation", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2, enableSandbox: true },
      scoreChunks: twoBranchScores(9, 6),
      passFactory: (index) => makePass({ streamedText: `branch ${index}`, pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok", durationMs: 3 }]);
    fakes.validateAfterToolExecution.mockResolvedValue([
      { filePath: "a.ts", validatorType: "tsc", rawOutput: "type error" },
    ]);

    const result = await runTreeOfThoughts(harness as never);

    expect(state.frontierCandidates).toEqual([]);
    expect(state.branchesBacktracked).toBe(1);
    expect(fakes.createSandboxCheckpoint).toHaveBeenCalledWith("/ws", expect.any(Function));
    expect(fakes.restoreSandboxCheckpoint).toHaveBeenCalledWith("/ws", "checkpoint-1", expect.any(Function));
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: STATUS_MESSAGES.BRANCH_BACKTRACKED,
        reason: "frontier_fallback",
        fallbackBranchIndex: 1,
      }),
    );
    expect(result.messages).toContainEqual({ role: "assistant", content: "branch 1" });
  });

  it("restores the checkpoint and injects a reflexion prompt when no sandbox checkpoint exists", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2 },
      scoreChunks: twoBranchScores(9, 6),
      passFactory: (index) => makePass({ streamedText: `branch ${index}`, pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok" }]);
    fakes.validateAfterToolExecution.mockResolvedValue([
      { filePath: "a.ts", validatorType: "tsc", rawOutput: "type error" },
    ]);

    const result = await runTreeOfThoughts(harness as never);

    expect(state.branchesBacktracked).toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_BACKTRACKED, restoredCheckpoint: true }),
    );
    expect(result.messages).toContainEqual({
      role: "system",
      content: "locale:harness.treeOfThoughts.reflexion",
    });
  });

  it("echoes the failed branch and injects the budget-exhausted prompt on a single-branch failure", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 1, enableSandbox: true },
      passFactory: () => makePass({ streamedText: "attempted fix", pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok", durationMs: 2 }]);
    fakes.validateAfterToolExecution.mockResolvedValue([
      { filePath: "a.ts", validatorType: "tsc", rawOutput: "type error" },
    ]);

    const result = await runTreeOfThoughts(harness as never);

    expect(state.branchesBacktracked).toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_BACKTRACKED, restoredCheckpoint: false }),
    );
    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "attempted fix", toolCalls: expect.any(Array) }),
    );
    expect(result.messages).toContainEqual({
      role: "system",
      content: "locale:harness.treeOfThoughts.budgetExhausted",
    });
  });

  it("commits a validated tool branch with retry guidance", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 1, branchCount: 1 },
      passFactory: () => makePass({ streamedText: "calling tools", pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok", durationMs: 3 }]);
    fakes.buildToolRetryGuidance.mockReturnValue({ role: "system", content: "retry guidance" });

    const result = await runTreeOfThoughts(harness as never);

    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "calling tools", toolCalls: expect.any(Array) }),
    );
    expect(result.messages).toContainEqual({ role: "system", content: "retry guidance" });
    expect(fakes.injectToolDiscoveryNudge).toHaveBeenCalled();
    expect(harness.checkAndApplyToolSetChanges).toHaveBeenCalled();
  });

  it("aborts the run when the plan gate rejects the committed branch", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 2, branchCount: 1 },
      stateOverrides: { planModeActive: true },
      passFactory: () => makePass({ streamedText: "calling tools", pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
    });
    fakes.runPlanningPhase.mockResolvedValueOnce({ planApproved: true }).mockResolvedValueOnce({ planApproved: false });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok" }]);

    const result = await runTreeOfThoughts(harness as never);

    expect(fakes.runPlanningPhase).toHaveBeenCalledTimes(2);
    expect(result.messages).not.toContainEqual(expect.objectContaining({ content: "retry guidance" }));
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("escalates maxTokens when the answer is truncated", async () => {
    const { harness, context } = makeHarness({
      options: { maxIterations: 2, branchCount: 1, maxTokens: 2048 },
      passFactory: (index) => makePass({ streamedText: index >= 1 ? "final answer" : "" }),
    });
    fakes.isOutputTruncated.mockImplementation((pass: Any) => !pass.streamedText && !pass.streamedThinking);

    await runTreeOfThoughts(harness as never);

    expect(context.options.maxTokens).toBe(4096);
    expect(fakes.injectContinuationContext).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.anything(), 1);
    expect(fakes.handleCodexPlanningResponse).toHaveBeenCalled();
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("gives up when maxTokens is already at the model ceiling", async () => {
    const { harness, context } = makeHarness({
      options: { maxIterations: 2, branchCount: 1, maxTokens: 8192 },
      passFactory: () => makePass(),
    });
    fakes.isOutputTruncated.mockReturnValue(true);
    fakes.isAtOutputCeiling.mockReturnValue(true);

    await runTreeOfThoughts(harness as never);

    expect(context.options.maxTokens).toBe(8192);
    expect(fakes.buildExhaustedRecoveryMessage).toHaveBeenCalledWith(0, 8192, undefined);
    expect(fakes.injectErrorAsConversationMessage).toHaveBeenCalledWith(
      expect.any(Array),
      "exhausted",
      expect.anything(),
    );
  });

  it("re-prompts when the branch produced only thinking", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 2, branchCount: 1 },
      passFactory: (index) => makePass(index === 0 ? { streamedThinking: "internal reasoning" } : { streamedText: "done" }),
    });

    const result = await runTreeOfThoughts(harness as never);

    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: expect.stringContaining("Do not repeat your reasoning"), _isSystemWarning: true }),
    );
    expect(fakes.handleCodexPlanningResponse).toHaveBeenCalled();
  });

  it("breaks on an empty branch output", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 3, branchCount: 1 },
      passFactory: () => makePass(),
    });

    await runTreeOfThoughts(harness as never);

    expect(state.iterations).toBe(1);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("runs the exhaustion recovery pass when the loop ends with tool calls outstanding", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 1 },
      stateOverrides: { streamedToolCalls: [{ id: "t1" }] },
      passFactory: () => makePass(),
    });

    await runTreeOfThoughts(harness as never);

    expect(state.conversationOutcome).toBe("exhausted");
    expect(fakes.runExhaustionRecoveryPass).toHaveBeenCalledWith(harness, harness.context, state, expect.any(Array));
  });

  it("persists the error path and rethrows the provider failure", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 1 },
      finalizeThrows: true,
    });
    harness.createProviderStream.mockRejectedValue(new Error("provider blew up"));

    await expect(runTreeOfThoughts(harness as never)).rejects.toThrow("provider blew up");
    expect(state.conversationOutcome).toBe("error");
    expect(fakes.buildProviderErrorMessage).toHaveBeenCalledWith(expect.any(Error), 1, undefined);
    expect(fakes.injectErrorAsConversationMessage).toHaveBeenCalled();
    expect(harness.finalize).toHaveBeenCalled();
  });
});


// ─── Graph of Thoughts ────────────────────────────────────────────────────────

describe("runGraphOfThoughts", () => {
  it("synthesizes all branches above the threshold into one pass", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass({
          streamedText: index < 2 ? `branch ${index}` : "merged answer",
          finalStreamedText: index < 2 ? `branch ${index}` : "merged answer",
        }),
    });

    const result = await runGraphOfThoughts(harness as never);

    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.SYNTHESIS_STARTED, branchCount: 2 }),
    );
    expect(harness.createPassState).toHaveBeenCalledTimes(3);
    expect(state.finalStreamedText).toBe("merged answer");
    expect(state.selectedBranchScores).toEqual([8]);
    expect(fakes.handleCodexPlanningResponse).toHaveBeenCalled();
    expect(harness.finalize).toHaveBeenCalledWith(result.messages, expect.any(Object));
  });

  it("skips synthesis when only one branch clears the threshold", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 2),
      passFactory: (index) => makePass({ streamedText: `branch ${index}`, finalStreamedText: `branch ${index}` }),
    });

    await runGraphOfThoughts(harness as never);

    expect(harness.createPassState).toHaveBeenCalledTimes(2);
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ message: STATUS_MESSAGES.SYNTHESIS_STARTED }));
    expect(state.finalStreamedText).toBe("branch 0");
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("re-branches when no branch clears the threshold after the first iteration", async () => {
    const { harness, emit, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      stateOverrides: { iterations: 1 },
      scoreChunks: twoBranchScores(1, 1),
      passFactory: () => makePass({ streamedText: "weak" }),
    });

    await runGraphOfThoughts(harness as never);

    expect(state.proactiveBacktracks).toBe(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ message: STATUS_MESSAGES.BRANCH_BACKTRACKED, reason: "proactive_value_threshold" }),
    );
    expect(harness.createPassState).toHaveBeenCalledTimes(2);
  });

  it("stops when exploration reports an abort", async () => {
    const { harness, emit } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      signal: { aborted: true },
      passFactory: () => makePass({ streamedText: "answer" }),
    });

    await runGraphOfThoughts(harness as never);

    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ message: STATUS_MESSAGES.SYNTHESIS_STARTED }));
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("restores the checkpoint and re-prompts when the synthesized tools fail validation", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2, enableSandbox: true },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass({
          streamedText: `branch ${index}`,
          pendingToolCalls: index === 2 ? [{ id: "t1", name: "read_file", args: {} }] : [],
        }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok" }]);
    fakes.validateAfterToolExecution.mockResolvedValue([
      { filePath: "a.ts", validatorType: "tsc", rawOutput: "type error" },
    ]);

    const result = await runGraphOfThoughts(harness as never);

    expect(state.branchesBacktracked).toBe(1);
    expect(fakes.restoreSandboxCheckpoint).toHaveBeenCalledWith("/ws", "checkpoint-1", expect.any(Function));
    expect(result.messages).toContainEqual({
      role: "system",
      content: "locale:harness.graphOfThoughts.synthesizedValidationError",
    });
  });

  it("returns early when the plan gate rejects the synthesized tool call", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass({
          streamedText: `branch ${index}`,
          pendingToolCalls: index === 2 ? [{ id: "t1", name: "read_file", args: {} }] : [],
        }),
    });
    fakes.checkForPlanModeEntry.mockImplementation(async (_calls: unknown, _messages: unknown, state: Any) => {
      state.planModeActive = true;
    });
    fakes.runPlanningPhase.mockResolvedValue({ planApproved: false });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok" }]);

    await runGraphOfThoughts(harness as never);

    expect(fakes.runPlanningPhase).toHaveBeenCalledWith(harness, expect.any(Array), "GraphOfThoughts");
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("commits validated synthesized tool calls with discovery nudge", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 1, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass({
          streamedText: `branch ${index}`,
          pendingToolCalls: index === 2 ? [{ id: "t1", name: "read_file", args: {} }] : [],
        }),
    });
    fakes.executeToolBatch.mockResolvedValue([{ id: "t1", result: "ok", durationMs: 2 }]);
    fakes.buildToolRetryGuidance.mockReturnValue({ role: "system", content: "retry guidance" });

    const result = await runGraphOfThoughts(harness as never);

    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "branch 2", toolCalls: expect.any(Array) }),
    );
    expect(result.messages).toContainEqual({ role: "system", content: "retry guidance" });
    expect(fakes.injectToolDiscoveryNudge).toHaveBeenCalled();
    expect(harness.checkAndApplyToolSetChanges).toHaveBeenCalled();
  });

  it("escalates maxTokens when the synthesized answer is truncated", async () => {
    const { harness, context } = makeHarness({
      options: { maxIterations: 2, branchCount: 2, maxTokens: 2048 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass({
          streamedText: index < 2 ? `branch ${index}` : index === 2 ? "" : "final answer",
        }),
    });
    fakes.isOutputTruncated.mockImplementation((pass: Any) => pass.streamedText === "");

    await runGraphOfThoughts(harness as never);

    expect(context.options.maxTokens).toBe(4096);
    expect(fakes.injectContinuationContext).toHaveBeenCalledWith(expect.any(Array), expect.anything(), expect.anything(), 1);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("gives up when maxTokens is already at the model ceiling", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 2, branchCount: 2, maxTokens: 8192 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) => makePass({ streamedText: index < 2 ? `branch ${index}` : "" }),
    });
    fakes.isOutputTruncated.mockReturnValue(true);
    fakes.isAtOutputCeiling.mockReturnValue(true);

    await runGraphOfThoughts(harness as never);

    expect(fakes.buildExhaustedRecoveryMessage).toHaveBeenCalledWith(0, 8192, undefined);
    expect(fakes.injectErrorAsConversationMessage).toHaveBeenCalledWith(expect.any(Array), "exhausted", expect.anything());
  });

  it("re-prompts when the synthesized pass produced only thinking", async () => {
    const { harness } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) =>
        makePass(index < 2 ? { streamedText: `branch ${index}` } : index === 2 ? { streamedThinking: "thinking" } : { streamedText: "done" }),
    });

    const result = await runGraphOfThoughts(harness as never);

    expect(result.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: expect.stringContaining("Do not repeat your reasoning"), _isSystemWarning: true }),
    );
  });

  it("breaks on an empty synthesized pass", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 3, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      passFactory: (index) => makePass({ streamedText: index < 2 ? `branch ${index}` : "" }),
    });

    await runGraphOfThoughts(harness as never);

    expect(state.iterations).toBe(1);
    expect(harness.finalize).toHaveBeenCalled();
  });

  it("runs exhaustion recovery when the loop ends with outstanding tool calls", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 1, branchCount: 2 },
      scoreChunks: twoBranchScores(8, 7),
      stateOverrides: { streamedToolCalls: [{ id: "t1" }] },
      passFactory: (index) => makePass({ streamedText: index < 2 ? `branch ${index}` : "" }),
    });

    await runGraphOfThoughts(harness as never);

    expect(state.conversationOutcome).toBe("exhausted");
    expect(fakes.runExhaustionRecoveryPass).toHaveBeenCalledWith(harness, harness.context, state, expect.any(Array));
  });

  it("returns before the loop when the entry plan is rejected", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 3 },
      stateOverrides: { planModeActive: true },
    });
    fakes.runPlanningPhase.mockResolvedValue({ planApproved: false });

    const result = await runGraphOfThoughts(harness as never);

    expect(result.messages).toEqual([{ role: "user", content: "solve the task" }]);
    expect(state.iterations).toBe(0);
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it("persists the error path and rethrows the provider failure", async () => {
    const { harness, state } = makeHarness({
      options: { maxIterations: 2, branchCount: 2 },
      finalizeThrows: true,
    });
    harness.createProviderStream.mockRejectedValue(new Error("graph provider down"));

    await expect(runGraphOfThoughts(harness as never)).rejects.toThrow("graph provider down");
    expect(state.conversationOutcome).toBe("error");
    expect(fakes.buildProviderErrorMessage).toHaveBeenCalledWith(expect.any(Error), 1, undefined);
    expect(harness.finalize).toHaveBeenCalled();
  });
});
