import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuleLoader, globMatches, globToRegExp } from "../rules/RuleLoader.ts";

let rulesDir: string;

function writeRule(fileName: string, content: string): void {
  fs.writeFileSync(path.join(rulesDir, fileName), content, "utf8");
}

const TESTING_RULE = `---
name: testing-policy
description: How to run tests
paths:
  - "src/**/__tests__/**"
  - "*.test.ts"
---

Always run vitest per file.
`;

const API_RULE = `---
name: api-conventions
description: REST conventions
paths: ["src/api/**"]
---

Use zod at boundaries.
`;

beforeEach(() => {
  rulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruleloader-"));
});

afterEach(() => {
  fs.rmSync(rulesDir, { recursive: true, force: true });
});

describe("globMatches", () => {
  it("matches ** across directories and * within a segment", () => {
    expect(globMatches("src/**/__tests__/**", "src/services/__tests__/foo.test.ts")).toBe(true);
    expect(globMatches("*.test.ts", "src/api/routes.test.ts")).toBe(true);
    expect(globMatches("src/api/**", "src/api/v1/routes.ts")).toBe(true);
    expect(globMatches("src/api/**", "src/api")).toBe(true);
  });

  it("rejects non-matching paths", () => {
    expect(globMatches("src/api/**", "src/services/foo.ts")).toBe(false);
    expect(globMatches("*.test.ts", "src/api/routes.ts")).toBe(false);
    expect(globMatches("src/**/__tests__/**", "src/services/foo.ts")).toBe(false);
  });

  it("escapes regex metacharacters in globs", () => {
    expect(globMatches("a+(b).ts", "a+(b).ts")).toBe(true);
    expect(globMatches("a+(b).ts", "aaab.ts")).toBe(false);
    expect(globMatches("a+b.ts", "a+b.ts")).toBe(true);
  });
});

describe("RuleLoader", () => {
  it("loads rules with valid frontmatter and skips files without paths", () => {
    writeRule("testing-policy.md", TESTING_RULE);
    writeRule("api-conventions.md", API_RULE);
    writeRule("README.example.md", "# Not a rule — no frontmatter\n");
    writeRule("broken.md", "---\nname: broken\n---\nno paths key\n");

    const loader = new RuleLoader(rulesDir);
    const rules = loader.load();
    expect(rules.map((rule) => rule.name).sort()).toEqual([
      "api-conventions",
      "testing-policy",
    ]);
  });

  it("returns only rules matching the touched paths", () => {
    writeRule("testing-policy.md", TESTING_RULE);
    writeRule("api-conventions.md", API_RULE);
    const loader = new RuleLoader(rulesDir);

    const matched = loader.rulesForPaths(["src/services/__tests__/AgenticLoopService.test.ts"]);
    expect(matched.map((rule) => rule.name)).toEqual(["testing-policy"]);

    const apiMatched = loader.rulesForPaths(["src/api/v1/routes.ts"]);
    expect(apiMatched.map((rule) => rule.name)).toEqual(["api-conventions"]);

    expect(loader.rulesForPaths(["docs/README.md"])).toEqual([]);
  });

  it("matches when any glob matches any touched path", () => {
    writeRule("testing-policy.md", TESTING_RULE);
    const loader = new RuleLoader(rulesDir);
    const matched = loader.rulesForPaths(["docs/readme.md", "src/utils/math.test.ts"]);
    expect(matched).toHaveLength(1);
    expect(matched[0].body).toContain("vitest per file");
  });

  it("returns an empty list when the directory does not exist", () => {
    const loader = new RuleLoader(path.join(rulesDir, "does-not-exist"));
    expect(loader.load()).toEqual([]);
    expect(loader.rulesForPaths(["src/anything.ts"])).toEqual([]);
  });

  it("derives the name from the filename when frontmatter omits it", () => {
    writeRule("noname.md", "---\ndescription: x\npaths:\n  - \"a/**\"\n---\n\nBody.\n");
    const rules = new RuleLoader(rulesDir).load();
    expect(rules[0].name).toBe("noname");
  });

  it("globToRegExp anchors the match", () => {
    expect(globToRegExp("*.test.ts").test("x/foo.test.ts")).toBe(false);
    expect(globToRegExp("*.test.ts").test("foo.test.ts")).toBe(true);
  });
});
