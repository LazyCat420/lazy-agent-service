/**
 * Current date in the system prompt (A6): the assembled prompt must open
 * with a "Current date: <YYYY-MM-DD> (<weekday>), timezone <tz>" line so the
 * model is grounded in today's date. Replaces any pre-existing date line
 * instead of stacking a second one.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: "hierarchical",
      locale: "en",
    }),
  },
}));

vi.mock("../../ToolOrchestratorService.ts", () => ({
  default: {
    getWorkspaceRoot: vi.fn().mockReturnValue("/home/test"),
    getClientToolSchemas: vi.fn().mockReturnValue([]),
    getToolSchemas: vi.fn().mockReturnValue([]),
    getAvailableTopologies: vi.fn().mockReturnValue([]),
    isWorkspaceAgentConnected: vi.fn().mockResolvedValue(false),
    ensureSchemas: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../../utils/logger.ts", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("../../RequestLogger.ts", () => ({
  default: {
    logRequest: vi.fn(),
  },
}));

import SystemPromptAssembler from "../index.ts";
import type { AssemblerContext } from "../types.ts";

describe("current date in the system prompt", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  });

  it("starts the assembled prompt with the current date line", async () => {
    const assembler = new SystemPromptAssembler();
    const context: AssemblerContext = {
      agent: "OMNI",
      project: "prism-chat",
      username: "test-user",
      messages: [
        { role: "system", content: "" },
        { role: "user", content: "hello" },
      ],
      enabledTools: [],
      resolvedToolNames: [],
      workspaceEnabled: false,
      locale: "en",
    };

    const result = await assembler.assemble(context);

    expect(result.prompt).toBeDefined();
    expect(result.prompt).toContain("Current date: 2026-10-17");
    expect(result.prompt).toContain("timezone");
  });
});
