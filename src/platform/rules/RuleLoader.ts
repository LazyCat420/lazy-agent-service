import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../frontmatter.ts";

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
export { parseFrontmatter };

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
