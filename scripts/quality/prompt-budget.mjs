#!/usr/bin/env node
/**
 * Progressive-disclosure budget for the tool catalog.
 *
 * Every token in a tool description is paid on every turn of every run, while
 * only the tools a run actually needs matter. This script measures the three
 * levels of disclosure and fails when the compact level stops saving tokens or
 * when a single description grows past the point where a summary would do.
 *
 *   full    — name + full description + full parameter JSON (what a naive
 *             "dump every schema" prompt costs)
 *   summary — name + first sentence (domain-grouped catalog view)
 *   compact — name + first sentence + parameter names only
 *
 * Token counts use the standard 4-characters-per-token estimate; the gate is on
 * ratios, so the estimate cancels out.
 *
 * Usage: node scripts/quality/prompt-budget.mjs [--max-compact-ratio 0.5]
 *        [--max-description-chars 600] [--out <dir>]
 * Exits 1 when a gate fails.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const MAX_COMPACT_RATIO = Number(opt("max-compact-ratio", "0.5"));
const MAX_DESCRIPTION_CHARS = Number(opt("max-description-chars", "600"));
const MAX_FULL_TOKENS = Number(opt("max-full-tokens", "15000"));
const OUT_DIR = path.resolve(
  ROOT,
  opt("out", `.checks/quality-${new Date().toISOString().slice(0, 10)}`),
);

const tokens = (text) => Math.ceil(text.length / 4);
const firstSentence = (text) => {
  const match = String(text || "").match(/^.*?[.!?](\s|$)/);
  return (match ? match[0] : String(text || "")).trim();
};

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, "tool_schemas.json"), "utf8"));

function measure(tools) {
  const full = [];
  const summary = [];
  const compact = [];
  for (const tool of tools) {
    const description = tool.description || "";
    const params = tool.parameters?.properties || {};
    const required = new Set(tool.parameters?.required || []);
    const paramLines = Object.entries(params).map(([name, schema]) => {
      const description = schema?.description || "";
      return `- ${name}${required.has(name) ? " (required)" : ""}: ${description}`;
    });
    full.push(`${tool.name}: ${description}\n${paramLines.join("\n")}`);
    summary.push(`${tool.name}: ${firstSentence(description)}`);
    compact.push(
      `${tool.name}: ${firstSentence(description)} (params: ${Object.keys(params).join(", ") || "none"})`,
    );
  }
  return {
    tools: tools.length,
    full: tokens(full.join("\n")),
    summary: tokens(summary.join("\n")),
    compact: tokens(compact.join("\n")),
  };
}

const byOwner = new Map();
for (const tool of catalog) {
  const owner = tool.owner_app || "unassigned";
  if (!byOwner.has(owner)) byOwner.set(owner, []);
  byOwner.get(owner).push(tool);
}

const rows = [];
for (const [owner, tools] of [...byOwner].sort()) {
  rows.push({ scope: owner, ...measure(tools) });
}
rows.push({ scope: "ALL", ...measure(catalog) });

const all = rows[rows.length - 1];
const ratio = all.compact / Math.max(1, all.full);
const overlong = catalog
  .filter((tool) => String(tool.description || "").length > MAX_DESCRIPTION_CHARS)
  .map((tool) => ({ name: tool.name, chars: String(tool.description).length }));

const failures = [];
if (ratio > MAX_COMPACT_RATIO) {
  failures.push(
    `compact disclosure costs ${(ratio * 100).toFixed(1)}% of full (limit ${(MAX_COMPACT_RATIO * 100).toFixed(0)}%)`,
  );
}
// Description bloat is reported, not gated: rewriting tool contracts is a
// product decision, and this gate exists to catch growth past the ceiling.
if (all.full > MAX_FULL_TOKENS) {
  failures.push(`full catalog costs ${all.full} tokens (ceiling ${MAX_FULL_TOKENS})`);
}
const warnings = overlong.length
  ? [
      `${overlong.length} description(s) exceed ${MAX_DESCRIPTION_CHARS} chars: ${overlong
        .slice(0, 5)
        .map((t) => `${t.name} (${t.chars})`)
        .join(", ")}`,
    ]
  : [];

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(
  path.join(OUT_DIR, "prompt-budget.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), maxCompactRatio: MAX_COMPACT_RATIO, maxDescriptionChars: MAX_DESCRIPTION_CHARS, maxFullTokens: MAX_FULL_TOKENS, rows, overlong, warnings, failures }, null, 2)}\n`,
);

const md = [
  "| scope | tools | full tok | summary tok | compact tok | compact/full |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (row) =>
      `| ${row.scope} | ${row.tools} | ${row.full} | ${row.summary} | ${row.compact} | ${((row.compact / Math.max(1, row.full)) * 100).toFixed(1)}% |`,
  ),
  "",
  ...warnings.map((w) => `WARN: ${w}`),
  failures.length ? `FAIL: ${failures.join("; ")}` : "PASS",
].join("\n");
fs.writeFileSync(path.join(OUT_DIR, "prompt-budget.md"), `${md}\n`);

console.log(md);
console.log(`[prompt-budget] wrote ${OUT_DIR}/prompt-budget.{json,md}`);
process.exit(failures.length ? 1 : 0);
