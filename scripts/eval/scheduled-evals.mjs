#!/usr/bin/env node
/**
 * Scheduled eval runner: runs a set of scored evals, appends one dated score line to the tracked
 * history `scripts/eval/history.jsonl`, and fails when the pass count drops below the previous
 * recorded run of the same suite set.
 *
 * Suites (each result is graded pass / weak / fail):
 *   security  scripts/benchmarks/security-bench.mts   offline; one check = pass or fail
 *   redteam   scripts/benchmarks/sandbox-redteam.mts  offline; wall PASS / UNPROVEN (weak) / FAIL
 *   basic     scripts/eval/run-basic-eval.mjs         LIVE: deployed LAS + GLM judge on vLLM; PASS/WEAK/FAIL
 *   chaos     run-basic-eval.mjs chaos questions      LIVE: LAS with LAS_EVAL_CHAOS=1, --no-judge
 *   harness2  scripts/harness2-eval/run.ts            LIVE, hours of Jetson + Spark model calls;
 *             attempt correct = pass, total or ids right = weak, else fail
 *
 * Usage: node scripts/eval/scheduled-evals.mjs [--suites security,redteam] [--live] [--history <file>] [--out <dir>]
 *   --suites   comma list (default: security,redteam — the suites that need no live service)
 *   --live     add basic,chaos (needs the env vars in scripts/eval/README.md)
 *   --history  history file (default scripts/eval/history.jsonl)
 *   --out      directory for raw suite outputs (default: a fresh temp dir)
 *
 * The comparison baseline is the last history line with the same suite set that neither
 * regressed nor errored, so a bad night never lowers the bar for the next one.
 * Exit codes: 0 pass count >= baseline (or first run); 1 pass count dropped; 2 a suite produced no
 * valid result (crash, unparseable output, LAS restart mid-run, harness2 tripwire). Such a run is
 * still appended, marked `error`, and never becomes a baseline.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OFFLINE = ["security", "redteam"];
const LIVE = ["basic", "chaos"];
const requested = opt("suites", OFFLINE.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const SUITES = [...new Set(argv.includes("--live") ? [...requested, ...LIVE] : requested)].sort();
const HISTORY = path.resolve(ROOT, opt("history", "scripts/eval/history.jsonl"));
const OUT = opt("out", null) ? path.resolve(ROOT, opt("out", null)) : fs.mkdtempSync(path.join(os.tmpdir(), "las-scheduled-evals-"));
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");

/** Run a child with inherited stderr; return its exit status and captured stdout (echoed). */
function run(cmd, args) {
  console.log(`[evals] $ ${[path.relative(ROOT, cmd) || cmd, ...args].join(" ")}`);
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 });
  if (res.error) throw res.error;
  process.stdout.write(res.stdout ?? "");
  return { status: res.status, stdout: res.stdout ?? "" };
}

const tally = (grades) => ({
  pass: grades.filter((g) => g === "pass").length,
  weak: grades.filter((g) => g === "weak").length,
  fail: grades.filter((g) => g === "fail").length,
});

/**
 * A suite result is valid only when the child exited with one of its scored exit codes and left a
 * parseable result. Anything else (crash, restart detected, tripwire) is an error, never a score.
 */
function graded(status, scoredCodes, readGrades) {
  if (!scoredCodes.includes(status)) return { error: `exit ${status} (scored only on ${scoredCodes.join("/")})` };
  const grades = readGrades();
  return grades && grades.length ? { grades } : { error: "no parseable result" };
}

function basicGrades(dir) {
  const file = path.join(dir, "results.json");
  if (!fs.existsSync(file)) return null;
  const { results } = JSON.parse(fs.readFileSync(file, "utf8"));
  return results.map((r) => String(r.grade).toLowerCase());
}

