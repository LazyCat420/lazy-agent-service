#!/usr/bin/env node
/**
 * Dead-code report (knip). Report-only by default; --gate exits 1 on findings.
 *
 * Usage: node scripts/quality/deadcode.mjs [--gate] [--out <dir>]
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
const GATE = argv.includes("--gate");
const OUT_DIR = path.resolve(ROOT, opt("out", `.checks/quality-${new Date().toISOString().slice(0, 10)}`));
const BIN = path.join(ROOT, "node_modules", ".bin", "knip");

const res = spawnSync(BIN, ["--reporter", "json", "--no-progress", "--include", "files,exports,types,duplicates"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (res.error) throw res.error;

let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error(`[deadcode] could not parse knip output\n${res.stdout ?? ""}${res.stderr ?? ""}`);
  process.exit(2);
}

const issues = report.issues ?? [];
const flat = (key) => issues.flatMap((issue) => (issue[key] ?? []).map((item) => ({ ...item, file: issue.file })));
const groups = [
  ["unused files", flat("files")],
  ["unused exports", flat("exports")],
  ["unused types", flat("types")],
  ["duplicate exports", flat("duplicates")],
];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "deadcode.json"), JSON.stringify(report, null, 2));

const md = [`# Dead-code report (${new Date().toISOString()})`, ""];
for (const [label, items] of groups) md.push(`- ${label}: **${items.length}**`);
md.push("");
for (const [label, items] of groups) {
  if (items.length === 0) continue;
  md.push(`## ${label}`);
  md.push("");
  for (const item of items.slice(0, 60)) md.push(`- ${item.name ?? item.file ?? JSON.stringify(item)}${item.file && item.name ? ` (${item.file})` : ""}`);
  md.push("");
}
fs.writeFileSync(path.join(OUT_DIR, "deadcode.md"), md.join("\n"));

console.log("[deadcode] knip findings:");
for (const [label, items] of groups) console.log(`  ${label}: ${items.length}`);
for (const item of (report.exports ?? []).slice(0, 10)) console.log(`  unused export: ${item.name} (${item.file})`);
console.log(`[deadcode] wrote ${path.relative(ROOT, path.join(OUT_DIR, "deadcode.json"))} and deadcode.md`);

const total = groups.reduce((sum, [, items]) => sum + items.length, 0);
if (GATE && total > 0) {
  console.error(`[deadcode] FAIL: ${total} findings`);
  process.exit(1);
}
console.log(`[deadcode] ${GATE ? "PASS" : "report-only"} (${total} findings)`);
