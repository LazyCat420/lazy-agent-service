import crypto from "node:crypto";
import { Span } from "./Span.ts";
import { TraceContext } from "./TraceContext.ts";
import { TraceExporter } from "./TraceExporter.ts";
import { RunEvidenceStore } from "../verify/RunEvidenceStore.ts";
import type { AgentRunManifest, SpanData, SideEffectClass } from "../contracts/telemetry.ts";

export interface StartRunOptions {
  runId?: string;
  traceId?: string;
  conversationId?: string | null;
  parentRunId?: string | null;
  parentSpanId?: string | null;
  project: string;
  agentRole: string;
  environment?: string;
  model: string;
}

export class HarnessInstrumenter {
  private static hash(data: unknown): string {
    return crypto
      .createHash("sha256")
      .update(typeof data === "string" ? data : JSON.stringify(data ?? {}))
      .digest("hex");
  }

  /**
   * Starts an agent run, creating the root span and registering the active TraceContext.
   */
  static startRun(options: StartRunOptions): {
    runManifest: AgentRunManifest;
    rootSpan: Span;
    complete: (status: AgentRunManifest["status"], stopReason?: string) => void;
  } {
    const traceId = options.traceId || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    // Give each execution a unique run ID. Keep conversation IDs as separate correlation fields.
    const runId = options.runId || `run_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const nowIso = new Date().toISOString();

    const rootSpan = new Span({
      trace_id: traceId,
      parent_span_id: options.parentSpanId || null,
      run_id: runId,
      name: `agent_run:${options.agentRole}`,
      kind: "agent_run",
      attributes: {
        project: options.project,
        environment: options.environment || "production",
        agent_role: options.agentRole,
        model: options.model,
        ...(options.conversationId ? { conversation_id: options.conversationId } : {}),
      },
    });

    const runManifest: AgentRunManifest = {
      run_id: runId,
      trace_id: traceId,
      conversation_id: options.conversationId || null,
      parent_run_id: options.parentRunId || null,
      project: options.project,
      agent_role: options.agentRole,
      environment: options.environment || "production",
      model: options.model,
      start_time: nowIso,
      status: "running",
      tool_call_count: 0,
      retry_count: 0,
      total_tokens: 0,
    };

    const complete = (status: AgentRunManifest["status"], stopReason?: string) => {
      const isOk = status === "completed";
      const finishedSpan = rootSpan.end(isOk ? "OK" : "ERROR", stopReason);
      runManifest.end_time = new Date().toISOString();
      runManifest.status = status;
      runManifest.stop_reason = stopReason;
      if (finishedSpan.duration_ms) {
        runManifest.total_duration_ms = finishedSpan.duration_ms;
      }

      // Populate tool, retry, and token totals from measured execution data in RunEvidenceStore
      const spans = RunEvidenceStore.getGlobalInstance().getSpans(runId);
      let toolCallCount = 0;
      let retryCount = 0;
      let totalTokens = 0;
      let inputTokens = 0;
      let outputTokens = 0;

      for (const s of spans) {
        if (s.kind === "tool_execution") toolCallCount++;
        if (s.kind === "retry") retryCount++;
        if (typeof s.attributes.tokens_input === "number") inputTokens += s.attributes.tokens_input;
        if (typeof s.attributes.tokens_output === "number") outputTokens += s.attributes.tokens_output;
        if (typeof s.attributes.total_tokens === "number") totalTokens += s.attributes.total_tokens;
      }
      if (totalTokens === 0 && (inputTokens > 0 || outputTokens > 0)) {
        totalTokens = inputTokens + outputTokens;
      }

      runManifest.tool_call_count = toolCallCount;
      runManifest.retry_count = retryCount;
      runManifest.total_tokens = totalTokens;

      const exporter = TraceExporter.getGlobalInstance();
      exporter.enqueueSpan(finishedSpan);
      exporter.enqueueRun(runManifest);
    };

    return { runManifest, rootSpan, complete };
  }

  /**
   * Instruments a tool guard decision (ToolCallGuard chokepoint).
   */
  static async traceToolGuard<T>(
    toolName: string,
    args: unknown,
    parentSpan: Span | undefined,
    decisionFn: () => Promise<{ allowed: boolean; decision: string; reason?: string; result?: T }>
  ): Promise<{ allowed: boolean; decision: string; reason?: string; result?: T }> {
    const ctx = TraceContext.get();
    const traceId = parentSpan?.trace_id || ctx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || ctx?.run_id || "unassigned_run";
    const parentSpanId = parentSpan?.span_id || ctx?.currentSpan?.span_id || ctx?.parentSpanId || null;
    const argsHash = this.hash(args);

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      run_id: runId,
      name: `tool_guard:${toolName}`,
      kind: "tool_guard",
      attributes: {
        tool_name: toolName,
        input_hash: argsHash,
      },
    });

    try {
      const res = await decisionFn();
      span.setAttributes({
        guard_decision: res.decision,
        allowed: res.allowed,
        reason: res.reason,
      });
      span.end(res.allowed ? "OK" : "ERROR", res.reason);
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      return res;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.end("ERROR", errMsg);
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      throw err;
    }
  }

  /**
   * Instruments tool execution (LocalToolRouter chokepoint).
   */
  static async traceToolExecution<T>(
    toolName: string,
    args: unknown,
    parentSpan: Span | undefined,
    sideEffect: SideEffectClass,
    runFn: () => Promise<T>
  ): Promise<T> {
    const ctx = TraceContext.get();
    const traceId = parentSpan?.trace_id || ctx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || ctx?.run_id || "unassigned_run";
    const parentSpanId = parentSpan?.span_id || ctx?.currentSpan?.span_id || ctx?.parentSpanId || null;
    const argsHash = this.hash(args);

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      run_id: runId,
      name: `tool_exec:${toolName}`,
      kind: "tool_execution",
      attributes: {
        tool_name: toolName,
        input_hash: argsHash,
        side_effect: sideEffect,
      },
    });

    try {
      const result = await runFn();
      const resultHash = this.hash(result);
      span.setAttributes({
        result_hash: resultHash,
        status_code: 200,
      });
      span.end("OK");
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.setAttributes({
        error_fingerprint: this.hash(errMsg).slice(0, 16),
      });
      span.end("ERROR", errMsg);
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      throw err;
    }
  }

  /**
   * Starts a model call span before provider invocation so connection failures, setup errors,
   * and initial provider latency are recorded.
   */
  static startModelSpan(
    model: string,
    provider: string,
    parentSpan?: Span | undefined,
    prompt?: string
  ): {
    modelSpan: Span;
    complete: (options: {
      status: "OK" | "ERROR";
      errorMessage?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; totalTokens?: number };
    }) => SpanData;
  } {
    const ctx = TraceContext.get();
    const traceId = parentSpan?.trace_id || ctx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || ctx?.run_id || "unassigned_run";
    const parentSpanId = parentSpan?.span_id || ctx?.currentSpan?.span_id || ctx?.parentSpanId || null;

    const modelSpan = new Span({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      run_id: runId,
      name: `llm.generate:${model}`,
      kind: "model_call",
      attributes: {
        model,
        provider,
        ...(prompt ? { input_hash: this.hash(prompt) } : {}),
      },
    });

    const complete = (options: {
      status: "OK" | "ERROR";
      errorMessage?: string;
      usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; totalTokens?: number };
    }): SpanData => {
      if (options.usage) {
        modelSpan.setAttributes({
          tokens_input: options.usage.inputTokens,
          tokens_output: options.usage.outputTokens,
          tokens_cache: options.usage.cacheReadInputTokens,
          total_tokens: options.usage.totalTokens || ((options.usage.inputTokens || 0) + (options.usage.outputTokens || 0)),
        });
      }
      modelSpan.end(options.status, options.errorMessage);
      TraceExporter.getGlobalInstance().enqueueSpan(modelSpan.toJSON());
      return modelSpan.toJSON();
    };

    return { modelSpan, complete };
  }

  /**
   * Traces an agent delegation and returns a join span emitter for when the child agent returns.
   */
  static traceDelegation(
    agentRole: string,
    model: string,
    subAgentRunId: string,
    parentSpan?: Span | undefined
  ): {
    delegateSpan: Span;
    complete: (status: "OK" | "ERROR", errorMessage?: string) => SpanData;
    emitJoinSpan: (status: "OK" | "ERROR", durationMs?: number) => SpanData;
  } {
    const ctx = TraceContext.get();
    const traceId = parentSpan?.trace_id || ctx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || ctx?.run_id || "unassigned_run";
    const parentSpanId = parentSpan?.span_id || ctx?.currentSpan?.span_id || ctx?.parentSpanId || null;

    const delegateSpan = new Span({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      run_id: runId,
      name: `agent.delegate:${agentRole}`,
      kind: "delegation",
      attributes: {
        agent_role: agentRole,
        model,
        subagent_run_id: subAgentRunId,
      },
    });

    const complete = (status: "OK" | "ERROR", errorMessage?: string): SpanData => {
      delegateSpan.end(status, errorMessage);
      TraceExporter.getGlobalInstance().enqueueSpan(delegateSpan.toJSON());
      return delegateSpan.toJSON();
    };

    const emitJoinSpan = (status: "OK" | "ERROR", durationMs?: number): SpanData => {
      const joinSpan = new Span({
        trace_id: traceId,
        parent_span_id: delegateSpan.span_id,
        run_id: runId,
        name: `agent.delegate_join:${agentRole}`,
        kind: "delegation_join",
        attributes: {
          agent_role: agentRole,
          delegation_span_id: delegateSpan.span_id,
          subagent_run_id: subAgentRunId,
          ...(durationMs !== undefined ? { delegation_duration_ms: durationMs } : {}),
        },
      });
      joinSpan.end(status);
      TraceExporter.getGlobalInstance().enqueueSpan(joinSpan.toJSON());
      return joinSpan.toJSON();
    };

    return { delegateSpan, complete, emitJoinSpan };
  }

  /**
   * Instruments model/LLM generation calls (legacy helper).
   */
  static async traceModelCall<T>(
    model: string,
    prompt: string,
    parentSpan: Span | undefined,
    callFn: () => Promise<T & { usage?: { prompt_tokens?: number; completion_tokens?: number } }>
  ): Promise<T> {
    const ctx = TraceContext.get();
    const traceId = parentSpan?.trace_id || ctx?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || ctx?.run_id || "unassigned_run";
    const parentSpanId = parentSpan?.span_id || ctx?.currentSpan?.span_id || ctx?.parentSpanId || null;

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpanId,
      run_id: runId,
      name: `model_call:${model}`,
      kind: "model_call",
      attributes: {
        model,
        input_hash: this.hash(prompt),
      },
    });

    try {
      const res = await callFn();
      if (res && res.usage) {
        span.setAttributes({
          tokens_input: res.usage.prompt_tokens,
          tokens_output: res.usage.completion_tokens,
          total_tokens: (res.usage.prompt_tokens || 0) + (res.usage.completion_tokens || 0),
        });
      }
      span.end("OK");
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      return res;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      span.end("ERROR", errMsg);
      TraceExporter.getGlobalInstance().enqueueSpan(span.toJSON());
      throw err;
    }
  }
}
