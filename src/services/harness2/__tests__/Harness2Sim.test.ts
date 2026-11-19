import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import MongoWrapper from "../../../wrappers/MongoWrapper.ts";
import { materialize, type Tree } from "../HarnessTree.ts";
import { runHarness2 } from "../Harness2Service.ts";
import { parseSimManifest, type Executor } from "../Recursion.ts";
import { SimStore } from "../SimStore.ts";

const BASE: Tree = { "systemprompt.md": "You are a quantitative trading analyst.\n" };

const tmpDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-sim-test-"));
  tmpDirs.push(dir);
  return dir;
}

describe("Harness2 + SIM integration (WI-2, arXiv:2611.18856 Eq. 3)", () => {
  it("freezes pre-evaluation diagnosis + predicted task ids before rollout execution", () => {
    const reply = [
      '<file path="tool_guidance.md">Stop retrying run_equation after 2 TypeErrors.</file>',
      '<diagnosis problem="NEW">Repeated run_equation dict TypeError retries</diagnosis>',
      "<predicted>cycle-1|CVI, cycle-1|CVS</predicted>",
      "<rationale>Qwen retries dict output 12 times while scalar output succeeds.</rationale>",
      "<notes>observed in CVI rollout</notes>",
    ].join("\n");
    const manifest = parseSimManifest(reply, "fallback");
    expect(manifest).toEqual({
      citedProblemId: undefined,
      rootCause: "Repeated run_equation dict TypeError retries",
      predicted: ["cycle-1|CVI", "cycle-1|CVS"],
      rationale: "Qwen retries dict output 12 times while scalar output succeeds.",
    });
  });

  it("feeds Full SIM to Proposer and Selector across model transitions and records missed predictions", async () => {
    const dir = tmpDir();
    const simStore = new SimStore("quant-crsi", {
      filePath: path.join(dir, "SIM.json"),
      useMongo: false,
    });

    const executeOrder: string[] = [];
    const executor: Executor = async (tree, label) => {
      executeOrder.push(label);
      const sys = materialize(tree);
      const output = sys.includes("stop after 2 tool errors")
        ? '{"summary":"clean-bounded"}'
        : sys.includes("scalar metrics")
          ? '{"summary":"clean"}'
          : '{"summary":"raw"}';
      return { ok: true, delivered: true, output, trajectory: `final output:\n${output}`, error: "" };
    };

    // Round 1 (DeepSeek source): opens P1, predicts fixing case-A and case-B, evaluator marks case-B missed.
    const r1Prompts: Record<string, string> = {};
    const r1 = await runHarness2(
      {
        taskId: "quant-dev-r1",
        task: "Produce quant_report JSON.",
        domain: "quant-crsi",
        baseTree: BASE,
        solver: { provider: "vllm-2", model: "DeepSeek-V4.1-Flash-1017" },
        k: 1,
        selectionPool: "mixed",
        simCondition: "full",
        simRound: 1,
        libraryRoot: dir,
      },
      {
        execute: executor,
        simStore,
        evaluateSimOutcome: ({ predicted }) => ({
          passed: 1,
          total: 2,
          fixed: [predicted[0]],
          missed: predicted.slice(1),
        }),
        propose: async (prompt, label) => {
          r1Prompts[label] = prompt;
          if (label === "select") {
            const m = /## (a\d)\s*\n\s*\{"summary":"clean"\}/.exec(prompt);
            return `<why>clean artifact</why>\n\`\`\`choice\n${m?.[1] ?? "a1"}\n\`\`\``;
          }
          if (label === "experience") return "NO_ENTRY";
          if (label.startsWith("agg") || label.startsWith("inv")) {
            return [
              '<file path="tool_guidance.md">Emit scalar metrics in run_equation.</file>',
              '<diagnosis problem="NEW">run_equation dict return TypeError</diagnosis>',
              "<predicted>case-A, case-B</predicted>",
              "<rationale>Scalar return avoids float(dict) TypeError.</rationale>",
              "<notes>added scalar rule</notes>",
            ].join("\n");
          }
          return "<notes>KEEP_BASE</notes>";
        },
      },
    );

    expect(r1.status).toBe("ok");
    expect(r1.simEntry?.id).toBe("P1");
    expect(r1.simEntry?.attempts[0].fixed).toEqual(["case-A"]);
    expect(r1.simEntry?.attempts[0].missed).toEqual(["case-B"]);
    expect(r1.simEntry?.attempts[0].provenance.modelFamily).toBe("deepseek");

    // Round 2 (Qwen target on evolved tree): both Proposer and Selector see P1's DeepSeek history + missed=[case-B].
    const r2Prompts: Record<string, string> = {};
    const r2 = await runHarness2(
      {
        taskId: "quant-dev-r2",
        task: "Produce quant_report JSON.",
        domain: "quant-crsi",
        baseTree: r1.adoptedTree,
        solver: { provider: "vllm-4", model: "Qwen3.8-Flash-Next" },
        k: 1,
        selectionPool: "mixed",
        simCondition: "full",
        simRound: 2,
        libraryRoot: dir,
      },
      {
        execute: executor,
        simStore,
        evaluateSimOutcome: ({ predicted }) => ({
          passed: 2,
          total: 2,
          fixed: predicted,
          missed: [],
        }),
        propose: async (prompt, label) => {
          r2Prompts[label] = prompt;
          if (label === "select") {
            const m = /## (a\d)\s*\n\s*\{"summary":"clean-bounded"\}/.exec(prompt);
            return `<why>retains scalar rule and bounds retries</why>\n\`\`\`choice\n${m?.[1] ?? "a1"}\n\`\`\``;
          }
          if (label === "experience") return "NO_ENTRY";
          if (label.startsWith("agg") || label.startsWith("inv")) {
            return [
              '<file path="tool_guidance.md">Emit scalar metrics in run_equation; stop after 2 tool errors.</file>',
              '<diagnosis problem="P1">run_equation dict return TypeError</diagnosis>',
              "<predicted>case-B</predicted>",
              "<rationale>Qwen needs explicit 2-error stop condition on top of scalar rule.</rationale>",
              "<notes>extended P1 for Qwen</notes>",
            ].join("\n");
          }
          return "<notes>KEEP_BASE</notes>";
        },
      },
    );

    expect(r2Prompts["inv1.a1"]).toContain("# HOW TO USE SELF-IMPROVEMENT MEMORY (SIM)");
    expect(r2Prompts["inv1.a1"]).toContain("P1 (opened r1): run_equation dict return TypeError");
    expect(r2Prompts["inv1.a1"]).toContain("missed=[case-B]");
    expect(r2Prompts.select).toContain("# HOW TO USE SELF-IMPROVEMENT MEMORY (SIM)");
    expect(r2Prompts.select).toContain("P1 (opened r1)");
    expect(r2.simEntry?.id).toBe("P1");
    expect(r2.simEntry?.attempts).toHaveLength(2);
    expect(r2.simEntry?.attempts[0].supersededByRound).toBe(2);
    expect(r2.simEntry?.attempts[1].provenance.modelFamily).toBe("qwen");
  });

  it("hydrates SIM from Mongo before rendering, leaves unverified predictions empty, and records rejected proposals", async () => {
    const dir = tmpDir();
    const mongoDocs = new Map<string, Record<string, unknown>>();
    vi.spyOn(MongoWrapper, "getDb").mockReturnValue({
      collection: () => ({
        findOne: async (q: { _id: string }) => mongoDocs.get(q._id) ?? null,
        updateOne: async (q: { _id: string }, u: { $set: Record<string, unknown> }) => {
          mongoDocs.set(q._id, { _id: q._id, ...u.$set });
        },
      }),
    } as never);

    // Seed MongoDB with P1 from an earlier host/process.
    const remoteSeed = new SimStore("mongo-sim-domain", {
      filePath: path.join(dir, "remote-seed.json"),
      useMongo: true,
    });
    await remoteSeed.recordAttempt({
      rootCause: "Prior Mongo root cause",
      round: 1,
      sample: "seed",
      accepted: true,
      what: "prior edit",
      files: ["systemprompt.md"],
      rationale: "seeded in mongo",
      predicted: ["seed-case"],
      fixed: ["seed-case"],
      missed: [],
      passed: 1,
      total: 1,
      modelId: "DeepSeek-V4.1-Flash-1017",
    });

    // Fresh cold store with no local file: runHarness2 must call load() before rendering!
    const freshStore = new SimStore("mongo-sim-domain", {
      filePath: path.join(dir, "fresh-local.json"),
      useMongo: true,
    });
    const seenPrompts: string[] = [];
    const acceptedUnverified = await runHarness2(
      {
        taskId: "unverified-task",
        task: "Answer JSON.",
        domain: "mongo-sim-domain",
        baseTree: BASE,
        solver: { provider: "vllm-4", model: "Qwen3.8-Flash-Next" },
        k: 1,
        selectionPool: "mixed",
        simCondition: "full",
        simRound: 2,
        libraryRoot: dir,
      },
      {
        simStore: freshStore,
        execute: async (tree) => {
          const out = materialize(tree).includes("new-rule") ? '{"ok":2}' : '{"ok":1}';
          return { ok: true, delivered: true, output: out, trajectory: out, error: "" };
        },
        propose: async (prompt, label) => {
          seenPrompts.push(`${label}:${prompt}`);
          if (label === "select") {
            const m = /## (a\d)\s*\n\s*\{"ok":2\}/.exec(prompt);
            return `<why>picked new</why>\n\`\`\`choice\n${m?.[1] ?? "a1"}\n\`\`\``;
          }
          if (label === "experience") return "NO_ENTRY";
          if (label.startsWith("inv") || label.startsWith("agg")) {
            return [
              '<file path="tool_guidance.md">new-rule</file>',
              '<diagnosis problem="NEW">Unverified edit diagnosis</diagnosis>',
              "<predicted>case-unverified</predicted>",
              "<rationale>No evaluator provided.</rationale>",
              "<notes>added new-rule</notes>",
            ].join("\n");
          }
          return "<notes>KEEP_BASE</notes>";
        },
      },
    );

    expect(seenPrompts.some((p) => p.includes("Prior Mongo root cause"))).toBe(true);
    // Without evaluateSimOutcome, fixed & missed stay empty rather than falsely claiming fixed!
    expect(acceptedUnverified.simEntry?.attempts[0].fixed).toEqual([]);
    expect(acceptedUnverified.simEntry?.attempts[0].missed).toEqual([]);
    expect(freshStore.snapshot().problems).toHaveLength(2);

    // Rejected proposal (base rollout beats proposed edit in mixed pool) is recorded with accepted=false!
    const rejectedRun = await runHarness2(
      {
        taskId: "rejected-task",
        task: "Answer JSON.",
        domain: "mongo-sim-domain",
        baseTree: BASE,
        solver: { provider: "vllm-4", model: "Qwen3.8-Flash-Next" },
        k: 1,
        selectionPool: "mixed",
        simCondition: "full",
        simRound: 3,
        libraryRoot: dir,
      },
      {
        simStore: freshStore,
        execute: async (tree) => {
          const out = materialize(tree).includes("worse-edit") ? '{"worse":true}' : '{"base_better":true}';
          return { ok: true, delivered: true, output: out, trajectory: out, error: "" };
        },
        propose: async (prompt, label) => {
          if (label === "select") {
            const m = /## (a\d)\s*\n\s*\{"base_better":true\}/.exec(prompt);
            return `<why>base outperformed worse edit</why>\n\`\`\`choice\n${m?.[1] ?? "a1"}\n\`\`\``;
          }
          if (label === "experience") return "NO_ENTRY";
          if (label.startsWith("inv") || label.startsWith("agg")) {
            return [
              '<file path="guardrails.md">worse-edit</file>',
              '<diagnosis problem="NEW">Overly aggressive truncation</diagnosis>',
              "<predicted>case-reg</predicted>",
              "<rationale>Tried aggressive cut.</rationale>",
              "<notes>tried worse-edit</notes>",
            ].join("\n");
          }
          return "<notes>KEEP_BASE</notes>";
        },
      },
    );

    expect(rejectedRun.chosenTreeIsBase).toBe(true);
    expect(rejectedRun.simEntry?.attempts[0].accepted).toBe(false);
    expect(rejectedRun.simEntry?.attempts[0].missed).toEqual(["case-reg"]);
  });
});
