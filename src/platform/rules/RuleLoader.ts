import fs from "node:fs";
import path from "node:path";

/**
 * RuleLoader — loads path-scoped markdown rules from `<repoRoot>/rules/*.md`.
 *
 * Each rule file has YAML-ish frontmatter:
 *
 * ```markdown
 * ---
 * name: testing-policy
 * description: How to write and run tests in this repo
 * paths:
 *   - "src/**\/__tests__/**"
 *   - "*.test.ts"
 * ---
 * Rule body in markdown...
 * ```
 *
 * A rule applies to a touched file path when ANY of its `paths` globs
 * matches. Rules with no frontmatter (e.g. README.example.md) are skipped.
 */

export interface Rule {
  name: string;
  description: string;
  /** Glob patterns (relative paths, POSIX separators) this rule scopes to. */
  paths: string[];
  /** Markdown body below the frontmatter. */
  body: string;
  /** Absolute file path the rule was loaded from. */
  source: string;
}

const DEFAULT_RULES_DIR = path.resolve(process.cwd(), "rules");

/** Convert a simple glob (`*`, `**`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let pattern = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**` — any characters including path separators. Consume both.
        i++;
        if (glob[i + 1] === "/") i++;
        pattern += "(?:.*)";
      } else {
        pattern += "([^/]*)";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function globMatches(glob: string, filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const normalizedGlob = glob.replace(/\\/g, "/").replace(/^\.\//, "");
  if (globToRegExp(normalizedGlob).test(normalized)) return true;
  // A glob without a separator matches every directory level (gitignore-style).
  if (!normalizedGlob.includes("/")) {
    return normalized
      .split("/")
      .some((segment) => globToRegExp(normalizedGlob).test(segment));
  }
  // A pattern like `src/**` should also match `src` itself.
  if (normalizedGlob.endsWith("/**")) {
    const base = normalizedGlob.slice(0, -3);
    if (normalized === base) return true;
  }
  return false;
}

/** Parse `---` frontmatter into a record of scalars and string arrays. */
export function parseFrontmatter(
  content: string,
): { frontmatter: Record<string, string | string[]>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  const frontmatter: Record<string, string | string[]> = {};
  let currentKey: string | null = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const listItem = /^-\s+(.+)$/.exec(line);
    if (listItem && currentKey) {
      const existing = frontmatter[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      list.push(stripQuotes(listItem[1]));
      frontmatter[currentKey] = list;
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    currentKey = kv[1];
    const value = kv[2].trim();
    if (value === "") {
      frontmatter[currentKey] = [];
    } else if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[currentKey] = value
        .slice(1, -1)
        .split(",")
        .map((entry) => stripQuotes(entry.trim()))
        .filter((entry) => entry.length > 0);
    } else {
      frontmatter[currentKey] = stripQuotes(value);
    }
  }
  return { frontmatter, body: match[2] };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export class RuleLoader {
  private rulesDir: string;
  private cache: Rule[] | null = null;

  constructor(rulesDir: string = DEFAULT_RULES_DIR) {
    this.rulesDir = rulesDir;
  }

  /** Load (and cache) all valid rule files from the rules directory. */
  load(): Rule[] {
    if (this.cache) return this.cache;
    this.cache = this.loadSync();
    return this.cache;
  }

  /** Force a reload from disk (picks up newly added rule files). */
  reload(): Rule[] {
    this.cache = null;
    return this.load();
  }

  private loadSync(): Rule[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.rulesDir);
    } catch {
      return [];
    }
    const rules: Rule[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const source = path.join(this.rulesDir, entry);
      let content: string;
      try {
        content = fs.readFileSync(source, "utf8");
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(content);
      if (!parsed) continue; // No frontmatter — not a rule file.
      const paths = parsed.frontmatter.paths;
      if (!Array.isArray(paths) || paths.length === 0) continue;
      rules.push({
        name:
          typeof parsed.frontmatter.name === "string" &&
          parsed.frontmatter.name.length > 0
            ? parsed.frontmatter.name
            : path.basename(entry, ".md"),
        description:
          typeof parsed.frontmatter.description === "string"
            ? parsed.frontmatter.description
            : "",
        paths,
        body: parsed.body.trim(),
        source,
      });
    }
    return rules;
  }

  /**
   * Return every rule whose glob list matches at least one touched path.
   */
  rulesForPaths(touchedPaths: string[]): Rule[] {
    const rules = this.load();
    return rules.filter((rule) =>
      rule.paths.some((glob) =>
        touchedPaths.some((touched) => globMatches(glob, touched)),
      ),
    );
  }
}

export default RuleLoader;
