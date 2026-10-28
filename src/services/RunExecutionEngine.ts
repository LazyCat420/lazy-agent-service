import type {
  CreateRunRequest,
  RunResult,
  RunEvent,
  StructuredError,
  RunUsage,
  EvidenceRecord,
  RunRecord,
} from "../types/run.ts";
import crypto from "node:crypto";
import { z } from "zod";
import { normalizeRunRequest } from "./RunAdmission.ts";
import { RuntimeExtensions } from "./RuntimeExtensions.ts";
import { RunApprovals } from "./RunApprovals.ts";
import { CanonicalProviderBudget } from "./CanonicalProviderBudget.ts";
import { LocalToolContinuation } from "./LocalToolContinuation.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { runCoreLoopForRun } from "../core/loop/RunsAdapter.ts";
import { ProfileRegistry } from "./ProfileRegistry.ts";
import { CapabilityRegistry } from "./CapabilityRegistry.ts";
import { GlobalCapabilityExecutor } from "./GlobalCapabilityExecutor.ts";
import { RunStore } from "./RunStore.ts";
import ConversationService from "./conversation/index.ts";
import logger from "../utils/logger.ts";
import { getProvider } from "../providers/index.ts";
import { ContextAssembly } from "../platform/context/ContextAssembly.ts";
import { HarnessInstrumenter } from "../platform/trace/HarnessInstrumenter.ts";
import { RunEvidenceStore } from "../platform/verify/RunEvidenceStore.ts";
import { DynamicModelResolver } from "./DynamicModelResolver.ts";
import AgentHooks from "./AgentHooks.ts";
import { decideProfileToolCall, type ProfileToolCall } from "./ProfileAuthorization.ts";
import { deniedToolResult, type ToolAuthorization } from "./ToolAuthorization.ts";
import { normalizeEmptyToolContent } from "./ToolResult.ts";
import { captureWriteSyntaxGuard, enforceWriteSyntaxGuard } from "./WriteSyntaxGuard.ts";
import { applyObservation, createSessionState, sessionStateHash } from "./SessionState.ts";
import type { ToolCall } from "./harnesses/types.ts";

/** The reason a beforeToolCall decide hook gave for its denial. */
function hookDenialReason(verdict: Record<string, unknown>): string {
  if (typeof verdict.reason === "string" && verdict.reason) return verdict.reason;
  if (typeof verdict.message === "string" && verdict.message) return verdict.message;
  return "denied by a beforeToolCall hook";
}

/**
 * The structured error a /v1/runs authorization denial reports: the code and
 * message of the call's DeniedToolResult, so a profile run speaks the same
 * vocabulary as every other path. Only a deny has one.
 */
function authorizationError(toolName: string, decision: ToolAuthorization): StructuredError {
  if (decision.verdict !== "deny") {
    throw new Error(`Tool call "${toolName}" left unanswered by profile authorization (${decision.verdict})`);
  }
  const denied = deniedToolResult(toolName, decision);
  return { code: denied.error, message: denied.message, category: "POLICY", retryable: false };
}

export class RunExecutionEngine {
  private static activeRuns: Map<
    string,
    { abortController: AbortController; deadlineTimer?: NodeJS.Timeout; softDeadlineTimer?: NodeJS.Timeout; steering: string[] }
  > = new Map();

  static steerRun(runId: string, instruction: string): boolean {
    const run = this.activeRuns.get(runId);
    if (!run || run.abortController.signal.aborted || run.steering.length >= 8 || !instruction.trim() || instruction.length > 4096) return false;
    run.steering.push(instruction); return true;
  }

  static async cancelRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (active) {
      clearTimeout(active.deadlineTimer);
      clearTimeout(active.softDeadlineTimer);
      active.abortController.abort();
      this.activeRuns.delete(runId);
      try {
        await RunStore.updateState(runId, "cancelled");
      } catch {
        // Ignore if already transitioned
      }
      return true;
    }
    const run = await RunStore.getRun(runId);
    if (
      run &&
      run.status !== "completed" &&
      run.status !== "failed" &&
      run.status !== "cancelled" &&
      run.status !== "timed_out"
    ) {
      await RunStore.updateState(runId, "cancelled");
      return true;
    }
    return false;
  }

  static reset(): void {
    for (const active of this.activeRuns.values()) {
      clearTimeout(active.deadlineTimer);
      clearTimeout(active.softDeadlineTimer);
      active.abortController.abort();
    }
    this.activeRuns.clear();
    RunStore.clearAll();
  }

  static async startRun(
    runId: string,
    request: CreateRunRequest,
    emitEvent: (event: Omit<RunEvent, "id" | "timestamp">) => void,
  ): Promise<RunResult> {
    try {
      request = normalizeRunRequest(request);
    } catch (error: any) {
      const err: StructuredError = {
        code: "INVALID_RUN_REQUEST",
        message: error.message,
        retryable: false,
        category: "CLIENT",
      };
      emitEvent({ run_id: runId, type: "run.failed", data: { error: err } });
      return { run_id: runId, status: "failed", messages: [], error: err };
    }

    const identity = resolveRunIdentity(request);
    const idempotencyKey = buildRunIdempotencyKey(request, identity);

    const requestedContractVersion = request.contract_version || request.contractVersion;
    const contractCheck = validateRunContractVersion(runId, requestedContractVersion, emitEvent);
    if (contractCheck) return contractCheck;

    const profileOutcome = await loadAndValidateRunProfile(runId, request, emitEvent);
    if ("failedResult" in profileOutcome) return profileOutcome.failedResult;
    const { profile } = profileOutcome;

    if (idempotencyKey) {
      const idempotencyResult = await reserveRunIdempotencyOrReturn(runId, idempotencyKey, emitEvent);
      if (idempotencyResult) return idempotencyResult;
    }

    await createAndAdmitRunRecord(runId, identity, request, profile, idempotencyKey, emitEvent);

    const deadlineState = setupRunDeadlinesAndAbort(runId, request, profile, emitEvent);
    const {
      abortController,
      finalizeController,
      deadlineTimer,
      softDeadlineTimer,
      deadlineMs,
      finalReserveMs,
      steering,
    } = deadlineState;
    this.activeRuns.set(runId, { abortController, deadlineTimer, softDeadlineTimer, steering });

    if (request.signal?.aborted || abortController.signal.aborted) {
      clearTimeout(deadlineTimer);
      clearTimeout(softDeadlineTimer);
      this.activeRuns.delete(runId);
      return handlePreExecutionAbort(
        runId,
        deadlineState.isDeadlineTimeout(),
        idempotencyKey,
        emitEvent,
      );
    }

    await RunStore.updateState(runId, "running", { started_at: new Date().toISOString() });
    emitEvent({ run_id: runId, runId, type: "run.started", data: { status: "running" } });

    const startTime = Date.now();
    const accounting = new CanonicalProviderBudget(
      request.budget?.max_tokens ?? profile.budget_limits.max_tokens,
      abortController.signal,
      profile.model_constraints.max_output_tokens,
    );
    const tracker = { actualToolCalls: 0, partialText: "" };

    try {
      return await executeAdmittedRunBody({
        runId,
        request,
        profile,
        identity,
        idempotencyKey,
        requestedContractVersion,
        deadlineState,
        finalizeController,
        deadlineMs,
        finalReserveMs,
        steering,
        startTime,
        accounting,
        tracker,
        emitEvent,
      });
    } catch (err: any) {
      return await handleRunExecutionCatch({
        runId,
        err,
        startTime,
        deadlineMs,
        isDeadlineTimeout: deadlineState.isDeadlineTimeout(),
        abortSignal: abortController.signal,
        accounting,
        actualToolCalls: tracker.actualToolCalls,
        partialText: tracker.partialText,
        emitEvent,
      });
    } finally {
      await finalizeRunIdempotencyAndTimers(
        runId,
        idempotencyKey,
        deadlineTimer,
        softDeadlineTimer,
        this.activeRuns,
      );
    }
  }

  /**
   * Process a tool call according to the Dev 1 contract:
   * - Policy denial if tool is not whitelisted by the profile.
   * - Global capability (execution: "shared"): authorized and executed in runtime, emitting tool.completed.
   * - Local application tool (execution: "local"): admitted with required_scope (app_id, session_id) and authorization_receipt,
   *   emitting tool.invoked without executing local code in runtime container.
   */
  static async processToolCall(
    runId: string,
    toolCall: {
      tool_call_id?: string;
      id?: string | null;
      tool_name?: string;
      name?: string;
      arguments?: Record<string, unknown>;
      args?: Record<string, unknown>;
    },
    context: {
      profile_id: string;
      profile_version?: string;
      approval_id?: string;
      signal?: AbortSignal;
      app_id?: string;
      session_id?: string;
      /** Set when an approved plan exists (plan permission mode). */
      planApproved?: boolean;
    },
    emitEvent?: (event: RunEvent) => void,
  ): Promise<{
    status: "admitted_local" | "executed_shared" | "denied";
    event: RunEvent;
    result?: unknown;
    error?: StructuredError;
  }> {
    const { toolName, toolCallId, toolArgs } = normalizeProcessToolCallInput(toolCall);

    const profile = await ProfileRegistry.loadProfile(context.profile_id, context.profile_version);
    if (!profile) {
      const err: StructuredError = {
        code: "PROFILE_NOT_FOUND",
        message: `Profile '${context.profile_id}' not found`,
        category: "CLIENT",
        retryable: false,
      };
      return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_err_${Date.now()}`, emitEvent);
    }

    const appPrefix = toolName.split(".")[0];
    const appId = context.app_id || appPrefix.replace(/_/g, "-");
    const sessionId = context.session_id || "";
    const approved = await RunApprovals.permits(
      runId,
      context.approval_id,
      { id: toolCallId, name: toolName, args: toolArgs },
      appId,
      sessionId,
    );
    const decision = decideProfileToolCall({
      profile,
      name: toolName,
      args: toolArgs,
      planApproved: !!context.planApproved,
      unattended: true,
      answer: approved ? { decision: "allow" } : null,
    });
    if (decision.verdict !== "allow") {
      const err = authorizationError(toolName, decision);
      return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_denied_${Date.now()}`, emitEvent);
    }

    if (toolName.startsWith("global.")) {
      return executeSharedGlobalCapability(runId, toolCallId, toolName, toolArgs, context.signal, emitEvent);
    }

    return admitLocalApplicationTool({
      runId,
      toolCallId,
      toolName,
      toolArgs,
      appPrefix,
      appId,
      sessionId,
      profile,
      context,
      emitEvent,
    });
  }
}

