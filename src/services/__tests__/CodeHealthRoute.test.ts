import { expect, it } from "vitest";
import { routeLocalTool } from "../LocalToolRouter.ts";

const FILE = `export function score(x: number, y: number, z: boolean) {
  if (x > 0 && y > 0) return 1;
  return z ? 2 : 3;
}
`;

it("code_health routes in-process and reports measured complexity", async () => {
  const out = (await routeLocalTool("code_health", { files: [{ path: "a.ts", content: FILE }] })) as Record<
    string,
    unknown
  >;

  expect(out.success).toBe(true);
  expect(out.verdict).toBe("ok");
  expect(out.functions).toBe(1);
  expect(out.maxComplexity).toBe(4);
});

it("code_health flags findings at the caller's thresholds", async () => {
  const out = (await routeLocalTool("code_health", {
    files: [{ path: "a.ts", content: FILE }],
    max_complexity: 3,
  })) as Record<string, unknown>;

  expect(out.verdict).toBe("warn");
  expect(out.reasons).toEqual([expect.stringContaining("exceed complexity 3")]);
  expect(out.guidance).toContain("call code_health again");
});

it("code_health rejects malformed input instead of guessing", async () => {
  const empty = (await routeLocalTool("code_health", {})) as Record<string, unknown>;
  expect(empty.error).toContain("non-empty files array");

  const malformed = (await routeLocalTool("code_health", { files: [{ path: "a.ts" }] })) as Record<string, unknown>;
  expect(malformed.error).toContain("string path and string content");
});
