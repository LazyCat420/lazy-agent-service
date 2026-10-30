/**
 * Harness lifecycle helpers + Vision/ReAct harnesses — coverage of truncation
 * recovery, context-pressure management, post-execution media/status emission,
 * LLM reminder extraction/injection, tool-discovery nudges, the critic gate,
 * plan-mode transitions and the Vision/ReAct loops. Providers, Mongo-backed
 * stores, file/MinIO uploads, compaction services and hooks are fakes; the
 * helpers, their parsers and the loop control flow are real, and assertions
 * read the emitted SSE events, injected messages and returned state.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SERVER_SENT_EVENT_TYPES, STATUS_MESSAGES } from "@rodrigo-barraza/utilities-library/taxonomy";

const fakes = vi.hoisted(() => ({
  estimateTokens: vi.fn(),
  microcompactMessages: vi.fn(),
  autoCompactEvaluate: vi.fn(),
  compactConversation: vi.fn(),
  persistCompactionSummary: vi.fn(),
  uploadFile: vi.fn(),
  webhookEmit: vi.fn(),
  getToolEmoji: vi.fn(),
  shouldSkipLearningForProject: vi.fn(),
  injectPlanningInstruction: vi.fn(),
  extractSteps: vi.fn(),
  stripPlanningInstruction: vi.fn(),
  localeGet: vi.fn(),
  getDefaultLocale: vi.fn(),
  logBackgroundLlmCall: vi.fn(),
  finalizePassTracker: vi.fn(),
  createStandardHooks: vi.fn(),
  manageContextPressure: vi.fn(),
  logKVCacheHitRate: vi.fn(),
  handleCodexPlanningResponse: vi.fn(),
  isOutputTruncated: vi.fn(),
  isAtOutputCeiling: vi.fn(),
  injectContinuationContext: vi.fn(),
  injectErrorAsConversationMessage: vi.fn(),
  buildExhaustedRecoveryMessage: vi.fn(),
  buildProviderErrorMessage: vi.fn(),
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
  getFrames: vi.fn(),
  resolveIndependentCriticModel: vi.fn(),
  pendingListUndelivered: vi.fn(),
  pendingMarkDelivered: vi.fn(),
  pendingCancel: vi.fn(),
  pendingCreate: vi.fn(),
  toolContextGetStore: vi.fn(),
  runTreeOfThoughts: vi.fn(),
  runGraphOfThoughts: vi.fn(),
}));

vi.mock("../../utils/ContextWindowManager.ts", () => ({
  default: { estimateTokens: fakes.estimateTokens },
}));
vi.mock("../compact/MicroCompactionService.ts", () => ({
  default: { microcompactMessages: fakes.microcompactMessages },
}));
vi.mock("../compact/AutoCompactionTrigger.ts", () => ({
  default: { evaluate: fakes.autoCompactEvaluate },
}));
vi.mock("../compact/CompactionService.ts", () => ({
  default: { compactConversation: fakes.compactConversation },
}));
vi.mock("../ConversationEmbeddingService.ts", () => ({
  default: { persistCompactionSummary: fakes.persistCompactionSummary },
}));
vi.mock("../FileService.ts", () => ({ default: { uploadFile: fakes.uploadFile } }));
vi.mock("../WebhookEventBus.ts", () => ({
  default: { emit: fakes.webhookEmit },
}));
vi.mock("../ToolOrchestratorService.ts", () => ({
  default: { getToolEmoji: fakes.getToolEmoji },
}));
vi.mock("../TradingAgentRequest.ts", () => ({
  shouldSkipLearningForProject: fakes.shouldSkipLearningForProject,
}));
vi.mock("../PlanningModeService.ts", () => ({
  default: {
    injectPlanningInstruction: fakes.injectPlanningInstruction,
    extractSteps: fakes.extractSteps,
    stripPlanningInstruction: fakes.stripPlanningInstruction,
  },
}));
vi.mock("../PendingApprovalStore.ts", () => ({
  pendingApprovalStore: {
    listUndelivered: fakes.pendingListUndelivered,
    markDelivered: fakes.pendingMarkDelivered,
    cancelPending: fakes.pendingCancel,
    create: fakes.pendingCreate,
  },
}));
vi.mock("../ToolContext.ts", () => ({
  default: { getStore: fakes.toolContextGetStore },
}));
vi.mock("../PromptLocaleService.ts", () => ({
  default: { get: fakes.localeGet, getDefaultLocale: fakes.getDefaultLocale },
}));
vi.mock("../RequestLogger.ts", () => ({
  default: { logBackgroundLlmCall: fakes.logBackgroundLlmCall },
}));
vi.mock("../harnesses/lifecycle/TrackerFinalizer.ts", () => ({
  finalizePassTracker: fakes.finalizePassTracker,
}));
vi.mock("../harnesses/lifecycle/IndependentJudge.ts", () => ({
  resolveIndependentCriticModel: fakes.resolveIndependentCriticModel,
}));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import {
  calculateEscalatedMaxTokens,
  injectContinuationContext,
  injectErrorAsConversationMessage,
  buildExhaustedRecoveryMessage,
  buildProviderErrorMessage,
} from "../harnesses/lifecycle/OutputTruncationRecovery.ts";
import { manageContextPressure } from "../harnesses/lifecycle/ContextPressureManager.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "../harnesses/lifecycle/PostExecutionEmitter.ts";
import { extractReminderViaLLM } from "../harnesses/lifecycle/SystemReminderExtractor.ts";
import {
  maybeInjectSystemReminder,
  cleanupReminderCache,
} from "../harnesses/lifecycle/SystemReminderInjector.ts";
import { injectToolDiscoveryNudge } from "../harnesses/lifecycle/ToolDiscoveryNudge.ts";
import CriticGate from "../harnesses/lifecycle/CriticGate.ts";
import {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
  runPlanningPhase,
} from "../harnesses/lifecycle/PlanModeController.ts";
import { pendingApprovals } from "../ApprovalRegistry.ts";

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

const makeState = () =>
  ({
    iterations: 3,
    loadedTools: new Set<string>(),
    planModeActive: false,
    planModeText: "",
    originalMessageCount: 1,
    streamedImages: [],
    streamedToolCalls: [],
    conversationOutcome: null,
    overallUsage: {},
    toolErrorCounts: new Map<string, number>(),
    branchesExplored: 0,
    branchesBacktracked: 0,
    proactiveBacktracks: 0,
    frontierCandidates: [],
    selectedBranchScores: [],
    compactionPerformed: false,
    ...{},
  }) as Any;

beforeEach(() => {
  vi.clearAllMocks();
  fakes.estimateTokens.mockReturnValue(1000);
  fakes.microcompactMessages.mockReturnValue({ clearedResultCount: 0, messages: [], freedTokens: 0 });
  fakes.autoCompactEvaluate.mockReturnValue({ shouldCompact: false });
  fakes.compactConversation.mockResolvedValue(null);
  fakes.persistCompactionSummary.mockResolvedValue(undefined);
  fakes.uploadFile.mockResolvedValue({ ref: "minio://audio.wav" });
  fakes.getToolEmoji.mockReturnValue("🔧");
  fakes.shouldSkipLearningForProject.mockReturnValue(false);
  fakes.injectPlanningInstruction.mockResolvedValue(undefined);
  fakes.extractSteps.mockReturnValue(["step 1", "step 2"]);
  fakes.localeGet.mockImplementation((_locale: string, key: string) => `locale:${key}`);
  fakes.getDefaultLocale.mockReturnValue("en");
  fakes.logBackgroundLlmCall.mockResolvedValue(undefined);
  fakes.createStandardHooks.mockReturnValue({ hooks: { run: vi.fn() } });
  fakes.manageContextPressure.mockImplementation(async (messages: unknown[]) => ({ messages }));
  fakes.handleCodexPlanningResponse.mockReturnValue({ shouldContinueLoop: false });
  fakes.isOutputTruncated.mockReturnValue(false);
  fakes.isAtOutputCeiling.mockReturnValue(false);
  fakes.injectContinuationContext.mockReturnValue(3072);
  fakes.buildExhaustedRecoveryMessage.mockReturnValue("exhausted");
  fakes.buildProviderErrorMessage.mockReturnValue("provider error");
  fakes.runExhaustionRecoveryPass.mockResolvedValue(undefined);
  fakes.maybeInjectSystemReminder.mockResolvedValue(undefined);
  fakes.checkCostBudget.mockResolvedValue(false);
  fakes.buildToolRetryGuidance.mockReturnValue(null);
  fakes.executeToolBatch.mockResolvedValue([]);
  fakes.validateAfterToolExecution.mockResolvedValue([]);
  fakes.runPlanningPhase.mockResolvedValue({ planApproved: true });
  fakes.checkForPlanModeEntry.mockResolvedValue(undefined);
  fakes.getFrames.mockReturnValue([]);
  fakes.resolveIndependentCriticModel.mockReturnValue({ model: "other-model", independent: true });
  fakes.pendingListUndelivered.mockResolvedValue([]);
  fakes.pendingMarkDelivered.mockResolvedValue(false);
  fakes.pendingCancel.mockResolvedValue(undefined);
  fakes.pendingCreate.mockResolvedValue(undefined);
  fakes.toolContextGetStore.mockReturnValue(new Map<string, unknown>());
  cleanupReminderCache("ac-1");
});

// ─── OutputTruncationRecovery ─────────────────────────────────────────────────

describe("OutputTruncationRecovery", () => {
  it("escalates maxTokens with the 1.5x multiplier and clamps to the ceiling", () => {
    expect(calculateEscalatedMaxTokens(1000, 1)).toBe(1500);
    expect(calculateEscalatedMaxTokens(1000, 2)).toBe(2250);
    expect(calculateEscalatedMaxTokens(8000, 1, 8192)).toBe(8192);
    expect(calculateEscalatedMaxTokens(1000, 1, 50_000)).toBe(1500);
  });

  it("injects the partial answer and a continuation prompt with the escalated budget", () => {
    const messages: Any[] = [];
    const context = makeContext({ options: { maxTokens: 2048 } });
    const escalated = injectContinuationContext(
      messages as never,
      makePass({ streamedText: "half an answer", streamedThinking: "plan", thinkingSignature: "sig" }) as never,
      context as never,
      1,
    );

    expect(escalated).toBe(3072);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      content: "half an answer",
      thinking: "plan",
      thinkingSignature: "sig",
    });
    expect(messages[1]).toEqual({ role: "system", content: "locale:harness.outputTruncation.continuationPrompt" });
    expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SERVER_SENT_EVENT_TYPES.STATUS,
        message: "output_truncation_recovery",
        attempt: 1,
        escalatedMaxTokens: 3072,
      }),
    );
  });

  it("falls back to thinking-only content and the default token budget", () => {
    const messages: Any[] = [];
    const context = makeContext({ modelDefinition: {} });
    const escalated = injectContinuationContext(
      messages as never,
      makePass({ streamedThinking: "only thinking" }) as never,
      context as never,
      2,
    );
    expect(messages[0]).toMatchObject({ role: "assistant", content: "only thinking" });
    expect(escalated).toBe(Math.ceil(16_384 * 1.5 ** 2));
  });

  it("does not append an assistant message when the truncated output is blank", () => {
    const messages: Any[] = [];
    injectContinuationContext(messages as never, makePass() as never, makeContext() as never, 1);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("system");
  });

  it("injects the error as an assistant message and emits a chunk", () => {
    const messages: Any[] = [];
    const context = makeContext();
    injectErrorAsConversationMessage(messages as never, "boom", context as never);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: "locale:harness.errorAsContext.wrapper",
        _isErrorIndicator: true,
      },
    ]);
    expect(context.emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.CHUNK,
      content: "locale:harness.errorAsContext.wrapper",
    });
    expect(fakes.localeGet).toHaveBeenCalledWith("en", "harness.errorAsContext.wrapper", {
      errorDescription: "boom",
    });
  });

  it("builds the exhausted and provider error descriptions", () => {
    expect(buildExhaustedRecoveryMessage(3, 2048)).toBe("locale:harness.outputTruncation.exhaustedRecovery");
    expect(fakes.localeGet).toHaveBeenCalledWith("en", "harness.outputTruncation.exhaustedRecovery", {
      configuredMaxTokens: "2048",
      maxAttempts: "3",
    });
    expect(buildProviderErrorMessage(new Error("timeout"), 4, "de")).toBe(
      "locale:harness.outputTruncation.providerError",
    );
    expect(fakes.localeGet).toHaveBeenCalledWith("de", "harness.outputTruncation.providerError", {
      errorText: "timeout",
      iteration: "4",
    });
  });
});

// ─── ContextPressureManager ───────────────────────────────────────────────────

describe("manageContextPressure", () => {
  it("returns messages untouched when pressure is low", async () => {
    const messages = [{ role: "user", content: "hi" }];
    const result = await manageContextPressure(messages as never, makeContext() as never, makeState() as never, "ReActHarness");
    expect(result).toEqual({ messages, tokenEstimate: 1000 });
    expect(fakes.microcompactMessages).not.toHaveBeenCalled();
    expect(fakes.compactConversation).not.toHaveBeenCalled();
  });

  it("microcompacts under pressure and runs the compaction hooks", async () => {
    fakes.estimateTokens.mockReturnValueOnce(90_000).mockReturnValueOnce(40_000);
    fakes.microcompactMessages.mockReturnValue({
      clearedResultCount: 2,
      messages: [{ role: "user", content: "compact" }],
      freedTokens: 50_000,
    });
    const context = makeContext({ options: { maxTokens: 10_000 } });
    const result = await manageContextPressure(
      [{ role: "user", content: "hi" }] as never,
      context as never,
      makeState() as never,
      "ReActHarness",
    );
    expect(result.messages).toEqual([{ role: "user", content: "compact" }]);
    expect(result.tokenEstimate).toBe(40_000);
    expect(context.hooks.run).toHaveBeenCalledWith("preCompact", expect.objectContaining({ reason: "micro-compaction" }));
    expect(context.hooks.run).toHaveBeenCalledWith("postCompact", { reason: "micro-compaction", freedTokens: 50_000 });
  });

  it("skips the postCompact hook when micro-compaction frees nothing", async () => {
    fakes.estimateTokens.mockReturnValue(95_000);
    const context = makeContext({ options: { maxTokens: 5000 } });
    await manageContextPressure([{ role: "user", content: "hi" }] as never, context as never, makeState() as never, "ReActHarness");
    expect(context.hooks.run).toHaveBeenCalledWith("preCompact", expect.anything());
    expect(context.hooks.run).not.toHaveBeenCalledWith("postCompact", expect.anything());
  });

  it("auto-compacts and persists the summary", async () => {
    fakes.autoCompactEvaluate.mockReturnValue({ shouldCompact: true });
    fakes.compactConversation.mockResolvedValue({
      compactedMessages: [{ role: "system", content: "summary" }],
      preCompactTokenCount: 90_000,
      postCompactTokenCount: 5000,
      summaryText: "summary text",
    });
    fakes.estimateTokens.mockReturnValueOnce(1000).mockReturnValueOnce(5000);
    const state = makeState();
    const result = await manageContextPressure(
      [{ role: "user", content: "hi" }] as never,
      makeContext() as never,
      state as never,
      "ReActHarness",
    );
    expect(result.messages).toEqual([{ role: "system", content: "summary" }]);
    expect(state).toMatchObject({
      originalMessageCount: 1,
      compactionPerformed: true,
      preCompactTokenCount: 90_000,
      postCompactTokenCount: 5000,
    });
    expect(fakes.persistCompactionSummary).toHaveBeenCalledWith("conv-1", "proj", "alice", "summary text");
  });

  it("keeps the messages when compaction returns nothing", async () => {
    fakes.autoCompactEvaluate.mockReturnValue({ shouldCompact: true });
    fakes.compactConversation.mockResolvedValue(null);
    const messages = [{ role: "user", content: "hi" }];
    const result = await manageContextPressure(messages as never, makeContext() as never, makeState() as never, "ReActHarness");
    expect(result.messages).toEqual(messages);
  });
});

// ─── PostExecutionEmitter ─────────────────────────────────────────────────────

describe("PostExecutionEmitter", () => {
  it("emits task, sub-agent and memory status updates", () => {
    const emit = vi.fn();
    emitPostExecutionStatus(
      [{ name: "create_task" }, { name: "create_subagent" }, { name: "save_memory" }] as never,
      emit,
      { project: "proj" },
    );
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.TASKS_UPDATED });
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.SUB_AGENTS_UPDATED });
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.MEMORIES_UPDATED });
  });

  it("suppresses the memory update when the project skips learning", () => {
    fakes.shouldSkipLearningForProject.mockReturnValue(true);
    const emit = vi.fn();
    emitPostExecutionStatus([{ name: "save_memory" }] as never, emit, { project: "vllm-trading-bot" });
    expect(emit).not.toHaveBeenCalled();
  });

  it("uploads audio, collects screenshot and image refs and emits tool events", async () => {
    const emit = vi.fn();
    const state = makeState();
    const pass = makePass();
    const resultObject: Any = {
      audio: { data: "AAA", mimeType: "audio/mpeg" },
      screenshotRef: "shot-1",
      image: { data: "BBB", mimeType: "image/png" },
    };
    await processToolResultMedia(
      [{ id: "t1", name: "screenshot" }] as never,
      [{ id: "t1", result: resultObject, durationMs: 7 }] as never,
      state as never,
      pass as never,
      emit,
      makeContext() as never,
    );

    expect(resultObject.audioRef).toBe("minio://audio.wav");
    expect(resultObject.audio).toBeUndefined();
    expect(resultObject.image).toBeUndefined();
    expect(state.streamedImages).toEqual(["shot-1", "data:image/png;base64,BBB"]);
    expect(pass.streamedImages).toEqual(["shot-1", "data:image/png;base64,BBB"]);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: SERVER_SENT_EVENT_TYPES.AUDIO, minioRef: "minio://audio.wav" }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: SERVER_SENT_EVENT_TYPES.IMAGE, mimeType: "image/png" }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION,
        status: "done",
        tool: expect.objectContaining({ name: "screenshot", durationMs: 7 }),
      }),
    );
    expect(fakes.webhookEmit).toHaveBeenCalledWith(
      "request.tool_call.completed",
      expect.objectContaining({ toolName: "screenshot", status: "done", durationMs: 7 }),
    );
  });

  it("marks errored tool results and keeps uploading failures non-fatal", async () => {
    fakes.uploadFile.mockRejectedValue(new Error("minio down"));
    const emit = vi.fn();
    await processToolResultMedia(
      [{ id: "t1", name: "run" }] as never,
      [{ id: "t1", result: { error: "failed", audio: { data: "AAA" } } }] as never,
      makeState() as never,
      makePass() as never,
      emit,
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: SERVER_SENT_EVENT_TYPES.TOOL_EXECUTION, status: "error" }),
    );
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: SERVER_SENT_EVENT_TYPES.AUDIO }));
  });

  it("counts consecutive tool errors, warns at the limit and clears on success", () => {
    const emit = vi.fn();
    const state = makeState();
    const toolCalls = [{ id: "t1", name: "run_shell" }];
    const failing = [{ id: "t1", result: { error: "boom" } }];

    trackToolErrors(toolCalls as never, failing as never, state as never, 3, emit);
    expect(state.toolErrorCounts.get("run_shell")).toBe(1);
    expect(emit).not.toHaveBeenCalled();

    trackToolErrors(toolCalls as never, failing as never, state as never, 3, emit);
    trackToolErrors(toolCalls as never, failing as never, state as never, 3, emit);
    expect(emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: 'Tool "run_shell" failed 3 times consecutively — skipping',
    });

    trackToolErrors(toolCalls as never, [{ id: "t1", result: "ok" }] as never, state as never, 3, emit);
    expect(state.toolErrorCounts.has("run_shell")).toBe(false);
  });
});

// ─── SystemReminderExtractor / Injector ───────────────────────────────────────

describe("extractReminderViaLLM", () => {
  const bullets = Array.from({ length: 10 }, (_, index) => `- constraint ${index + 1}`).join("\n");

  it("distills a long system prompt into capped bullets and logs the call", async () => {
    const provider = { generateTextStream: vi.fn(() => streamOf([bullets])) };
    const result = await extractReminderViaLLM("system prompt", provider as never, "model-x", undefined, {
      project: "proj",
      username: "alice",
      agent: "CODING",
      providerName: "lm-studio",
      agentConversationId: "ac-1",
    });
    expect(result).toBe(bullets);
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "agent:system-reminder",
        requestId: "ac-1-system-reminder",
        success: true,
      }),
    );
  });

  it("discards content shorter than 50 characters", async () => {
    const provider = { generateTextStream: vi.fn(() => streamOf(["- too short"])) };
    expect(await extractReminderViaLLM("p", provider as never, "m")).toBeNull();
  });

  it("discards output with fewer than three bullets", async () => {
    const provider = {
      generateTextStream: vi.fn(() => streamOf(["Some prose that is definitely longer than fifty characters total.\n- one\n- two"])),
    };
    expect(await extractReminderViaLLM("p", provider as never, "m")).toBeNull();
  });

  it("caps the reminder at twelve bullets and 1500 characters", async () => {
    const many = Array.from({ length: 20 }, (_, index) => `- ${"x".repeat(200)}${index}`).join("\n");
    const provider = { generateTextStream: vi.fn(() => streamOf([many])) };
    const result = await extractReminderViaLLM("p", provider as never, "m");
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(1500);
    expect(result!.split("\n")).toHaveLength(7);
  });

  it("fails silently when the provider stream throws", async () => {
    const provider = {
      generateTextStream: vi.fn(() => {
        throw new Error("stream broke");
      }),
    };
    expect(await extractReminderViaLLM("p", provider as never, "m")).toBeNull();
  });
});

describe("maybeInjectSystemReminder", () => {
  const systemMessage = { role: "system", content: `constraints ${"y".repeat(300)}` };
  const bullets = Array.from(
    { length: 5 },
    (_, index) => `- rule ${index + 1}: keep responses concise, accurate and on topic`,
  ).join("\n");

  it("is disabled when no reminder model is configured", async () => {
    const messages: Any[] = [systemMessage];
    const context = makeContext({ options: {} });
    await maybeInjectSystemReminder(messages as never, makeState() as never, context as never);
    expect(messages).toHaveLength(1);
    expect(context.provider.generateTextStream).not.toHaveBeenCalled();
  });

  it("waits for the minimum iteration and interval", async () => {
    const messages: Any[] = [systemMessage];
    const context = makeContext({ options: { reminderModel: "m" }, provider: { generateTextStream: vi.fn(() => streamOf([bullets])) } });
    await maybeInjectSystemReminder(messages as never, makeState() as never, context as never);
    expect(messages).toHaveLength(1);

    const state = makeState();
    state.iterations = 9;
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(messages).toHaveLength(1);
  });

  it("does nothing when no long system message exists", async () => {
    const messages: Any[] = [{ role: "user", content: "hi" }];
    const state = makeState();
    state.iterations = 8;
    const context = makeContext({ options: { reminderModel: "m" } });
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(messages).toHaveLength(1);
  });

  it("extracts once, injects the reminder and reuses the cache", async () => {
    const messages: Any[] = [systemMessage];
    const state = makeState();
    state.iterations = 8;
    const context = makeContext({
      options: { reminderModel: "m", reminderInterval: 8 },
      provider: { generateTextStream: vi.fn(() => streamOf([bullets])) },
    });

    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("system");
    expect(String(messages[1].content)).toContain(bullets);
    expect(context.emit).toHaveBeenCalledWith({
      type: SERVER_SENT_EVENT_TYPES.STATUS,
      message: STATUS_MESSAGES.SYSTEM_REMINDER_INJECTED,
      iteration: 8,
      interval: 8,
    });

    state.iterations = 16;
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(messages).toHaveLength(3);
    expect(context.provider.generateTextStream).toHaveBeenCalledTimes(1);
  });

  it("does not inject when extraction yields nothing", async () => {
    const messages: Any[] = [systemMessage];
    const state = makeState();
    state.iterations = 8;
    const context = makeContext({
      options: { reminderModel: "m" },
      provider: { generateTextStream: vi.fn(() => streamOf(["short"])) },
    });
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(messages).toHaveLength(1);
  });

  it("clears the cache for a finished session", async () => {
    const messages: Any[] = [systemMessage];
    const state = makeState();
    state.iterations = 8;
    const context = makeContext({
      options: { reminderModel: "m" },
      provider: { generateTextStream: vi.fn(() => streamOf([bullets])) },
    });
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    cleanupReminderCache("ac-1");
    state.iterations = 16;
    await maybeInjectSystemReminder(messages as never, state as never, context as never);
    expect(context.provider.generateTextStream).toHaveBeenCalledTimes(2);
  });
});

// ─── ToolDiscoveryNudge ───────────────────────────────────────────────────────

describe("injectToolDiscoveryNudge", () => {
  const searchResult = {
    id: "t1",
    result: {
      matches: [
        { name: "alpha", isEnabled: false },
        { name: "beta", isEnabled: false },
        { name: "gamma", isEnabled: true },
      ],
    },
  };

  it("auto-enables discovered tools for a lower-tier model", () => {
    const store = new Map<string, unknown>([["dynamicEnabledTools", ["existing"]]]);
    fakes.toolContextGetStore.mockReturnValue(store);
    const messages: Any[] = [];
    const context = makeContext({ resolvedModel: "gpt-4o-mini" });

    injectToolDiscoveryNudge([{ id: "t1", name: "search_tools" }] as never, [searchResult] as never, messages as never, context as never);

    expect(store.get("dynamicEnabledTools")).toEqual(["existing", "alpha", "beta"]);
    expect(store.get("toolSetDirty")).toBe(true);
    expect(messages).toEqual([
      { role: "system", content: "<tool-update>\nlocale:harness.toolDiscoveryNudge.autoEnabled\n</tool-update>" },
    ]);
    expect(fakes.localeGet).toHaveBeenCalledWith("en", "harness.toolDiscoveryNudge.autoEnabled", {
      count: "2",
      toolNames: "alpha, beta",
    });
  });

  it("asks a higher-tier model to enable the tools itself", () => {
    const messages: Any[] = [];
    const context = makeContext({ resolvedModel: "claude-sonnet-4-5" });
    injectToolDiscoveryNudge([{ id: "t1", name: "search_tools" }] as never, [searchResult] as never, messages as never, context as never);
    expect(messages).toEqual([
      { role: "system", content: "<tool-update>\nlocale:harness.toolDiscoveryNudge.enableRequired\n</tool-update>" },
    ]);
    expect(fakes.toolContextGetStore).not.toHaveBeenCalled();
  });

  it("ignores non-search tools, missing matches and fully enabled results", () => {
    const messages: Any[] = [];
    const context = makeContext({ resolvedModel: "gpt-4o-mini" });
    injectToolDiscoveryNudge([{ id: "t1", name: "read_file" }] as never, [searchResult] as never, messages as never, context as never);
    injectToolDiscoveryNudge([{ id: "t1", name: "search_tools" }] as never, [{ id: "t1", result: {} }] as never, messages as never, context as never);
    injectToolDiscoveryNudge(
      [{ id: "t1", name: "search_tools" }] as never,
      [{ id: "t1", result: { matches: [{ name: "gamma", isEnabled: true }] } }] as never,
      messages as never,
      context as never,
    );
    expect(messages).toEqual([]);
  });
});

// ─── CriticGate ───────────────────────────────────────────────────────────────

describe("CriticGate", () => {
  const context = (overrides: Any = {}) =>
    makeContext({
      options: {},
      provider: { generateTextStream: vi.fn(() => streamOf(["APPROVE\nsafe"])) },
      ...overrides,
    });

  it("passes tools below the danger tier without calling the critic", async () => {
    const gate = new CriticGate();
    const result = await gate.review({ name: "read_file", args: {} } as never, context() as never);
    expect(result).toEqual({
      isApproved: true,
      reason: "below_danger_tier",
      criticModel: "other-model",
      judgeIndependent: true,
    });
  });

  it("honours an explicit critic model and reports independence", async () => {
    const gate = new CriticGate({ model: "critic-x" });
    const result = await gate.review(
      { name: "execute_shell", args: { command: "ls" } } as never,
      context({ options: { skipCritic: true } }) as never,
    );
    expect(result).toMatchObject({ isApproved: true, reason: "critic_skipped", criticModel: "critic-x", judgeIndependent: true });
  });

  it("approves when the critic answers APPROVE and logs the review", async () => {
    const gate = new CriticGate();
    const result = await gate.review({ name: "execute_shell", args: { command: "ls" } } as never, context() as never);
    expect(result).toMatchObject({ isApproved: true, reason: "critic_approved", criticModel: "other-model" });
    expect(fakes.logBackgroundLlmCall).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "agent:critic-review", success: true, resultText: "APPROVE\nsafe" }),
    );
  });

  it("denies with the critic's stated reason", async () => {
    const gate = new CriticGate();
    const result = await gate.review(
      { name: "execute_shell", args: { command: "rm -rf /" } } as never,
      context({ provider: { generateTextStream: vi.fn(() => streamOf(["DENY\ndestructive command"])) } }) as never,
    );
    expect(result).toMatchObject({ isApproved: false, reason: "destructive command" });
  });

  it("denies with a default reason when the critic gives none", async () => {
    const gate = new CriticGate();
    const result = await gate.review(
      { name: "execute_shell", args: {} } as never,
      context({ provider: { generateTextStream: vi.fn(() => streamOf(["DENY"])) } }) as never,
    );
    expect(result).toMatchObject({ isApproved: false, reason: "critic_denied" });
  });

  it("defaults to approve on an ambiguous critic answer", async () => {
    const gate = new CriticGate();
    const result = await gate.review(
      { name: "execute_shell", args: {} } as never,
      context({ provider: { generateTextStream: vi.fn(() => streamOf(["maybe?"])) } }) as never,
    );
    expect(result).toMatchObject({ isApproved: true, reason: "critic_parse_fallback" });
  });

  it("fails open when the critic call throws", async () => {
    const gate = new CriticGate();
    const result = await gate.review(
      { name: "execute_shell", args: {} } as never,
      context({
        provider: {
          generateTextStream: vi.fn(() => {
            throw new Error("critic offline");
          }),
        },
      }) as never,
    );
    expect(result).toMatchObject({ isApproved: true, reason: "critic_error_fallback" });
  });

  it("exposes a decide hook that reviews the tool call", async () => {
    const gate = new CriticGate();
    const hook = gate.createHook();
    const result = await hook({ name: "read_file", args: {} } as never, context() as never);
    expect(result.isApproved).toBe(true);
  });
});

// ─── PlanModeController ───────────────────────────────────────────────────────

describe("PlanModeController", () => {
  it("keeps only exit_plan_mode calls and reports partial blocking", () => {
    const calls = [{ name: "exit_plan_mode" }, { name: "write_file" }] as Any[];
    const messages: Any[] = [];
    const result = blockUnauthorizedToolCalls(calls as never, messages as never, makePass() as never, makeState() as never);
    expect(result).toEqual({ allBlocked: false });
    expect(calls.map((call) => call.name)).toEqual(["exit_plan_mode"]);
    expect(messages).toEqual([]);
  });

  it("blocks every call, echoes the text and injects the blocked notice", () => {
    const calls = [{ name: "write_file" }, { name: "read_file" }] as Any[];
    const messages: Any[] = [];
    const result = blockUnauthorizedToolCalls(
      calls as never,
      messages as never,
      makePass({ streamedText: "planning", streamedThinking: "think" }) as never,
      makeState() as never,
      "de",
    );
    expect(result).toEqual({ allBlocked: true });
    expect(calls).toEqual([]);
    expect(messages).toEqual([
      { role: "assistant", content: "planning", thinking: "think" },
      { role: "system", content: "locale:harness.planningMode.blocked" },
    ]);
    expect(fakes.localeGet).toHaveBeenCalledWith("de", "harness.planningMode.blocked", {
      blockedNames: "write_file, read_file",
    });
  });

  it("lets an allow-listed auto-approved plan through without asking", async () => {
    const emit = vi.fn();
    const context = makeContext({ emit, options: { autoApprove: true } });
    const state = makeState();
    state.planModeActive = true;
    state.planModeText = "  do the thing  ";
    const messages: Any[] = [];

    const result = await handleExitPlanMode(
      { id: "t1", name: "exit_plan_mode" } as never,
      makePass() as never,
      [{ id: "t1", result: {} }] as never,
      messages as never,
      context as never,
      state as never,
    );

    expect(result).toEqual({ shouldContinueLoop: true });
    expect(emit).toHaveBeenCalledWith({ type: "plan_proposal", plan: "do the thing", steps: ["step 1", "step 2"], autoApproved: true });
    expect(state.planModeActive).toBe(false);
    expect(state.planModeText).toBe("");
    expect(fakes.stripPlanningInstruction).toHaveBeenCalledWith(messages);
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_EXITED });
    expect(fakes.pendingCreate).not.toHaveBeenCalled();
  });

  it("rejects a plan denied by the tool gate without asking", async () => {
    const emit = vi.fn();
    const state = makeState();
    state.planModeActive = true;
    state.planModeText = "plan";
    const result = await handleExitPlanMode(
      { id: "t1", name: "exit_plan_mode" } as never,
      makePass() as never,
      [{ id: "t1", result: { success: false, error: "PERMISSION_DENIED" } }] as never,
      [] as never,
      makeContext({ emit }) as never,
      state as never,
    );
    expect(result).toEqual({ shouldContinueLoop: false });
    expect(state.planModeActive).toBe(true);
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.DONE, usage: {}, totalTime: expect.any(Number) });
  });

  it("takes a stored approval instead of asking again", async () => {
    fakes.pendingListUndelivered.mockResolvedValue([
      { id: "plan-1", args: { plan: "plan" }, decision: { decision: "allow" } },
    ]);
    fakes.pendingMarkDelivered.mockResolvedValue(true);
    const state = makeState();
    state.planModeActive = true;
    state.planModeText = "plan";
    const result = await handleExitPlanMode(
      { id: "t1", name: "exit_plan_mode" } as never,
      makePass() as never,
      [{ id: "t1", result: {} }] as never,
      [] as never,
      makeContext() as never,
      state as never,
    );
    expect(result).toEqual({ shouldContinueLoop: true });
    expect(fakes.pendingMarkDelivered).toHaveBeenCalledWith("plan-1");
    expect(fakes.pendingCreate).not.toHaveBeenCalled();
  });

  it("records the plan and waits for the live approval card", async () => {
    const state = makeState();
    state.planModeActive = true;
    state.planModeText = "plan";
    const pending = handleExitPlanMode(
      { id: "t1", name: "exit_plan_mode" } as never,
      makePass() as never,
      [{ id: "t1", result: {} }] as never,
      [] as never,
      makeContext() as never,
      state as never,
    );
    await vi.waitFor(() => expect(pendingApprovals.get("conv-1")).toBeDefined());
    const approval = pendingApprovals.get("conv-1");
    approval!.resolve(true as never);
    expect(await pending).toEqual({ shouldContinueLoop: true });
    expect(fakes.pendingCreate).toHaveBeenCalled();
  });

  it("enters plan mode when the model calls enter_plan_mode", async () => {
    const emit = vi.fn();
    const state = makeState();
    const messages: Any[] = [];
    await checkForPlanModeEntry([{ name: "enter_plan_mode" }] as never, messages as never, state as never, emit);
    expect(state.planModeActive).toBe(true);
    expect(state.planModeText).toBe("");
    expect(fakes.injectPlanningInstruction).toHaveBeenCalledWith(messages, undefined);
    expect(emit).toHaveBeenCalledWith({ type: SERVER_SENT_EVENT_TYPES.STATUS, message: STATUS_MESSAGES.PLAN_MODE_ENTERED });
  });

  it("leaves plan mode untouched for ordinary tool calls", async () => {
    const state = makeState();
    await checkForPlanModeEntry([{ name: "read_file" }] as never, [] as never, state as never, vi.fn());
    expect(state.planModeActive).toBe(false);
    expect(fakes.injectPlanningInstruction).not.toHaveBeenCalled();
  });

  const planHarness = (passes: Any[]) => {
    let index = 0;
    const context = makeContext();
    const state = makeState();
    const tools = { finalTools: [{ name: "exit_plan_mode" }, { name: "read_file" }] };
    const harness: Any = {
      context,
      state,
      tools,
      createPassState: vi.fn(() => passes[index++] ?? makePass()),
      registerTrackerRequest: vi.fn(),
      createProviderStream: vi.fn(async () => streamOf([])),
      consumeStream: vi.fn(async () => {}),
      logIteration: vi.fn(),
      emitGenerationProgress: vi.fn(),
      emitUsageUpdate: vi.fn(),
    };
    return { harness, context, state };
  };

  it("approves the plan when the planning pass calls exit_plan_mode", async () => {
    const { harness, state } = planHarness([
      makePass({ streamedText: "my plan", pendingToolCalls: [{ id: "t1", name: "exit_plan_mode", args: {} }] }),
    ]);
    state.planModeActive = true;
    harness.context.options = { autoApprove: true };
    const result = await runPlanningPhase(harness as never, [] as never, "TreeOfThoughts");
    expect(result).toEqual({ planApproved: true });
    expect(harness.logIteration).toHaveBeenCalled();
  });

  it("rejects the plan when the approval gate says no", async () => {
    const { harness, state } = planHarness([
      makePass({ pendingToolCalls: [{ id: "t1", name: "exit_plan_mode", args: {} }] }),
    ]);
    state.planModeActive = true;
    harness.context.options = { unattended: true };
    const result = await runPlanningPhase(harness as never, [] as never, "GraphOfThoughts");
    expect(result).toEqual({ planApproved: false });
  });

  it("blocks unauthorized planning tool calls and retries", async () => {
    const { harness } = planHarness([
      makePass({ streamedText: "sneaky", pendingToolCalls: [{ id: "t1", name: "read_file", args: {} }] }),
      makePass({ pendingToolCalls: [{ id: "t2", name: "exit_plan_mode", args: {} }] }),
    ]);
    harness.context.options = { autoApprove: true };
    const messages: Any[] = [];
    const result = await runPlanningPhase(harness as never, messages as never, "TreeOfThoughts");
    expect(result).toEqual({ planApproved: true });
    expect(messages).toContainEqual({ role: "system", content: "locale:harness.planningMode.blocked" });
  });

  it("rejects the plan on an empty planning pass", async () => {
    const { harness } = planHarness([makePass()]);
    const result = await runPlanningPhase(harness as never, [] as never, "TreeOfThoughts");
    expect(result).toEqual({ planApproved: false });
  });

  it("rejects the plan when the run is aborted", async () => {
    const { harness } = planHarness([]);
    harness.context.signal = { aborted: true };
    const result = await runPlanningPhase(harness as never, [] as never, "TreeOfThoughts");
    expect(result).toEqual({ planApproved: false });
    expect(harness.createPassState).not.toHaveBeenCalled();
  });
});

