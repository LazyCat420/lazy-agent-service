/**
 * Live check of the Harness² loop against the LAN models (documentation chapter 13 §9).
 *
 * Spends real model calls: about 9 minutes of the Jetson (solver, instance "vllm") and the DGX
 * Spark (improver, "vllm-2"). Not part of the test suite; `scripts/audit-harness2-loop.ts` is the
 * offline counterpart. Check the trading cycle is idle first, since both boxes serve it.
 *
 *   cd agents/lazy-agent-service      # the primary checkout, never a .worktrees/ copy
 *   testrun --mem 3G --max-time 75m -- npx tsx scripts/harness2-live-check.ts [--part=loop|select|all]
 *
 * Isolation: the library, run store and proxy sessions live in an OS temp directory that is
 * removed on every exit path; VAULT_SERVICE_URL and MONGO_URI are unset so nothing hydrates
 * production credentials; fetch reaches only the two model hosts and localhost. The models are
 * whatever each instance serves today, so the check does not go stale when a model is swapped.
 *
 * Part "loop" (two tasks in one domain, k=1, through the route): preflight, async run + record,
 * trivial k=1 selection, real improver replies, the learning gate, task B reading task A's lesson
 * but never its own, a base-failed run, DELETE. Part "select" (k=2, default finals pool): one
 * blind selector call that parses, an id map to the finals, and the reflection's adoption block.
 *
 * Exit 0 when nothing failed; each line reads `PASS|FAIL|SKIP <check> :: <observed>`.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = process.env.HARNESS2_LIVE_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const part = (process.argv.find((a) => a.startsWith("--part=")) ?? "--part=all").slice("--part=".length);
if (!["loop", "select", "all"].includes(part)) throw new Error(`--part must be loop, select or all (got ${part})`);

// Environment first: the service modules read it at import time, so they are imported below.
const config = JSON.parse(fs.readFileSync(path.join(REPO, "projects.json"), "utf8")).config;
const jetson = String(config.JETSON_VLLM_URL).replace(/\/+$/, "");
const spark = String(config.DGX_SPARK_VLLM_URL).replace(/\/+$/, "");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "harness2-live-"));
delete process.env.VAULT_SERVICE_URL;
delete process.env.MONGO_URI;
process.env.RUNTIME_STORE_PATH = path.join(TMP, "run_store.json");
process.env.PRISM_PROXY_SESSIONS_FILE = path.join(TMP, "prism-proxy-sessions.json");
process.env.HARNESS2_LIBRARY_PATH = path.join(TMP, "library");
process.env.ALLOW_MISSING_PROJECTS_JSON = "1";
process.env.PROVIDER_VLLM_1_URL = jetson; // instance "vllm", as deployed
process.env.PROVIDER_VLLM_1_CONCURRENCY = "2";
process.env.PROVIDER_VLLM_2_URL = spark; // instance "vllm-2"
process.env.PROVIDER_VLLM_2_CONCURRENCY = "2";

const allowed = new Set([new URL(jetson).host, new URL(spark).host]);
const blocked = new Set<string>();
const require = createRequire(path.join(REPO, "package.json"));
// As boot.ts does: the provider client passes an undici dispatcher, which needs undici's own fetch.
const realFetch = require("undici").fetch as typeof fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (allowed.has(u.host) || ["127.0.0.1", "localhost"].includes(u.hostname)) return realFetch(input, init);
  blocked.add(u.host);
  throw new Error(`harness2 live check: external fetch blocked: ${u.host}`);
}) as typeof fetch;
const mod = (rel: string) => import(path.join(REPO, rel));

const results: Array<{ pass: boolean | null }> = [];
const verdict = (check: string, pass: boolean | null, detail: string) => {
  results.push({ pass });
  console.log(`${pass === null ? "SKIP" : pass ? "PASS" : "FAIL"} ${check} :: ${detail}`);
};
const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);

// A deliberately weak base harness: "one sentence" fights a request for a total AND a list.
const BASE = { "systemprompt.md": "You are an accounts-payable assistant. Be brief: answer in one sentence.\n" };
const taskText = (rows: string[]) =>
  "Reconcile these invoice lines. A duplicate is a line whose invoice id already appeared; lines with different ids are " +
  "never duplicates, even when vendor and amount match. Report (1) the total of the de-duplicated lines and (2) every " +
  "duplicated invoice id.\n\n| invoice | vendor | amount |\n|---|---|---|\n" + rows.join("\n");
// Each task has a decoy: a line with another line's vendor and amount under a different id.
const TASK_A = {
  id: "recon-a",
  rows: ["| INV-101 | Acme Supplies | 1,250.00 |", "| INV-102 | Brightline | 430.50 |", "| INV-101 | Acme Supplies | 1,250.00 |", "| INV-104 | Coastal Freight | 812.25 |",
    "| INV-105 | Delta Office | 99.99 |", "| INV-104 | Coastal Freight | 812.25 |", "| INV-107 | Evergreen Labs | 2,000.00 |", "| INV-108 | Brightline | 430.50 |"],
  total: "5023.24",
  dups: ["INV-101", "INV-104"],
};
const TASK_B = {
  id: "recon-b",
  rows: ["| INV-201 | Harbor Tools | 640.00 |", "| INV-202 | Ironwood | 1,120.40 |", "| INV-203 | Harbor Tools | 640.00 |", "| INV-202 | Ironwood | 1,120.40 |",
    "| INV-205 | Juniper Media | 75.10 |", "| INV-206 | Keystone | 3,300.00 |", "| INV-205 | Juniper Media | 75.10 |", "| INV-208 | Lumen Power | 410.90 |"],
  total: "6186.40",
  dups: ["INV-202", "INV-205"],
};
/** Out of 2, computed here only (no prompt sees it): the right total, and every duplicated id. */
const score = (out: string, task: typeof TASK_A) => {
  const flat = out.replace(/[,$]/g, "");
  return Number(flat.includes(task.total) || flat.includes(task.total.replace(/0$/, ""))) + Number(task.dups.every((d) => out.includes(d)));
};
const scores = (rollouts: Record<string, any> | undefined, task: typeof TASK_A) =>
  Object.entries(rollouts ?? {}).map(([label, r]) => `${label}=${score(r.output || "", task)}/2${r.ok ? "" : "(failed)"}`).join(" ");
