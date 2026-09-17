import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { HarnessInstrumenter } from "../trace/HarnessInstrumenter.ts";
import { TraceContext } from "../trace/TraceContext.ts";
import { TraceExporter, sanitizeTelemetryPayload } from "../trace/TraceExporter.ts";
import { Span } from "../trace/Span.ts";
import { RunEvidenceStore } from "../verify/RunEvidenceStore.ts";
import { DeterministicVerifiers } from "../verify/DeterministicVerifiers.ts";
import { createSseEmitter } from "../../utils/SseUtilities.ts";
import type { SpanData } from "../contracts/telemetry.ts";

describe("Phase 1: Harness Trace Propagation, Redaction & Verifier Evidence", () => {
  beforeEach(() => {
    RunEvidenceStore.getGlobalInstance().clear();
    TraceExporter.getGlobalInstance().clear();
  });

  it("produces a fully connected trace across root run, model calls, tools, retries, and delegated agents", async () => {
    // 1. Root run
    const instrumenter = HarnessInstrumenter.startRun({
      project: "sun-test",
      agentRole: "lead_orchestrator",
      model: "local-glm",
    });

    const rootTraceId = instrumenter.runManifest.trace_id;
    const rootRunId = instrumenter.runManifest.run_id;

    await TraceContext.run(
      {
        trace_id: rootTraceId,
        run_id: rootRunId,
        currentSpan: instrumenter.rootSpan,
        current_span_id: instrumenter.rootSpan.span_id,
        conversation_id: "conv_123",
      },
      async () => {
        // 2. Model span before provider invocation
        const model = HarnessInstrumenter.startModelSpan("local-glm", "vllm", instrumenter.rootSpan);
        model.complete({
          status: "OK",
          usage: { inputTokens: 400, outputTokens: 150, totalTokens: 550 },
        });

        // 3. First tool execution
        await HarnessInstrumenter.traceToolExecution(
          "read_file",
          { path: "config.json" },
          instrumenter.rootSpan,
          "READ_ONLY",
          async () => ({ content: "{}" })
        );

        // 4. Second tool execution with a simulated failure and retry link
        const failureSpan = new Span({
          trace_id: rootTraceId,
          parent_span_id: instrumenter.rootSpan.span_id,
          run_id: rootRunId,
          name: "tool_exec:network_fetch",
          kind: "tool_execution",
          attributes: { tool_name: "network_fetch" },
        });
        failureSpan.end("ERROR", "Connection refused");
        TraceExporter.getGlobalInstance().enqueueSpan(failureSpan.toJSON());

        // Retry span linked to failure
        const retrySpan = new Span({
          trace_id: rootTraceId,
          parent_span_id: failureSpan.span_id,
          run_id: rootRunId,
          name: "workflow_retry:network_fetch",
          kind: "retry",
          attributes: {
            tool_name: "network_fetch",
            attempt: 1,
            failed_attempt: 1,
            failure_span_id: failureSpan.span_id,
          },
        });
        retrySpan.end("OK");
        TraceExporter.getGlobalInstance().enqueueSpan(retrySpan.toJSON());

        // 5. Delegated subagent workflow
        const subAgentRunId = `run_sub_${crypto.randomUUID().slice(0, 8)}`;
        const delegation = HarnessInstrumenter.traceDelegation(
          "researcher",
          "local-glm",
          subAgentRunId,
          instrumenter.rootSpan
        );

        // Child agent starts run under delegation span
        const subInstrumenter = HarnessInstrumenter.startRun({
          traceId: rootTraceId,
          runId: subAgentRunId,
          parentRunId: rootRunId,
          parentSpanId: delegation.delegateSpan.span_id,
          project: "sun-test",
          agentRole: "researcher",
          model: "local-glm",
        });

        await TraceContext.run(
          {
            trace_id: rootTraceId,
            run_id: subAgentRunId,
            currentSpan: subInstrumenter.rootSpan,
            current_span_id: subInstrumenter.rootSpan.span_id,
            parentSpanId: delegation.delegateSpan.span_id,
          },
          async () => {
            // Child tool execution
            await HarnessInstrumenter.traceToolExecution(
              "query_docs",
              { query: "telemetry" },
              subInstrumenter.rootSpan,
              "READ_ONLY",
              async () => ({ found: 3 })
            );
          }
        );

        subInstrumenter.complete("completed");
        delegation.complete("OK");
        delegation.emitJoinSpan("OK", 120);
      }
    );

    // Complete root run
    instrumenter.complete("completed");

    // Assert trace connectivity in evidence store
    const rootSpans = RunEvidenceStore.getGlobalInstance().getSpans(rootRunId);
    expect(rootSpans.length).toBeGreaterThan(4);

    // All spans must share the single root trace_id
    for (const span of rootSpans) {
      expect(span.trace_id).toBe(rootTraceId);
      expect(span.run_id).toBe(rootRunId);
    }

    // Root span metrics must be accurately aggregated from measured execution
    expect(instrumenter.runManifest.tool_call_count).toBe(2); // read_file + network_fetch
    expect(instrumenter.runManifest.retry_count).toBe(1);
    expect(instrumenter.runManifest.total_tokens).toBe(550);

    // Verify delegation join span exists
    const allQueued = TraceExporter.getGlobalInstance().getQueuedSpans();
    const joinSpan = allQueued.find((s) => s.kind === "delegation_join");
    expect(joinSpan).toBeDefined();
    expect(joinSpan?.trace_id).toBe(rootTraceId);
    expect(joinSpan?.attributes.agent_role).toBe("researcher");
  });

  it("enriches SSE events with matching trace, run, and span identifiers", () => {
    const emittedEvents: any[] = [];
    const mockRes: any = {
      write: (data: string) => {
        const json = data.replace(/^data: /, "").trim();
        if (json) emittedEvents.push(JSON.parse(json));
      },
      flushHeaders: () => {},
      destroyed: false,
      writableEnded: false,
      socket: { setNoDelay: () => {} },
    };

    const abortCtrl = new AbortController();
    const emitter = createSseEmitter(mockRes, abortCtrl.signal);

    TraceContext.run(
      {
        trace_id: "trace_sse_123",
        run_id: "run_sse_456",
        current_span_id: "span_sse_789",
      },
      () => {
        emitter({ type: "chunk", content: "Hello" } as any);
        emitter({ type: "tool_output", name: "fetch" } as any);
        emitter({ type: "done" } as any);
      }
    );

    expect(emittedEvents).toHaveLength(3);
    for (const ev of emittedEvents) {
      expect(ev.trace_id).toBe("trace_sse_123");
      expect(ev.run_id).toBe("run_sse_456");
      expect(ev.span_id).toBe("span_sse_789");
    }
  });

  it("strictly isolates verification evidence between concurrent workflows", async () => {
    const evidenceStore = RunEvidenceStore.getGlobalInstance();
    const runA = "run_flow_A";
    const runB = "run_flow_B";

    // Workflow A records passing test evidence
    evidenceStore.record({
      trace_id: "trace_A",
      span_id: "span_A_test",
      run_id: runA,
      name: "tool_exec:run_tests",
      kind: "tool_execution",
      status: "OK",
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      attributes: { tool_name: "run_tests" },
      events: [],
      links: [],
    });

    // Workflow B only records an unrelated file read
    evidenceStore.record({
      trace_id: "trace_B",
      span_id: "span_B_read",
      run_id: runB,
      name: "tool_exec:read_file",
      kind: "tool_execution",
      status: "OK",
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      attributes: { tool_name: "read_file" },
      events: [],
      links: [],
    });

    // Verification for Workflow A: "All unit tests passed" -> PASSES
    const verA = DeterministicVerifiers.verifyRunEvidence("All unit tests passed", runA);
    expect(verA.passed).toBe(true);
    expect(verA.evidence_refs).toContain("span_A_test");

    // Verification for Workflow B: "All unit tests passed" -> MUST FAIL because it has no test evidence!
    const verB = DeterministicVerifiers.verifyRunEvidence("All unit tests passed", runB);
    expect(verB.passed).toBe(false);
    expect(verB.reason).toMatch(/requires test execution evidence/);
    expect(verB.evidence_refs).toHaveLength(0);
  });

  it("preserves verification evidence during exporter queue flushes and collector outages", async () => {
    const runId = "run_outage_test";
    const span = new Span({
      trace_id: "trace_outage",
      run_id: runId,
      name: "tool_exec:run_tests",
      kind: "tool_execution",
      attributes: { tool_name: "run_tests" },
    });
    span.end("OK");

    const exporter = TraceExporter.getGlobalInstance();
    exporter.enqueueSpan(span.toJSON());

    // Flush the exporter queue (simulating exporter network flush)
    await exporter.flushAll(500);
    expect(exporter.getQueueLength().spans).toBe(0);

    // Verifier MUST still be able to verify using RunEvidenceStore
    const result = DeterministicVerifiers.verifyRunEvidence("Unit tests passed", runId);
    expect(result.passed).toBe(true);
    expect(result.evidence_refs).toContain(span.span_id);
  });

  it("preserves numeric token usage while redacting secrets and credentials", () => {
    // Generate dynamic in-memory credential fixture (zero static hardcoded secrets)
    const testSecret = `auth_${crypto.randomBytes(12).toString("hex")}`;
    const testApiKey = `key_${crypto.randomBytes(16).toString("hex")}`;

    const payload = {
      prompt: "Analyze codebase",
      tokens_input: 1250,
      tokens_output: 320,
      tokens_cache: 400,
      total_tokens: 1570,
      apiKey: testApiKey,
      password: testSecret,
      user_token: testSecret,
    };

    const sanitized = sanitizeTelemetryPayload(payload) as Record<string, unknown>;

    // Numeric token fields MUST be strictly preserved
    expect(sanitized.tokens_input).toBe(1250);
    expect(sanitized.tokens_output).toBe(320);
    expect(sanitized.tokens_cache).toBe(400);
    expect(sanitized.total_tokens).toBe(1570);

    // Secrets MUST be redacted
    expect(sanitized.apiKey).toBe("[REDACTED]");
    expect(sanitized.password).toBe("[REDACTED]");
    expect(sanitized.user_token).toBe("[REDACTED]");
  });

  it("gating: unrelated tool calls cannot satisfy completion claims (e.g. tests or deploy)", () => {
    const readSpan: SpanData = {
      trace_id: "t_gate",
      span_id: "s_gate_read",
      run_id: "r_gate",
      name: "tool_exec:read_file",
      kind: "tool_execution",
      status: "OK",
      start_time: new Date().toISOString(),
      attributes: { tool_name: "read_file" },
      events: [],
      links: [],
    };

    // Claiming tests passed with only a read_file tool call MUST FAIL
    const testClaimRes = DeterministicVerifiers.verifyCompletionClaim("All test suites passed", [readSpan]);
    expect(testClaimRes.passed).toBe(false);
    expect(testClaimRes.reason).toMatch(/requires test execution evidence/);

    // Claiming deployment succeeded with only a read_file tool call MUST FAIL
    const deployClaimRes = DeterministicVerifiers.verifyCompletionClaim("The container was deployed to production", [readSpan]);
    expect(deployClaimRes.passed).toBe(false);
    expect(deployClaimRes.reason).toMatch(/requires deployment execution evidence/);
  });

  it("records accurate terminal status on cancellation and provider setup errors", async () => {
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    const instrumenter = HarnessInstrumenter.startRun({
      project: "sun-test",
      agentRole: "cancelling_agent",
      model: "local-glm",
    });

    let caughtError = false;
    try {
      if (abortCtrl.signal.aborted) {
        throw new Error("Execution cancelled by client");
      }
    } catch (err: any) {
      caughtError = true;
      instrumenter.complete("cancelled", err.message);
    }

    expect(caughtError).toBe(true);
    expect(instrumenter.runManifest.status).toBe("cancelled");
    expect(instrumenter.runManifest.end_time).toBeDefined();

    // Provider setup error test
    const setupModel = HarnessInstrumenter.startModelSpan("invalid-model", "vllm");
    const setupSpan = setupModel.complete({
      status: "ERROR",
      errorMessage: "Connection refused: provider offline",
    });

    expect(setupSpan.status).toBe("ERROR");
    expect(setupSpan.status_message).toContain("provider offline");
  });
});
