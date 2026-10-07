import fs from "node:fs";
import path from "node:path";

/**
 * SkillRegistry — discovers on-demand skill packages under
 * `<repoRoot>/skills/<name>/SKILL.md`.
 *
 * A SKILL.md has YAML-ish frontmatter with `name`, `description` and an
 * optional `tools` list restricting which tools the skill assumes:
 *
 * ```markdown
 * ---
 * name: repo-triage
 * description: Systematic triage of failing tests in this repository
 * tools:
 *   - shell
 *   - read_file
 * ---
 * Skill body in markdown...
 * ```
 *
 * `describeAll()` powers the system prompt projectScope layer (name +
 * description only); `loadBody(name)` loads the full markdown body on
 * demand via the `skill_read` internal tool.
 */

export interface SkillSummary {
  name: string;
  description: string;
  tools?: string[];
  /** Absolute path of the SKILL.md backing this skill. */
  source: string;
}

const DEFAULT_SKILLS_ROOT = path.resolve(process.cwd(), "skills");

/** Parse `---` frontmatter scalars and string lists (shared minimal parser). */
function parseSkillFrontmatter(
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
      const list = frontmatter[currentKey];
      if (!Array.isArray(list)) continue;
      list.push(unquote(listItem[1]));
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
        .map(unquote)
        .filter((entry) => entry.length > 0);
    } else {
      frontmatter[currentKey] = unquote(value);
    }
  }
  return { frontmatter, body: match[2] };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export class SkillRegistry {
  private skillsRoot: string;
  private cache: SkillSummary[] | null = null;

  constructor(skillsRoot: string = DEFAULT_SKILLS_ROOT) {
    this.skillsRoot = skillsRoot;
  }

  /** Discover all `<skillsRoot>/<name>/SKILL.md` packages. */
  discover(): SkillSummary[] {
    if (this.cache) return this.cache;
    this.cache = this.discoverSync();
    return this.cache;
  }

  private discoverSync(): SkillSummary[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.skillsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
    const skills: SkillSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const source = path.join(this.skillsRoot, entry.name, "SKILL.md");
      let content: string;
      try {
        content = fs.readFileSync(source, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillFrontmatter(content);
      if (!parsed) continue;
      skills.push({
        name:
          typeof parsed.frontmatter.name === "string" &&
          parsed.frontmatter.name.length > 0
            ? parsed.frontmatter.name
            : entry.name,
        description:
          typeof parsed.frontmatter.description === "string"
            ? parsed.frontmatter.description
            : "",
        tools: Array.isArray(parsed.frontmatter.tools)
          ? (parsed.frontmatter.tools as string[])
          : undefined,
        source,
      });
    }
    return skills;
  }

  /** Name + description only, for prompt assembly. */
  describeAll(): Array<{ name: string; description: string }> {
    return this.discover().map((skill) => ({
      name: skill.name,
      description: skill.description,
    }));
  }

  /** Load the markdown body of a skill (everything below the frontmatter). */
  loadBody(name: string): string | null {
    const skill = this.discover().find((entry) => entry.name === name);
    if (!skill) return null;
    try {
      const content = fs.readFileSync(skill.source, "utf8");
      const parsed = parseSkillFrontmatter(content);
      return parsed ? parsed.body.trim() : null;
    } catch {
      return null;
    }
  }
}

export default SkillRegistry;
