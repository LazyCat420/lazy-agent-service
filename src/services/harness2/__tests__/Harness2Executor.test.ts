/**
 * Rollouts always end, and a run can be cancelled (documentation ch.13 §6 Phase 1 item 9, B1).
 */
import { describe, expect, it } from "vitest";
import type { Tree } from "../HarnessTree.ts";
import { makeExecutor, makeProposer, runHarness2, type Harness2Request } from "../Harness2Service.ts";
import { ProposerError, type Proposer } from "../Recursion.ts";

const BASE: Tree = { "systemprompt.md": "You are a careful analyst. MARK-BASE\n" };
const req: Harness2Request = { taskId: "t1", task: "Sum the rows.", domain: "finance", baseTree: BASE, solver: { provider: "vllm", model: "m" }, k: 1 };

type RunModel = NonNullable<Parameters<typeof makeExecutor>[1]>["runModel"];
type Hooks = { signal?: AbortSignal; onEvent?: (event: { type: string; tool?: { name?: string } }) => void };
/** A fake solver: `body` receives the prompt, system prompt and hooks runSingleModel would get. */
const fake = (body: (args: { systemPrompt: string; hooks: Hooks }) => Promise<Record<string, unknown>>): RunModel =>
  (async (benchmark: { systemPrompt?: string }, _model: unknown, _project: unknown, _user: unknown, hooks: Hooks = {}) =>
    body({ systemPrompt: benchmark.systemPrompt || "", hooks })) as unknown as RunModel;
const untilAborted = (signal?: AbortSignal) =>
  signal?.aborted ? Promise.resolve() : new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));

describe("rollouts always end [B1]", () => {
  it("a rollout that calls ask_user is stopped at once and recorded as failed", async () => {
    const started = Date.now();
    const execute = makeExecutor(req, {
      timeoutMs: 60_000,
      runModel: fake(async ({ hooks }) => {
        hooks.onEvent?.({ type: "tool_execution", tool: { name: "ask_user" } });
        await untilAborted(hooks.signal); // the loop's ask_user parks until its signal aborts
        return { response: "", error: "Aborted" };
      }),
    });
    const r = await execute(BASE, "base1");
    expect(r).toMatchObject({ ok: false, delivered: false });
    expect(r.error).toMatch(/called ask_user, but no user is attached/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a rollout past its deadline is aborted and recorded as failed", async () => {
    const execute = makeExecutor(req, {
      timeoutMs: 30,
      runModel: fake(async ({ hooks }) => (await untilAborted(hooks.signal), { response: "partial", error: null })),
    });
    const r = await execute(BASE, "base1");
    expect(r).toMatchObject({ ok: false, delivered: false, output: "partial" });
    expect(r.error).toMatch(/exceeded its 0 s deadline/);
  });

  it("a rollout that ignores its abort is abandoned after the grace period", async () => {
    const execute = makeExecutor(req, { timeoutMs: 20, abortGraceMs: 20, runModel: fake(() => new Promise(() => {})) });
    const r = await execute(BASE, "base1");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not stop within 0 s and was abandoned/);
  });

  it("follows the run's cancellation", async () => {
    const run = new AbortController();
    const execute = makeExecutor(req, {
      signal: run.signal,
      runModel: fake(async ({ hooks }) => (await untilAborted(hooks.signal), { response: "", error: "Aborted" })),
    });
    const pending = execute(BASE, "base1");
    run.abort();
    expect((await pending).error).toBe("run cancelled");
    expect((await execute(BASE, "base2")).error).toBe("run cancelled");
  });

  it("a normal rollout gets the materialized harness and keeps tool results up to 10,000 chars", async () => {
    let system = "";
    const execute = makeExecutor(req, {
      runModel: fake(async ({ systemPrompt }) => {
        system = systemPrompt;
        return { response: "total: 42", error: null, toolCalls: [{ name: "calculate_precise", args: {}, status: "success", result: "r".repeat(15_000) }] };
      }),
    });
    const r = await execute(BASE, "base1");
    expect(system).toContain("MARK-BASE");
    expect(r).toMatchObject({ ok: true, delivered: true, output: "total: 42" });
    expect(r.trajectory).toContain("…[truncated 5000 chars]");
  });
});

describe("cancellation", () => {
  it("the proposer rejects a pending and a new call once the run is cancelled, without a retry", async () => {
    const run = new AbortController();
    const propose = makeProposer({ provider: "vllm-2", model: "m" }, { signal: run.signal, providerOf: () => ({ generateText: () => new Promise<never>(() => {}) }) });
    const pending = propose("p", "inv1.a1").catch((e) => e);
    run.abort();
    const error = await pending;
    expect(error).toBeInstanceOf(ProposerError);
    expect(error).toMatchObject({ message: "run cancelled", retryable: false });
    await expect(propose("p", "dom1.a1")).rejects.toMatchObject({ message: "run cancelled" });
  });

  it("a run cancelled during its base rollouts stops with status cancelled and no improver calls", async () => {
    const run = new AbortController();
    const calls: string[] = [];
    const propose: Proposer = async (_p, label) => (calls.push(label), "<notes>KEEP_BASE</notes>");
    const r = await runHarness2(req, {
      signal: run.signal,
      propose,
      execute: async () => (run.abort(), { ok: true, delivered: true, output: "o", trajectory: "t", error: "" }),
    });
    expect(r.status).toBe("cancelled");
    expect(calls).toEqual([]);
    expect(r.learned).toBe(false);
  });
});
