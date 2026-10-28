import { Router } from "express";
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { LOCAL_PROVIDER_TYPES } from "../services/local-provider/constants.ts";
import LocalProviderGateway from "../services/local-provider/index.ts";
import { DEFAULT_IMPROVER, type Harness2Request, type ModelRef } from "../services/harness2/Harness2Service.ts";
import { activeRun, cancelRun, getRun, startRun, waitRun } from "../services/harness2/Harness2Jobs.ts";
import { Library } from "../services/harness2/Library.ts";
import { validateTree } from "../services/harness2/HarnessTree.ts";

const router = Router();

/** Caller-chosen ids become directory names: no leading dot, no separators. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BENCH_KEYS = ["work", "domainGuidance", "deliverableWord", "domainWord", "yardstick"] as const;
/** Upstream spec.py: prompt slots describe the WORK, never its measurement. */
const MEASUREMENT_WORDS = ["benchmark", "evaluation", "grader", "rubric", "score"];
const MAX_TASK_CHARS = 200_000;

/** "vllm", "vllm-2", "lm-studio-3": a local provider type, optionally with an instance number. */
const isLocal = (provider: string) => (LOCAL_PROVIDER_TYPES as ReadonlySet<string>).has(provider.replace(/-\d+$/, ""));

type Checked = { req: Harness2Request; preflight: boolean } | { error: string };

function modelRef(value: unknown, role: string): ModelRef | string {
  const m = value as Partial<ModelRef> | undefined;
  if (!m || typeof m.provider !== "string" || !m.provider) return `${role}.provider is required`;
  if (m.model !== undefined && typeof m.model !== "string") return `${role}.model must be a string`;
  if (!isLocal(m.provider) && process.env.HARNESS2_ALLOW_CLOUD !== "1") {
    return `${role}.provider ${m.provider} is not a local provider; harness2 runs local models only (set HARNESS2_ALLOW_CLOUD=1 to allow cloud)`;
  }
  return { provider: m.provider, model: m.model ?? "", thinkingEnabled: Boolean(m.thinkingEnabled), toolsEnabled: Boolean(m.toolsEnabled) };
}

function validateTaskAndDomainIdentifiers(
  body: Record<string, unknown>,
): { taskId: string; task: string; domain: string } | { error: string } {
  const { taskId, task, domain } = body as {
    taskId?: unknown;
    task?: unknown;
    domain?: unknown;
  };
  if (
    typeof taskId !== "string" ||
    typeof task !== "string" ||
    typeof domain !== "string" ||
    !task.trim()
  ) {
    return { error: "taskId, task and domain are required strings" };
  }
  if (!ID_RE.test(taskId)) {
    return { error: "taskId must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}" };
  }
  if (!ID_RE.test(domain)) {
    return { error: "domain must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}" };
  }
  if (task.length > MAX_TASK_CHARS) {
    return { error: `task is over ${MAX_TASK_CHARS} chars` };
  }
  return { taskId, task, domain };
}

