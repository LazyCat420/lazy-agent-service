import { describe, expect, it } from "vitest";
import { analyzeCodeHealth } from "../CodeHealthSensor.ts";

describe("CodeHealthSensor", () => {
  it("counts McCabe decision points per function", () => {
    const report = analyzeCodeHealth([
      {
        path: "a.ts",
        content: `export function score(x: number, y: number, z: boolean) {\n  if (x > 0 && y > 0) return 1;\n  for (let i = 0; i < 2; i++) {}\n  return z ? 2 : 3;\n}\n`,
      },
    ]);

    expect(report.functions).toBe(1);
    // 1 + if + && + for + ternary
    expect(report.maxComplexity).toBe(5);
    expect(report.highComplexity).toEqual([]);
  });

  it("does not inflate a parent with decisions inside a nested closure", () => {
    const report = analyzeCodeHealth(
      [
        {
          path: "nested.ts",
          content: `export function outer(items: number[]) {\n  if (!items.length) return [];\n  const mapped = items.map((item) => {\n    if (item > 1) return item;\n    if (item < 0) return 0;\n    return item;\n  });\n  return mapped;\n}\n`,
        },
      ],
      { maxComplexity: 1 },
    );

    const byName = Object.fromEntries(report.highComplexity.map((f) => [f.name, f.complexity]));
    expect(byName.outer).toBe(2);
    expect(byName.map).toBe(3);
  });

  it("ignores optional chaining, optional parameters and strings", () => {
    const report = analyzeCodeHealth([
      {
        path: "optional.ts",
        content: `export function read(value?: { name?: string }) {\n  const label = "if (a && b) ? c : d";\n  return value?.name ?? label;\n}\n`,
      },
    ]);

    // Only ?? is a real branch; `if`/`&&`/`?` inside the string literal are not.
    expect(report.maxComplexity).toBe(2);
  });

  it("reports duplicate token windows across files", () => {
    const block = Array.from({ length: 20 }, (_, i) => `  const value${i} = compute(${i}, "x", true);`).join("\n");
    const report = analyzeCodeHealth(
      [
        { path: "one.ts", content: `function one() {\n${block}\n}\n` },
        { path: "two.ts", content: `function two() {\n${block}\n}\n` },
      ],
      { minDuplicateTokens: 40 },
    );

    expect(report.duplicates.length).toBeGreaterThan(0);
    expect(report.duplicates[0].leftPath).not.toBe(report.duplicates[0].rightPath);
    expect(report.verdict).toBe("warn");
  });

  it("flags exported names never referenced", () => {
    const report = analyzeCodeHealth([
      { path: "lib.ts", content: `export const USED = 1;\nexport const ORPHAN = 2;\n` },
      { path: "use.ts", content: `import { USED } from "./lib.ts";\nconsole.log(USED);\n` },
    ]);

    expect(report.unusedExports).toEqual(["ORPHAN"]);
  });

  it("passes clean code with an explicit ok verdict", () => {
    const report = analyzeCodeHealth([
      { path: "clean.ts", content: `export function add(a: number, b: number) {\n  return a + b;\n}\n` },
    ]);

    expect(report.verdict).toBe("ok");
    expect(report.reasons).toEqual([]);
    expect(report.highComplexity).toEqual([]);
  });
});
