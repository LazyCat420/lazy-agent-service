/**
 * ch.06 item 3 — the core-tools decision.
 *
 * prism force-adds the core agentic tools; ours honoured the SDK's
 * `coreToolsLocked: false`, so a trading persona lost execute_python,
 * emit_structured_output and think. Decision: those three stay available
 * even for an unlocked persona (an explicit blockedTools entry still wins).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: async () => {},
    getToolSchemas: () => CATALOG,
    getClientToolSchemas: () => CATALOG,
    getMCPToolSchemas: () => [],
    isTradingRequest: () => false,
    getToolEmoji: () => "",
  },
}));
vi.mock("../SettingsService.ts", () => ({
  default: { getSection: async () => ({ topology: "default" }) },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: {
    get: (agent: string) =>
      agent === "unlocked"
        ? { coreToolsLocked: false, availableTools: ["get_market_data"] }
        : null,
  },
}));
vi.mock("../ToolContext.ts", () => ({
  default: { get: () => null },
}));

import AgenticToolResolver from "../AgenticToolResolver.ts";

const CATALOG = [
  { name: "get_market_data", description: "md", parameters: {} },
  { name: "execute_python", description: "py", parameters: {} },
  { name: "emit_structured_output", description: "eso", parameters: {} },
  { name: "think", description: "think", parameters: {} },
  { name: "save_memory", description: "core", parameters: {} },
] as never[];

describe("AgenticToolResolver: always-available cognitive tools", () => {
  it("an unlocked persona (coreToolsLocked: false) still gets the three cognitive tools", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: { enabledTools: ["get_market_data"] },
      agent: "unlocked",
      agentConversationId: "conv-core",
    });
    const names = finalTools.map((tool) => tool.name);
    expect(names).toContain("execute_python");
    expect(names).toContain("emit_structured_output");
    expect(names).toContain("think");
    expect(names).toContain("get_market_data");
  });

  it("an unlocked persona does not get other core tools by default", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: { enabledTools: ["get_market_data"] },
      agent: "unlocked",
      agentConversationId: "conv-core",
    });
    const names = finalTools.map((tool) => tool.name);
    expect(names).not.toContain("save_memory");
  });
});
