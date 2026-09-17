import crypto from "node:crypto";
import { Span } from "./Span.ts";
import { TraceContext } from "./TraceContext.ts";
import { TraceExporter } from "./TraceExporter.ts";
import type { AgentRunManifest, SpanData, SideEffectClass } from "../contracts/telemetry.ts";

export interface StartRunOptions {
  runId?: string;
  traceId?: string;
  parentRunId?: string | null;
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
    const runId = options.runId || `run_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const nowIso = new Date().toISOString();

    const rootSpan = new Span({
      trace_id: traceId,
      run_id: runId,
      name: `agent_run:${options.agentRole}`,
      kind: "agent_run",
      attributes: {
        project: options.project,
        environment: options.environment || "production",
        agent_role: options.agentRole,
        model: options.model,
      },
    });

    const runManifest: AgentRunManifest = {
      run_id: runId,
      trace_id: traceId,
      parent_run_id: options.parentRunId || null,
      project: options.project,
      agent_role: options.agentRole,
      environment: options.environment || "production",
      model: options.model,
      start_time: nowIso,
      status: "running",
      tool_call_count: 0,
      retry_count: 0,
    };

    const complete = (status: AgentRunManifest["status"], stopReason?: string) => {
      const finishedSpan = rootSpan.end(status === "completed" ? "OK" : "ERROR", stopReason);
      runManifest.end_time = new Date().toISOString();
      runManifest.status = status;
      runManifest.stop_reason = stopReason;
      if (finishedSpan.duration_ms) {
        runManifest.total_duration_ms = finishedSpan.duration_ms;
      }

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
    const traceId = parentSpan?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || "unassigned_run";
    const argsHash = this.hash(args);

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpan?.span_id || null,
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
    const traceId = parentSpan?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || "unassigned_run";
    const argsHash = this.hash(args);

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpan?.span_id || null,
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
   * Instruments model/LLM generation calls.
   */
  static async traceModelCall<T>(
    model: string,
    prompt: string,
    parentSpan: Span | undefined,
    callFn: () => Promise<T & { usage?: { prompt_tokens?: number; completion_tokens?: number } }>
  ): Promise<T> {
    const traceId = parentSpan?.trace_id || crypto.randomUUID().replaceAll("-", "").slice(0, 32);
    const runId = parentSpan?.run_id || "unassigned_run";

    const span = new Span({
      trace_id: traceId,
      parent_span_id: parentSpan?.span_id || null,
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
