import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SkillRegistry from "../skills/SkillRegistry.ts";

let skillsRoot: string;

function writeSkill(dirName: string, content: string): void {
  const dir = path.join(skillsRoot, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
}

const TRIAGE_SKILL = `---
name: repo-triage
description: Systematic triage of failing tests
tools:
  - shell
  - read_file
---

# Repo Triage Skill

1. Reproduce with a single test file.
2. Isolate the smallest code path.
`;

beforeEach(() => {
  skillsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skillregistry-"));
});

afterEach(() => {
  fs.rmSync(skillsRoot, { recursive: true, force: true });
});

describe("SkillRegistry", () => {
  it("discovers skills with SKILL.md frontmatter", () => {
    writeSkill("repo-triage", TRIAGE_SKILL);
    const registry = new SkillRegistry(skillsRoot);
    const skills = registry.discover();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("repo-triage");
    expect(skills[0].tools).toEqual(["shell", "read_file"]);
  });

  it("ignores directories without SKILL.md and files without frontmatter", () => {
    writeSkill("repo-triage", TRIAGE_SKILL);
    fs.mkdirSync(path.join(skillsRoot, "empty-skill"));
    fs.mkdirSync(path.join(skillsRoot, "loose-file"));
    fs.writeFileSync(
      path.join(skillsRoot, "loose-file", "NOTES.md"),
      "# no frontmatter",
      "utf8",
    );
    expect(new SkillRegistry(skillsRoot).discover()).toHaveLength(1);
  });

  it("describeAll returns only name and description", () => {
    writeSkill("repo-triage", TRIAGE_SKILL);
    const described = new SkillRegistry(skillsRoot).describeAll();
    expect(described).toEqual([
      { name: "repo-triage", description: "Systematic triage of failing tests" },
    ]);
    expect(Object.keys(described[0]).sort()).toEqual(["description", "name"]);
  });

  it("loadBody returns the markdown body below the frontmatter", () => {
    writeSkill("repo-triage", TRIAGE_SKILL);
    const registry = new SkillRegistry(skillsRoot);
    const body = registry.loadBody("repo-triage");
    expect(body).toContain("# Repo Triage Skill");
    expect(body).toContain("Isolate the smallest code path.");
    expect(body).not.toContain("description:");
  });

  it("loadBody returns null for unknown skills", () => {
    writeSkill("repo-triage", TRIAGE_SKILL);
    expect(new SkillRegistry(skillsRoot).loadBody("nope")).toBeNull();
  });

  it("falls back to the directory name when frontmatter omits name", () => {
    writeSkill(
      "unnamed",
      "---\ndescription: d\n---\nBody here.\n",
    );
    const skills = new SkillRegistry(skillsRoot).discover();
    expect(skills[0].name).toBe("unnamed");
  });

  it("returns empty discoveries when the root does not exist", () => {
    const registry = new SkillRegistry(path.join(skillsRoot, "missing"));
    expect(registry.discover()).toEqual([]);
    expect(registry.describeAll()).toEqual([]);
    expect(registry.loadBody("x")).toBeNull();
  });
});
