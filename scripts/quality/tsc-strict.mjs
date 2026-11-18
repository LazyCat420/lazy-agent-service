#!/usr/bin/env node
/**
 * TypeScript strict-mode ratchet.
 *
 * The build (`tsconfig.json`) stays non-strict. This gate type-checks the same files with
 * `tsconfig.strict.json` (strict + noImplicitAny, noEmit), counts the errors per file and
 * compares them with the committed baseline `scripts/quality/tsc-strict-baseline.json`.
 *
 * Fails (exit 1) when
 *   - a file has more strict errors than its baseline count, or
 *   - a file that is not in the baseline has any strict error.
 * Files whose count went down only print a hint; run with --update to lock the lower numbers in.
 *
 * Usage: node scripts/quality/tsc-strict.mjs [--update]
 *   --update  rewrite the baseline with today's counts. Refused (exit 1) when any count rose or a
 *             new file has errors, so the baseline can only ever go down.
 * Exit 2: tsc produced no parseable result (crash or config error).
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const UPDATE = process.argv.slice(2).includes("--update");
const PROJECT = "tsconfig.strict.json";
const BASELINE_FILE = path.join(ROOT, "scripts", "quality", "tsc-strict-baseline.json");
const BIN = path.join(ROOT, "node_modules", ".bin", "tsc");

// `path(line,col): error TS1234: message` — continuation lines of multi-line diagnostics are indented.
const DIAGNOSTIC = /^(\S[^(]*)\(\d+,\d+\): error (TS\d+):/;
// Diagnostics without a location (config errors, missing files) start with `error TS`.
const GLOBAL_DIAGNOSTIC = /^error (TS\d+):/;
const GLOBAL_KEY = "<global>";

const res = spawnSync(BIN, ["-p", PROJECT, "--pretty", "false"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (res.error) throw res.error;
const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;

/** @type {Record<string, number>} */
const current = {};
let parsed = 0;
for (const line of output.split(/\r?\n/)) {
  const m = DIAGNOSTIC.exec(line);
  const key = m ? path.relative(ROOT, path.resolve(ROOT, m[1])).split(path.sep).join("/") : GLOBAL_DIAGNOSTIC.test(line) ? GLOBAL_KEY : null;
  if (!key) continue;
  current[key] = (current[key] ?? 0) + 1;
  parsed++;
}
// tsc exits 0 (clean) or 2 (errors reported). Anything else, or "errors" with nothing parsed, is a crash.
if ((res.status !== 0 && res.status !== 2) || (res.status === 2 && parsed === 0)) {
  console.error(`[tsc-strict] tsc exited ${res.status} without parseable diagnostics:\n${output.slice(0, 4000)}`);
  process.exit(2);
}

const baseline = fs.existsSync(BASELINE_FILE) ? JSON.parse(fs.readFileSync(BASELINE_FILE, "utf8")) : null;
/** @type {Record<string, number>} */
const allowed = baseline?.files ?? {};

const rose = [];
const fresh = [];
const dropped = [];
for (const [file, count] of Object.entries(current)) {
  if (!(file in allowed)) fresh.push([file, count]);
  else if (count > allowed[file]) rose.push([file, allowed[file], count]);
}
for (const [file, count] of Object.entries(allowed)) {
  const now = current[file] ?? 0;
  if (now < count) dropped.push([file, count, now]);
}

const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
// Code-unit order, not locale order, so the baseline file is byte-identical on every machine.
const sorted = (counts) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

console.log(`[tsc-strict] ${total(current)} strict errors in ${Object.keys(current).length} files (baseline ${total(allowed)} in ${Object.keys(allowed).length})`);
// Without a baseline every file is "fresh"; only report regressions against a real baseline.
const regressed = baseline !== null && (rose.length > 0 || fresh.length > 0);
if (regressed) {
  for (const [file, was, now] of rose) console.error(`  ✗ ${file}: ${was} -> ${now}`);
  for (const [file, now] of fresh) console.error(`  ✗ ${file}: not in baseline, ${now} new strict error(s)`);
}
for (const [file, was, now] of dropped) console.log(`  ↓ ${file}: ${was} -> ${now}`);

if (regressed) {
  const offending = new Set([...rose.map(([f]) => f), ...fresh.map(([f]) => f)]);
  const lines = output.split(/\r?\n/).filter((l) => {
    const m = DIAGNOSTIC.exec(l);
    return m && offending.has(path.relative(ROOT, path.resolve(ROOT, m[1])).split(path.sep).join("/"));
  });
  console.error(`[tsc-strict] errors in regressed files:\n${lines.map((l) => `    ${l}`).join("\n")}`);
}

if (UPDATE) {
  if (regressed) {
    console.error("[tsc-strict] --update refused: the baseline may only go down. Fix the errors above first.");
    process.exit(1);
  }
  const next = { tsconfig: PROJECT, total: total(current), files: sorted(current) };
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`[tsc-strict] baseline ${baseline ? "lowered" : "created"}: ${next.total} errors in ${Object.keys(next.files).length} files -> ${path.relative(ROOT, BASELINE_FILE)}`);
  process.exit(0);
}

if (!baseline) {
  console.error(`[tsc-strict] FAIL: no baseline at ${path.relative(ROOT, BASELINE_FILE)}; create it with --update`);
  process.exit(1);
}
if (regressed) {
  console.error("[tsc-strict] FAIL: strict errors rose above the baseline (see ✗ rows)");
  process.exit(1);
}
if (dropped.length) console.log("[tsc-strict] counts went down; run `npm run quality:strict -- --update` to lock them in");
console.log("[tsc-strict] PASS (no file above its baseline)");
