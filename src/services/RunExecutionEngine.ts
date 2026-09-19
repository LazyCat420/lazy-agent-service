import { CreateRunRequest, RunResult, RunEvent, StructuredError } from "../types/run.ts";
import AgenticLoopService from "./AgenticLoopService.ts";
import { ProfileRegistry } from "./ProfileRegistry.ts";
import { randomUUID } from "crypto";
import logger from "../utils/logger.ts";
import { getProvider } from "../providers/index.ts";

export class RunExecutionEngine {
  static async startRun(
    runId: string,
    request: CreateRunRequest,
    emitEvent: (event: Omit<RunEvent, 'id' | 'timestamp'>) => void
  ): Promise<RunResult> {
    emitEvent({ runId, type: 'run.started', data: { status: 'in_progress' } });
    
    try {
      const profile = await ProfileRegistry.loadProfile(request.profileId);
      if (!profile) {
        throw new Error(`Profile ${request.profileId} not found`);
      }

      // Convert CreateRunRequest into the options AgenticLoopService expects
      const options: any = {
        model: request.model || profile.defaultModel,
        enabledTools: [...profile.baseTools, ...(request.tools?.map(t => t.name) || [])],
        systemPrompt: profile.systemPrompt,
        agenticLoopEnabled: true,
        functionCallingEnabled: true,
        maxIterations: request.budget?.maxToolCalls || 10,
      };

      const messages = Array.isArray(request.input) ? request.input : [{ role: 'user', content: request.input }];
      
      const context: any = {
        options,
        messages,
        providerName: "vllm-shim", // Simplified for contract testing
        resolvedModel: options.model,
        provider: getProvider("vllm-shim") || {},
        conversationId: runId,
        project: "default",
        username: "run-engine",
        clientIp: "127.0.0.1",
        signal: undefined,
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

      emitEvent({ runId, type: 'run.completed', data: finalResult });
      return finalResult;
      
    } catch (err: any) {
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
    }
  }
}
