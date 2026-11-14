/**
 * T3 — Trading-context tool resolution must NOT auto-inject CORE_AGENTIC_TOOLS
 * or systemTools (`search_web`, `write_file`, `execute_command`/`bash`, etc.)
 * that fail with PERMISSION_DENIED on trading seats (`Board`, `research_worker`),
 * while preserving existing core-tool injection for non-trading coding-agent callers.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSection: vi.fn(),
  getToolSchemas: vi.fn(),
  getClientToolSchemas: vi.fn(),
  getMCPToolSchemas: vi.fn(),
  ensureSchemas: vi.fn(),
  isTradingRequest: vi.fn(),
  withTradingCatalog: vi.fn(),
  personaGet: vi.fn(),
  toolContextGet: vi.fn(),
}));

vi.mock("../ToolOrchestratorService.ts", () => ({
  default: {
    ensureSchemas: mocks.ensureSchemas,
    getToolSchemas: mocks.getToolSchemas,
    getClientToolSchemas: mocks.getClientToolSchemas,
    getMCPToolSchemas: mocks.getMCPToolSchemas,
    isTradingRequest: mocks.isTradingRequest,
    withTradingCatalog: mocks.withTradingCatalog,
  },
}));
vi.mock("../SettingsService.ts", () => ({
  default: { getSection: mocks.getSection },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: { get: mocks.personaGet },
}));
vi.mock("../ToolContext.ts", () => ({
  default: { get: mocks.toolContextGet },
}));

import AgenticToolResolver from "../AgenticToolResolver.ts";

const CATALOG = [
  { name: "whiteboard_read", description: "wb read", domain: "Trading" },
  { name: "read_ledger_entry", description: "ledger read", domain: "Trading" },
  { name: "lazy_web_search", description: "trading web", domain: "Trading" },
  { name: "scrape_url", description: "scrape", domain: "Trading" },
  { name: "get_market_data", description: "md", domain: "Trading" },
  { name: "custom_mcp_tool", description: "mcp", domain: "Custom" },
  { name: "search_web", description: "core web", domain: "Web", system: true },
  { name: "write_file", description: "core write", domain: "Core Workspace", system: true },
  { name: "read_file", description: "core read", domain: "Core Workspace", system: true },
  { name: "execute_command", description: "core cmd", domain: "Core Workspace", system: true },
  { name: "bash", description: "shell", domain: "Core Workspace", system: true },
  { name: "save_memory", description: "mem", domain: "Memory", system: true },
  { name: "create_subagent", description: "orch", domain: "Orchestration", system: true },
];

const FORBIDDEN_SYSTEM_TOOLS = [
  "search_web",
  "write_file",
  "read_file",
  "execute_command",
  "bash",
  "save_memory",
  "create_subagent",
];

describe("AgenticToolResolver T3 trading-context isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureSchemas.mockResolvedValue(undefined);
    mocks.getSection.mockResolvedValue({ topology: "default" });
    mocks.getToolSchemas.mockReturnValue(CATALOG);
    mocks.getClientToolSchemas.mockReturnValue(CATALOG);
    mocks.getMCPToolSchemas.mockReturnValue([]);
    mocks.isTradingRequest.mockImplementation((proj?: string) => proj === "vllm-trading-bot");
    mocks.withTradingCatalog.mockImplementation((tools: unknown[]) => tools);
    mocks.personaGet.mockReturnValue(null);
    mocks.toolContextGet.mockReturnValue(null);
  });

  it("does not inject CORE_AGENTIC_TOOLS or systemTools for Board on project vllm-trading-bot", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      project: "vllm-trading-bot",
      agent: "Board",
      options: { enabledTools: ["whiteboard_read", "read_ledger_entry"] },
    });
    const names = finalTools.map((t) => t.name);
    expect(names).toContain("whiteboard_read");
    expect(names).toContain("read_ledger_entry");
    for (const forbidden of FORBIDDEN_SYSTEM_TOOLS) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("does not inject CORE_AGENTIC_TOOLS or systemTools for research_worker with signed trading context", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      agent: "research_worker",
      options: {
        enabledTools: ["lazy_web_search", "scrape_url"],
        systemPrompt: "Research prompt <TRADING_TOOL_CONTEXT_V1>signed-tok</TRADING_TOOL_CONTEXT_V1>",
      },
    });
    const names = finalTools.map((t) => t.name);
    expect(names).toEqual(["lazy_web_search", "scrape_url"]);
    for (const forbidden of FORBIDDEN_SYSTEM_TOOLS) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("does not inject systemTools when caller supplies an explicit non-system whitelist without a coding persona", async () => {
    const { finalTools } = await AgenticToolResolver.resolve({
      options: { enabledTools: ["get_market_data"] },
    });
    const names = finalTools.map((t) => t.name);
    expect(names).toEqual(["get_market_data"]);
    for (const forbidden of FORBIDDEN_SYSTEM_TOOLS) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("preserves CORE_AGENTIC_TOOLS and systemTools for non-trading coding-agent callers", async () => {
    mocks.personaGet.mockImplementation((agent: string) =>
      agent === "coding" ? { availableTools: ["*"] } : null,
    );

    const { finalTools } = await AgenticToolResolver.resolve({
      project: "coding-workspace",
      agent: "coding",
      options: { enabledTools: ["custom_mcp_tool"] },
    });
    const names = finalTools.map((t) => t.name);
    expect(names).toContain("custom_mcp_tool");
    expect(names).toContain("search_web");
    expect(names).toContain("write_file");
    expect(names).toContain("read_file");
    expect(names).toContain("execute_command");
    expect(names).toContain("create_subagent");
  });
});