type RunEventEmitter = (event: Omit<RunEvent, "id" | "timestamp">) => void;
type LoadedProfile = NonNullable<Awaited<ReturnType<typeof ProfileRegistry.loadProfile>>>;

function resolveRunIdentity(request: CreateRunRequest): { project: string; username: string } {
  if (request.identity) return request.identity;
  return { project: request.app_id || "default", username: "internal" };
}

function buildRunIdempotencyKey(
  request: CreateRunRequest,
  identity: { project: string; username: string },
): string | undefined {
  const key = request.idempotency_key;
  if (!key) return undefined;
  return JSON.stringify([identity.project, identity.username, request.app_id, request.session_id, key]);
}

function emitFailedRunWithId(
  runId: string,
  err: StructuredError,
  emitEvent: RunEventEmitter,
): RunResult {
  emitEvent({ run_id: runId, runId, type: "run.failed", data: { error: err } });
  return { run_id: runId, id: runId, status: "failed", messages: [], error: err };
}

function validateRunContractVersion(
  runId: string,
  requestedContractVersion: string | undefined,
  emitEvent: RunEventEmitter,
): RunResult | null {
  if (!requestedContractVersion) return null;
  if (["1.0.0", "1.1.0", "1.2.0"].includes(requestedContractVersion)) return null;
  const versionErr: StructuredError = {
    code: "CONTRACT_VERSION_MISMATCH",
    message: `Incompatible contract version '${requestedContractVersion}'. Supported major versions: 1.x.x`,
    retryable: false,
    category: "CLIENT",
  };
  return emitFailedRunWithId(runId, versionErr, emitEvent);
}

async function loadAndValidateRunProfile(
  runId: string,
  request: CreateRunRequest,
  emitEvent: RunEventEmitter,
): Promise<{ profile: LoadedProfile } | { failedResult: RunResult }> {
  const profileId = request.profile_id || request.profileId;
  if (!profileId) {
    const err: StructuredError = {
      code: "INVALID_RUN_REQUEST",
      message: "Missing profile_id in run request",
      retryable: false,
      category: "CLIENT",
    };
    return { failedResult: emitFailedRunWithId(runId, err, emitEvent) };
  }

  const profile = await ProfileRegistry.loadProfile(profileId, request.profile_version);
  if (!profile) {
    const err: StructuredError = {
      code: "PROFILE_NOT_FOUND",
      message: `Profile ${profileId} not found`,
      retryable: false,
      category: "CLIENT",
    };
    return { failedResult: emitFailedRunWithId(runId, err, emitEvent) };
  }

  await DynamicModelResolver.queryLiveHosts();

  try {
    ProfileRegistry.validateOverrides(profile, request.runtime_overrides);
  } catch (overrideErr: any) {
    const err: StructuredError = {
      code: "INVALID_RUN_REQUEST",
      message: overrideErr.message,
      retryable: false,
      category: "CLIENT",
    };
    return { failedResult: emitFailedRunWithId(runId, err, emitEvent) };
  }
  return { profile };
}

function cachedStatusToEventType(status: string): "run.completed" | "run.cancelled" | "run.failed" {
  if (status === "completed") return "run.completed";
  if (status === "cancelled") return "run.cancelled";
  return "run.failed";
}

async function reserveRunIdempotencyOrReturn(
  runId: string,
  idempotencyKey: string,
  emitEvent: RunEventEmitter,
): Promise<RunResult | null> {
  const reservation = await RunStore.reserveIdempotencyKey(idempotencyKey, runId);
  if (reservation.success) return null;
  if (reservation.cachedResult) {
    const cached = reservation.cachedResult;
    emitEvent({
      run_id: cached.run_id,
      runId: cached.run_id,
      type: cachedStatusToEventType(cached.status),
      data: cached,
    });
    return cached;
  }
  if (reservation.conflict) {
    const conflictError: StructuredError = {
      code: "IDEMPOTENCY_CONFLICT",
      message: `Concurrent run active under idempotency key '${idempotencyKey}'`,
      retryable: true,
      category: "CLIENT",
      details: { existing_run_id: reservation.existingRunId },
    };
    return emitFailedRunWithId(runId, conflictError, emitEvent);
  }
  return null;
}

async function createAndAdmitRunRecord(
  runId: string,
  identity: { project: string; username: string },
  request: CreateRunRequest,
  profile: LoadedProfile,
  idempotencyKey: string | undefined,
  emitEvent: RunEventEmitter,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const initialRecord: RunRecord = {
    run_id: runId,
    identity,
    session_id: request.session_id,
    status: "admitted",
    profile_id: profile.profile_id,
    profile_version: profile.version,
    created_at: nowIso,
    current_turn: 0,
    idempotency_key: idempotencyKey,
    input: request.input,
    messages: [],
    usage: {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      tool_calls_count: 0,
      retry_count: 0,
      duration_ms: 0,
    },
    evidence_records: [],
  };
  await RunStore.createRun(initialRecord);

  emitEvent({
    run_id: runId,
    runId,
    type: "run.admitted",
    data: {
      run_id: runId,
      profile_id: profile.profile_id,
      version: profile.version,
      status: "admitted",
    },
  });
}

