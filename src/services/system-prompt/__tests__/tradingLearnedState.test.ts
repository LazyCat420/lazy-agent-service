/**
 * A trading run gets no harness-learned state from the assembler.
 *
 * Found 2026-10-16 (trading audit F1): after trading's agents moved from
 * prism's loop to ours, every V3 brief arrived behind ~12-26k chars of
 * "[Agent Memory]" and "## Past Successful Workflows" ("do not redundantly
 * fetch data already provided", other tickers' figures). Prism never sent
 * them (its retrieval failed on every call), and valuation screener_query use
 * fell from 33/37 runs to 1/6.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import type { AssemblerContext } from "../types.ts";

vi.mock("../../SettingsService.ts", () => ({
  default: { getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }) },
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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../WorkflowMemoryService.ts", () => ({
  default: { retrieveRelevantWorkflows: vi.fn().mockResolvedValue("## Past Successful Workflows\nscreen then annotate") },
}));
vi.mock("../../../wrappers/MongoWrapper.ts", () => ({ default: { getDb: vi.fn() } }));

import SystemPromptAssembler from "../index.ts";
import { SkillMemoryScorer } from "../SkillMemoryScorer.ts";
import WorkflowMemoryService from "../../WorkflowMemoryService.ts";

const brief = "## Ticker: AMZN\n## Cycle: cycle-v3-1792183632\n\n## PRECOMPUTED VALUATION MATH\n- P/E 20.1";

function context(project: string): AssemblerContext {
  return {
    agent: "OMNI",
    project,
    username: "lazy-trader",
    messages: [{ role: "system", content: "" }, { role: "user", content: brief }],
    enabledTools: [],
    resolvedToolNames: [],
    workspaceEnabled: false,
  };
}

describe("trading runs carry no harness-learned state", () => {
  let fetchMemories: MockInstance;
  let fetchSkills: MockInstance;
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMemories = vi.spyOn(SkillMemoryScorer.prototype, "fetchMemories")
      .mockResolvedValue("- Do not redundantly fetch data already provided");
    fetchSkills = vi.spyOn(SkillMemoryScorer.prototype, "fetchSkills")
      .mockResolvedValue([{ name: "valuation", content: "skip the screener" } as never]);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fetchMemories.mockRestore();
    fetchSkills.mockRestore();
  });

  it("retrieves no memories, workflows or skills for vllm-trading-bot", async () => {
    const result = await new SystemPromptAssembler().assemble(context("vllm-trading-bot"));
    expect(fetchMemories).not.toHaveBeenCalled();
    expect(fetchSkills).not.toHaveBeenCalled();
    expect(WorkflowMemoryService.retrieveRelevantWorkflows).not.toHaveBeenCalled();
    expect(result.memoriesText).toBe("");
    expect(result.workflowsText).toBe("");
    expect(result.skillsText).toBe("");
  });

  it("still retrieves them for other projects", async () => {
    const result = await new SystemPromptAssembler().assemble(context("prism-chat"));
    expect(fetchMemories).toHaveBeenCalledOnce();
    expect(WorkflowMemoryService.retrieveRelevantWorkflows).toHaveBeenCalledOnce();
    expect(result.memoriesText).toContain("[Agent Memory]");
    expect(result.workflowsText).toContain("## Past Successful Workflows");
    expect(result.skillsText).toContain("[Project Skills]");
  });

  it("follows the boundary switch: TRADING_LEARNING_BOUNDARY_ENABLED=false restores retrieval", async () => {
    vi.stubEnv("TRADING_LEARNING_BOUNDARY_ENABLED", "false");
    const result = await new SystemPromptAssembler().assemble(context("vllm-trading-bot"));
    expect(fetchMemories).toHaveBeenCalledOnce();
    expect(result.memoriesText).toContain("[Agent Memory]");
  });
});
