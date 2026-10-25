/**
 * ToolOrchestratorService.ensureSchemas — waits for a schema fetch that is already in flight.
 *
 * Regression: the module starts a tools-service fetch at import time without awaiting it, and
 * ensureSchemas() skipped any fetch within 30 s of the last attempt. So while that first fetch
 * was in flight, ensureSchemas() returned at once and its caller read an empty catalog: the
 * first agent runs after boot were offered only the orchestrator tools (documentation chapter
 * 13 §4.B6).
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

const REMOTE_TOOL = {
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
};

/** tools-service answers only after `delayMs`, so the import-time fetch is still in flight. */
function slowToolsService(delayMs: number) {
  return vi.fn().mockImplementation((urlInput: string | URL | Request) => {
    const url = String(urlInput);
    const body = url.includes("/admin/tool-schemas") ? [structuredClone(REMOTE_TOOL)] : { workspaceRoots: ["/home/test"], staticRoots: [] };
    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: () => Promise.resolve(body) }), delayMs),
    );
  });
}

/**
 * How long the mocked tools-service takes to answer. The tests need the
 * import-time fetch still in flight when `ensureSchemas` runs; with 50 ms, an
 * import slowed by a loaded box (the deploy's sharded run spent 305 s on
 * imports) outlasted the fetch, so the test saw a second fetch or timed out.
 */
const IN_FLIGHT_MS = 2_000;
const TEST_TIMEOUT_MS = 30_000;

describe("ToolOrchestratorService.ensureSchemas — a fetch already in flight", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("waits for the import-time fetch instead of returning an empty catalog", async () => {
    globalThis.fetch = slowToolsService(IN_FLIGHT_MS);
    // Importing starts the module's own fetch; it answers after IN_FLIGHT_MS.
    const ToolOrchestratorService = (await import("../ToolOrchestratorService.ts")).default;

    await ToolOrchestratorService.ensureSchemas();

    const names = ToolOrchestratorService.getClientToolSchemas().map((t) => t.name);
    expect(names).toContain("evaluate_expression");
  }, TEST_TIMEOUT_MS);

  it("does not start a second fetch while one is in flight", async () => {
    const fetchMock = slowToolsService(IN_FLIGHT_MS);
    globalThis.fetch = fetchMock;
    const ToolOrchestratorService = (await import("../ToolOrchestratorService.ts")).default;

    await Promise.all([ToolOrchestratorService.ensureSchemas(), ToolOrchestratorService.ensureSchemas()]);

    const schemaFetches = fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/admin/tool-schemas"));
    expect(schemaFetches).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});
