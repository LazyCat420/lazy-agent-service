import { describe, expect, it } from "vitest";
import BaseAgenticHarness from "../BaseAgenticHarness.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";

describe("BaseAgenticHarness tool-set helpers", () => {
  const catalog = [
    { name: "custom_a" },
    { name: "custom_b" },
    { name: "mcp__srv__tool" },
    { name: TOOL_NAMES.THINK },
  ];

  it("keeps dynamically enabled and mcp__ tools only", () => {
    const out = BaseAgenticHarness.filterToolsForSet(
      catalog,
      new Set(["custom_a"]),
      true,
      false,
    ).map((t) => t.name);
    expect(out).toContain("custom_a");
    expect(out).toContain("mcp__srv__tool");
    expect(out).not.toContain("custom_b");
  });

  it("drops the think tool when the model has native thinking", () => {
    const withThink = BaseAgenticHarness.filterToolsForSet(
      catalog,
      new Set([TOOL_NAMES.THINK]),
      true,
      false,
    ).map((t) => t.name);
    const without = BaseAgenticHarness.filterToolsForSet(
      catalog,
      new Set([TOOL_NAMES.THINK]),
      true,
      true,
    ).map((t) => t.name);
    expect(withThink).toContain(TOOL_NAMES.THINK);
    expect(without).not.toContain(TOOL_NAMES.THINK);
  });

  it("computes only newly added non-core tools", () => {
    const added = BaseAgenticHarness.computeNewlyAddedTools(
      [{ name: "custom_a" }, { name: "custom_b" }],
      new Set(["custom_a"]),
    );
    expect(added).toEqual([{ name: "custom_b" }]);
  });
});