// Exit codes: security-bench and sandbox-redteam exit 1 when a check fails, which is a score.
// run-basic-eval exits 2 when the service restarted mid-run (invalid) and 1 on script errors;
// harness2 exits 3 when a tripwire invalidates the measurement.
const SUITE_RUNNERS = {
  security() {
    const file = path.join(OUT, "security.json");
    const { status } = run(TSX, ["scripts/benchmarks/security-bench.mts", "--out", file]);
    return graded(status, [0, 1], () =>
      fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).checks.map((c) => (c.pass ? "pass" : "fail")) : null,
    );
  },
  redteam() {
    const { status, stdout } = run(TSX, ["scripts/benchmarks/sandbox-redteam.mts"]);
    fs.writeFileSync(path.join(OUT, "redteam.txt"), stdout);
    // Each wall row ends with its verdict: PASS, UNPROVEN (attack dud) or FAIL (escaped).
    return graded(status, [0, 1], () => {
      const grades = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = /(PASS|UNPROVEN \(attack dud\)|FAIL \(escaped\))$/.exec(line);
        if (m) grades.push(m[1] === "PASS" ? "pass" : m[1].startsWith("UNPROVEN") ? "weak" : "fail");
      }
      return grades;
    });
  },
  basic() {
    const dir = path.join(OUT, "basic");
    const { status } = run(process.execPath, ["scripts/eval/run-basic-eval.mjs", "--out", dir]);
    return graded(status, [0], () => basicGrades(dir));
  },
  chaos() {
    const dir = path.join(OUT, "chaos");
    const { status } = run(process.execPath, [
      "scripts/eval/run-basic-eval.mjs",
      "--questions-file", "scripts/eval/chaos-questions.json",
      "--profiles", "chaos",
      "--questions", "1-5",
      "--no-judge",
      "--concurrency", "5",
      "--out", dir,
    ]);
    return graded(status, [0], () => basicGrades(dir));
  },
  harness2() {
    const state = path.join(OUT, "harness2");
    const { status } = run(TSX, ["scripts/harness2-eval/run.ts", `--name=scheduled`, `--state=${state}`]);
    const file = path.join(state, "units.json");
    return graded(status, [0], () =>
      fs.existsSync(file)
        ? Object.values(JSON.parse(fs.readFileSync(file, "utf8"))).flatMap((u) =>
            (u.attempts ?? []).map((a) => (a.correct ? "pass" : a.totalOk || a.dupsOk ? "weak" : "fail")),
          )
        : null,
    );
  },
};

const unknown = SUITES.filter((s) => !(s in SUITE_RUNNERS));
if (unknown.length) {
  console.error(`[evals] unknown suite(s): ${unknown.join(", ")}; known: ${Object.keys(SUITE_RUNNERS).join(", ")}`);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const bySuite = {};
const errors = [];
for (const suite of SUITES) {
  const result = SUITE_RUNNERS[suite]();
  if (result.error) {
    errors.push(suite);
    bySuite[suite] = { pass: 0, weak: 0, fail: 0, error: result.error };
  } else bySuite[suite] = tally(result.grades);
}
const totals = Object.values(bySuite).reduce((t, s) => ({ pass: t.pass + s.pass, weak: t.weak + s.weak, fail: t.fail + s.fail }), { pass: 0, weak: 0, fail: 0 });

const suitesKey = SUITES.join(",");
const history = fs.existsSync(HISTORY)
  ? fs.readFileSync(HISTORY, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
  : [];
const previous = history.filter((h) => h.suites === suitesKey && !h.regressed && !h.error).at(-1) ?? null;
const regressed = previous !== null && totals.pass < previous.pass;

const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout?.trim() || null;
const line = {
  date: new Date().toISOString(),
  commit,
  suites: suitesKey,
  ...totals,
  by_suite: bySuite,
  ...(regressed ? { regressed: true } : {}),
  ...(errors.length ? { error: `no valid result from: ${errors.join(", ")}` } : {}),
};
fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
fs.appendFileSync(HISTORY, `${JSON.stringify(line)}\n`);

console.log(`[evals] ${suitesKey}: pass ${totals.pass}, weak ${totals.weak}, fail ${totals.fail}`);
for (const [suite, s] of Object.entries(bySuite)) console.log(`  ${suite.padEnd(9)} pass ${s.pass} weak ${s.weak} fail ${s.fail}${s.error ? ` (${s.error})` : ""}`);
console.log(`[evals] raw outputs in ${OUT}; appended to ${HISTORY}`);
if (errors.length) {
  console.error(`[evals] FAIL: no valid result from ${errors.join(", ")}`);
  process.exit(2);
}
if (!previous) {
  console.log("[evals] first recorded run for this suite set; nothing to compare");
  process.exit(0);
}
if (regressed) {
  console.error(`[evals] FAIL: pass count ${totals.pass} < ${previous.pass} (previous run ${previous.date}, ${previous.commit ?? "?"})`);
  process.exit(1);
}
console.log(`[evals] PASS: pass count ${totals.pass} >= ${previous.pass} (previous run ${previous.date})`);