function validateBaseTreeMap(
  rawTree: unknown,
): { baseTree: Record<string, string> } | { error: string } {
  if (!rawTree || typeof rawTree !== "object" || Array.isArray(rawTree)) {
    return { error: "baseTree is required" };
  }
  const baseTree = rawTree as Record<string, unknown>;
  if (Object.values(baseTree).some((v) => typeof v !== "string")) {
    return { error: "baseTree values must be file text strings" };
  }
  try {
    validateTree(baseTree as Record<string, string>);
  } catch (error) {
    return {
      error: `baseTree invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { baseTree: baseTree as Record<string, string> };
}

function validateRecursionAndModeFields(
  body: Record<string, unknown>,
): { k: number; width: number } | { error: string } {
  const k = Number(body.k ?? 1);
  if (!Number.isInteger(k) || k < 1 || k > 4) {
    return { error: "k must be an integer 1..4" };
  }
  const width = Number(body.width ?? 2);
  if (!Number.isInteger(width) || width < 1 || width > 4) {
    return { error: "width must be an integer 1..4" };
  }
  if (
    body.mode !== undefined &&
    body.mode !== "parallel" &&
    body.mode !== "sequential"
  ) {
    return { error: "mode must be parallel or sequential" };
  }
  if (
    body.selectionPool !== undefined &&
    body.selectionPool !== "finals" &&
    body.selectionPool !== "mixed"
  ) {
    return { error: "selectionPool must be finals or mixed" };
  }
  if (body.seed !== undefined && !Number.isInteger(body.seed)) {
    return { error: "seed must be an integer" };
  }
  return { k, width };
}

function validateBenchSlots(
  rawBench: unknown,
): { bench: Harness2Request["bench"] } | { error: string } {
  if (rawBench === undefined) return { bench: undefined };
  if (!rawBench || typeof rawBench !== "object" || Array.isArray(rawBench)) {
    return { error: "bench must be an object" };
  }
  const slots = rawBench as Record<string, unknown>;
  const unknown = Object.keys(slots).filter(
    (key) => !(BENCH_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length) {
    return {
      error: `bench has unknown slots: ${unknown.join(", ")} (allowed: ${BENCH_KEYS.join(", ")})`,
    };
  }
  for (const [key, value] of Object.entries(slots)) {
    if (typeof value !== "string" || value.length > 20_000) {
      return {
        error: `bench.${key} must be a string of at most 20,000 chars`,
      };
    }
    const word =
      key === "work"
        ? undefined
        : MEASUREMENT_WORDS.find((w) => value.toLowerCase().includes(w));
    if (word) {
      return {
        error: `bench.${key} must describe the WORK, not its measurement (found "${word}")`,
      };
    }
  }
  return { bench: slots as Harness2Request["bench"] };
}

/** Every request check that needs no network. */
function check(body: Record<string, unknown>): Checked {
  const idRes = validateTaskAndDomainIdentifiers(body);
  if ("error" in idRes) return idRes;
  const { taskId, task, domain } = idRes;

  const solver = modelRef(body.solver, "solver");
  if (typeof solver === "string") return { error: solver };
  if (!solver.model) return { error: "solver.model is required" };
  const improver =
    body.improver === undefined
      ? { ...DEFAULT_IMPROVER }
      : modelRef(body.improver, "improver");
  if (typeof improver === "string") return { error: improver };

  const treeRes = validateBaseTreeMap(body.baseTree);
  if ("error" in treeRes) return treeRes;

  const modeRes = validateRecursionAndModeFields(body);
  if ("error" in modeRes) return modeRes;

  const benchRes = validateBenchSlots(body.bench);
  if ("error" in benchRes) return benchRes;

  const req: Harness2Request = {
    taskId,
    task,
    domain,
    baseTree: treeRes.baseTree,
    bench: benchRes.bench,
    k: modeRes.k,
    width: modeRes.width,
    mode: body.mode as Harness2Request["mode"],
    selectionPool: body.selectionPool as Harness2Request["selectionPool"],
    seed: body.seed as number | undefined,
    solver,
    improver,
    project: typeof body.project === "string" ? body.project : undefined,
    username: typeof body.username === "string" ? body.username : undefined,
  };
  return { req, preflight: body.preflight !== false };
}

/**
 * A14: confirm that each local model is served before spending rollouts on it, and give the
 * default improver the model its provider serves today. Returns an error, or null.
 */
async function preflight(req: Harness2Request): Promise<{ status: number; error: string } | null> {
  const roles: Array<[string, ModelRef]> = [["solver", req.solver], ["improver", req.improver!]];
  for (const [role, ref] of roles) {
    if (!isLocal(ref.provider)) continue;
    let served: string[];
    try {
      served = (await LocalProviderGateway.discoverModelsForInstance(ref.provider, { timeoutMs: 5_000, enrich: false })).map((m) => m.name);
    } catch (error) {
      return { status: 502, error: `could not list the models ${ref.provider} serves: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!served.length) return { status: 400, error: `${role}.provider ${ref.provider} serves no models (unknown instance, or offline)` };
    if (!ref.model && role === "improver") ref.model = served[0];
    if (!served.includes(ref.model)) {
      return { status: 400, error: `${role}.model ${ref.model} is not served by ${ref.provider} (serves: ${served.join(", ")})` };
    }
  }
  return null;
}

