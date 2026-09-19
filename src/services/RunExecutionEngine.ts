import type {
  CreateRunRequest,
  RunResult,
  RunEvent,
  StructuredError,
  RunUsage,
  EvidenceRecord,
  RunRecord,
} from "../types/run.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { ProfileRegistry } from "./ProfileRegistry.ts";
import { RunStore } from "./RunStore.ts";
import logger from "../utils/logger.ts";
import { getProvider } from "../providers/index.ts";
import { ContextAssembly } from "../platform/context/ContextAssembly.ts";
import { HarnessInstrumenter } from "../platform/trace/HarnessInstrumenter.ts";
import { RunEvidenceStore } from "../platform/verify/RunEvidenceStore.ts";

export class RunExecutionEngine {
  private static activeRuns: Map<
    string,
    { abortController: AbortController; deadlineTimer?: NodeJS.Timeout }
  > = new Map();

  static async cancelRun(runId: string): Promise<boolean> {
    const active = this.activeRuns.get(runId);
    if (active) {
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
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
      if (active.deadlineTimer) clearTimeout(active.deadlineTimer);
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
    const idempotencyKey = request.idempotency_key || request.idempotencyKey;

    // 1. Idempotency Check & Atomic Key Reservation
    if (idempotencyKey) {
      const reservation = await RunStore.reserveIdempotencyKey(idempotencyKey, runId);
      if (!reservation.success) {
        if (reservation.cachedResult) {
          const cached = reservation.cachedResult;
          emitEvent({
            run_id: cached.run_id,
            runId: cached.run_id,
            type: "run.completed",
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
          const conflictResult: RunResult = {
            run_id: runId,
            id: runId,
            status: "failed",
            messages: [],
            error: conflictError,
          };
          emitEvent({
            run_id: runId,
            runId,
            type: "run.failed",
            data: { error: conflictError },
          });
          return conflictResult;
        }
      }
    }

    // 1.5 Contract Version Validation
    const requestedContractVersion = request.contract_version || request.contractVersion;
    if (requestedContractVersion) {
      const match = /^(\d+)\./.exec(requestedContractVersion);
      if (!match || match[1] !== "1") {
        const versionErr: StructuredError = {
          code: "CONTRACT_VERSION_MISMATCH",
          message: `Incompatible contract version '${requestedContractVersion}'. Supported major versions: 1.x.x`,
          retryable: false,
          category: "CLIENT",
        };
        emitEvent({ run_id: runId, runId, type: "run.failed", data: { error: versionErr } });
        return { run_id: runId, id: runId, status: "failed", messages: [], error: versionErr };
      }
    }

    // 2. Profile Lookup & Overrides Validation
    const profileId = request.profile_id || request.profileId;
    if (!profileId) {
      const err: StructuredError = {
        code: "INVALID_RUN_REQUEST",
        message: "Missing profile_id in run request",
        retryable: false,
        category: "CLIENT",
      };
      emitEvent({ run_id: runId, runId, type: "run.failed", data: { error: err } });
      return { run_id: runId, id: runId, status: "failed", messages: [], error: err };
    }

    const profile = await ProfileRegistry.loadProfile(profileId, request.profile_version);
    if (!profile) {
      const err: StructuredError = {
        code: "PROFILE_NOT_FOUND",
        message: `Profile ${profileId} not found`,
        retryable: false,
        category: "CLIENT",
      };
      emitEvent({ run_id: runId, runId, type: "run.failed", data: { error: err } });
      return { run_id: runId, id: runId, status: "failed", messages: [], error: err };
    }

    try {
      ProfileRegistry.validateOverrides(profile, request.runtime_overrides);
    } catch (overrideErr: any) {
      const err: StructuredError = {
        code: "INVALID_RUN_REQUEST",
        message: overrideErr.message,
        retryable: false,
        category: "CLIENT",
      };
      emitEvent({ run_id: runId, runId, type: "run.failed", data: { error: err } });
      return { run_id: runId, id: runId, status: "failed", messages: [], error: err };
    }

    // 3. Admission in RunStore & Emit run.admitted
    const nowIso = new Date().toISOString();
    const initialRecord: RunRecord = {
      run_id: runId,
      status: "admitted",
      profile_id: profile.profile_id,
      profile_version: profile.version,
      created_at: nowIso,
      current_turn: 0,
      idempotency_key: idempotencyKey,
      input: request.input,
      messages: [],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
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

    // 4. Cancellation & Deadline Setup
    const abortController = new AbortController();
    let isDeadlineTimeout = false;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const deadlineMs =
      request.deadline_ms ||
      request.budget?.max_duration_ms ||
      request.budget?.maxDurationMs ||
      profile.budget_limits.max_duration_ms;

    if (deadlineMs && deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        isDeadlineTimeout = true;
        abortController.abort(new Error("DEADLINE_EXCEEDED"));
      }, deadlineMs);
    }

    this.activeRuns.set(runId, { abortController, deadlineTimer });

    if (request.signal) {
      request.signal.addEventListener("abort", () => {
        abortController.abort();
      });
    }

    if (request.signal?.aborted || abortController.signal.aborted) {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.activeRuns.delete(runId);
      const cancelPayload: StructuredError = {
        code: "RUN_CANCELLED",
        message: "Run cancelled before execution",
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

    // 5. State Transition to RUNNING
    await RunStore.updateState(runId, "running", { started_at: new Date().toISOString() });
    emitEvent({ run_id: runId, runId, type: "run.started", data: { status: "running" } });

    const startTime = Date.now();

    try {
      // 6. Context Assembly Integration
      const assembly = new ContextAssembly();
      const userTask =
        typeof request.input === "string"
          ? request.input
          : Array.isArray(request.input)
            ? request.input.map((m) => `${m.role}: ${m.content}`).join("\n")
            : JSON.stringify(request.input);

      const assembled = assembly.assemble({
        agentRole: profile.role,
        project: "default",
        roleRules: profile.system_prompt,
        outputContract: "Adhere to structured tool results and verifiable claims.",
        toolProtocol: "Execute enabled tools according to whitelist policy.",
        selectedToolSchemas: profile.tool_policy.whitelist.map((name) => ({ name })),
        userTask,
      });

      // 7. Model & Provider Resolution
      const selectedModel =
        request.model ||
        request.runtime_overrides?.model ||
        profile.model_constraints.default_model;

      const preferredProvider =
        profile.model_constraints.allowed_providers[0] || "vllm-shim";
      let provider: any = {};
      try {
        provider = getProvider(preferredProvider) || {};
      } catch {
        try {
          provider = getProvider("vllm-shim") || {};
        } catch {
          provider = {};
        }
      }

      // 8. Trace & Evidence Setup
      HarnessInstrumenter.startRun({
        runId,
        traceId: idempotencyKey,
        project: "default",
        agentRole: profile.role,
        model: selectedModel,
      });

      const maxToolCalls =
        request.budget?.max_tool_calls ||
        request.budget?.maxToolCalls ||
        profile.budget_limits.max_tool_calls;

      const options: any = {
        model: selectedModel,
        enabledTools: [...profile.tool_policy.whitelist],
        systemPrompt: assembled.fullPrompt,
        agenticLoopEnabled: true,
        functionCallingEnabled: true,
        maxIterations: maxToolCalls,
      };

      const messages = Array.isArray(request.input)
        ? request.input
        : [{ role: "user", content: request.input }];

      const context: any = {
        options,
        messages,
        providerName: preferredProvider,
        resolvedModel: selectedModel,
        provider,
        conversationId: runId,
        project: "default",
        username: "run-engine",
        clientIp: "127.0.0.1",
        signal: abortController.signal,
      };

      // 9. Execute Agentic Loop Façade
      const result = await AgenticLoopService.runAgenticLoop(context);

      // 10. Seal Receipts, Evidence, and Usage
      const durationMs = Date.now() - startTime;
      const spans = RunEvidenceStore.getGlobalInstance().getSpans(runId);
      const evidenceRecords: EvidenceRecord[] = spans.map((s, idx) => ({
        evidence_id: s.span_id || `ev-${runId}-${idx}`,
        source: s.name || (s.attributes?.tool_name as string) || "runtime-span",
        provenance_hash: (s.attributes?.input_hash as string) || undefined,
        redacted: false,
      }));

      let promptTokens = 0;
      let completionTokens = 0;
      for (const s of spans) {
        promptTokens += s.attributes?.tokens_input || 0;
        completionTokens += s.attributes?.tokens_output || 0;
      }
      if (promptTokens === 0 && completionTokens === 0) {
        promptTokens = Math.max(1, Math.round(assembled.receipt.total_chars / 4));
        completionTokens = Math.max(
          1,
          Math.round(JSON.stringify(result.messages || []).length / 4),
        );
      }
      const toolCallsCount = spans.filter(
        (s) => s.kind === "tool_execution" || s.name.startsWith("tool:"),
      ).length;

      const usage: RunUsage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        tool_calls_count: toolCallsCount,
        retry_count: 0,
        duration_ms: durationMs,
        // Aliases
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        toolCalls: toolCallsCount,
      };

      const contextReceipt = {
        ...assembled.receipt,
        receipt_id: assembled.receipt.receipt_id.startsWith("sha256-")
          ? assembled.receipt.receipt_id
          : `sha256-${assembled.receipt.receipt_id}`,
      };

      const finalResult: RunResult = {
        run_id: runId,
        id: runId,
        status: "completed",
        profile_id: profile.profile_id,
        messages: result.messages || [],
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
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      if (abortController.signal.aborted) {
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

      emitEvent({
        run_id: runId,
        runId,
        type: "run.failed",
        data: { error: errorPayload },
      });

      return {
        run_id: runId,
        id: runId,
        status: "failed",
        messages: [],
        error: errorPayload,
      };
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.activeRuns.delete(runId);
    }
  }
}
