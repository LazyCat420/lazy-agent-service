import crypto from "node:crypto";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { RunExecutionEngine as Engine } from "../../src/services/RunExecutionEngine.ts";
import { LocalToolContinuation } from "../../src/services/LocalToolContinuation.ts";
import { ProfileRegistry } from "../../src/services/ProfileRegistry.ts";
import { RunStore } from "../../src/services/RunStore.ts";
import { RuntimeExtensions } from "../../src/services/RuntimeExtensions.ts";
import AgenticLoopService from "../../src/services/AgenticLoopService.ts";

const profile = "html-notes-canvas-v1";
const schema = { name: "html_notes.notes.get", description: "Read a note", parameters: { type: "object" } };
beforeEach(async () => {
  Engine.reset();
  vi.restoreAllMocks();
  vi.stubEnv("RUNTIME_AUTH_SECRET", crypto.randomBytes(32).toString("hex"));
  await ProfileRegistry.loadProfilesFromDisk();
});
afterEach(() => vi.unstubAllEnvs());

describe("Canonical repair regressions", () => {
  it("rejects an exact unknown version, then permits a corrected admission with the same key", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockResolvedValue({ messages: [{ role: "assistant", content: "Ready" }] });
    const request = { profile_id: profile, profile_version: "99.0.0", input: "news", idempotency_key: crypto.randomUUID() };
    expect((await Engine.startRun("invalid", request, () => {})).error?.code).toBe("PROFILE_NOT_FOUND");
    expect((await Engine.startRun("valid", { ...request, profile_version: "1.2.0" }, () => {})).status).toBe("completed");
  });

  it("validates the top-level model actually executed", async () => {
    const loop = vi.spyOn(AgenticLoopService, "runAgenticLoop");
    expect((await Engine.startRun("bad-model", { profile_id: profile, model: "outside-policy", input: "news" }, () => {})).error?.code).toBe("INVALID_RUN_REQUEST");
    expect(loop).not.toHaveBeenCalled();
  });

  it("preserves zero tool calls and replays the original failed terminal outcome", async () => {
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async context => {
      await context.runtimeToolExecutor!({ id: "call", name: schema.name, args: {} });
      return { messages: [] };
    });
    const request = { profile_id: profile, input: "news", budget: { max_tool_calls: 0 }, idempotency_key: crypto.randomUUID() };
    expect((await Engine.startRun("zero", request, () => {})).error?.code).toBe("TOOL_BUDGET_EXHAUSTED");
    const events: string[] = [];
    const replay = await Engine.startRun("replay", request, e => events.push(e.type));
    expect(replay.status).toBe("failed");
    expect(events).toEqual(["run.failed"]);
  });

  it("waits for real results, rejects cross-run results and safely acknowledges identical duplicates", async () => {
    let continued = false;
    let admission: any;
    let notify!: () => void;
    const pending = new Promise<void>(resolve => { notify = resolve; });
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async context => {
      expect(context.messages[0].content).toContain("canvas fixture");
      const observation = await context.runtimeToolExecutor!({ id: "call", name: schema.name, args: {} });
      expect(observation).toEqual({ links: ["https://example.com/news"] });
      continued = true;
      return { messages: [{ role: "assistant", content: "Sourced news https://example.com/news" }] };
    });
    const run = Engine.startRun("continuation", { profile_id: profile, input: "news", app_id: "html-notes", session_id: "session",
      runtime_overrides: { local_tool_schemas: [schema], context: { canvas_context: "canvas fixture" } } }, event => {
      if (event.type === "tool.invoked") { admission = event.data; notify(); }
    });
    await pending;
    expect(continued).toBe(false);
    expect((await RunStore.getRun("continuation"))?.status).toBe("waiting_for_tool");
    const submission = { authorization_receipt: admission.authorization_receipt, result: { links: ["https://example.com/news"] }, is_error: false };
    await expect(LocalToolContinuation.submit("another", "call", submission)).rejects.toThrow();
    expect(await LocalToolContinuation.submit("continuation", "call", submission)).toEqual({ duplicate: false });
    expect((await run).status).toBe("completed");
    expect(await LocalToolContinuation.submit("continuation", "call", submission)).toEqual({ duplicate: true });
    await expect(LocalToolContinuation.submit("continuation", "call", { ...submission, result: {} })).rejects.toThrow("Conflicting");
  });
});

