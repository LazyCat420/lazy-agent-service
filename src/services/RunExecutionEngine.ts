import { CreateRunRequest, RunResult, RunEvent, StructuredError } from "../types/run.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { ProfileRegistry } from "./ProfileRegistry.ts";
import { randomUUID } from "crypto";
import logger from "../utils/logger.ts";
import { getProvider } from "../providers/index.ts";

export class RunExecutionEngine {
  private static idempotencyCache: Map<string, RunResult> = new Map();
  private static activeRuns: Map<string, AbortController> = new Map();

  static cancelRun(runId: string): boolean {
    const controller = this.activeRuns.get(runId);
    if (controller) {
      controller.abort();
      this.activeRuns.delete(runId);
      return true;
    }
    return false;
  }

  static clearIdempotencyCache(): void {
    this.idempotencyCache.clear();
  }

  static reset(): void {
    this.idempotencyCache.clear();
    this.activeRuns.clear();
  }

  static async startRun(
    runId: string,
    request: CreateRunRequest,
    emitEvent: (event: Omit<RunEvent, 'id' | 'timestamp'>) => void
  ): Promise<RunResult> {
    // 1. Idempotency Check
    if (request.idempotencyKey && this.idempotencyCache.has(request.idempotencyKey)) {
      const cached = this.idempotencyCache.get(request.idempotencyKey)!;
      emitEvent({ runId: cached.id, type: 'run.completed', data: cached });
      return cached;
    }

    emitEvent({ runId, type: 'run.started', data: { status: 'in_progress' } });
    
    // 2. Cancellation / Abort Registration
    const abortController = new AbortController();
    this.activeRuns.set(runId, abortController);
    if (request.signal) {
      request.signal.addEventListener("abort", () => {
        abortController.abort();
      });
    }

    if (request.signal?.aborted || abortController.signal.aborted) {
      emitEvent({ runId, type: 'run.cancelled', data: { reason: "Run cancelled before execution" } });
      this.activeRuns.delete(runId);
      return {
        id: runId,
        status: 'cancelled',
        messages: [],
        error: {
          code: "RUN_CANCELLED",
          message: "Execution was cancelled",
          retryable: false,
        }
      };
    }

    try {
      const profile = await ProfileRegistry.loadProfile(request.profileId);
      if (!profile) {
        throw new Error(`Profile ${request.profileId} not found`);
      }

      // Convert CreateRunRequest into options
      const options: any = {
        model: request.model || profile.defaultModel,
        enabledTools: [...profile.baseTools, ...(request.tools?.map(t => t.name) || [])],
        systemPrompt: profile.systemPrompt,
        agenticLoopEnabled: true,
        functionCallingEnabled: true,
        maxIterations: request.budget?.maxToolCalls || 10,
      };

      const messages = Array.isArray(request.input) ? request.input : [{ role: 'user', content: request.input }];
      
      let provider: any = {};
      try {
        provider = getProvider("vllm-shim") || {};
      } catch {
        provider = {};
      }

      const context: any = {
        options,
        messages,
        providerName: "vllm-shim", // Simplified for contract testing
        resolvedModel: options.model,
        provider,
        conversationId: runId,
        project: "default",
        username: "run-engine",
        clientIp: "127.0.0.1",
        signal: abortController.signal,
      };

      // Call the existing AgenticLoopService
      const result = await AgenticLoopService.runAgenticLoop(context);
      
      const finalResult: RunResult = {
        id: runId,
        status: 'completed',
        messages: result.messages || [],
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          toolCalls: 0
        }
      };

      if (request.idempotencyKey) {
        this.idempotencyCache.set(request.idempotencyKey, finalResult);
      }

      emitEvent({ runId, type: 'run.completed', data: finalResult });
      return finalResult;
      
    } catch (err: any) {
      if (abortController.signal.aborted) {
        const cancelPayload: StructuredError = {
          code: "RUN_CANCELLED",
          message: "Execution cancelled by client",
          retryable: false,
        };
        emitEvent({ runId, type: 'run.cancelled', data: { error: cancelPayload } });
        return {
          id: runId,
          status: 'cancelled',
          messages: [],
          error: cancelPayload,
        };
      }

      logger.error(`Run ${runId} failed:`, err);
      const errorPayload: StructuredError = {
        code: "RUN_FAILED",
        message: err.message || "Unknown error",
        retryable: false
      };
      
      emitEvent({ runId, type: 'run.failed', data: { error: errorPayload } });
      
      return {
        id: runId,
        status: 'failed',
        messages: [],
        error: errorPayload
      };
    } finally {
      this.activeRuns.delete(runId);
    }
  }
}
