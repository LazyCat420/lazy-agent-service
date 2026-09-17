import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import { LifecycleMemoryEngine } from "../memory/LifecycleMemory.ts";
import { ContextAssembly } from "../context/ContextAssembly.ts";
import { ContextBudget } from "../context/ContextBudget.ts";
import { RepositoryMapService } from "../context/RepositoryMapService.ts";
import { HarnessInstrumenter } from "../trace/HarnessInstrumenter.ts";
import { TraceExporter } from "../trace/TraceExporter.ts";
import { Span } from "../trace/Span.ts";
import { DeterministicVerifiers } from "../verify/DeterministicVerifiers.ts";
import { ReplayManifestBuilder } from "../replay/ReplayManifest.ts";
import type { SpanData } from "../contracts/telemetry.ts";

describe("Platform Architecture Subsystem", () => {
  describe("Phase 1: LifecycleMemoryEngine & Domain Boundaries", () => {
    it("quarantines ticker/trading memories from general agent memory", () => {
      expect(() => {
        LifecycleMemoryEngine.createCandidateObservation({
          scope: { domain: "general", project: "sun", ...({ ticker: "AAPL" } as any) },
          provenance: { trace_id: "trace_1", span_id: "span_1", source_ref: "eval" },
          type: "reference",
          content: "AAPL Q3 beat expectations",
        });
      }).toThrow(/Domain Boundary Violation/);
    });

    it("creates CANDIDATE observations that cannot enter prompts until promoted", () => {
      const candidate = LifecycleMemoryEngine.createCandidateObservation({
        scope: { domain: "general", agent: "coding", project: "sun" },
        provenance: { trace_id: "trace_1", span_id: "span_1", source_ref: "git-commit-1" },
        type: "project",
        content: "Always run npm test before deploy",
      });

      expect(candidate.lifecycle_state).toBe("CANDIDATE");
      expect(candidate.provenance.verified_at).toBeNull();

      // Filter for prompts
      const eligible = LifecycleMemoryEngine.filterActiveForPrompt([candidate], {
        domain: "general",
        project: "sun",
        agent: "coding",
      });
      expect(eligible).toHaveLength(0);

      // Promote to ACTIVE
      const active = LifecycleMemoryEngine.promoteToActive(candidate, {
        verified_by: "test_runner",
        verification_evidence_ref: "vitest_pass_receipt",
      });

      expect(active.lifecycle_state).toBe("ACTIVE");
      expect(active.provenance.verified_at).not.toBeNull();

      const eligibleAfterPromotion = LifecycleMemoryEngine.filterActiveForPrompt([active], {
        domain: "general",
        project: "sun",
        agent: "coding",
      });
      expect(eligibleAfterPromotion).toHaveLength(1);
    });

    it("evaluates freshness and marks expired memories as RETIRED", () => {
      const candidate = LifecycleMemoryEngine.createCandidateObservation({
        scope: { domain: "general", agent: "coding", project: "sun" },
        provenance: { trace_id: "trace_1", span_id: "span_1", source_ref: "doc" },
        type: "reference",
        content: "Short-lived temporary token hint",
        ttlSeconds: 10,
      });

      const active = LifecycleMemoryEngine.promoteToActive(candidate, {
        verified_by: "validator",
        verification_evidence_ref: "verified_ref",
      });

      // 15 seconds in future
      const future = new Date(Date.now() + 15_000);
      const evaluated = LifecycleMemoryEngine.evaluateFreshness(active, future);
      expect(evaluated.lifecycle_state).toBe("RETIRED");
    });
  });

  describe("Phase 2: Normalized Context Assembly & Receipts", () => {
    it("produces deterministic prefix and tool hashes for identical role configurations", () => {
      const assembler = new ContextAssembly();
      const options = {
        agentRole: "code_reviewer",
        project: "lazy-agent-service",
        roleRules: "Always review for high test coverage and zero static secrets.",
        outputContract: '{"review_status": "APPROVED" | "CHANGES_REQUESTED"}',
        toolProtocol: "Use tools in JSON format.",
        selectedToolSchemas: [
          { name: "grep_search", description: "Search codebase" },
          { name: "view_file", description: "View file contents" },
        ],
        userTask: "Audit the PR for security.",
      };

      const run1 = assembler.assemble(options);
      const run2 = assembler.assemble(options);

      expect(run1.receipt.layers.prefix.hash).toBe(run2.receipt.layers.prefix.hash);
      expect(run1.receipt.layers.project_scope.hash).toBe(run2.receipt.layers.project_scope.hash);
      expect(run1.receipt.receipt_id).toBe(run2.receipt.receipt_id);
    });

    it("enforces layer budgets and flags truncated layers in the ContextReceipt", () => {
      const budgetConfig = { totalMaxChars: 500 }; // Very small budget to force truncation
      const assembler = new ContextAssembly(budgetConfig);

      const res = assembler.assemble({
        agentRole: "worker",
        project: "sun",
        roleRules: "Rule ".repeat(50),
        outputContract: "Output contract ".repeat(50),
        toolProtocol: "Tool protocol ".repeat(50),
        selectedToolSchemas: [{ name: "bash", description: "Execute shell" }],
        userTask: "Task ".repeat(100),
      });

      expect(res.receipt.layers.prefix.truncated).toBe(true);
      expect(res.receipt.layers.dynamic_tail.truncated).toBe(true);
      expect(res.fullPrompt.length).toBeLessThanOrEqual(1000);
    });

    it("excludes non-ACTIVE memories from prompt injection and logs them in receipt exclusions", () => {
      const assembler = new ContextAssembly();
      const candidateMem = LifecycleMemoryEngine.createCandidateObservation({
        scope: { domain: "general", agent: "architect", project: "sun" },
        provenance: { trace_id: "t1", span_id: "s1", source_ref: "ref1" },
        type: "project",
        content: "Unverified architectural claim",
      });

      const res = assembler.assemble({
        agentRole: "architect",
        project: "sun",
        roleRules: "Architect rules",
        outputContract: "JSON",
        toolProtocol: "Execute tools",
        selectedToolSchemas: [],
        verifiedMemories: [candidateMem],
        userTask: "Design subsystem",
      });

      expect(res.receipt.layers.retrieved_evidence.memory_ids).toHaveLength(0);
      expect(res.receipt.excluded_items.some((item) => item.id === candidateMem.id)).toBe(true);
    });
  });

  describe("Phase 3: Trace Engineering & Harness Chokepoints", () => {
    it("instruments agent runs and generates root spans and manifests", () => {
      const { runManifest, rootSpan, complete } = HarnessInstrumenter.startRun({
        project: "lazy-agent-service",
        agentRole: "testing_agent",
        model: "local-qwen",
      });

      expect(runManifest.status).toBe("running");
      expect(rootSpan.kind).toBe("agent_run");
      expect(rootSpan.attributes.agent_role).toBe("testing_agent");

      complete("completed", "goal_achieved");
      expect(runManifest.status).toBe("completed");
      expect(runManifest.stop_reason).toBe("goal_achieved");
      expect(rootSpan.status).toBe("OK");
    });

    it("captures tool guard and tool execution spans with input/result hashes", async () => {
      const rootSpan = new Span({
        run_id: "run_test_1",
        name: "root",
        kind: "agent_run",
      });

      const guardRes = await HarnessInstrumenter.traceToolGuard(
        "file_reader",
        { path: "/tmp/foo" },
        rootSpan,
        async () => ({ allowed: true, decision: "ALLOW" })
      );
      expect(guardRes.allowed).toBe(true);

      const execRes = await HarnessInstrumenter.traceToolExecution(
        "file_reader",
        { path: "/tmp/foo" },
        rootSpan,
        "READ_ONLY",
        async () => "file content here"
      );
      expect(execRes).toBe("file content here");
    });

    it("safely enqueues and flushes spans in TraceExporter without throwing on failures", async () => {
      const exporter = new TraceExporter({
        collectorEndpoint: "http://127.0.0.1:59999/unreachable", // Intentionally unreachable
        batchSize: 10,
      });

      const testSpan = new Span({
        run_id: "r1",
        name: "test_span",
        kind: "tool_execution",
      });
      testSpan.end("OK");

      exporter.enqueueSpan(testSpan.toJSON());
      expect(exporter.getQueueLength().spans).toBe(1);

      // Flushing to an unreachable endpoint must NOT throw
      await expect(exporter.flush()).resolves.not.toThrow();
      exporter.stop();
    });
  });

  describe("Phase 4: Deterministic Verifiers & Replay Manifests", () => {
    it("verifies completion claims require evidence spans", () => {
      // 1. Completion claimed with NO execution spans -> FAILS
      const emptySpans: SpanData[] = [];
      const failRes = DeterministicVerifiers.verifyCompletionClaim("All tasks completed!", emptySpans);
      expect(failRes.passed).toBe(false);
      expect(failRes.reason).toMatch(/zero successful execution/);

      // 2. Completion claimed WITH execution span -> PASSES
      const okSpan: SpanData = {
        trace_id: "t1",
        span_id: "s1",
        run_id: "r1",
        name: "tool_exec",
        kind: "tool_execution",
        status: "OK",
        start_time: new Date().toISOString(),
        attributes: {},
        events: [],
        links: [],
      };
      const passRes = DeterministicVerifiers.verifyCompletionClaim("Tasks completed.", [okSpan]);
      expect(passRes.passed).toBe(true);
      expect(passRes.evidence_refs).toContain("s1");
    });

    it("detects and stops tool repeat loops", () => {
      const hashes = ["hash_abc", "hash_abc", "hash_abc", "hash_abc", "hash_abc"];
      // 6th repeat exceeds threshold of 5
      const res = DeterministicVerifiers.verifyToolRepeatLoop("fetch_data", { id: 1 }, hashes, 5);
      // Wait: hash for { toolName: "fetch_data", args: { id: 1 } } will be different from "hash_abc"
      // Let's test with exact matching hash
      const currentHash = crypto
        .createHash("sha256")
        .update(JSON.stringify({ toolName: "fetch_data", args: { id: 1 } }))
        .digest("hex");

      const matchingHashes = [currentHash, currentHash, currentHash, currentHash, currentHash];
      const loopRes = DeterministicVerifiers.verifyToolRepeatLoop("fetch_data", { id: 1 }, matchingHashes, 5);
      expect(loopRes.passed).toBe(false);
      expect(loopRes.reason).toMatch(/exceeding repeat threshold/);
    });

    it("detects identical failure retry loops", () => {
      const repeatedFp = ["err_timeout_123", "err_timeout_123", "err_timeout_123"];
      const res = DeterministicVerifiers.verifyRetryLoop(repeatedFp, 3);
      expect(res.passed).toBe(false);
      expect(res.reason).toMatch(/consecutive times without recovery/);
    });

    it("builds replay manifests with ordered tool events and verifier outcomes", () => {
      const receipt = {
        receipt_id: "receipt_123",
        agent_role: "coder",
        project: "sun",
        task_delivery: "exact" as const,
        created_at: new Date().toISOString(),
        layers: {
          prefix: { allocated_chars: 1000, used_chars: 500, truncated: false, item_count: 3, hash: "h1" },
          project_scope: { allocated_chars: 2000, used_chars: 800, truncated: false, item_count: 2, hash: "h2", tool_ids: ["tool1"] },
          retrieved_evidence: { allocated_chars: 1500, used_chars: 400, truncated: false, item_count: 1, hash: "h3", memory_ids: ["m1"], artifact_refs: [] },
          dynamic_tail: { allocated_chars: 1500, used_chars: 600, truncated: false, item_count: 2, hash: "h4" },
        },
        total_chars: 2300,
        excluded_items: [],
      };

      const builder = new ReplayManifestBuilder({
        runId: "run_999",
        traceId: "trace_999",
        harnessVersion: "2.0.0",
        model: "local-qwen",
        agentRole: "coder",
        contextReceipt: receipt,
      });

      builder.addToolEvent({
        turn: 1,
        callId: "call_1",
        toolName: "read_source",
        arguments: { file: "index.ts" },
        result: "code",
        status: "success",
        durationMs: 45,
      });

      builder.addVerifierOutcome({
        verifier_name: "test_verifier",
        passed: true,
        evidence_refs: ["test_span_1"],
      });

      builder.setStopReason("completed");

      const manifest = builder.build();
      expect(manifest.ordered_tool_events).toHaveLength(1);
      expect(manifest.verifier_outcomes).toHaveLength(1);
      expect(manifest.stop_reason).toBe("completed");
    });
  });
});
