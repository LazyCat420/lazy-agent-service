/**
 * CodeHealthSensor — deterministic, dependency-free code health measurement.
 *
 * WHY this exists: agents finish runs claiming work is clean, and the harness
 * has no cheap way to check. This sensor is the runtime counterpart of
 * scripts/quality/{crap,dry,deadcode}.mjs: it takes the files an agent wrote
 * (inline content, no filesystem access, no shell) and returns measurable
 * findings the harness can gate on.
 *
 * Limits (documented, not hidden): this is a lexer, not a compiler. Comments
 * and string/template literals are stripped, so complexity inside a `${...}`
 * interpolation is not counted, and function detection is structural
 * (`function`, `=>`, and `name(...) {`), not semantic.
 */

export interface CodeHealthFile {
  path: string;
  content: string;
}

export interface FunctionHealth {
  path: string;
  name: string;
  line: number;
  complexity: number;
  lines: number;
}

export interface DuplicateFinding {
  tokens: number;
  leftPath: string;
  leftLine: number;
  rightPath: string;
  rightLine: number;
}

export interface CodeHealthThresholds {
  maxComplexity?: number;
  maxLines?: number;
  minDuplicateTokens?: number;
  maxUnusedExports?: number;
}

export interface CodeHealthReport {
  files: number;
  lines: number;
  functions: number;
  maxComplexity: number;
  highComplexity: FunctionHealth[];
  longFunctions: FunctionHealth[];
  duplicates: DuplicateFinding[];
  unusedExports: string[];
  verdict: "ok" | "warn";
  reasons: string[];
}

type TokenKind = "id" | "num" | "op" | "punct";

interface Token {
  text: string;
  kind: TokenKind;
  line: number;
}

/** Tokens that may precede a method name without changing its identity. */
const METHOD_MODIFIERS: Record<string, true> = {
  async: true,
  static: true,
  public: true,
  private: true,
  protected: true,
  readonly: true,
  override: true,
  abstract: true,
  get: true,
  set: true,
  default: true,
};

const DECISION_KEYWORDS: Record<string, true> = {
  if: true,
  for: true,
  while: true,
  catch: true,
  case: true,
};
const NOT_METHOD_PREFIX: Record<string, true> = {
  if: true,
  for: true,
  while: true,
  switch: true,
  catch: true,
  return: true,
  typeof: true,
  await: true,
  new: true,
  function: true,
  do: true,
  else: true,
  case: true,
  yield: true,
  delete: true,
  void: true,
  in: true,
  of: true,
  instanceof: true,
};

interface LexCursor {
  i: number;
  line: number;
}

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const NUMBER_START = /[0-9]/;
const NUMBER_PART = /[0-9a-fA-FxX._]/;
const TWO_CHAR_OPS: Record<string, true> = {
  "&&": true,
  "||": true,
  "??": true,
  "=>": true,
  "?.": true,
};
const OPERATOR_CHARS = "+-*/%=<>!&|^~?:";
const PUNCT_CHARS = "{}()[];,.";

function skipLineComment(source: string, cursor: LexCursor): void {
  while (cursor.i < source.length && source[cursor.i] !== "\n") cursor.i++;
}

function skipBlockComment(source: string, cursor: LexCursor): void {
  cursor.i += 2;
  while (cursor.i < source.length && !(source[cursor.i] === "*" && source[cursor.i + 1] === "/")) {
    if (source[cursor.i] === "\n") cursor.line++;
    cursor.i++;
  }
  cursor.i += 2;
}

function skipQuoted(source: string, cursor: LexCursor, quote: string): void {
  cursor.i++;
  while (cursor.i < source.length && source[cursor.i] !== quote) {
    if (source[cursor.i] === "\\") cursor.i++;
    else if (source[cursor.i] === "\n") cursor.line++;
    cursor.i++;
  }
  cursor.i++;
}

function readIdentifier(source: string, cursor: LexCursor): string {
  const start = cursor.i;
  while (cursor.i < source.length && IDENT_PART.test(source[cursor.i])) cursor.i++;
  return source.slice(start, cursor.i);
}

function readNumber(source: string, cursor: LexCursor): void {
  while (cursor.i < source.length && NUMBER_PART.test(source[cursor.i])) cursor.i++;
}