function setupRunDeadlinesAndAbort(
  runId: string,
  request: CreateRunRequest,
  profile: LoadedProfile,
  emitEvent: RunEventEmitter,
) {
  const abortController = new AbortController();
  const finalizeController = new AbortController();
  let deadlineTimedOut = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let softDeadlineTimer: NodeJS.Timeout | undefined;
  let finalizeRequest: { reason: string } | undefined;
  let runContextRef: { finalizeRequested?: { reason: string } } | undefined;

  const deadlineMs =
    request.deadline_ms ??
    request.budget?.max_duration_ms ??
    request.budget?.maxDurationMs ??
    profile.budget_limits.max_duration_ms;

  if (deadlineMs >= 0) {
    deadlineTimer = setTimeout(() => {
      deadlineTimedOut = true;
      abortController.abort(new Error("DEADLINE_EXCEEDED"));
    }, deadlineMs);
  }

  const finalReserveMs = deadlineMs > 0 ? Math.min(90000, Math.floor(deadlineMs * 0.3)) : 0;
  const softMs = deadlineMs > 0 ? deadlineMs - finalReserveMs : 0;
  if (softMs > 0) {
    softDeadlineTimer = setTimeout(() => {
      if (finalizeRequest) return;
      finalizeRequest = { reason: "DEADLINE_SOFT" };
      if (runContextRef) runContextRef.finalizeRequested = finalizeRequest;
      finalizeController.abort(new Error("DEADLINE_SOFT"));
      emitEvent({
        run_id: runId,
        runId,
        type: "run.warning",
        data: {
          code: "DEADLINE_SOFT",
          message: "Soft deadline reached; the run will answer now with the information already gathered.",
        },
      });
    }, softMs);
  }

  if (request.signal) {
    request.signal.addEventListener("abort", () => {
      abortController.abort();
    });
  }
  if (deadlineMs === 0) {
    deadlineTimedOut = true;
    abortController.abort();
  }

  return {
    abortController,
    finalizeController,
    deadlineTimer,
    softDeadlineTimer,
    deadlineMs,
    finalReserveMs,
    steering: [] as string[],
    isDeadlineTimeout: () => deadlineTimedOut,
    getFinalizeRequest: () => finalizeRequest,
    bindRunContext: (ctx: { finalizeRequested?: { reason: string } }) => {
      runContextRef = ctx;
      if (finalizeRequest) ctx.finalizeRequested = finalizeRequest;
    },
  };
}

async function handlePreExecutionAbort(
  runId: string,
  isDeadlineTimeout: boolean,
  idempotencyKey: string | undefined,
  emitEvent: RunEventEmitter,
): Promise<RunResult> {
  const status = isDeadlineTimeout ? "timed_out" : "cancelled";
  const cancelPayload: StructuredError = {
    code: isDeadlineTimeout ? "DEADLINE_EXCEEDED" : "RUN_CANCELLED",
    message: isDeadlineTimeout
      ? "Run deadline exhausted before execution"
      : "Run cancelled before execution",
    retryable: false,
    category: "CLIENT",
  };
  await RunStore.updateState(runId, status, {
    error: cancelPayload,
    completed_at: new Date().toISOString(),
  });
  emitEvent({
    run_id: runId,
    runId,
    type: isDeadlineTimeout ? "run.failed" : "run.cancelled",
    data: { error: cancelPayload },
  });
  const cancelled: RunResult = {
    run_id: runId,
    id: runId,
    status,
    messages: [],
    error: cancelPayload,
  };
  if (idempotencyKey) {
    await RunStore.completeIdempotency(idempotencyKey, cancelled);
  }
  return cancelled;
}

function validateWorkerTaskEnvelope(workerId: string, taskId: string, result: any): void {
  const isValidStatus = Boolean(
    result &&
      result.taskId === taskId &&
      ["success", "error", "cancelled"].includes(result.status),
  );
  if (!isValidStatus) {
    throw Object.assign(new Error(`Worker '${workerId}' returned an invalid task result`), {
      code: "WORKER_RESULT_INVALID",
    });
  }
}

function validateWorkerUsageAndBudget(
  workerId: string,
  result: any,
  perWorkerTokens: number,
): void {
  const usage = result.usage;
  const usageValues = usage
    ? [usage.promptTokens, usage.completionTokens, usage.totalTokens, usage.durationMs]
    : null;
  const allNonNegInts = Boolean(
    usageValues && usageValues.every((value) => Number.isInteger(value) && value >= 0),
  );
  if (!allNonNegInts) {
    throw Object.assign(new Error(`Worker '${workerId}' returned invalid usage`), {
      code: "WORKER_RESULT_INVALID",
    });
  }
  const sumMatches = usage.totalTokens === usage.promptTokens + usage.completionTokens;
  if (!sumMatches || usage.totalTokens > perWorkerTokens) {
    throw Object.assign(
      new Error(`Worker '${workerId}' exceeded its allocated token budget`),
      { code: "WORKER_BUDGET_EXHAUSTED" },
    );
  }
}

function validateWorkerEvidenceRefs(workerId: string, evidenceRefs: unknown): void {
  const isInvalid =
    !Array.isArray(evidenceRefs) ||
    evidenceRefs.length > 32 ||
    evidenceRefs.some((ref) => typeof ref !== "string" || ref.length > 2048);
  if (isInvalid) {
    throw Object.assign(
      new Error(`Worker '${workerId}' returned invalid evidence references`),
      { code: "WORKER_RESULT_INVALID" },
    );
  }
}

async function runSingleWorkerTask(params: {
  runId: string;
  worker: ReturnType<typeof RuntimeExtensions.workers>[number];
  request: CreateRunRequest;
  perWorkerTokens: number;
  deadlineMs: number;
  startTime: number;
  abortSignal: AbortSignal;
  accounting: CanonicalProviderBudget;
  workerEvidence: EvidenceRecord[];
  contributedContext: string[];
  emitEvent: RunEventEmitter;
}): Promise<void> {
  const {
    runId,
    worker,
    request,
    perWorkerTokens,
    deadlineMs,
    startTime,
    abortSignal,
    accounting,
    workerEvidence,
    contributedContext,
    emitEvent,
  } = params;
  const taskId = `worker-${worker.id}-${crypto.randomUUID()}`;
  const remainingMs = Math.max(1, deadlineMs - (Date.now() - startTime));
  emitEvent({
    run_id: runId,
    type: "worker.dispatched",
    data: { worker_id: worker.id, task_id: taskId },
  });
  const result = await worker.execute(
    {
      workerId: worker.id,
      taskId,
      parameters: { input: structuredClone(request.input) },
      allocatedBudget: { maxTokens: perWorkerTokens, maxDurationMs: remainingMs },
    },
    {
      parentRunId: runId,
      traceId: runId,
      parentSpanId: runId,
      signal: abortSignal,
      emitEvent: (type, data) => emitEvent({ run_id: runId, type: type as any, data }),
    },
  );
  abortSignal.throwIfAborted();
  validateWorkerTaskEnvelope(worker.id, taskId, result);
  validateWorkerUsageAndBudget(worker.id, result, perWorkerTokens);
  validateWorkerEvidenceRefs(worker.id, result.evidenceRefs);

  const workerContext = JSON.stringify({
    worker_id: worker.id,
    task_id: taskId,
    status: result.status,
    output: result.output,
    evidence_refs: result.evidenceRefs,
    error: result.error,
  });
  if (Buffer.byteLength(workerContext, "utf8") > 32 * 1024) {
    throw Object.assign(
      new Error(`Worker '${worker.id}' output exceeded the context limit`),
      { code: "WORKER_RESULT_INVALID" },
    );
  }
  accounting.chargeExternalUsage(result.usage.promptTokens, result.usage.completionTokens);
  workerEvidence.push(
    ...result.evidenceRefs.map((ref: string, index: number) => ({
      evidence_id: `worker-${worker.id}-${index}-${crypto.createHash("sha256").update(ref).digest("hex").slice(0, 16)}`,
      source: `worker:${worker.id}`,
      provenance_hash: `sha256-${crypto.createHash("sha256").update(ref).digest("hex")}`,
      redacted: false,
    })),
  );
  contributedContext.push(workerContext);
  emitEvent({
    run_id: runId,
    type: "worker.completed",
    data: {
      worker_id: worker.id,
      task_id: taskId,
      status: result.status,
      usage: result.usage,
      evidence_refs: result.evidenceRefs,
      error: result.error,
    },
  });
}