/**
 * POST /harness2/run
 * One task through Harness² recursive harnessing: k base rollouts, Propose–Probe–Compose
 * (parallel or sequential), blind selection, experience reflection, library update.
 * Answers 202 with a run id to poll; `wait: true` answers with the finished run record instead
 * and cancels the run if the client disconnects. One run at a time per domain (409).
 */
router.post(
  "/run",
  asyncHandler(async (req, res) => {
    const body = (req.body || {}) as Record<string, unknown>;
    const checked = check(body);
    if ("error" in checked) return res.status(400).json({ error: checked.error });
    const run = checked.req;
    if (checked.preflight) {
      const problem = await preflight(run);
      if (problem) return res.status(problem.status).json({ error: problem.error });
    } else if (!run.improver?.model) {
      return res.status(400).json({ error: "improver.model is required when preflight is off" });
    }
    const started = startRun(run);
    if ("conflict" in started) {
      return res.status(409).json({ error: `a harness2 run is already active in domain ${run.domain}`, runId: started.conflict });
    }
    const { runId } = started.record;
    if (body.wait !== true) {
      return res.status(202).json({ runId, status: "running", poll: `/harness2/runs/${runId}`, cancel: `/harness2/runs/${runId}/cancel` });
    }
    res.on("close", () => {
      if (!res.writableFinished) cancelRun(runId);
    });
    res.json(await waitRun(runId));
  }),
);

/** GET /harness2/runs/:runId — the run record (status running, done, cancelled, error or interrupted). */
router.get(
  "/runs/:runId",
  asyncHandler(async (req, res) => {
    const record = getRun(String(req.params.runId));
    if (!record) return res.status(404).json({ error: "no such run" });
    res.json(record);
  }),
);

/** POST /harness2/runs/:runId/cancel — abort a running run; it finishes with status cancelled. */
router.post(
  "/runs/:runId/cancel",
  asyncHandler(async (req, res) => {
    const runId = String(req.params.runId);
    if (cancelRun(runId)) return res.status(202).json({ runId, status: "cancelling" });
    const record = getRun(runId);
    if (!record) return res.status(404).json({ error: "no such run" });
    res.status(409).json({ error: `run is ${record.status}, not running`, runId });
  }),
);

/** GET /harness2/library/:domain — the domain's INDEX and entry ids. */
router.get(
  "/library/:domain",
  asyncHandler(async (req, res) => {
    const domain = String(req.params.domain);
    if (!ID_RE.test(domain)) return res.status(400).json({ error: "invalid domain" });
    const lib = new Library(domain);
    res.json({ domain: lib.domain, entries: lib.entriesByAge(), context: lib.contextText() });
  }),
);

/** DELETE /harness2/library/:domain/:taskId — drop one stored lesson (upstream `forget`). */
router.delete(
  "/library/:domain/:taskId",
  asyncHandler(async (req, res) => {
    const domain = String(req.params.domain);
    const taskId = String(req.params.taskId);
    if (!ID_RE.test(domain) || !ID_RE.test(taskId)) return res.status(400).json({ error: "invalid domain or taskId" });
    const busy = activeRun(domain);
    if (busy) return res.status(409).json({ error: `a harness2 run is active in domain ${domain}; retry when it finishes`, runId: busy });
    const removed = new Library(domain).forget([taskId]);
    if (!removed.length) return res.status(404).json({ error: "no such entry" });
    res.json({ domain, removed });
  }),
);

export default router;