/** Strip comments and string/template literals while keeping line numbers. */
function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const cursor: LexCursor = { i: 0, line: 1 };

  while (cursor.i < source.length) {
    const ch = source[cursor.i];
    const line = cursor.line;

    if (ch === "\n") {
      cursor.line++;
      cursor.i++;
      continue;
    }

    if (ch === "/" && source[cursor.i + 1] === "/") {
      skipLineComment(source, cursor);
      continue;
    }

    if (ch === "/" && source[cursor.i + 1] === "*") {
      skipBlockComment(source, cursor);
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      skipQuoted(source, cursor, ch);
      tokens.push({ text: "STR", kind: "punct", line });
      continue;
    }

    if (IDENT_START.test(ch)) {
      tokens.push({ text: readIdentifier(source, cursor), kind: "id", line });
      continue;
    }

    if (NUMBER_START.test(ch)) {
      readNumber(source, cursor);
      tokens.push({ text: "NUM", kind: "num", line });
      continue;
    }

    const two = source.slice(cursor.i, cursor.i + 2);
    if (TWO_CHAR_OPS[two]) {
      tokens.push({ text: two, kind: "op", line });
      cursor.i += 2;
      continue;
    }

    if (OPERATOR_CHARS.includes(ch)) {
      tokens.push({ text: ch, kind: "op", line });
      cursor.i++;
      continue;
    }

    if (PUNCT_CHARS.includes(ch)) {
      tokens.push({ text: ch, kind: "punct", line });
      cursor.i++;
      continue;
    }

    cursor.i++;
  }

  return tokens;
}

function tokenComplexity(tokens: Token[], index: number): number {
  const token = tokens[index];
  if (token.kind === "id" && DECISION_KEYWORDS[token.text]) return 1;
  if (token.kind === "op") {
    if (token.text === "&&" || token.text === "||" || token.text === "??") return 1;
    if (token.text === "?") {
      const next = tokens[index + 1]?.text;
      // Optional chaining (`?.`) and optional parameters (`x?: T`) are not branches.
      return next !== "." && next !== ":" ? 1 : 0;
    }
  }
  return 0;
}

interface FunctionFrame {
  name: string;
  startLine: number;
  depth: number;
  complexity: number;
}

interface PendingFunction {
  name: string;
  startLine: number;
  kind: "declaration" | "arrow";
}

function analyzeFunctions(path: string, tokens: Token[]): FunctionHealth[] {
  const functions: FunctionHealth[] = [];
  const stack: FunctionFrame[] = [];
  let depth = 0;
  let parenDepth = 0;
  let pending: PendingFunction | null = null;

  const nameBefore = (index: number): string => {
    const prev = tokens[index - 1];
    if (prev?.kind === "id") return prev.text;
    return "(anonymous)";
  };

  // "function outer(" -> "outer"; "const f = function (" -> "f".
  const declarationName = (index: number): string => {
    const after = tokens[index + 1];
    if (after?.kind === "id") return after.text;
    return nameBefore(index);
  };

  // `items.map((item) => {` -> "map": walk back over the parameter list.
  const arrowName = (index: number): string => {
    if (tokens[index - 1]?.text !== ")") return nameBefore(index);
    let depth = 0;
    for (let cursor = index - 1; cursor >= 0; cursor--) {
      if (tokens[cursor].text === ")") depth++;
      else if (tokens[cursor].text === "(") {
        depth--;
        if (depth === 0) {
          let ownerIndex = cursor - 1;
          while (
            tokens[ownerIndex]?.text === "." ||
            tokens[ownerIndex]?.text === "=" ||
            tokens[ownerIndex]?.text === "("
          ) {
            ownerIndex -= 1;
          }
          const owner = tokens[ownerIndex];
          return owner?.kind === "id" ? owner.text : "(anonymous)";
        }
      }
    }
    return "(anonymous)";
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];

    if (token.text === "function") {
      pending = { name: declarationName(index), startLine: token.line, kind: "declaration" };
      continue;
    }

    if (token.text === "=>") {
      if (tokens[index + 1]?.text === "{") {
        pending = { name: arrowName(index), startLine: token.line, kind: "arrow" };
      }
      continue;
    }

    if (
      token.kind === "id" &&
      !NOT_METHOD_PREFIX[token.text] &&
      tokens[index + 1]?.text === "("
    ) {
      const prev = tokens[index - 1];
      const startsMember =
        prev === undefined ||
        prev.text === "{" ||
        prev.text === "}" ||
        prev.text === ";" ||
        prev.text === "," ||
        prev.text === "*" ||
        (prev.kind === "id" && METHOD_MODIFIERS[prev.text]);
      if (startsMember) {
        pending = { name: token.text, startLine: token.line, kind: "declaration" };
      }
      continue;
    }

    if (token.text === "(") {
      parenDepth++;
      continue;
    }

    if (token.text === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (token.text === "{") {
      depth++;
      // A brace inside a parameter list is a type literal, not a body. An arrow
      // body brace sits inside the caller's argument list, so paren depth does
      // not apply to it.
      if (pending && (pending.kind === "arrow" || parenDepth === 0)) {
        stack.push({
          name: pending.name,
          startLine: pending.startLine,
          depth,
          complexity: 1,
        });
        pending = null;
      }
      continue;
    }

    if (token.text === "}") {
      const frame = stack[stack.length - 1];
      if (frame && frame.depth === depth) {
        stack.pop();
        functions.push({
          path,
          name: frame.name,
          line: frame.startLine,
          complexity: frame.complexity,
          lines: Math.max(1, token.line - frame.startLine + 1),
        });
      }
      depth = Math.max(0, depth - 1);
      continue;
    }

    const decision = tokenComplexity(tokens, index);
    if (decision) {
      const frame = stack[stack.length - 1];
      if (frame) frame.complexity += decision;
    }
  }

  return functions;
}

