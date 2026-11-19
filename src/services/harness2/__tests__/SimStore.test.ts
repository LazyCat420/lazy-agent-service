import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import MongoWrapper from "../../../wrappers/MongoWrapper.ts";
import {
  mergeIdenticalRootCauses,
  normalizeRootCause,
  renderSimPromptBlock,
  SIM_COLLECTION,
  SimStore,
  type SimDocument,
} from "../SimStore.ts";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function makeTempFile(name = "SIM.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-store-test-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

describe("SimStore (arXiv:2611.18856 Self-Improvement Memory)", () => {
  it("groups attempts under a problem, derives modelFamily dynamically, and retains missed/regressed attempts", async () => {
    const filePath = makeTempFile();
    const store = new SimStore("v3-quant-crsi", { filePath, useMongo: false });

    const p1 = await store.recordAttempt({
      rootCause: "Repeated run_equation dict TypeError retries exhaust turn budget",
      round: 1,
      sample: "agg1",
      accepted: true,
      what: "Add single-shot turn-budget convergence check after opening reads succeed",
      files: ["tool_guidance.md"],
      rationale: "Qwen3.8-Flash-Next retried run_equation 12 times after price+covariance succeeded",
      predicted: ["cycle-1|CVI", "cycle-1|CVS"],
      fixed: ["cycle-1|CVI"],
      missed: ["cycle-1|CVS"],
      passed: 18,
      total: 20,
      modelId: "Qwen3.8-Flash-Next",
      upstream: "dell1",
      agentRole: "v3_quant_analyst",
      perModel: {
        dell1: { modelFamily: "qwen", modelId: "Qwen3.8-Flash-Next", passed: 9, total: 10, avgLoops: 4.1 },
        "gold-spark": { modelFamily: "deepseek", modelId: "DeepSeek-V4.1-Flash-1017", passed: 9, total: 10, avgLoops: 2.2 },
      },
    });

    expect(p1.id).toBe("P1");
    expect(p1.attempts[0].provenance.modelFamily).toBe("qwen");
    expect(p1.attempts[0].provenance.modelId).toBe("Qwen3.8-Flash-Next");

    // Round 2 cites P1, modifies the same file, and misses all predicted fixes (like P8 in §F.2).
    const p1Updated = await store.recordAttempt({
      citedProblemId: "P1",
      rootCause: "Repeated run_equation dict TypeError retries exhaust turn budget",
      round: 2,
      sample: "agg2",
      accepted: true,
      what: "Hard-block completion whenever run_equation errors once",
      files: ["tool_guidance.md"],
      rationale: "Attempt stricter gate on CVS",
      predicted: ["cycle-1|CVS"],
      fixed: [],
      missed: ["cycle-1|CVS"],
      passed: 16,
      total: 20,
      modelId: "DeepSeek-V4.1-Flash-1017",
      upstream: "gold-spark",
      agentRole: "v3_quant_analyst",
    });

    expect(p1Updated.id).toBe("P1");
    expect(p1Updated.attempts).toHaveLength(2);
    expect(p1Updated.attempts[0].supersededByRound).toBe(2);
    expect(p1Updated.attempts[1].fixed).toEqual([]);
    expect(p1Updated.attempts[1].missed).toEqual(["cycle-1|CVS"]);
    expect(p1Updated.attempts[1].provenance.modelFamily).toBe("deepseek");

    const fullText = store.renderPrompt("full");
    expect(fullText).toContain("# SELF-IMPROVEMENT MEMORY (SIM)");
    expect(fullText).toContain("P1 (opened r1)");
    expect(fullText).toContain("(later revised in r2)");
    expect(fullText).toContain("missed=[cycle-1|CVS]");
    expect(fullText).toContain("per_model=[dell1(qwen/Qwen3.8-Flash-Next): 9/10, avgLoops=4.1");

    const problemOnly = store.renderPrompt("problem-only");
    expect(problemOnly).toContain("ROOT CAUSES ONLY");
    expect(problemOnly).toContain("P1 (opened r1)");
    expect(problemOnly).not.toContain("tool_guidance.md");

    expect(store.renderPrompt("none")).toBe("");
  });

  it("deterministically merges identical normalized root causes and resolves aliases without losing attempts", async () => {
    expect(normalizeRootCause("  Premature   Completion\nWithout Evidence ")).toBe(
      "premature completion without evidence",
    );

    const doc: SimDocument = {
      domain: "merge-check",
      nextId: 7,
      aliases: {},
      updatedAt: new Date().toISOString(),
      problems: [
        {
          id: "P5",
          name: "Premature completion without execution verification",
          openedRound: 6,
          attempts: [
            {
              round: 6,
              sample: "s2",
              accepted: true,
              what: "first interlock",
              files: ["guardrails.md"],
              rationale: "stop early exits",
              predicted: ["t1"],
              fixed: ["t1"],
              missed: [],
              passed: 5,
              total: 6,
              domain: "merge-check",
              provenance: {
                domain: "merge-check",
                benchmark: "dev",
                modelFamily: "deepseek",
                modelId: "DeepSeek-V4.1-Flash-1017",
                round: 6,
                recordedAt: "2026-11-18T00:00:00Z",
              },
            },
          ],
        },
        {
          id: "P6",
          name: "  premature completion   without execution verification ",
          openedRound: 8,
          attempts: [
            {
              round: 8,
              sample: "s1",
              accepted: true,
              what: "second interlock",
              files: ["guardrails.md"],
              rationale: "handle truncated blocks",
              predicted: ["t2"],
              fixed: [],
              missed: ["t2"],
              passed: 5,
              total: 6,
              domain: "merge-check",
              provenance: {
                domain: "merge-check",
                benchmark: "dev",
                modelFamily: "qwen",
                modelId: "Qwen3.8-Flash-Next",
                round: 8,
                recordedAt: "2026-11-18T01:00:00Z",
              },
            },
          ],
        },
      ],
    };

    mergeIdenticalRootCauses(doc);
    expect(doc.problems).toHaveLength(1);
    expect(doc.problems[0].id).toBe("P5");
    expect(doc.problems[0].attempts).toHaveLength(2);
    expect(doc.aliases).toEqual({ P6: "P5" });

    const filePath = makeTempFile("merged.json");
    fs.writeFileSync(filePath, JSON.stringify(doc));
    const store = new SimStore("merge-check", { filePath, useMongo: false });
    const appended = await store.recordAttempt({
      citedProblemId: "P6", // citing merged alias resolves to P5
      rootCause: "ignored because P6 resolves to P5",
      round: 9,
      sample: "s1",
      accepted: true,
      what: "third interlock",
      files: ["systemprompt.md"],
      rationale: "extend P5 via P6 alias",
      predicted: ["t3"],
      fixed: ["t3"],
      missed: [],
      passed: 6,
      total: 6,
      modelId: "Qwen3.8-Flash-Next",
    });
    expect(appended.id).toBe("P5");
    expect(appended.attempts).toHaveLength(3);
  });

  it("carries source SIM into target cross-model continuation and syncs with MongoDB when enabled", async () => {
    const mongoDocs = new Map<string, Record<string, unknown>>();
    const collection = {
      findOne: vi.fn(async (q: { _id: string }) => mongoDocs.get(q._id) ?? null),
      updateOne: vi.fn(async (q: { _id: string }, u: { $set: Record<string, unknown> }) => {
        mongoDocs.set(q._id, { _id: q._id, ...u.$set });
      }),
    };
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({ collection: (name: string) => {
      expect(name).toBe(SIM_COLLECTION);
      return collection;
    } } as never);

    const srcFile = makeTempFile("src-sim.json");
    const dstFile = makeTempFile("dst-sim.json");
    const source = new SimStore("quant-deepseek-src", { filePath: srcFile, useMongo: true });
    await source.recordAttempt({
      rootCause: "Missing covariance ticker normalization",
      round: 1,
      sample: "agg1",
      accepted: true,
      what: "Add ticker sorting rule",
      files: ["tool_guidance.md"],
      rationale: "Keep covariance cache hits deterministic",
      predicted: ["c1"],
      fixed: ["c1"],
      missed: [],
      passed: 10,
      total: 10,
      modelId: "DeepSeek-V4.1-Flash-1017",
    });

    const target = new SimStore("quant-qwen-target", { filePath: dstFile, useMongo: true });
    const carried = await source.carryInto(target, {
      sourceArm: "run-src-1",
      targetRun: "run-dst-1",
      sourceModelId: "DeepSeek-V4.1-Flash-1017",
      targetModelId: "Qwen3.8-Flash-Next",
    });

    expect(carried.carriedFrom).toMatchObject({
      arm: "run-src-1",
      sourceModelFamily: "deepseek",
      into: "run-dst-1",
      targetModelFamily: "qwen",
    });

    const reloaded = new SimStore("quant-qwen-target", { filePath: makeTempFile("empty.json"), useMongo: true });
    const fromMongo = await reloaded.load();
    expect(fromMongo.problems).toHaveLength(1);
    expect(fromMongo.carriedFrom?.targetModelFamily).toBe("qwen");
  });

  it("rejects grader verdict leaks and redacts accidental bearer tokens", async () => {
    const store = new SimStore("safety-check", { filePath: makeTempFile(), useMongo: false });
    await expect(
      store.recordAttempt({
        rootCause: 'Leaked {"pass_rate": 0.9}',
        round: 1,
        sample: "s1",
        accepted: true,
        what: "x",
        files: [],
        rationale: "y",
        predicted: [],
        fixed: [],
        missed: [],
        passed: 1,
        total: 1,
        modelId: "Qwen3.8-Flash-Next",
      }),
    ).rejects.toThrow(/grader-verdict marker/);

    const clean = await store.recordAttempt({
      rootCause: "Header formatting issue",
      round: 1,
      sample: "s1",
      accepted: true,
      what: "Authorization Bearer abcdefghijklmnopqrstuvwxyz123456",
      files: ["tool_guidance.md"],
      rationale: "strip raw header",
      predicted: [],
      fixed: [],
      missed: [],
      passed: 1,
      total: 1,
      modelId: "Qwen3.8-Flash-Next",
    });
    expect(clean.attempts[0].what).toContain("[REDACTED_SECRET]");
    expect(clean.attempts[0].what).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(renderSimPromptBlock(store.snapshot(), "full", 500)).toContain("[REDACTED_SECRET]");
  });

  it("enforces maxChars cap across full and problem-only modes and hydrates Mongo before recordAttempt", async () => {
    const mongoDocs = new Map<string, Record<string, unknown>>();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: () => ({
        findOne: async (q: { _id: string }) => mongoDocs.get(q._id) ?? null,
        updateOne: async (q: { _id: string }, u: { $set: Record<string, unknown> }) => {
          mongoDocs.set(q._id, { _id: q._id, ...u.$set });
        },
      }),
    } as never);

    // Seed MongoDB from instance A
    const storeA = new SimStore("mongo-hydrate-guard", { filePath: makeTempFile("a.json"), useMongo: true });
    await storeA.recordAttempt({
      rootCause: `Remote root cause ${"X".repeat(260)}`,
      round: 1,
      sample: "r1",
      accepted: true,
      what: `edit-1 ${"W".repeat(400)}`,
      files: ["a.ts"],
      rationale: `rationale-1 ${"R".repeat(400)}`,
      predicted: ["c1"],
      fixed: ["c1"],
      missed: [],
      passed: 1,
      total: 1,
      modelId: "DeepSeek-V4.1-Flash-1017",
    });

    // Instance B has a cold empty local file and calls recordAttempt WITHOUT explicit load(): must preserve P1!
    const storeB = new SimStore("mongo-hydrate-guard", { filePath: makeTempFile("b.json"), useMongo: true });
    await storeB.recordAttempt({
      rootCause: `Second root cause ${"Y".repeat(260)}`,
      round: 2,
      sample: "r2",
      accepted: false,
      what: `edit-2 ${"Z".repeat(400)}`,
      files: ["b.ts"],
      rationale: `rationale-2 ${"Q".repeat(400)}`,
      predicted: ["c2"],
      fixed: [],
      missed: ["c2"],
      passed: 0,
      total: 1,
      modelId: "Qwen3.8-Flash-Next",
    });

    const snap = storeB.snapshot();
    expect(snap.problems).toHaveLength(2);
    expect(renderSimPromptBlock(snap, "full", 320).length).toBeLessThanOrEqual(320);
    expect(renderSimPromptBlock(snap, "problem-only", 200).length).toBeLessThanOrEqual(200);
  });
});
