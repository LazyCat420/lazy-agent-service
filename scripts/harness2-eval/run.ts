/**
 * Harness² improvement benchmark (documentation chapter 13 §10). Every number comes from FRESH
 * solver attempts of a fixed harness, never from the attempts the loop used to choose it.
 *
 *   base         the base harness
 *   handwritten  a hand-written harness (a reference ceiling, never part of the loop)
 *   solo-<v>     the harness the loop adopts for the task, starting from an EMPTY library
 *   chain-<v>    the same, with the tasks run in order in one domain, so each reads earlier lessons
 *   v = blind    the loop as shipped: the improver is never told which tools the solver has
 *   v = told     the improver also gets a neutral note on one of the solver's tools (bench.domainGuidance)
 *
 * Tripwires stop the run (exit 3) when a measurement would be invalid: the assembled system prompt
 * changes size between solver calls, the solver is offered a different tool set, or an attempt
 * hits the context exhaustion guard. Every attempt records each tool it called.
 *
 * Spends real model calls on the Jetson (solver) and the Spark (improver); check the trading
 * cycle is idle first. Resumable: finished units stay in <state>/units.json and libraries in
 * <state>/library, so a stopped run continues where it left off. <state>/meta.json holds the
 * offered tool set and the prompt sizes seen.
 *
 *   cd agents/lazy-agent-service      # the primary checkout, never a .worktrees/ copy
 *   testrun --mem 3G --max-time 150m -- npx tsx scripts/harness2-eval/run.ts --name=s2 --tasks=10 --r=4 \
 *     "--lanes=solo-blind,base;solo-told,handwritten" [--pause=01:08-01:40] [--state=<dir>]
 *   python3 scripts/harness2-eval/report.py <state>/units.json
 */
import { BASE, HANDWRITTEN, TOOL_NOTE, blocked, cleanup, makeTask, mod, pool, score } from "./common.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const arg = (k: string, d: string) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split("=").slice(1).join("=");
const NAME = arg("name", "main");
const NTASKS = Number(arg("tasks", "10"));
const R = Number(arg("r", "4"));
const LANES = arg("lanes", "solo-blind,base;solo-told,handwritten").split(";").map((l) => l.split(",").filter(Boolean));
const PAUSE = arg("pause", ""); // no new unit starts inside this UTC window, e.g. 01:08-01:40
const STATE_DIR = arg("state", path.join(os.tmpdir(), "harness2-eval", NAME));
fs.mkdirSync(STATE_DIR, { recursive: true });
process.env.HARNESS2_LIBRARY_PATH = path.join(STATE_DIR, "library"); // persists across restarts
const STATE = path.join(STATE_DIR, "units.json");
const META = path.join(STATE_DIR, "meta.json");
const units: Record<string, any> = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const writeJson = (file: string, value: unknown) => (fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 1)), fs.renameSync(file + ".tmp", file));
const save = () => writeJson(STATE, units);
const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

