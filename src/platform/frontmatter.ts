/**
 * frontmatter — the minimal `---` block parser shared by RuleLoader
 * (`rules/*.md`) and SkillRegistry (`skills/<name>/SKILL.md`).
 *
 * Handles the subset both loaders need — scalars, `[a, b]` inline arrays and
 * `- item` lists — without a YAML dependency. Quoted scalars are unquoted.
 *
 * The two call sites historically disagreed on two details; the options below
 * let each keep its exact parsing semantics:
 *
 *   listWithoutArrayKey  "overwrite" (RuleLoader) turns a scalar-valued key
 *                        into a list when a `- item` line follows it;
 *                        "ignore" (SkillRegistry) drops that stray item.
 *   trimInlineArrayEntries  RuleLoader trims `[a, b]` entries, SkillRegistry
 *                        keeps their surrounding whitespace.
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

export interface FrontmatterParseOptions {
  /** Behaviour of a `- item` line whose key currently holds a scalar. Default: "overwrite". */
  listWithoutArrayKey?: "overwrite" | "ignore";
  /** Trim whitespace around inline `[a, b]` entries before unquoting. Default: true. */
  trimInlineArrayEntries?: boolean;
}

/** Strip one matching pair of surrounding single or double quotes. */
export function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a leading `---` frontmatter block into a record of scalars and string
 * arrays. Returns null when the content has no frontmatter block.
 */
export function parseFrontmatter(
  content: string,
  options: FrontmatterParseOptions = {},
): ParsedFrontmatter | null {
  const { listWithoutArrayKey = "overwrite", trimInlineArrayEntries = true } = options;
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
      if (!Array.isArray(existing) && listWithoutArrayKey === "ignore") continue;
      const list = Array.isArray(existing) ? existing : [];
      list.push(unquote(listItem[1]));
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
        .map((entry) => unquote(trimInlineArrayEntries ? entry.trim() : entry))
        .filter((entry) => entry.length > 0);
    } else {
      frontmatter[currentKey] = unquote(value);
    }
  }
  return { frontmatter, body: match[2] };
}
