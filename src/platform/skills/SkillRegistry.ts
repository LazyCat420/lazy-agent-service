import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../frontmatter.ts";

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

/** Skill files historically keep inline-array whitespace and drop stray list items. */
const SKILL_FRONTMATTER_OPTIONS = {
  listWithoutArrayKey: "ignore",
  trimInlineArrayEntries: false,
} as const;

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
      const parsed = parseFrontmatter(content, SKILL_FRONTMATTER_OPTIONS);
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
      const parsed = parseFrontmatter(content, SKILL_FRONTMATTER_OPTIONS);
      return parsed ? parsed.body.trim() : null;
    } catch {
      return null;
    }
  }
}

export default SkillRegistry;