/** Normalized token stream used for duplicate detection. */
function normalizedTokens(tokens: Token[]): { text: string; line: number }[] {
  return tokens
    .filter((token) => token.text !== ";" && token.text !== ",")
    .map((token) => ({
      text: token.kind === "num" ? "NUM" : token.text,
      line: token.line,
    }));
}

const EXPORT_PATTERN =
  /export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

interface ExportSite {
  path: string;
  line: number;
}

function collectExports(files: CodeHealthFile[]): Map<string, ExportSite> {
  const exports = new Map<string, ExportSite>();
  for (const file of files) {
    const tokens = lex(file.content);
    let index = 0;
    for (const match of file.content.matchAll(EXPORT_PATTERN)) {
      const name = match[1];
      const site = tokens.findIndex((token, cursor) => cursor >= index && token.text === name);
      const line = site >= 0 ? tokens[site].line : 0;
      index = Math.max(index, site + 1);
      exports.set(name, { path: file.path, line });
    }
  }
  return exports;
}

function findDuplicates(
  perFile: Map<string, { text: string; line: number }[]>,
  minTokens: number,
  limit: number,
): DuplicateFinding[] {
  const seen = new Map<string, { path: string; line: number }>();
  const findings: DuplicateFinding[] = [];

  for (const [path, tokens] of perFile) {
    for (let i = 0; i + minTokens <= tokens.length; i++) {
      const window = tokens
        .slice(i, i + minTokens)
        .map((token) => token.text)
        .join(" ");
      const hit = seen.get(window);
      if (hit) {
        if (hit.path === path && hit.line === tokens[i].line) continue;
        findings.push({
          tokens: minTokens,
          leftPath: hit.path,
          leftLine: hit.line,
          rightPath: path,
          rightLine: tokens[i].line,
        });
        if (findings.length >= limit) return findings;
      } else {
        seen.set(window, { path, line: tokens[i].line });
      }
    }
  }

  return findings;
}

/**
 * Measure the health of a set of files. Deterministic: same input, same report.
 */
export function analyzeCodeHealth(
  files: CodeHealthFile[],
  thresholds: CodeHealthThresholds = {},
): CodeHealthReport {
  const maxComplexity = thresholds.maxComplexity ?? 30;
  const maxLines = thresholds.maxLines ?? 150;
  const minDuplicateTokens = thresholds.minDuplicateTokens ?? 60;
  const maxUnusedExports = thresholds.maxUnusedExports ?? 0;

  const functions: FunctionHealth[] = [];
  const perFile = new Map<string, { text: string; line: number }[]>();
  let totalLines = 0;

  for (const file of files) {
    const tokens = lex(file.content);
    functions.push(...analyzeFunctions(file.path, tokens));
    perFile.set(file.path, normalizedTokens(tokens));
    totalLines += file.content.split("\n").length;
  }

  // A single submitted file cannot tell us what other files import; skip the
  // unused-export check rather than flag every export as orphaned.
  const exports = files.length > 1 ? collectExports(files) : new Map<string, ExportSite>();
  const unusedExports = [...exports.entries()]
    .filter(([name, site]) => {
      for (const [path, tokens] of perFile) {
        for (const token of tokens) {
          if (token.text !== name) continue;
          if (path === site.path && token.line === site.line) continue;
          return false;
        }
      }
      return true;
    })
    .map(([name]) => name);

  const highComplexity = functions
    .filter((fn) => fn.complexity > maxComplexity)
    .sort((a, b) => b.complexity - a.complexity);
  const longFunctions = functions
    .filter((fn) => fn.lines > maxLines)
    .sort((a, b) => b.lines - a.lines);
  const duplicates = findDuplicates(perFile, minDuplicateTokens, 20);

  const reasons: string[] = [];
  if (highComplexity.length) {
    reasons.push(
      `${highComplexity.length} function(s) exceed complexity ${maxComplexity} (worst ${highComplexity[0].name} = ${highComplexity[0].complexity})`,
    );
  }
  if (longFunctions.length) {
    reasons.push(
      `${longFunctions.length} function(s) exceed ${maxLines} lines (longest ${longFunctions[0].name} = ${longFunctions[0].lines})`,
    );
  }
  if (duplicates.length) {
    reasons.push(`${duplicates.length} duplicate token window(s) of ${minDuplicateTokens}+ tokens`);
  }
  if (unusedExports.length > maxUnusedExports) {
    reasons.push(`${unusedExports.length} exported name(s) never referenced in the submitted files`);
  }

  return {
    files: files.length,
    lines: totalLines,
    functions: functions.length,
    maxComplexity: functions.reduce((max, fn) => Math.max(max, fn.complexity), 0),
    highComplexity,
    longFunctions,
    duplicates,
    unusedExports,
    verdict: reasons.length ? "warn" : "ok",
    reasons,
  };
}