async function executeRunWorkers(params: {
  runId: string;
  request: CreateRunRequest;
  profile: LoadedProfile;
  deadlineMs: number;
  startTime: number;
  abortSignal: AbortSignal;
  accounting: CanonicalProviderBudget;
  contributedContext: string[];
  emitEvent: RunEventEmitter;
}): Promise<EvidenceRecord[]> {
  const { profile, accounting } = params;
  const workers = RuntimeExtensions.workers(profile);
  const workerEvidence: EvidenceRecord[] = [];
  if (workers.length === 0) return workerEvidence;

  const concurrency = Math.max(
    1,
    Math.min(workers.length, profile.budget_limits.max_concurrent_workers ?? 1),
  );
  const perWorkerTokens = Math.max(1, Math.floor(accounting.limit / (workers.length + 1)));
  let nextWorker = 0;
  const executeWorkerLane = async () => {
    while (nextWorker < workers.length) {
      const worker = workers[nextWorker++];
      await runSingleWorkerTask({
        ...params,
        worker,
        perWorkerTokens,
        workerEvidence,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => executeWorkerLane()));
  return workerEvidence;
}

function isObjectTypeParameterBlock(parameters: unknown): boolean {
  if (!parameters || typeof parameters !== "object") return false;
  return "type" in parameters && (parameters as { type?: unknown }).type === "object";
}

function isValidSuppliedLocalSchemaObject(s: unknown): s is {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
} {
  if (!s || typeof s !== "object") return false;
  const candidate = s as Record<string, unknown>;
  if (typeof candidate.name !== "string" || typeof candidate.description !== "string") {
    return false;
  }
  return isObjectTypeParameterBlock(candidate.parameters);
}

function formatRunUserTask(input: CreateRunRequest["input"]): string {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((m) => `${m.role}: ${m.content}`).join("\n");
  }
  return JSON.stringify(input);
}

function assembleRunSystemContext(
  request: CreateRunRequest,
  profile: LoadedProfile,
  identity: { project: string; username: string },
  contributedContext: string[],
) {
  const assembly = new ContextAssembly();
  const userTask = formatRunUserTask(request.input);
  const promptSuppliedSchemas: unknown = request.runtime_overrides?.local_tool_schemas;
  const suppliedList = Array.isArray(promptSuppliedSchemas) ? promptSuppliedSchemas : [];
  const promptCallableLocalNames = new Set(
    suppliedList.filter(isValidSuppliedLocalSchemaObject).map((s) => s.name),
  );
  const callableToolSchemas = profile.tool_policy.whitelist
    .filter((name: string) => name.startsWith("global.") || promptCallableLocalNames.has(name))
    .map((name: string) => ({ name }));

  return assembly.assemble({
    agentRole: profile.role,
    project: identity.project,
    roleRules: profile.system_prompt,
    artifactExcerpts: contributedContext,
    outputContract: "Adhere to structured tool results and verifiable claims.",
    toolProtocol: "Execute enabled tools according to whitelist policy.",
    selectedToolSchemas: callableToolSchemas,
    userTask,
  });
}

function resolveRunModelAndProvider(request: CreateRunRequest, profile: LoadedProfile) {
  const requestedModel = request.model || request.runtime_overrides?.model;
  const requestedProvider = request.runtime_overrides?.provider
    ? String(request.runtime_overrides.provider)
    : undefined;

  const dynamicResolution = DynamicModelResolver.resolveProviderAndModel(
    profile.role,
    profile.model_constraints.allowed_providers,
    requestedModel || profile.model_constraints.default_model,
    requestedProvider,
  );

  const selectedModel =
    requestedModel || dynamicResolution.model || profile.model_constraints.default_model;

  const preferredProvider =
    requestedProvider ||
    dynamicResolution.provider ||
    profile.model_constraints.provider_by_model?.[selectedModel] ||
    profile.model_constraints.allowed_providers[0] ||
    "vllm-shim";

  let provider: any = {};
  try {
    provider = getProvider(preferredProvider) || {};
  } catch {
    provider = {};
  }
  return { selectedModel, preferredProvider, provider };
}

function resolveRunMaxToolCalls(request: CreateRunRequest, profile: LoadedProfile): number {
  return (
    request.budget?.max_tool_calls ??
    request.budget?.maxToolCalls ??
    profile.budget_limits.max_tool_calls
  );
}

function resolveRunMaxTokens(request: CreateRunRequest, profile: LoadedProfile): number {
  return (
    request.budget?.max_tokens ??
    request.budget?.maxTokens ??
    profile.budget_limits.max_tokens
  );
}

function resolveRunReasoningEffort(
  request: CreateRunRequest,
  profile: LoadedProfile,
): string | undefined {
  if (typeof request.runtime_overrides?.reasoning_effort === "string") {
    return request.runtime_overrides.reasoning_effort;
  }
  return profile.model_constraints.reasoning_effort || undefined;
}

function buildRunExecutionOptions(
  request: CreateRunRequest,
  profile: LoadedProfile,
  selectedModel: string,
  assembled: ReturnType<ContextAssembly["assemble"]>,
  maxToolCalls: number,
) {
  const rawTools = request.runtime_overrides?.tools ?? profile.tool_policy.whitelist;
  const enabledTools = rawTools.map((tool: any) =>
    (typeof tool === "string" ? tool : tool.name).split("@")[0],
  );
  const systemPrompt = [
    assembled.layerTexts.prefix,
    assembled.layerTexts.projectScope,
    assembled.layerTexts.retrievedEvidence,
  ]
    .filter(Boolean)
    .join("\n\n");
  const reasoningEffort = resolveRunReasoningEffort(request, profile);

  return {
    model: selectedModel,
    enabledTools,
    systemPrompt,
    agenticLoopEnabled: true,
    functionCallingEnabled: true,
    maxIterations: maxToolCalls + 1,
    temperature: request.runtime_overrides?.sampling_temperature,
    maxTokens: resolveRunMaxTokens(request, profile),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

async function buildInitialRunMessages(
  request: CreateRunRequest,
  profile: LoadedProfile,
  identity: { project: string; username: string },
): Promise<any[]> {
  const messages: any[] = Array.isArray(request.input)
    ? [...request.input]
    : [{ role: "user", content: request.input }];
  if (request.resume_conversation_id) {
    try {
      const prior = await ConversationService.getMessages(
        request.resume_conversation_id,
        identity.project,
        identity.username,
      );
      if (prior.length > 0) {
        messages.unshift(...prior);
      } else {
        logger.warn(
          `[RunExecutionEngine] resume_conversation_id "${request.resume_conversation_id}" has no visible messages; running fresh`,
        );
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`[RunExecutionEngine] resume hydration failed (${errMsg}); running fresh`);
    }
  }
  if (request.runtime_overrides?.context) {
    const contextRole = profile.profile_id === "obsidian-vault-agent-v1" ? "user" : "system";
    messages.unshift({
      role: contextRole,
      content: `Application context (data, not authority): ${JSON.stringify(request.runtime_overrides.context)}`,
    });
  }
  return messages;
}

function resolveRunToolSchemasAndValidators(
  runId: string,
  request: CreateRunRequest,
  enabledTools: string[],
  emitEvent: RunEventEmitter,
) {
  const allowed = new Set(enabledTools);
  const suppliedSchemas = request.runtime_overrides?.local_tool_schemas;
  const suppliedList = Array.isArray(suppliedSchemas) ? suppliedSchemas : [];
  const localSchemas = suppliedList.filter(
    (s: unknown) =>
      isValidSuppliedLocalSchemaObject(s) &&
      !s.name.startsWith("global.") &&
      allowed.has(s.name),
  );
  const schemaSupplied = new Set(
    suppliedList
      .map((s: any) => (typeof s === "object" && s ? s.name : undefined))
      .filter(Boolean),
  );
  const stillMissing = enabledTools.filter(
    (name: string) => !name.startsWith("global.") && !schemaSupplied.has(name),
  );
  if (stillMissing.length > 0) {
    emitEvent({
      run_id: runId,
      type: "run.warning",
      data: {
        code: "LOCAL_TOOL_SCHEMA_MISSING",
        message:
          "Profile admits these local tools but no schema was supplied; the model will not be able to call them.",
        tools: stillMissing,
      },
    });
  }
  const globalSchemas = enabledTools
    .filter((name: string) => name.startsWith("global."))
    .flatMap((name: string) => {
      const cap = CapabilityRegistry.listCapabilities().find((c) => c.id === name);
      return cap ? [{ name, description: cap.description, parameters: cap.parameters }] : [];
    });
  const finalTools = [...localSchemas, ...globalSchemas];
  const toolValidators = new Map<string, z.ZodType>();
  for (const schema of finalTools) {
    try {
      toolValidators.set(schema.name, z.fromJSONSchema(schema.parameters));
    } catch {
      throw Object.assign(new Error(`Unsupported tool schema: ${schema.name}`), {
        code: "TOOL_SCHEMA_UNSUPPORTED",
      });
    }
  }
  return {
    runtimeTools: { finalTools, resolvedEnabledTools: enabledTools },
    toolValidators,
  };
}

function createRunContextEmitter(
  runId: string,
  tracker: { partialText: string },
  emitEvent: RunEventEmitter,
) {
  return (event: any) => {
    if (event.type === "chunk") {
      const delta = event.content || event.text || "";
      tracker.partialText += delta;
      emitEvent({ run_id: runId, type: "message.delta", data: { delta } });
    } else if (event.type === "run.warning") {
      emitEvent({ run_id: runId, runId, type: "run.warning", data: event.data ?? event });
    }
  };
}

function checkAdmittedToolBudgetAndSchema(
  tracker: { actualToolCalls: number },
  maxToolCalls: number,
  toolValidators: Map<string, z.ZodType>,
  call: ToolCall & { arguments?: Record<string, unknown> },
): { observation: unknown; dispatched: boolean } | null {
  if (++tracker.actualToolCalls > maxToolCalls) {
    if (maxToolCalls === 0) {
      throw Object.assign(new Error("Tool call budget exhausted"), {
        code: "TOOL_BUDGET_EXHAUSTED",
      });
    }
    return {
      observation: {
        error: "TOOL_BUDGET_EXHAUSTED",
        message: `Tool call budget reached (${maxToolCalls} tool calls). You must now synthesize and deliver your final comprehensive answer using the information already gathered without calling any further tools.`,
      },
      dispatched: false,
    };
  }
  const validator = toolValidators.get(call.name);
  if (!validator || !validator.safeParse(call.args || {}).success) {
    throw Object.assign(new Error("Tool arguments do not match the admitted schema"), {
      code: "TOOL_ARGUMENTS_INVALID",
    });
  }
  return null;
}

async function evaluateAdmittedToolDecision(
  profile: LoadedProfile,
  planApproved: boolean,
  hooks: AgentHooks,
  context: any,
  call: ToolCall & { arguments?: Record<string, unknown> },
) {
  const authorization: ProfileToolCall = {
    profile,
    name: call.name,
    args: call.args || {},
    planApproved,
    unattended: false,
  };
  let decision = decideProfileToolCall(authorization);
  if (decision.verdict !== "deny") {
    const hookVerdict = await hooks.run("beforeToolCall", structuredClone(call), context);
    if (hookVerdict && hookVerdict.isApproved === false) {
      decision = decideProfileToolCall({
        ...authorization,
        hookDenial: hookDenialReason(hookVerdict),
      });
    }
  }
  return { authorization, decision };
}

async function awaitRunToolApprovalIfNeeded(params: {
  runId: string;
  decision: ToolAuthorization;
  authorization: ProfileToolCall;
  call: ToolCall & { arguments?: Record<string, unknown> };
  scopeAppId: string | undefined;
  scopeSessionId: string | undefined;
  abortSignal: AbortSignal;
  emitEvent: RunEventEmitter;
}): Promise<
  | { approved: true; approvalId: string | undefined }
  | { approved: false; rejectedResult: { observation: unknown; dispatched: boolean } }
> {
  const {
    runId,
    decision,
    authorization,
    call,
    scopeAppId,
    scopeSessionId,
    abortSignal,
    emitEvent,
  } = params;
  if (decision.verdict !== "ask") {
    return { approved: true, approvalId: undefined };
  }
  const approvalAppId = scopeAppId || call.name.split(".")[0].replace(/_/g, "-");
  const approval = await RunApprovals.wait(
    runId,
    call,
    approvalAppId,
    scopeSessionId || "",
    abortSignal,
    emitEvent,
  );
  if (approval.approved === true) {
    return { approved: true, approvalId: approval.id };
  }
  const unanswered = decideProfileToolCall(
    approval.approved === false
      ? { ...authorization, answer: { decision: "deny" } }
      : { ...authorization, unattended: true },
  );
  const denied = authorizationError(call.name, unanswered);
  emitEvent({
    run_id: runId,
    type: "tool.failed",
    data: { tool_call_id: call.id, tool_name: call.name, error: denied },
  });
  return {
    approved: false,
    rejectedResult: {
      observation: { error: denied.code, message: denied.message, retryable: false },
      dispatched: false,
    },
  };
}

async function handleLocalToolContinuationResult(params: {
  runId: string;
  processedEvent: RunEvent;
  call: ToolCall & { arguments?: Record<string, unknown> };
  extensions: ReturnType<typeof RuntimeExtensions.resolve>;
  hooks: AgentHooks;
  context: any;
  abortSignal: AbortSignal;
  emitEvent: RunEventEmitter;
}): Promise<{ observation: unknown; dispatched: boolean }> {
  const { runId, processedEvent, call, extensions, hooks, context, abortSignal, emitEvent } = params;
  const observation = await LocalToolContinuation.wait(
    runId,
    processedEvent,
    abortSignal,
    () => emitEvent(processedEvent),
  );
  const failed = Boolean(
    observation && typeof observation === "object" && (observation as any).is_error,
  );
  emitEvent({
    run_id: runId,
    type: failed ? "tool.failed" : "tool.completed",
    data: {
      tool_call_id: processedEvent.data.tool_call_id,
      ...(failed
        ? {
            error: {
              code: "TOOL_EXECUTION_FAILED",
              message: "Local tool returned a recoverable error",
              details: observation,
            },
          }
        : { result: observation }),
    },
  });
  for (const extension of extensions) {
    await extension.afterTool?.(call, observation);
  }
  await hooks.run("afterToolCall", call, observation, context);
  return { observation: normalizeEmptyToolContent(observation), dispatched: true };
}

async function finalizeProcessedRunToolCall(params: {
  runId: string;
  processed: Awaited<ReturnType<typeof RunExecutionEngine.processToolCall>>;
  call: ToolCall & { arguments?: Record<string, unknown> };
  extensions: ReturnType<typeof RuntimeExtensions.resolve>;
  hooks: AgentHooks;
  context: any;
  abortSignal: AbortSignal;
  emitEvent: RunEventEmitter;
}): Promise<{ observation: unknown; dispatched: boolean }> {
  const { runId, processed, call, extensions, hooks, context, abortSignal, emitEvent } = params;
  if (processed.status !== "admitted_local") {
    emitEvent(processed.event);
  }
  if (processed.status === "denied") {
    return {
      observation: {
        error: processed.error?.code || "TOOL_DENIED",
        message: processed.error?.message || "Tool denied",
        retryable: false,
      },
      dispatched: false,
    };
  }
  if (processed.status === "admitted_local") {
    return handleLocalToolContinuationResult({
      runId,
      processedEvent: processed.event,
      call,
      extensions,
      hooks,
      context,
      abortSignal,
      emitEvent,
    });
  }
  for (const extension of extensions) {
    await extension.afterTool?.(call, processed.result);
  }
  await hooks.run("afterToolCall", call, processed.result, context);
  return { observation: normalizeEmptyToolContent(processed.result), dispatched: true };
}

async function executeAdmittedRunTool(params: {
  runId: string;
  request: CreateRunRequest;
  profile: LoadedProfile;
  planApproved: boolean;
  maxToolCalls: number;
  tracker: { actualToolCalls: number };
  toolValidators: Map<string, z.ZodType>;
  extensions: ReturnType<typeof RuntimeExtensions.resolve>;
  hooks: AgentHooks;
  context: any;
  requestContext: Record<string, string>;
  abortSignal: AbortSignal;
  emitEvent: RunEventEmitter;
  call: ToolCall & { arguments?: Record<string, unknown> };
  toolSignal?: AbortSignal;
}): Promise<{ observation: unknown; dispatched: boolean }> {
  const {
    runId,
    request,
    profile,
    planApproved,
    maxToolCalls,
    tracker,
    toolValidators,
    extensions,
    hooks,
    context,
    requestContext,
    abortSignal,
    emitEvent,
    call,
    toolSignal,
  } = params;
  abortSignal.throwIfAborted();
  const budgetOrSchemaResult = checkAdmittedToolBudgetAndSchema(
    tracker,
    maxToolCalls,
    toolValidators,
    call,
  );
  if (budgetOrSchemaResult) return budgetOrSchemaResult;

  const { authorization, decision } = await evaluateAdmittedToolDecision(
    profile,
    planApproved,
    hooks,
    context,
    call,
  );
  if (decision.verdict === "deny" && decision.deniedBy === "hook") {
    return { observation: deniedToolResult(call.name, decision), dispatched: false };
  }
  for (const extension of extensions) {
    await extension.beforeTool?.(structuredClone(call));
  }
  const scopeAppId = request.app_id ?? request.appId ?? requestContext.app_id;
  const scopeSessionId = request.session_id ?? request.sessionId ?? requestContext.session_id;
  const approvalOutcome = await awaitRunToolApprovalIfNeeded({
    runId,
    decision,
    authorization,
    call,
    scopeAppId,
    scopeSessionId,
    abortSignal,
    emitEvent,
  });
  if (!approvalOutcome.approved) {
    return (approvalOutcome as { approved: false; rejectedResult: { observation: unknown; dispatched: boolean } }).rejectedResult;
  }

  const combinedSignal = toolSignal ? AbortSignal.any([abortSignal, toolSignal]) : abortSignal;
  const processed = await RunExecutionEngine.processToolCall(runId, call, {
    approval_id: approvalOutcome.approvalId,
    signal: combinedSignal,
    profile_id: profile.profile_id,
    profile_version: profile.version,
    app_id: scopeAppId,
    session_id: scopeSessionId,
    planApproved,
  });
  return finalizeProcessedRunToolCall({
    runId,
    processed,
    call,
    extensions,
    hooks,
    context,
    abortSignal,
    emitEvent,
  });
}

function hasAssistantAnswerAfterInitial(resultMessages: any[] | undefined, initialMessages: any[]): boolean {
  if (!resultMessages) return false;
  return resultMessages.some(
    (m: any) =>
      !initialMessages.includes(m) &&
      m.role === "assistant" &&
      typeof m.content === "string" &&
      Boolean(m.content.trim()),
  );
}

async function sealAndCompleteRun(params: {
  runId: string;
  request: CreateRunRequest;
  profile: LoadedProfile;
  requestedContractVersion: string | undefined;
  idempotencyKey: string | undefined;
  startTime: number;
  actualToolCalls: number;
  accounting: CanonicalProviderBudget;
  assembled: ReturnType<ContextAssembly["assemble"]>;
  context: any;
  workerEvidence: EvidenceRecord[];
  resultMessages: any[];
  emitEvent: RunEventEmitter;
}): Promise<RunResult> {
  const {
    runId,
    request,
    profile,
    requestedContractVersion,
    idempotencyKey,
    startTime,
    actualToolCalls,
    accounting,
    assembled,
    context,
    workerEvidence,
    resultMessages,
    emitEvent,
  } = params;
  const durationMs = Date.now() - startTime;
  const spans = RunEvidenceStore.getGlobalInstance().getSpans(runId);
  const evidenceRecords: EvidenceRecord[] = [
    ...workerEvidence,
    ...spans.map((s, idx) => ({
      evidence_id: s.span_id || `ev-${runId}-${idx}`,
      source: s.name || (s.attributes?.tool_name as string) || "runtime-span",
      provenance_hash: (s.attributes?.input_hash as string) || undefined,
      redacted: false,
    })),
  ];

  const usage: RunUsage = accounting.usage(actualToolCalls, durationMs);
  const rawReceiptId = assembled.receipt.receipt_id;
  const contractVersion = requestedContractVersion || "1.2.0";

  const contextReceipt = {
    ...assembled.receipt,
    input_delivery: "messages",
    input_hash: `sha256-${crypto.createHash("sha256").update(JSON.stringify(request.input)).digest("hex")}`,
    contract_version: contractVersion,
    profile_version: profile.version,
    session_state_hash: sessionStateHash(context.sessionState),
    receipt_id: rawReceiptId.startsWith("sha256-") ? rawReceiptId : `sha256-${rawReceiptId}`,
  };

  const finalResult: RunResult = {
    contract_version: contractVersion,
    run_id: runId,
    id: runId,
    status: "completed",
    profile_id: profile.profile_id,
    profile_version: profile.version,
    messages: resultMessages,
    usage,
    context_receipt: contextReceipt,
    evidence_records: evidenceRecords,
  };

  await RunStore.updateState(runId, "completed", {
    completed_at: new Date().toISOString(),
    messages: finalResult.messages,
    usage,
    context_receipt: contextReceipt,
    evidence_records: evidenceRecords,
  });

  if (idempotencyKey) {
    await RunStore.completeIdempotency(idempotencyKey, finalResult);
  }

  emitEvent({
    run_id: runId,
    runId,
    type: "run.completed",
    data: finalResult,
  });
  return finalResult;
}

async function executeAdmittedRunBody(params: {
  runId: string;
  request: CreateRunRequest;
  profile: LoadedProfile;
  identity: { project: string; username: string };
  idempotencyKey: string | undefined;
  requestedContractVersion: string | undefined;
  deadlineState: ReturnType<typeof setupRunDeadlinesAndAbort>;
  finalizeController: AbortController;
  deadlineMs: number;
  finalReserveMs: number;
  steering: string[];
  startTime: number;
  accounting: CanonicalProviderBudget;
  tracker: { actualToolCalls: number; partialText: string };
  emitEvent: RunEventEmitter;
}): Promise<RunResult> {
  const {
    runId,
    request,
    profile,
    identity,
    idempotencyKey,
    requestedContractVersion,
    deadlineState,
    finalizeController,
    deadlineMs,
    finalReserveMs,
    steering,
    startTime,
    accounting,
    tracker,
    emitEvent,
  } = params;
  const abortSignal = deadlineState.abortController.signal;
  const extensions = RuntimeExtensions.resolve(profile);
  const contributedContext = await Promise.all(
    extensions.filter((e) => e.context).map((e) => e.context!(request)),
  );
  const workerEvidence = await executeRunWorkers({
    runId,
    request,
    profile,
    deadlineMs,
    startTime,
    abortSignal,
    accounting,
    contributedContext,
    emitEvent,
  });
  abortSignal.throwIfAborted();

  const assembled = assembleRunSystemContext(request, profile, identity, contributedContext);
  const { selectedModel, preferredProvider, provider } = resolveRunModelAndProvider(request, profile);

  HarnessInstrumenter.startRun({
    runId,
    traceId: idempotencyKey,
    project: identity.project,
    agentRole: profile.role,
    model: selectedModel,
  });

  const maxToolCalls = resolveRunMaxToolCalls(request, profile);
  const options = buildRunExecutionOptions(request, profile, selectedModel, assembled, maxToolCalls);
  const messages = await buildInitialRunMessages(request, profile, identity);
  const { runtimeTools, toolValidators } = resolveRunToolSchemasAndValidators(
    runId,
    request,
    options.enabledTools,
    emitEvent,
  );

  const context: any = {
    options,
    runtimeSteering: steering,
    messages,
    providerName: preferredProvider,
    resolvedModel: selectedModel,
    provider: accounting.wrap(provider),
    conversationId: runId,
    agentConversationId: runId,
    runId,
    traceId: runId,
    project: identity.project,
    username: identity.username,
    clientIp: "127.0.0.1",
    signal: abortSignal,
    runtimeTools,
    finalizeSignal: finalizeController.signal,
    ...(finalReserveMs > 0 ? { finalPassTimeoutMs: Math.max(5000, finalReserveMs - 10000) } : {}),
    canonicalBudget: accounting,
    emit: createRunContextEmitter(runId, tracker, emitEvent),
    sessionState: createSessionState(new Date().toISOString()),
  };
  deadlineState.bindRunContext(context);

  const requestContext = (request.runtime_overrides?.context || {}) as Record<string, string>;
  const hooks = new AgentHooks();
  await hooks.run("sessionStart", context, { runId });
  const planApproved =
    Boolean(context.planApproved) || Boolean((request.runtime_overrides as any)?.planApproved);

  context.runtimeToolExecutor = async (
    call: ToolCall & { arguments?: Record<string, unknown> },
    toolSignal?: AbortSignal,
  ) => {
    const localPolicy = profile.local_tool_policy?.[call.name];
    const writeCapture = captureWriteSyntaxGuard(
      (call.args || call.arguments || {}) as Record<string, unknown>,
      localPolicy?.effect,
    );
    const { observation, dispatched } = await executeAdmittedRunTool({
      runId,
      request,
      profile,
      planApproved,
      maxToolCalls,
      tracker,
      toolValidators,
      extensions,
      hooks,
      context,
      requestContext,
      abortSignal,
      emitEvent,
      call,
      toolSignal,
    });
    const guarded = dispatched
      ? enforceWriteSyntaxGuard(writeCapture, observation)
      : observation;
    context.sessionState = applyObservation(context.sessionState, call.name, guarded);
    return guarded;
  };

  if (options.maxTokens === 0) {
    throw Object.assign(new Error("Token budget exhausted"), { code: "TOKEN_BUDGET_EXHAUSTED" });
  }

  const result =
    process.env.LAS_RUNS_LOOP === "legacy"
      ? await AgenticLoopService.runAgenticLoop(context)
      : await runCoreLoopForRun(context);
  abortSignal.throwIfAborted();
  if (!hasAssistantAnswerAfterInitial(result.messages, messages)) {
    throw Object.assign(new Error("Run ended without an assistant answer"), {
      code: "INCOMPLETE_RUN",
    });
  }

  for (const extension of extensions) {
    await extension.validate?.(result.messages);
  }
  abortSignal.throwIfAborted();

  const stopPayload = {
    runId,
    messages: result.messages || [],
    toolCalls: tracker.actualToolCalls,
  };
  await hooks.run("runStop", context, stopPayload);
  await hooks.run("sessionEnd", context, stopPayload);

  return sealAndCompleteRun({
    runId,
    request,
    profile,
    requestedContractVersion,
    idempotencyKey,
    startTime,
    actualToolCalls: tracker.actualToolCalls,
    accounting,
    assembled,
    context,
    workerEvidence,
    resultMessages: result.messages || [],
    emitEvent,
  });
}

async function handleAbortedRunCatch(
  runId: string,
  err: any,
  deadlineMs: number,
  isDeadlineTimeout: boolean,
  emitEvent: RunEventEmitter,
): Promise<RunResult> {
  if (isDeadlineTimeout || err.message?.includes("DEADLINE_EXCEEDED")) {
    const timeoutPayload: StructuredError = {
      code: "DEADLINE_EXCEEDED",
      message: `Run wall-clock duration exceeded deadline of ${deadlineMs}ms`,
      retryable: false,
      category: "RESOURCE",
    };
    await RunStore.updateState(runId, "timed_out", {
      error: timeoutPayload,
      completed_at: new Date().toISOString(),
    });
    emitEvent({
      run_id: runId,
      runId,
      type: "run.failed",
      data: { error: timeoutPayload },
    });
    return {
      run_id: runId,
      id: runId,
      status: "timed_out",
      messages: [],
      error: timeoutPayload,
    };
  }

  const cancelPayload: StructuredError = {
    code: "RUN_CANCELLED",
    message: "Execution cancelled by client",
    retryable: false,
    category: "CLIENT",
  };
  await RunStore.updateState(runId, "cancelled", {
    error: cancelPayload,
    completed_at: new Date().toISOString(),
  });
  emitEvent({
    run_id: runId,
    runId,
    type: "run.cancelled",
    data: { error: cancelPayload },
  });
  return {
    run_id: runId,
    id: runId,
    status: "cancelled",
    messages: [],
    error: cancelPayload,
  };
}

async function handleRunExecutionCatch(params: {
  runId: string;
  err: any;
  startTime: number;
  deadlineMs: number;
  isDeadlineTimeout: boolean;
  abortSignal: AbortSignal;
  accounting: CanonicalProviderBudget;
  actualToolCalls: number;
  partialText: string;
  emitEvent: RunEventEmitter;
}): Promise<RunResult> {
  const {
    runId,
    err,
    startTime,
    deadlineMs,
    isDeadlineTimeout,
    abortSignal,
    accounting,
    actualToolCalls,
    partialText,
    emitEvent,
  } = params;
  const durationMs = Date.now() - startTime;
  await RunStore.updateRun(runId, {
    usage: accounting.usage(actualToolCalls, durationMs),
    messages: partialText
      ? [{ role: "assistant", content: partialText, outcome: "incomplete" }]
      : [],
  });
  if (abortSignal.aborted) {
    return handleAbortedRunCatch(runId, err, deadlineMs, isDeadlineTimeout, emitEvent);
  }

  logger.error(`Run ${runId} failed:`, err);
  const errorPayload: StructuredError = {
    code: err.code || "RUN_FAILED",
    message: err.message || "Unknown error",
    retryable: false,
    category: err.category || "RUNTIME",
  };
  await RunStore.updateState(runId, "failed", {
    error: errorPayload,
    completed_at: new Date().toISOString(),
  });
  return emitFailedRunWithId(runId, errorPayload, emitEvent);
}

async function finalizeRunIdempotencyAndTimers(
  runId: string,
  idempotencyKey: string | undefined,
  deadlineTimer: NodeJS.Timeout | undefined,
  softDeadlineTimer: NodeJS.Timeout | undefined,
  activeRuns: Map<string, unknown>,
): Promise<void> {
  if (idempotencyKey) {
    const record = await RunStore.getRun(runId);
    if (record && ["completed", "failed", "cancelled", "timed_out"].includes(record.status)) {
      await RunStore.completeIdempotency(idempotencyKey, { ...record, id: runId });
    }
  }
  clearTimeout(deadlineTimer);
  clearTimeout(softDeadlineTimer);
  activeRuns.delete(runId);
}

function normalizeProcessToolCallInput(toolCall: {
  tool_call_id?: string;
  id?: string | null;
  tool_name?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  args?: Record<string, unknown>;
}) {
  return {
    toolName: toolCall.tool_name || toolCall.name || "",
    toolCallId: toolCall.tool_call_id || toolCall.id || `tc_${Date.now()}`,
    toolArgs: toolCall.arguments || toolCall.args || {},
  };
}

function emitDeniedToolProcessResult(
  runId: string,
  toolCallId: string,
  toolName: string,
  err: StructuredError,
  eventId: string,
  emitEvent?: (event: RunEvent) => void,
  timestamp: string = new Date().toISOString(),
): { status: "denied"; event: RunEvent; error: StructuredError } {
  const evt: RunEvent = {
    id: eventId,
    run_id: runId,
    type: "tool.failed",
    timestamp,
    data: { tool_call_id: toolCallId, tool_name: toolName, error: err },
  };
  if (emitEvent) emitEvent(evt);
  return { status: "denied", event: evt, error: err };
}

async function executeSharedGlobalCapability(
  runId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  signal: AbortSignal | undefined,
  emitEvent?: (event: RunEvent) => void,
): Promise<{
  status: "executed_shared" | "denied";
  event: RunEvent;
  result?: unknown;
  error?: StructuredError;
}> {
  const cap = CapabilityRegistry.getCapability(toolName);
  if (!cap) {
    const err: StructuredError = {
      code: "UNKNOWN_CAPABILITY",
      message: `Unknown global capability '${toolName}'`,
      category: "POLICY",
      retryable: false,
    };
    return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_unk_${Date.now()}`, emitEvent);
  }

  const execResult = await GlobalCapabilityExecutor.execute(toolName, toolArgs, signal);
  if (!execResult.success) {
    const err: StructuredError = {
      code: execResult.error?.code || "TOOL_EXECUTION_FAILED",
      message: execResult.error?.message || "Execution failed",
      category: "TOOL",
      retryable: false,
    };
    return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_fail_${Date.now()}`, emitEvent);
  }

  let evidenceRecords: EvidenceRecord[] = [];
  if (cap.supports_evidence) {
    const evidenceId = `ev_${runId}_${Date.now()}`;
    evidenceRecords = [
      {
        evidence_id: evidenceId,
        source: toolName,
        provenance_hash: `sha256-${crypto.createHash("sha256").update(JSON.stringify(execResult.result)).digest("hex")}`,
      },
    ];
    RunEvidenceStore.getGlobalInstance().record({
      trace_id: runId,
      span_id: evidenceId,
      run_id: runId,
      name: `capability:${toolName}`,
      kind: "tool_execution",
      status: "OK",
      start_time: new Date().toISOString(),
      attributes: { tool_name: toolName },
      events: [],
      links: [],
    });
  }

  const completedEvent: RunEvent = {
    id: `evt_comp_${Date.now()}`,
    run_id: runId,
    type: "tool.completed",
    timestamp: new Date().toISOString(),
    data: {
      tool_call_id: toolCallId,
      tool_name: toolName,
      execution: "shared",
      result: execResult.result,
      evidence_records: evidenceRecords,
    },
  };
  if (emitEvent) emitEvent(completedEvent);
  return { status: "executed_shared", event: completedEvent, result: execResult.result };
}

function admitLocalApplicationTool(params: {
  runId: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  appPrefix: string;
  appId: string;
  sessionId: string;
  profile: LoadedProfile;
  context: {
    profile_id: string;
    approval_id?: string;
    app_id?: string;
    session_id?: string;
  };
  emitEvent?: (event: RunEvent) => void;
}): {
  status: "admitted_local" | "denied";
  event: RunEvent;
  error?: StructuredError;
} {
  const {
    runId,
    toolCallId,
    toolName,
    toolArgs,
    appPrefix,
    appId,
    sessionId,
    profile,
    context,
    emitEvent,
  } = params;
  if (!context.session_id) {
    const err: StructuredError = {
      code: "SCOPE_VIOLATION",
      message: `Local tool '${toolName}' requires valid session_id`,
      category: "POLICY",
      retryable: false,
    };
    return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_nosess_${Date.now()}`, emitEvent);
  }

  if (context.app_id) {
    const normalizedCallerApp = context.app_id.replace(/-/g, "_");
    if (normalizedCallerApp !== appPrefix) {
      const err: StructuredError = {
        code: "SCOPE_VIOLATION",
        message: `Local tool '${toolName}' namespace does not match caller app_id '${context.app_id}'`,
        category: "POLICY",
        retryable: false,
      };
      return emitDeniedToolProcessResult(runId, toolCallId, toolName, err, `evt_badapp_${Date.now()}`, emitEvent);
    }
  }

  const receiptId = `auth_rec_${runId}_${crypto.randomUUID()}`;
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const profileId = context.profile_id || "";
  const effect = profile.local_tool_policy?.[toolName]?.effect;

  const secret = process.env.RUNTIME_AUTH_SECRET || process.env.INTERNAL_EXECUTE_TOKEN;
  if (!secret) {
    const error: StructuredError = {
      code: "AUTH_SIGNING_UNAVAILABLE",
      message: "Runtime receipt signing is not configured",
      category: "POLICY",
      retryable: false,
    };
    return emitDeniedToolProcessResult(
      runId,
      toolCallId,
      toolName,
      error,
      `evt_denied_${crypto.randomUUID()}`,
      emitEvent,
      issuedAt,
    );
  }

  const argumentsJson = JSON.stringify(toolArgs);
  const argumentsHash = crypto.createHash("sha256").update(argumentsJson).digest("hex");
  const sigPayload = `${runId}:${toolCallId}:${toolName}:${argumentsHash}:${appId}:${sessionId}:${profileId}:${receiptId}:${expiresAt}`;
  const signature = `hmac-sha256-${crypto.createHmac("sha256", secret).update(sigPayload).digest("hex")}`;

  const authorizationReceipt = {
    receipt_id: receiptId,
    arguments_json: argumentsJson,
    arguments_hash: argumentsHash,
    nonce: receiptId,
    run_id: runId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    canonical_tool_id: toolName,
    app_id: appId,
    session_id: sessionId,
    profile_id: profileId,
    execution: "local" as const,
    effect,
    approval_id: context.approval_id,
    issued_at: issuedAt,
    expires_at: expiresAt,
    signature,
  };

  const localInvokedEvent: RunEvent = {
    id: `evt_loc_${Date.now()}`,
    run_id: runId,
    type: "tool.invoked",
    timestamp: issuedAt,
    data: {
      tool_call_id: toolCallId,
      tool_name: toolName,
      execution: "local",
      effect,
      arguments: toolArgs,
      authorization_receipt: authorizationReceipt,
      required_scope: {
        app_id: appId,
        session_id: sessionId,
      },
    },
  };

  if (emitEvent) emitEvent(localInvokedEvent);
  return { status: "admitted_local", event: localInvokedEvent };
}
