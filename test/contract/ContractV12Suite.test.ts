import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { CapabilityRegistry } from "../../src/services/CapabilityRegistry.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunExecutionEngine } from "../../src/services/RunExecutionEngine.ts";
import { RunStore } from "../../src/services/RunStore.ts";
import { RunStateMachine } from "../../src/services/RunStateMachine.ts";
import { RunEvidenceStore } from "../../src/platform/verify/RunEvidenceStore.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";

describe("Developer 1 — Shared Runtime & Contract v1.2 Test Suite", () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const profilesDir = path.resolve(testDir, "..", "..", "profiles");
  const contractsDir = path.resolve(testDir, "..", "..", "contracts");

  beforeEach(async () => {
    CapabilityRegistry.reset();
    ProfileRegistry.clear();
    RunExecutionEngine.reset();
    RunEvidenceStore.getGlobalInstance().clearAll();
    vi.restoreAllMocks();
    await ProfileRegistry.loadProfilesFromDisk(profilesDir);
  });

  it("test_profile_rejects_unknown_capability", () => {
    const invalidProfile = {
      profile_id: "test-unknown-cap-agent",
      version: "1.0.0",
      contract_version: "1.2.0",
      role: "test-role",
      system_prompt: "Test persona",
      allowed_global_capabilities: ["global.nonexistent_exploit_tool@1.2"],
      model_constraints: {
        default_model: "llama-3-8b",
        allowed_models: ["llama-3-8b"],
        allowed_providers: ["vllm-shim"],
      },
      budget_limits: {
        max_tokens: 4096,
        max_tool_calls: 10,
        max_duration_ms: 30000,
      },
      retention_class: "EPHEMERAL",
    };

    expect(() => {
      ProfileRegistry.validateProfileSchema(invalidProfile);
    }).toThrow(/grants nonexistent or unauthorized capability: global\.nonexistent_exploit_tool@1\.2/);
  });

  it("test_profile_rejects_incompatible_contract_major", () => {
    const v2Profile = {
      profile_id: "test-v2-agent",
      version: "1.0.0",
      contract_version: "2.0.0",
      role: "test-role",
      system_prompt: "Test persona",
      allowed_global_capabilities: ["global.web.search@1.2"],
      model_constraints: {
        default_model: "llama-3-8b",
        allowed_models: ["llama-3-8b"],
        allowed_providers: ["vllm-shim"],
      },
      budget_limits: {
        max_tokens: 4096,
        max_tool_calls: 10,
        max_duration_ms: 30000,
      },
      retention_class: "EPHEMERAL",
    };

    expect(() => {
      ProfileRegistry.validateProfileSchema(v2Profile);
    }).toThrow(/specifies incompatible contract major version '2\.0\.0'\. Supported major: 1/);
  });

  it("test_profile_accepts_compatible_contract_minor", () => {
    const validProfile = {
      profile_id: "test-v12-agent",
      version: "1.2.0",
      contract_version: "1.2.0",
      role: "researcher",
      system_prompt: "Synthesize research",
      allowed_global_capabilities: ["global.web.search@1.2", "global.data.transform@1.2"],
      allowed_local_tools: ["html_notes.canvas.upsert_widget@1.0"],
      model_constraints: {
        default_model: "llama-3-8b",
        allowed_models: ["llama-3-8b"],
        allowed_providers: ["vllm-shim"],
      },
      budget_limits: {
        max_tokens: 4096,
        max_tool_calls: 10,
        max_duration_ms: 30000,
      },
      retention_class: "AUDITED_SESSION",
    };

    const validated = ProfileRegistry.validateProfileSchema(validProfile);
    expect(validated.profile_id).toBe("test-v12-agent");
    expect(validated.contract_version).toBe("1.2.0");
    expect(validated.tool_policy.whitelist).toContain("global.web.search@1.2");
    expect(validated.tool_policy.whitelist).toContain("html_notes.canvas.upsert_widget@1.0");
  });

  it("test_global_capability_requires_registry_metadata", () => {
    // Missing required metadata (effect, execution, timeout_ms, etc.)
    const incompleteCap: any = {
      id: "global.incomplete",
      name: "global.incomplete",
      // missing owner, version, execution, effect, timeout_ms, supports_evidence, requires_confirmation
    };

    expect(() => {
      CapabilityRegistry.registerCapability(incompleteCap);
    }).toThrow(/Capability definition must define id, name, version, owner, execution, effect, timeout_ms, supports_evidence, and requires_confirmation/);
  });

  it("test_global_capability_executes_in_runtime", async () => {
    const processed = await RunExecutionEngine.processToolCall(
      "run-shared-exec-01",
      {
        id: "tc-sort-101",
        name: "global.data.sort",
        arguments: {
          items: [
            { id: 2, price: 50 },
            { id: 1, price: 10 },
            { id: 3, price: 30 },
          ],
          key: "price",
          direction: "asc",
        },
      },
      {
        profile_id: "html-notes-researcher-v1",
        app_id: "html-notes",
        session_id: "sess_shared_101",
      },
    );

    expect(processed.status).toBe("executed_shared");
    expect(processed.event.type).toBe("tool.completed");
    expect(processed.event.data.execution).toBe("shared");
    const res = processed.result as any;
    expect(res.items.map((i: any) => i.price)).toEqual([10, 30, 50]);
  });

  it("test_local_tool_is_admitted_but_not_runtime_executed", async () => {
    const processed = await RunExecutionEngine.processToolCall(
      "run-local-admit-01",
      {
        id: "tc-local-201",
        name: "html_notes.canvas.upsert_widget",
        arguments: {
          widget_type: "notes_card",
          title: "Admitted Widget",
        },
      },
      {
        profile_id: "html-notes-researcher-v1",
        app_id: "html-notes",
        session_id: "sess_local_201",
      },
    );

    expect(processed.status).toBe("admitted_local");
    expect(processed.event.type).toBe("tool.invoked");
    expect(processed.event.data.execution).toBe("local");
    expect(processed.event.data.tool_name).toBe("html_notes.canvas.upsert_widget");
    // Assert no execution result was produced inside the runtime container
    expect(processed.result).toBeUndefined();
  });

  it("test_local_tool_event_contains_required_scope", async () => {
    const processed = await RunExecutionEngine.processToolCall(
      "run-local-scope-01",
      {
        id: "tc-local-301",
        name: "html_notes.canvas.upsert_widget",
        arguments: { title: "Scoped Item" },
      },
      {
        profile_id: "html-notes-researcher-v1",
        app_id: "html-notes",
        session_id: "session_scope_999",
      },
    );

    expect(processed.status).toBe("admitted_local");
    const evtData = processed.event.data;
    expect(evtData.required_scope).toBeDefined();
    expect(evtData.required_scope.app_id).toBe("html-notes");
    expect(evtData.required_scope.session_id).toBe("session_scope_999");
    expect(evtData.authorization_receipt).toBeDefined();
    expect(evtData.authorization_receipt.execution).toBe("local");
    expect(evtData.authorization_receipt.run_id).toBe("run-local-scope-01");
    expect(evtData.authorization_receipt.tool_call_id).toBe("tc-local-301");
    expect(evtData.authorization_receipt.app_id).toBe("html-notes");
    expect(evtData.authorization_receipt.session_id).toBe("session_scope_999");
    expect(evtData.authorization_receipt.profile_id).toBe("html-notes-researcher-v1");
    expect(evtData.authorization_receipt.arguments_hash).toBeDefined();
    expect(evtData.authorization_receipt.expires_at).toBeDefined();
    expect(evtData.authorization_receipt.signature).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it("test_tool_denial_contains_machine_readable_reason", async () => {
    const processed = await RunExecutionEngine.processToolCall(
      "run-denied-01",
      {
        id: "tc-unauthorized-01",
        name: "forbidden.system.execute_bash",
        arguments: { cmd: "rm -rf /" },
      },
      {
        profile_id: "html-notes-researcher-v1",
        app_id: "html-notes",
        session_id: "sess_denied_01",
      },
    );

    expect(processed.status).toBe("denied");
    expect(processed.event.type).toBe("tool.failed");
    expect(processed.error?.code).toBe("POLICY_VIOLATION");
    expect(processed.error?.category).toBe("POLICY");
    expect(processed.error?.message).toContain("is not allowed by profile");
  });

  it("test_cancellation_transitions_once", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ messages: [] } as any), 2000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("CANCELLED"));
        });
      });
    });

    const emittedEvents: string[] = [];
    const runPromise = RunExecutionEngine.startRun(
      "run-cancel-test-id",
      {
        profile_id: "html-notes-researcher-v1",
        input: "Test cancel transition",
      },
      (evt) => emittedEvents.push(evt.type),
    );

    // Wait a tick for run to initialize and enter running state
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Cancel once
    const firstCancel = await RunExecutionEngine.cancelRun("run-cancel-test-id");
    expect(firstCancel).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(emittedEvents).toContain("run.cancelled");

    // Second cancellation attempt on already-cancelled run must return false
    const secondCancel = await RunExecutionEngine.cancelRun("run-cancel-test-id");
    expect(secondCancel).toBe(false);

    // Terminal state invariant: cancelled cannot transition to running
    expect(RunStateMachine.isValidTransition("cancelled", "running")).toBe(false);
  });

  it("test_timeout_transitions_once", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (ctx) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ messages: [] } as any), 1000);
        ctx.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("DEADLINE_EXCEEDED"));
        });
      });
    });

    const result = await RunExecutionEngine.startRun(
      "run-timeout-test-id",
      {
        profile_id: "html-notes-researcher-v1",
        input: "Timeout test",
        budget: { max_duration_ms: 50 },
      },
      () => {},
    );

    expect(result.status).toBe("timed_out");
    expect(result.error?.code).toBe("DEADLINE_EXCEEDED");

    const record = await RunStore.getRun("run-timeout-test-id");
    expect(record?.status).toBe("timed_out");
    expect(RunStateMachine.isValidTransition("timed_out", "running")).toBe(false);
  });

  it("test_receipt_contains_contract_and_profile_version", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockResolvedValue({
      messages: [{ role: "assistant", content: "Analysis complete." }],
    } as any);

    const result = await RunExecutionEngine.startRun(
      "run-receipt-v12-test",
      {
        profile_id: "html-notes-researcher-v1",
        contract_version: "1.2.0",
        input: "Check version stamping",
      },
      () => {},
    );

    expect(result.status).toBe("completed");
    expect(result.contract_version).toBe("1.2.0");
    expect(result.context_receipt).toBeDefined();
    expect((result.context_receipt as any).contract_version).toBe("1.2.0");
    expect((result.context_receipt as any).profile_version).toBe("1.2.0");
  });

  it("test_duplicate_event_replay_is_idempotent", async () => {
    const loopSpy = vi.spyOn(AgenticLoopService, "runAgenticLoop").mockResolvedValue({
      messages: [{ role: "assistant", content: "Idempotent result." }],
    } as any);

    const idempotencyKey = "idem-replay-key-test-v12";
    const req = {
      profile_id: "html-notes-researcher-v1",
      contract_version: "1.2.0",
      idempotency_key: idempotencyKey,
      input: "Idempotency check",
    };

    const firstRun = await RunExecutionEngine.startRun("run-first-replay", req, () => {});
    expect(firstRun.status).toBe("completed");
    expect(loopSpy).toHaveBeenCalledTimes(1);

    // Second call with same idempotency key returns cached result without running loop
    const secondRun = await RunExecutionEngine.startRun("run-second-replay", req, () => {});
    expect(secondRun.status).toBe("completed");
    expect(secondRun.run_id).toBe("run-first-replay");
    expect(secondRun.messages[0].content).toBe("Idempotent result.");
    expect(loopSpy).toHaveBeenCalledTimes(1);
  });

  it("test_global_capability_emits_evidence_when_configured", async () => {
    const processed = await RunExecutionEngine.processToolCall(
      "run-evidence-test-01",
      {
        id: "tc-web-001",
        name: "global.web.search",
        arguments: { query: "semiconductor advancements", max_results: 2 },
      },
      {
        profile_id: "html-notes-researcher-v1",
        app_id: "html-notes",
        session_id: "sess_ev_01",
      },
    );

    expect(processed.status).toBe("executed_shared");
    const evtData = processed.event.data;
    expect(evtData.evidence_records).toBeDefined();
    expect(evtData.evidence_records.length).toBeGreaterThan(0);
    expect(evtData.evidence_records[0].source).toBe("global.web.search");
    expect(evtData.evidence_records[0].provenance_hash).toMatch(/^sha256-[a-f0-9]{64}$/);
  });

  it("test_fixture_bundle_validates_against_contract_schema", () => {
    const fixturesPath = path.join(contractsDir, "fixtures");
    expect(fs.existsSync(fixturesPath)).toBe(true);

    const fixtureFiles = fs.readdirSync(fixturesPath).filter((f) => f.endsWith(".json"));
    expect(fixtureFiles.length).toBe(14);

    const requiredFixtures = [
      "success-text-only.json",
      "success-global-web-search.json",
      "success-local-tool-admission.json",
      "success-local-tool-completion.json",
      "denied-global-tool.json",
      "denied-local-tool.json",
      "cancellation.json",
      "timeout.json",
      "provider-retry.json",
      "malformed-event.json",
      "runtime-unavailable.json",
      "incompatible-contract-version.json",
      "duplicate-event-replay.json",
      "idempotency-race.json",
    ];

    for (const reqFile of requiredFixtures) {
      expect(fixtureFiles).toContain(reqFile);
      const parsed = JSON.parse(fs.readFileSync(path.join(fixturesPath, reqFile), "utf-8"));
      expect(parsed.contract_version).toBe("1.2.0");
      expect(parsed.fixture_id).toBeDefined();
      expect(parsed.description).toBeDefined();
      expect(parsed.request).toBeDefined();
      expect(parsed.events).toBeInstanceOf(Array);
      expect(parsed.result).toBeDefined();
    }
  });
});
