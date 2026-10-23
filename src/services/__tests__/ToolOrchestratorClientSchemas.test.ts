/**
 * ToolOrchestratorService.getClientToolSchemas — the catalog must not grow between calls.
 *
 * Regression: getClientToolSchemas() pushed the orchestrator tools into the module-level
 * English cache on every call, and then appended them again on return. Each call therefore
 * returned one more copy of create_subagent & co. than the call before, and every assembled
 * system prompt that lists the enabled tools grew by ~3k chars per call until the context
 * exhaustion guard skipped the call (documentation chapter 13 §10).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ConfigModule from "../../config.ts";

vi.mock("../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Promise<typeof ConfigModule>>()),
  TOOLS_SERVICE_URL: "http://mock-tools-service:9999",
}));

vi.mock("../MCPClientService.ts", () => ({
  default: {
    getConnectedClients: vi.fn().mockReturnValue([]),
    getAllToolSchemas: vi.fn().mockReturnValue([]),
    getToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getClientSchemas: vi.fn().mockReturnValue([]),
    getAISchemas: vi.fn().mockReturnValue([]),
    getSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({ topology: "hierarchical", locale: "en" }),
    getCached: vi.fn().mockReturnValue({
      agents: { locale: "en", topology: "hierarchical" },
      creative: {},
    }),
  },
}));

vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../RequestLogger.ts", () => ({
  default: { logRequest: vi.fn() },
}));

const REMOTE_TOOLS = [
  {
    name: "read_url",
    description: "Extract structured content from any URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Any URL." } },
      required: ["url"],
    },
    endpoint: { path: "/tools/read-url", method: "POST" },
    domain: "Web",
    dataSource: "web",
  },
  {
    name: "evaluate_expression",
    description: "Exact arithmetic on two numbers.",
    parameters: {
      type: "object",
      properties: {
        operation: { type: "string", description: "add, subtract, multiply, divide, modulo, power or sqrt." },
        a: { type: "string", description: "First operand." },
        b: { type: "string", description: "Second operand." },
      },
      required: ["operation", "a"],
    },
    endpoint: { path: "/utility/calculate", method: "GET" },
    domain: "Utility",
    dataSource: "local",
  },
];

describe("ToolOrchestratorService.getClientToolSchemas — stable catalog", () => {
  let ToolOrchestratorService: typeof import("../ToolOrchestratorService.ts").default;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation((urlInput: string | URL | Request) => {
      const url = String(urlInput);
      if (url.includes("/admin/tool-schemas")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(structuredClone(REMOTE_TOOLS)) });
      }
      if (url.includes("/admin/config")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ workspaceRoots: ["/home/test"], staticRoots: [] }) });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
    });

    ToolOrchestratorService = (await import("../ToolOrchestratorService.ts")).default;
    (ToolOrchestratorService as any)._resetCaches();
    await ToolOrchestratorService.ensureSchemas();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("lists every tool once, orchestrator tools included", () => {
    const schemas = ToolOrchestratorService.getClientToolSchemas();
    const names = schemas.map((t) => t.name);

    // Guards against a vacuous pass: the leak only shows when both halves of the catalog exist.
    expect(names).toEqual(expect.arrayContaining(["read_url", "evaluate_expression"]));
    expect(schemas.filter((t) => t.domainKey === "core_orchestrator").length).toBeGreaterThan(0);

    expect(names.length).toBe(new Set(names).size);
  });

  it("returns the same catalog on every call", () => {
    const first = ToolOrchestratorService.getClientToolSchemas().map((t) => t.name);
    for (let i = 0; i < 4; i++) {
      expect(ToolOrchestratorService.getClientToolSchemas().map((t) => t.name)).toEqual(first);
    }
  });
});