it("fails readiness when a required guard is not installed", async () => {
  const loop = vi.spyOn(AgenticLoopService, "runAgenticLoop");
  const result = await Engine.startRun("guard", { profile_id: "trading-analyst-v1", input: "Analyze" }, () => {});
  expect(result.error?.code).toBe("PROFILE_NOT_READY");
  expect(loop).not.toHaveBeenCalled();
});
it("zero duration expires before generation and stays timed out on replay", async () => {
  const loop = vi.spyOn(AgenticLoopService, "runAgenticLoop");
  const request = { profile_id: profile, input: "news", budget: { max_duration_ms: 0 }, idempotency_key: crypto.randomUUID() };
  expect((await Engine.startRun("expired", request, () => {})).status).toBe("timed_out");
  expect((await Engine.startRun("expired-replay", request, () => {})).status).toBe("timed_out");
  expect(loop).not.toHaveBeenCalled();
});
it("a restart seals interrupted work without replaying pending effects", async () => {
  const prior = await Engine.startRun("seed", { profile_id: profile, input: "news", budget: { max_duration_ms: 0 } }, () => {});
  const record = await RunStore.getRun(prior.run_id);
  await RunStore.createRun({ ...record!, run_id: "interrupted", status: "waiting_for_tool", error: undefined, pending_tools: { call: { event: { tool_call_id: "call" } } } });
  await RunStore.reload();
  const recovered = await RunStore.getRun("interrupted");
  expect(recovered?.status).toBe("failed");
  expect(recovered?.error?.code).toBe("RUN_INTERRUPTED");
  expect(recovered?.pending_tools?.call).toBeDefined();
  expect(recovered?.events?.at(-1)?.type).toBe("run.failed");
  expect(recovered?.events?.at(-1)?.data.error.code).toBe("RUN_INTERRUPTED");
});

it("accepts an unversioned effective tool only at the registered version", async () => {
  const active = await ProfileRegistry.loadProfile(profile);
  expect(() => ProfileRegistry.validateOverrides(active!, { tools: [schema.name] })).not.toThrow();
  expect(() => ProfileRegistry.validateOverrides(active!, { tools: [`${schema.name}@99.0`] })).toThrow();
});

it("does not promote the user task or history into the shared system prompt", async () => {
  const content = `user-task-${crypto.randomUUID()}`;
  vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async context => {
    expect(context.options.systemPrompt).not.toContain(content);
    expect(context.messages.filter(message => message.role === "user" && message.content === content)).toHaveLength(1);
    return { messages: [{ role: "assistant", content: "Done" }] };
  });
  expect((await Engine.startRun("single-task", { profile_id: profile, input: content }, () => {})).status).toBe("completed");
});

it("executes required context, before-tool, result, and final-validator hooks in lifecycle order", async () => {
  const extensionName = `lifecycle-fixture-${crypto.randomUUID()}`;
  const profileId = `hook-fixture-${crypto.randomUUID()}`;
  const calls: string[] = [];
  RuntimeExtensions.register(extensionName, {
    context: async () => { calls.push("context"); return "trusted application context"; },
    beforeTool: async () => { calls.push("before-tool"); },
    afterTool: async (_call, observation) => {
      expect(observation).toEqual({ title: "fixture note" });
      calls.push("after-tool");
    },
    validate: async messages => {
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant", content: "Verified" })]));
      calls.push("validate");
    },
  });
  const base = await ProfileRegistry.loadProfile(profile);
  ProfileRegistry.registerProfile({
    ...base!, profile_id: profileId, plugins: {
      context_contributors: [extensionName],
      verifiers: [extensionName],
    },
  });

  let admission: any;
  let notify!: () => void;
  const pending = new Promise<void>(resolve => { notify = resolve; });
  vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async context => {
    expect(context.options.systemPrompt).toContain("trusted application context");
    const observation = await context.runtimeToolExecutor!({ id: "hook-call", name: schema.name, args: {} });
    expect(observation).toEqual({ title: "fixture note" });
    return { messages: [{ role: "assistant", content: "Verified" }] };
  });
  const run = Engine.startRun("hook-lifecycle", {
    profile_id: profileId, input: "Read", app_id: "html-notes", session_id: "hook-session",
    runtime_overrides: { local_tool_schemas: [schema] },
  }, event => {
    if (event.type === "tool.invoked") { admission = event.data; notify(); }
  });
  await pending;
  await LocalToolContinuation.submit("hook-lifecycle", "hook-call", {
    authorization_receipt: admission.authorization_receipt,
    result: { title: "fixture note" },
    is_error: false,
  });
  expect((await run).status).toBe("completed");
  expect(calls).toEqual(["context", "before-tool", "after-tool", "validate"]);
});
