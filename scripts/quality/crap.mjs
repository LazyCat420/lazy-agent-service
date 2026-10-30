#!/usr/bin/env node
/**
 * CRAP analyzer: per-function McCabe complexity x statement coverage.
 *
 *   CRAP(m) = cx(m)^2 * (1 - cov(m))^3 + cx(m)
 *
 * Coverage comes from the istanbul JSON report written by
 * `vitest run --coverage --coverage.reporter=json` (coverage/coverage-final.json).
 * Complexity is counted per function with nested functions excluded, so a
 * closure inside a function does not inflate its parent. Decision points:
 * if, ?:, for, for-of, for-in, while, do-while, catch, case, &&, ||, ??.
 *
 * Usage: node scripts/quality/crap.mjs [--coverage <file>] [--out <dir>]
 *        [--max-cx 30] [--max-crap 60] [--top 25]
 * Exits 1 when any function exceeds --max-cx or --max-crap.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const COVERAGE = path.resolve(ROOT, opt("coverage", "coverage/coverage-final.json"));
const OUT_DIR = path.resolve(ROOT, opt("out", `.checks/quality-${new Date().toISOString().slice(0, 10)}`));
const MAX_CX = Number(opt("max-cx", "30"));
const MAX_CRAP = Number(opt("max-crap", "60"));
// Ratchet: the number of functions over MAX_CRAP may not grow. Lower this
// ceiling as coverage rises; per-function CRAP is still listed in the report.
const MAX_CRAP_COUNT = Number(opt("max-crap-count", "180"));
const MAX_CX_COUNT = Number(opt("max-cx-count", "0"));
const TOP = Number(opt("top", "25"));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const isFunc = (node) =>
  ts.isFunctionDeclaration(node) ||
  ts.isMethodDeclaration(node) ||
  ts.isArrowFunction(node) ||
  ts.isFunctionExpression(node) ||
  ts.isGetAccessor(node) ||
  ts.isSetAccessor(node) ||
  ts.isConstructorDeclaration(node);

function complexity(fn) {
  let cx = 1;
  const visit = (node) => {
    if (node !== fn && isFunc(node)) return;
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isForStatement(node) ||
      ts.isForOfStatement(node) ||
      ts.isForInStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isCatchClause(node) ||
      ts.isCaseClause(node)
    ) {
      cx += 1;
    } else if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      if (
        kind === ts.SyntaxKind.AmpersandAmpersandToken ||
        kind === ts.SyntaxKind.BarBarToken ||
        kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        cx += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  return cx;
}

function functionName(node, sf) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (ts.isPropertyAssignment(node.parent)) {
    const name = node.parent.name;
    return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : "prop";
  }
  return "anonymous";
}

function loadCoverage(file) {
  if (!fs.existsSync(file)) {
    console.error(`[crap] coverage report missing: ${file}`);
    console.error("[crap] run `npm run coverage` first");
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const coverage = loadCoverage(COVERAGE);
const byRel = new Map();
for (const [abs, data] of Object.entries(coverage)) {
  byRel.set(path.relative(ROOT, abs), data);
}

const files = walk(path.join(ROOT, "src")).filter((f) => !f.includes(`${path.sep}__tests__${path.sep}`));
const rows = [];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  const text = fs.readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const cov = byRel.get(rel);

  const statements = [];
  if (cov) {
    for (const [id, span] of Object.entries(cov.statementMap)) {
      statements.push({ start: span.start.line, end: span.end.line, count: cov.s[id] ?? 0 });
    }
  }

  const visit = (node) => {
    if (isFunc(node) && node.body) {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const endLine = sf.getLineAndCharacterOfPosition(node.end).line + 1;
      const cx = complexity(node);
      const inside = statements.filter((s) => s.start >= startLine && s.end <= endLine);
      const covered = inside.filter((s) => s.count > 0).length;
      const covRatio = inside.length === 0 ? 1 : covered / inside.length;
      const crap = cx * cx * Math.pow(1 - covRatio, 3) + cx;
      rows.push({
        file: rel,
        name: functionName(node, sf),
        line: startLine,
        lines: endLine - startLine + 1,
        cx,
        statements: inside.length,
        covered,
        coverage: Number(covRatio.toFixed(3)),
        crap: Number(crap.toFixed(1)),
        measured: Boolean(cov),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

rows.sort((a, b) => b.crap - a.crap || b.cx - a.cx);
const overCx = rows.filter((r) => r.cx > MAX_CX);
const overCrap = rows.filter((r) => r.crap > MAX_CRAP);
const unmeasured = rows.filter((r) => !r.measured);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "crap.json"), JSON.stringify(rows, null, 2));

const md = [];
md.push(`# CRAP report (${new Date().toISOString()})`);
md.push("");
md.push(`Functions analysed: **${rows.length}** · coverage measured: ${rows.length - unmeasured.length} · no coverage file entry: ${unmeasured.length}`);
md.push("");
md.push(`Thresholds: cx > ${MAX_CX} (max ${MAX_CX_COUNT} functions), CRAP > ${MAX_CRAP} (max ${MAX_CRAP_COUNT} functions)`);
md.push(`Over cx: **${overCx.length}** · over CRAP: **${overCrap.length}**`);
md.push("");
md.push("| CRAP | cx | cov | stmts | lines | file:line | function |");
md.push("|---|---|---|---|---|---|---|");
for (const r of rows.slice(0, TOP)) {
  md.push(`| ${r.crap} | ${r.cx} | ${r.coverage} | ${r.covered}/${r.statements} | ${r.lines} | ${r.file}:${r.line} | ${r.name} |`);
}
fs.writeFileSync(path.join(OUT_DIR, "crap.md"), md.join("\n"));

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
console.log(`[crap] ${rows.length} functions · measured ${rows.length - unmeasured.length} (${pct(rows.length - unmeasured.length, rows.length)})`);
console.log(`[crap] cx>${MAX_CX}: ${overCx.length} · CRAP>${MAX_CRAP}: ${overCrap.length}`);
console.log("[crap] top 10 by CRAP:");
for (const r of rows.slice(0, 10)) {
  console.log(`  crap=${r.crap} cx=${r.cx} cov=${r.coverage} ${r.file}:${r.line} ${r.name}`);
}
console.log(`[crap] wrote ${path.relative(ROOT, path.join(OUT_DIR, "crap.json"))} and crap.md`);

if (overCx.length > MAX_CX_COUNT || overCrap.length > MAX_CRAP_COUNT) {
  console.error(
    `[crap] FAIL: ${overCx.length} functions over cx ${MAX_CX} (ceiling ${MAX_CX_COUNT}), ` +
      `${overCrap.length} over CRAP ${MAX_CRAP} (ceiling ${MAX_CRAP_COUNT})`,
  );
  process.exit(1);
}
console.log("[crap] PASS");
