#!/usr/bin/env node
/**
 * Duplication gate (jscpd, type-1/type-2 clones).
 *
 * Runs two scans:
 *   logic  — src/** minus tests, declarative config/data/types tables
 *   all    — src/** minus tests
 * The logic scan is the gated number; the all scan is reported for context.
 *
 * Usage: node scripts/quality/dry.mjs [--max-percent 8] [--min-tokens 60] [--out <dir>]
 * Exits 1 when the logic duplicated-line percentage exceeds --max-percent.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const MAX_PERCENT = Number(opt("max-percent", "8"));
const MIN_TOKENS = Number(opt("min-tokens", "60"));
const OUT_DIR = path.resolve(ROOT, opt("out", `.checks/quality-${new Date().toISOString().slice(0, 10)}`));
const BIN = path.join(ROOT, "node_modules", ".bin", "jscpd");

const DATA_IGNORE = "**/__tests__/**,**/*.test.ts,**/config/**,**/data/**,**/types/**,**/contracts/**";

function run(name, ignore, outSub) {
  const out = path.join(OUT_DIR, outSub);
  fs.rmSync(out, { recursive: true, force: true });
  const args = [
    "src",
    "--format",
    "typescript",
    "--min-tokens",
    String(MIN_TOKENS),
    "--reporters",
    "json",
    "--output",
    out,
    "--silent",
    "--ignore",
    ignore,
  ];
  const res = spawnSync(BIN, args, { cwd: ROOT, encoding: "utf8" });
  if (res.error) throw res.error;
  const reportFile = path.join(out, "jscpd-report.json");
  if (!fs.existsSync(reportFile)) {
    console.error(`[dry] ${name}: no report at ${reportFile}\n${res.stdout ?? ""}${res.stderr ?? ""}`);
    process.exit(2);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const total = report.statistics?.total ?? {};
  return {
    name,
    percent: Number(total.percentage ?? 0),
    lines: Number(total.lines ?? 0),
    duplicatedLines: Number(total.duplicatedLines ?? 0),
    clones: Number(total.clones ?? 0),
    top: (report.duplicates ?? [])
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)
      .map((d) => ({
        tokens: d.tokens,
        lines: d.lines,
        a: `${d.firstFile.name}:${d.firstFile.start}`,
        b: `${d.secondFile.name}:${d.secondFile.start}`,
      })),
  };
}

const logic = run("logic", DATA_IGNORE, "jscpd-logic");
const all = run("all", "**/__tests__/**,**/*.test.ts", "jscpd-all");

const summary = { generatedAt: new Date().toISOString(), minTokens: MIN_TOKENS, logic, all };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "dry.json"), JSON.stringify(summary, null, 2));

const md = [];
md.push(`# Duplication report (${summary.generatedAt})`);
md.push("");
md.push(`jscpd, min-tokens ${MIN_TOKENS}`);
md.push("");
md.push("| scan | duplicated % | duplicated lines | total lines | clones |");
md.push("|---|---|---|---|---|");
for (const s of [logic, all]) {
  md.push(`| ${s.name} | ${s.percent}% | ${s.duplicatedLines} | ${s.lines} | ${s.clones} |`);
}
md.push("");
md.push("## Top logic clones");
md.push("");
md.push("| tokens | lines | first | second |");
md.push("|---|---|---|---|");
for (const c of logic.top) md.push(`| ${c.tokens} | ${c.lines} | ${c.a} | ${c.b} |`);
fs.writeFileSync(path.join(OUT_DIR, "dry.md"), md.join("\n"));

console.log(`[dry] logic: ${logic.percent}% duplicated (${logic.duplicatedLines}/${logic.lines} lines, ${logic.clones} clones)`);
console.log(`[dry] all:   ${all.percent}% duplicated (${all.duplicatedLines}/${all.lines} lines, ${all.clones} clones)`);
console.log("[dry] top logic clones:");
for (const c of logic.top.slice(0, 8)) console.log(`  ${c.tokens}tok ${c.a} <-> ${c.b}`);
console.log(`[dry] wrote ${path.relative(ROOT, path.join(OUT_DIR, "dry.json"))} and dry.md`);

if (logic.percent > MAX_PERCENT) {
  console.error(`[dry] FAIL: logic duplication ${logic.percent}% > ${MAX_PERCENT}%`);
  process.exit(1);
}
console.log(`[dry] PASS (logic ${logic.percent}% <= ${MAX_PERCENT}%)`);