const stageLines = (stages: any[]) =>
  stages.map((s) => `${s.label}: keptBase=${s.keptBase} fellBack=${s.fellBack} attempts=${s.attempts}${s.error ? ` error=${JSON.stringify(String(s.error).slice(0, 160))}` : ""}`).join(" | ");
const fellBackOnProposer = (stages: any[]) => stages.filter((s) => s.fellBack && String(s.error).startsWith("proposer failed"));

let server: http.Server | undefined;
try {
  const router = (await mod("src/routes/Harness2Routes.ts")).default;
  const S = await mod("src/services/harness2/Harness2Service.ts");
  const L = await mod("src/services/harness2/Library.ts");
  const LocalProviderGateway = (await mod("src/services/local-provider/index.ts")).default;
  const served = async (instance: string) =>
    ((await LocalProviderGateway.discoverModelsForInstance(instance, { timeoutMs: 15_000, enrich: false })) as Array<{ name: string }>).map((m) => m.name);
  const [solverModels, improverModels] = await Promise.all([served("vllm"), served("vllm-2")]);
  if (!solverModels.length || !improverModels.length) throw new Error(`a model server serves nothing: vllm=${solverModels} vllm-2=${improverModels}`);
  const solver = { provider: "vllm", model: solverModels[0] };
  const improver = { provider: "vllm-2", model: improverModels[0] };
  log(`solver ${solver.provider}/${solver.model}; improver ${improver.provider}/${improver.model}; part=${part}`);

  if (part !== "select") {
    const DOMAIN = "invoice-recon-live";
    const express = require("express");
    const app = express();
    app.use(express.json({ limit: "5mb" }));
    app.use("/harness2", router);
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/harness2`;
    const post = async (url: string, payload: unknown) => {
      const res = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      return { status: res.status, json: await res.json() };
    };
    const poll = async (runId: string, limitMin = 45) => {
      const until = Date.now() + limitMin * 60_000;
      while (Date.now() < until) {
        const rec = await (await fetch(`${base}/runs/${runId}`)).json();
        if (rec.status !== "running") return rec;
        await new Promise((r) => setTimeout(r, 10_000));
      }
      throw new Error(`run ${runId} still running after ${limitMin} min`);
    };

    // 1. Preflight refuses a model the improver's server does not serve (A14).
    const stale = await post("/run", { taskId: "stale", task: taskText(TASK_A.rows), domain: DOMAIN, baseTree: BASE, solver, improver: { provider: "vllm-2", model: "not-a-served-model" } });
    verdict("preflight refuses an improver model the server does not serve", stale.status === 400 && /not served by vllm-2/.test(stale.json.error), `${stale.status} ${stale.json.error}`);

    // 2. Task A through the async route, default improver (no improver in the body).
    log("task A start");
    const startA = await post("/run", { taskId: TASK_A.id, task: taskText(TASK_A.rows), domain: DOMAIN, baseTree: BASE, solver, k: 1 });
    verdict("POST /run answers 202 with a run id", startA.status === 202 && Boolean(startA.json.runId), `${startA.status} ${JSON.stringify(startA.json)}`);
    const recA = await poll(startA.json.runId);
    const rA = recA.result;
    log(`task A ${recA.status}/${rA?.status}; stages: ${stageLines(rA?.result?.stages ?? [])}`);
    log(`task A scores: ${scores(rA?.result?.rollouts, TASK_A)}; delivered=${rA?.selection?.chosenLabel} chosenTreeIsBase=${rA?.chosenTreeIsBase}`);
    verdict("default improver resolved to the served model", recA.request?.improver?.model === improver.model, JSON.stringify(recA.request?.improver));
    verdict("task A run finished with a result", recA.status === "done" && Boolean(rA), `status=${recA.status} result.status=${rA?.status} errors=${JSON.stringify(rA?.errors)}`);
    verdict("run record on disk", fs.existsSync(path.join(TMP, "library", DOMAIN, "runs", `${recA.runId}.json`)), `runs/${recA.runId}.json`);
    verdict("k=1 finals-only: trivial selection, no selector call", rA?.selection?.trivial === true && rA?.selection?.chosenLabel === "agg1", JSON.stringify(rA?.selection));
    verdict("real improver replies were used (no stage fell back on a proposer failure)", Boolean(rA) && fellBackOnProposer(rA.result.stages).length === 0, `${rA?.result?.stages?.length} stages`);
    verdict("a successful run reflects; an entry exists iff the reflector wrote one", Boolean(rA) && rA.learned === Boolean(rA.experience?.entry), `learned=${rA?.learned}`);
    if (rA?.experience?.entry) log(`task A lesson (${rA.experience.entry.confidence.split(/\s/)[0]}): ${JSON.stringify(rA.experience.entry.lesson)}`);

    // 3. Task B, same domain, called directly with a recording proposer: it must read A's lesson.
    const prompts: Record<string, string> = {};
    const real = S.makeProposer(improver);
    const recording = async (p: string, label: string) => ((prompts[label] = p), real(p, label));
    const reqB = { taskId: TASK_B.id, task: taskText(TASK_B.rows), domain: DOMAIN, baseTree: BASE, solver, improver, k: 1 };
    log("task B start");
    const rB = await S.runHarness2(reqB, { propose: recording });
    log(`task B ${rB.status}; stages: ${stageLines(rB.result.stages)}`);
    log(`task B scores: ${scores(rB.result.rollouts, TASK_B)}; learned=${rB.learned}`);
    const stageLabels = () => Object.keys(prompts).filter((l) => /^(inv|dom|agg)\d\.a\d$/.test(l));
    if (rA?.learned) {
      const lesson = rA.experience.entry.lesson.slice(0, 40);
      const sees = stageLabels().every((l) => prompts[l].includes(`## Entry ${TASK_A.id}`) && prompts[l].includes(lesson));
      verdict("task B's every proposer reads task A's stored lesson", sees && stageLabels().length >= 3, `stages=${stageLabels().join(",")}`);
    } else {
      verdict("task B's every proposer reads task A's stored lesson", null, "task A stored no entry, so there is nothing to read");
    }
    verdict("task B never reads its own entry", stageLabels().every((l) => !prompts[l].includes(`## Entry ${TASK_B.id}`)), `stages=${stageLabels().join(",")}`);

    // 4. Re-run B: with A and B both stored, B must see A but not itself.
    if (rA?.learned && rB.learned) {
      for (const k of Object.keys(prompts)) delete prompts[k];
      log("task B re-run start");
      const rB2 = await S.runHarness2(reqB, { propose: recording });
      verdict("re-run of B reads A but not its own earlier entry",
        stageLabels().length >= 3 && stageLabels().every((l) => prompts[l].includes(`## Entry ${TASK_A.id}`) && !prompts[l].includes(`## Entry ${TASK_B.id}`)),
        `stages=${stageLabels().join(",")} status=${rB2.status}`);
    } else {
      const ctx = new L.Library(DOMAIN).contextText({ exclude: [TASK_B.id] });
      verdict("re-run of B reads A but not its own earlier entry", null, `needs both A and B stored (A=${rA?.learned}, B=${rB.learned}); context without B mentions B: ${ctx.includes(`## Entry ${TASK_B.id}`)}`);
    }

    // 5. Base failure: no improver call at all.
    log("base-failed start");
    const dead = await post("/run", { taskId: "recon-dead", task: taskText(TASK_A.rows), domain: DOMAIN, baseTree: BASE, solver: { provider: "vllm", model: "no-such-model" }, improver, preflight: false, wait: true });
    const rD = dead.json?.result;
    verdict("every base rollout failed: base-failed, zero stages, nothing learned",
      dead.status === 200 && rD?.status === "base-failed" && rD?.result?.stages?.length === 0 && rD?.learned === false,
      `${dead.status} status=${rD?.status} stages=${rD?.result?.stages?.length} errors=${JSON.stringify(rD?.errors)?.slice(0, 200)}`);

    // 6. Clean up through the DELETE route.
    const lib = await (await fetch(`${base}/library/${DOMAIN}`)).json();
    log(`library entries before cleanup (oldest first): ${JSON.stringify(lib.entries)}`);
    for (const id of lib.entries) {
      const del = await fetch(`${base}/library/${DOMAIN}/${id}`, { method: "DELETE" });
      verdict(`DELETE ${id}`, del.status === 200, String(del.status));
    }
    const after = await (await fetch(`${base}/library/${DOMAIN}`)).json();
    verdict("library empty after cleanup", after.entries.length === 0, JSON.stringify(after.entries));
  }

  if (part !== "loop") {
    // 7. k=2 with the default finals pool: the selector makes a real, blind call.
    const prompts: Record<string, string> = {};
    const real = S.makeProposer(improver);
    const recording = async (p: string, label: string) => ((prompts[label] = p), real(p, label));
    log("k=2 run start");
    const r = await S.runHarness2(
      { taskId: "recon-select", task: taskText(TASK_A.rows), domain: "invoice-recon-select", baseTree: BASE, solver, improver, k: 2 },
      { propose: recording },
    );
    const rr = r.result;
    const stages = rr?.stages ?? [];
    log(`k=2 run ${r.status}; errors=${JSON.stringify(r.errors)}; stages: ${stageLines(stages)}`);
    log(`k=2 scores: ${scores(rr?.rollouts, TASK_A)}; finals=${JSON.stringify(rr?.finals)}`);
    verdict("k=2 run finished ok", r.status === "ok", `status=${r.status}`);
    verdict("six stages, real improver replies", stages.length === 6 && fellBackOnProposer(stages).length === 0, stages.map((s: any) => s.label).join(","));
    const sel = r.selection;
    log(`selection: ${JSON.stringify({ ...sel, why: String(sel.why).slice(0, 500) })}`);
    const delivered: string[] = (rr?.finals ?? []).filter((l: string) => rr.rollouts[l]?.delivered);
    const sp = prompts.select ?? "";
    verdict("the selector was called over the finals pool", "select" in prompts && sel.pool === "finals" && !sel.trivial, `select prompt ${sp.length} chars; delivered finals=${delivered.join(",")}`);
    verdict("the real selector's reply parsed (no fallback)", sel.ok && !sel.fallback && Boolean(sel.chosenLabel), `chosen=${sel.chosenLabel} error=${sel.error ?? ""}`);
    verdict("anonymous ids map to the delivered finals", JSON.stringify(Object.values(sel.ids).sort()) === JSON.stringify([...delivered].sort()), JSON.stringify(sel.ids));
    verdict("blind: the selector prompt carries no rollout label", !/\b(base|inv|dom|agg)\d\b/.test(sp), `labels found: ${JSON.stringify(sp.match(/\b(base|inv|dom|agg)\d\b/g) ?? [])}`);
    verdict("every delivered final's output is in the selector prompt", delivered.every((l) => sp.includes(String(rr.rollouts[l].output).slice(0, 60))), delivered.join(","));
    verdict("the delivered output is the chosen rollout's", r.output === rr.rollouts[sel.chosenLabel]?.output, `chosen=${sel.chosenLabel} score=${score(r.output || "", TASK_A)}/2`);
    const ep = prompts.experience ?? "";
    verdict("the reflection sees the adoption block with the id map",
      ep.includes("# ADOPTION") && Object.entries(sel.ids).every(([id, l]) => ep.includes(`${id} → ${l}`)), `experience prompt ${ep.length} chars`);
    verdict("learned iff the reflector wrote an entry", r.learned === Boolean(r.experience?.entry), `learned=${r.learned}`);
    if (r.experience?.entry) log(`k=2 lesson (${r.experience.entry.confidence.split(/\s/)[0]}): ${JSON.stringify(r.experience.entry.lesson)}`);
  }
} catch (error) {
  verdict("live check crashed", false, error instanceof Error ? error.stack || error.message : String(error));
} finally {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  log(`blocked hosts: ${JSON.stringify([...blocked])}`);
  fs.rmSync(TMP, { recursive: true, force: true });
  const count = (p: boolean | null) => results.filter((r) => r.pass === p).length;
  console.log(`SUMMARY pass=${count(true)} fail=${count(false)} skip=${count(null)}; temp dir removed: ${!fs.existsSync(TMP)}`);
}
process.exit(results.some((r) => r.pass === false) ? 1 : 0);