function paused(): boolean {
  if (!PAUSE) return false;
  const [a, b] = PAUSE.split("-");
  const now = new Date().toISOString().slice(11, 16);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
async function untilUnpaused() {
  let said = false;
  while (paused()) {
    if (!said) {
      log(`paused (${PAUSE} UTC)`);
      said = true;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const S = await mod("src/services/harness2/Harness2Service.ts");
const LocalProviderGateway = (await mod("src/services/local-provider/index.ts")).default;
const SystemPromptAssembler = (await mod("src/services/system-prompt/index.ts")).default;
const AgenticToolResolver = (await mod("src/services/AgenticToolResolver.ts")).default;
const ToolOrchestratorService = (await mod("src/services/ToolOrchestratorService.ts")).default;

// ── Tripwires ─────────────────────────────────────────────────────────────────────────────────
// The assembled prompt holds no harness text (the tree goes in as its own system message), so
// only the date line may vary between solver calls. Load the tools-service catalog first, so the
// first attempt is offered the same tools as the rest.
await ToolOrchestratorService.ensureSchemas();
const MAX_PROMPT_DRIFT = 500; // chars
const meta = { promptChars: {} as Record<string, [number, number]>, offeredTools: {} as Record<string, number>, trips: [] as string[] };
const saveMeta = () => writeJson(META, meta);
function trip(why: string): never {
  log(`TRIPWIRE: ${why}; stopping (finished units are kept)`);
  meta.trips.push(`${new Date().toISOString()} ${why}`);
  saveMeta();
  process.exit(3);
}
const assemble = SystemPromptAssembler.prototype.assemble;
SystemPromptAssembler.prototype.assemble = async function (ctx: any) {
  const r = await assemble.call(this, ctx);
  const key = `${ctx.project ?? "-"}|${ctx.agent ?? "direct"}`;
  const n = String(r.prompt).length;
  const [lo, hi] = meta.promptChars[key] ?? [n, n];
  meta.promptChars[key] = [Math.min(lo, n), Math.max(hi, n)];
  if (Math.max(hi, n) - Math.min(lo, n) > MAX_PROMPT_DRIFT) trip(`the assembled system prompt for ${key} went from ${lo}-${hi} to ${n} chars`);
  return r;
};
const resolve = AgenticToolResolver.resolve;
AgenticToolResolver.resolve = async function (...args: any[]) {
  const r = await resolve.apply(this, args);
  const names = (r.finalTools as Array<{ name: string }>).map((t) => t.name).sort().join(",");
  meta.offeredTools[names] = (meta.offeredTools[names] ?? 0) + 1;
  if (Object.keys(meta.offeredTools).length > 1) trip(`the solver was offered ${Object.keys(meta.offeredTools).length} different tool sets`);
  return r;
};
const EXHAUSTED = /context window exhausted/i;

const served = async (instance: string) =>
  ((await LocalProviderGateway.discoverModelsForInstance(instance, { timeoutMs: 15_000, enrich: false })) as Array<{ name: string }>).map((m) => m.name);
const [solverModels, improverModels] = await Promise.all([served("vllm"), served("vllm-2")]);
if (!solverModels.length || !improverModels.length) throw new Error(`a model server serves nothing: vllm=${solverModels} vllm-2=${improverModels}`);
const solver = { provider: "vllm", model: solverModels[0], toolsEnabled: true };
const improver = { provider: "vllm-2", model: improverModels[0] };
const realPropose = S.makeProposer(improver);
const tasks = Array.from({ length: NTASKS }, (_, i) => makeTask(i));

/** Calls per tool name, from the trajectory's `tool <name>(...)` lines. */
function toolCalls(trajectory: string) {
  const calls: Record<string, number> = {};
  for (const m of trajectory.matchAll(/^tool (\w+)\(/gm)) calls[m[1]] = (calls[m[1]] ?? 0) + 1;
  return calls;
}

async function freshAttempts(key: string, tree: Record<string, string>, task: ReturnType<typeof makeTask>) {
  const execute = S.makeExecutor({ taskId: task.id, task: task.text, domain: "eval", solver } as any, { timeoutMs: 5 * 60_000 });
  return pool(2, Array.from({ length: R }, (_, j) => async () => {
    const r = await execute(tree, `${key}#${j}`);
    const traj = String(r.trajectory);
    if (EXHAUSTED.test(String(r.output)) || EXHAUSTED.test(traj)) trip(`${key}#${j} hit the context exhaustion guard`);
    const tools = toolCalls(traj);
    return { ...score(r.output || "", task), ok: r.ok, calc: tools.evaluate_expression ?? 0, tools, error: r.error || "", tail: String(r.output).slice(-240) };
  }));
}

async function loopUnit(arm: string, task: ReturnType<typeof makeTask>) {
  const [kind, variant] = arm.split("-");
  const domain = kind === "solo" ? `solo-${variant}-${task.id}` : `chain-${variant}`;
  const seen: Record<string, boolean> = {};
  const propose = async (p: string, label: string) => ((seen[label] = p.includes(TOOL_NOTE.slice(0, 60))), realPropose(p, label));
  const t0 = Date.now();
  const res = await S.runHarness2(
    { taskId: task.id, task: task.text, domain, baseTree: BASE, solver, improver, k: 1, ...(variant === "told" ? { bench: { domainGuidance: TOOL_NOTE } } : {}) },
    { propose },
  );
  const rollouts = Object.entries(res.result?.rollouts ?? {}) as Array<[string, any]>;
  for (const [label, v] of rollouts) if (EXHAUSTED.test(String(v.output))) trip(`${arm}/${task.id} loop rollout ${label} hit the context exhaustion guard`);
  return {
    status: res.status, learned: res.learned, errors: res.errors, chosen: res.selection?.chosenLabel, chosenTreeIsBase: res.chosenTreeIsBase,
    deliveredCorrect: score(res.output || "", task).correct,
    inLoop: Object.fromEntries(rollouts.map(([label, v]) => [label, score(v.output || "", task).correct])),
    inLoopTools: Object.fromEntries(rollouts.map(([label, v]) => [label, toolCalls(String(v.trajectory ?? ""))])),
    adoptedTree: res.adoptedTree, toolNoteSeen: seen,
    stages: (res.result?.stages ?? []).map((s: any) => ({ label: s.label, keptBase: s.keptBase, fellBack: s.fellBack, error: String(s.error || "").slice(0, 200) })),
    lesson: res.experience?.entry ? { lesson: res.experience.entry.lesson, confidence: res.experience.entry.confidence } : null,
    libraryBefore: res.libraryEntriesBefore, loopMs: Date.now() - t0,
  };
}

async function unit(arm: string, task: ReturnType<typeof makeTask>) {
  const key = `${arm}/${task.id}`;
  if (units[key]?.attempts) return;
  await untilUnpaused();
  let tree: Record<string, string> | undefined = arm === "base" ? BASE : arm === "handwritten" ? HANDWRITTEN : units[key]?.loop?.adoptedTree;
  if (arm.includes("-") && !units[key]?.loop) {
    log(`${key}: loop run`);
    units[key] = { loop: await loopUnit(arm, task) };
    save();
    saveMeta();
    const L = units[key].loop;
    log(`${key}: loop ${L.status} chosen=${L.chosen} base=${L.chosenTreeIsBase} learned=${L.learned} libraryBefore=${L.libraryBefore} toolNote=${JSON.stringify(L.toolNoteSeen)} ${Math.round(L.loopMs / 1000)}s`);
    tree = L.adoptedTree;
  }
  if (!tree) {
    units[key] = { ...(units[key] ?? {}), attempts: [], note: "no adopted tree" };
    return save();
  }
  const attempts = await freshAttempts(key, tree, task);
  units[key] = { ...(units[key] ?? {}), attempts };
  save();
  saveMeta();
  log(`${key}: ${attempts.filter((a) => a.correct).length}/${R} correct (calculator used in ${attempts.filter((a) => a.calc > 0).length})`);
}

log(`harness2 eval ${NAME}: solver ${solver.model}, improver ${improver.model}, tasks=${NTASKS} r=${R} lanes=${JSON.stringify(LANES)} pause=${PAUSE || "none"} state=${STATE_DIR}`);
// Chain arms must run in task order; every lane does, so a lane may hold a chain arm.
await Promise.all(LANES.map(async (arms) => {
  for (const t of tasks) for (const arm of arms) await unit(arm, t);
}));
saveMeta();
log(`done; prompt sizes ${JSON.stringify(meta.promptChars)}; ${Object.keys(meta.offeredTools).length} offered tool set(s); blocked hosts: ${JSON.stringify([...blocked])}`);
cleanup();
process.exit(0);
