import { afterEach, beforeEach, expect, it, vi } from "vitest";

// search_web on this harness: answered by the shared search, never forwarded to
// tools-service (whose search is DuckDuckGo alone). WebSearchService is mocked
// and fetch throws, so a call that leaks to tools-service fails the test.
const mocks = vi.hoisted(() => ({
  webSearch: vi.fn(),
  isToolAllowed: vi.fn(() => true),
}));
vi.mock("../WebSearchService.ts", () => ({ webSearch: mocks.webSearch }));
vi.mock("../prism/PrismProxyService.js", () => ({
  PrismProxyService: { isToolAllowed: mocks.isToolAllowed },
}));
vi.mock("../../../config.ts", () => ({ TOOLS_SERVICE_URL: "http://tools-service.invalid" }));
vi.mock("../MCPClientService.ts", () => ({
  default: { getConnectedClients: vi.fn(() => []), getAllToolSchemas: vi.fn(() => []), getToolSchemas: vi.fn(() => []) },
}));
vi.mock("../AgentPersonaRegistry.ts", () => ({ default: { get: vi.fn(() => null), list: vi.fn(() => []) } }));
vi.mock("../local-tools/InternalToolRegistry.ts", () => ({
  default: { getClientSchemas: vi.fn(() => []), getAISchemas: vi.fn(() => []), getSchemas: vi.fn(() => []) },
}));
vi.mock("../OrchestratorPrompt.ts", () => ({ ORCHESTRATOR_ONLY_TOOLS: [], getOrchestratorToolSchemas: vi.fn(() => []) }));
vi.mock("../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn(async () => ({ topology: "hierarchical", locale: "en" })),
    getCached: vi.fn(() => ({ agents: { locale: "en", topology: "hierarchical" }, creative: {} })),
  },
}));
vi.mock("../../utils/logger.ts", () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../RequestLogger.ts", () => ({ default: { logRequest: vi.fn() } }));

const { default: ToolOrchestratorService } = await import("../ToolOrchestratorService.ts");

const fetchSpy = vi.fn(async () => {
  throw new Error("search_web must not reach tools-service");
});

beforeEach(() => {
  mocks.webSearch.mockReset();
  mocks.isToolAllowed.mockReset().mockReturnValue(true);
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

it("answers search_web from the shared search in tools-service's result shape", async () => {
  mocks.webSearch.mockResolvedValue({
    status: "ok", provider: "exa", cached: false,
    results: [{ title: "Tokio tutorial", url: "https://www.docs.rs/tokio", snippet: "async runtime", published: "2026-09-30", author: "" }],
  });
  const out = await ToolOrchestratorService.executeTool(
    "search_web",
    { query: "  rust async  ", limit: 3, siteSearch: "docs.rs", dateRestrict: "w1" },
    { conversationId: "c1" },
  );
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("site:docs.rs rust async", 3);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(out).toEqual({
    query: "rust async",
    limit: 3,
    results: [{ title: "Tokio tutorial", url: "https://www.docs.rs/tokio", snippet: "async runtime", displayUrl: "docs.rs", published: "2026-09-30" }],
    totalResults: "1",
    provider: "exa",
    cached: false,
  });
});

it("reports a search that did not run as an error, not as an empty web", async () => {
  mocks.webSearch.mockResolvedValue({ status: "rate_limited", provider: "exa", cached: false, results: [], error: "searches resume in 40 s" });
  const out = await ToolOrchestratorService.executeTool("search_web", { query: "fed decision" }) as Record<string, unknown>;
  expect(mocks.webSearch).toHaveBeenCalledExactlyOnceWith("fed decision", 5);
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(out).toMatchObject({ query: "fed decision", results: [], status: "rate_limited" });
  expect(String(out.error)).toContain("searches resume in 40 s");
});

it("rejects an empty query without searching", async () => {
  const out = await ToolOrchestratorService.executeTool("search_web", { query: "   " });
  expect(out).toEqual({ error: "'query' is required and must be a non-empty string" });
  expect(mocks.webSearch).not.toHaveBeenCalled();
});

it("still enforces the session's tool allowlist first", async () => {
  mocks.isToolAllowed.mockReturnValue(false);
  const out = await ToolOrchestratorService.executeTool("search_web", { query: "x" }, { conversationId: "c2" }) as Record<string, unknown>;
  expect(String(out.error)).toContain("not allowed");
  expect(mocks.webSearch).not.toHaveBeenCalled();
});
