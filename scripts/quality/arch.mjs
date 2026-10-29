#!/usr/bin/env node
/**
 * Architecture fitness check (dependency-cruiser).
 *
 * Usage: node scripts/quality/arch.mjs [--out <dir>]
 * Exits 1 when a rule with severity "error" is violated.
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
const OUT_DIR = path.resolve(ROOT, opt("out", `.checks/quality-${new Date().toISOString().slice(0, 10)}`));
const BIN = path.join(ROOT, "node_modules", ".bin", "depcruise");

const res = spawnSync(
  BIN,
  ["src", "--config", ".dependency-cruiser.cjs", "--output-type", "json", "--no-progress"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
if (res.error) throw res.error;

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error(`[arch] could not parse dependency-cruiser output\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  process.exit(2);
}

const violations = report.summary?.violations ?? [];
const bySeverity = { error: [], warn: [], info: [] };
for (const v of violations) {
  const key = bySeverity[v.rule?.severity] ? v.rule.severity : "info";
  bySeverity[key].push(v);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "arch.json"), JSON.stringify(report, null, 2));

const md = [`# Architecture report (${new Date().toISOString()})`, ""];
md.push(`Modules: ${report.summary?.totalCruised ?? "?"} · dependencies: ${report.summary?.totalDependenciesCruised ?? "?"}`);
md.push("");
for (const sev of ["error", "warn"]) {
  md.push(`## ${sev} (${bySeverity[sev].length})`);
  md.push("");
  for (const v of bySeverity[sev].slice(0, 40)) {
    md.push(`- **${v.rule.name}**: ${v.from} → ${v.to}`);
  }
  md.push("");
}
fs.writeFileSync(path.join(OUT_DIR, "arch.md"), md.join("\n"));

console.log(`[arch] ${report.summary?.totalCruised ?? "?"} modules · errors ${bySeverity.error.length} · warnings ${bySeverity.warn.length}`);
for (const v of bySeverity.error.slice(0, 10)) console.log(`  ERROR ${v.rule.name}: ${v.from} -> ${v.to}`);
for (const v of bySeverity.warn.slice(0, 10)) console.log(`  warn  ${v.rule.name}: ${v.from} -> ${v.to}`);
console.log(`[arch] wrote ${path.relative(ROOT, path.join(OUT_DIR, "arch.json"))} and arch.md`);

if (bySeverity.error.length > 0) {
  console.error(`[arch] FAIL: ${bySeverity.error.length} error-severity violations`);
  process.exit(1);
}
console.log("[arch] PASS");
