/**
 * ToolOrchestratorService — Per-Locale Cache Selection Tests
 *
 * Verifies that the per-locale caching layer works correctly:
 *
 *   ensureSchemas("caveman")
 *     → fetchSchemasForLocale("caveman")
 *       → fetch(TOOLS_SERVICE_URL + "/admin/tool-schemas?locale=caveman")
 *         → localizedClientSchemasCache.set("caveman", ...)
 *         → localizedAISchemasCache.set("caveman", ...)
 *
 *   getClientToolSchemas(topology, "caveman")
 *     → reads from localizedClientSchemasCache.get("caveman")
 *     → NOT from cachedClientSchemas (default English cache)
 *
 * These tests mock global fetch() to simulate tools-service responses
 * with distinct English vs caveman descriptions, then verify that the
 * correct cache is selected based on the locale argument.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as ConfigModule from "../../../config.ts";

// ── Mock dependencies before imports ───────────────────────

vi.mock("../../../config.ts", async (importOriginal) => ({
  ...(await importOriginal<Promise<typeof ConfigModule>>()),
  TOOLS_SERVICE_URL: "http://mock-tools-service:9999",
}));

vi.mock("../../MCPClientService.ts", () => ({
  default: {
    getConnectedClients: vi.fn().mockReturnValue([]),
    getAllToolSchemas: vi.fn().mockReturnValue([]),
    getToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../AgentPersonaRegistry.ts", () => ({
  default: {
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../local-tools/InternalToolRegistry.ts", () => ({
  default: {
    getClientSchemas: vi.fn().mockReturnValue([]),
    getAISchemas: vi.fn().mockReturnValue([]),
    getSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../../OrchestratorPrompt.ts", () => ({
  ORCHESTRATOR_ONLY_TOOLS: [],
  getOrchestratorToolSchemas: vi.fn().mockReturnValue([]),
}));

vi.mock("../../SettingsService.ts", () => ({
  default: {
    getSection: vi.fn().mockResolvedValue({
      topology: "hierarchical",
      locale: "en",
    }),
    getCached: vi.fn().mockReturnValue({
      agents: { locale: "en", topology: "hierarchical" },
      creative: {},
    }),
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
  default: { logRequest: vi.fn() },
}));

// ── Distinct markers for English vs Caveman remote tools ───
const ENGLISH_REMOTE_DESCRIPTION = "Extract structured content from any URL. Auto-detects platform and uses best extraction method.";
const CAVEMAN_REMOTE_DESCRIPTION = "pull stuff from any URL. auto-detect platform and use best extraction way.";

const ENGLISH_REMOTE_PARAM = "Any URL. handled platforms are auto-detected.";
const CAVEMAN_REMOTE_PARAM = "any URL. platform auto-found.";

/**
 * Build a mock tools-service response with descriptions
 * that differ based on locale.
 */
function buildMockToolSchemas(locale: string) {
  const isCaveman = locale === "caveman";
  return [
    {
      name: "read_url",
      description: isCaveman ? CAVEMAN_REMOTE_DESCRIPTION : ENGLISH_REMOTE_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: isCaveman ? CAVEMAN_REMOTE_PARAM : ENGLISH_REMOTE_PARAM,
          },
        },
        required: ["url"],
      },
      endpoint: { path: "/tools/read-url", method: "POST" },
      domain: "Web",
      dataSource: "web",
    },
    {
      name: "search_web",
      description: isCaveman
        ? "search web using brave. give back result with title."
        : "Search the web using Brave Search. Returns results with titles.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: isCaveman ? "search word." : "The search query.",
          },
        },
        required: ["query"],
      },
      endpoint: { path: "/tools/search-web", method: "POST" },
      domain: "Web",
      dataSource: "brave",
    },
  ];
}

// ── Tests ──────────────────────────────────────────────────

describe("ToolOrchestratorService — Per-Locale Cache Selection", () => {
  let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Save original fetch and replace with mock
    originalFetch = globalThis.fetch;

    globalThis.fetch = vi.fn().mockImplementation((urlInput: string | URL | Request) => {
      const urlString = String(urlInput);

      // Tool schemas endpoint — return locale-specific schemas
      if (urlString.includes("/admin/tool-schemas")) {
        const localeMatch = urlString.match(/locale=([^&]+)/);
        const locale = localeMatch ? decodeURIComponent(localeMatch[1]) : "en";
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(buildMockToolSchemas(locale)),
        });
      }

      // Config endpoint
      if (urlString.includes("/admin/config")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ workspaceRoots: ["/home/test"], staticRoots: [] }),
        });
      }

      // Health endpoint
      if (urlString.includes("/admin/health")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: "ok" }),
        });
      }

      return Promise.resolve({ ok: false, status: 404, statusText: "Not Found" });
    });

    // Dynamic import after mocks are set up
    const orchestratorModule = await import("../../ToolOrchestratorService.ts");
    ToolOrchestratorService = orchestratorModule.default;
    (ToolOrchestratorService as any)._resetCaches();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────────────
  // ensureSchemas(locale) — on-demand locale fetch
  // ────────────────────────────────────────────────────────

  describe("ensureSchemas(locale)", () => {
    it("should fetch schemas from tools-service with locale query parameter", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const fetchCalls = fetchMock.mock.calls.map(
        (call: unknown[]) => (typeof call[0] === "string" ? call[0] : String(call[0])),
      );

      const cavemanSchemaCall = fetchCalls.find(
        (callUrl: string) => callUrl.includes("tool-schemas") && callUrl.includes("locale=caveman"),
      );
      expect(
        cavemanSchemaCall,
        "Expected fetch to be called with ?locale=caveman for tool-schemas",
      ).toBeDefined();
    });

    it("should not re-fetch if caveman schemas are already cached", async () => {
      // First call populates cache
      await ToolOrchestratorService.ensureSchemas("caveman");
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const callCountAfterFirstEnsure = fetchMock.mock.calls.length;

      // Second call should be a no-op
      await ToolOrchestratorService.ensureSchemas("caveman");
      expect(fetchMock.mock.calls.length).toBe(callCountAfterFirstEnsure);
    });

    it("should not fetch for 'en' locale (uses default cache)", async () => {
      const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
      const callCountBefore = fetchMock.mock.calls.length;

      await ToolOrchestratorService.ensureSchemas("en");

      // Should not have made any NEW locale-specific fetch calls
      const newCalls = fetchMock.mock.calls
        .slice(callCountBefore)
        .map((call: unknown[]) => String(call[0]));
      const localeCall = newCalls.find(
        (callUrl: string) => callUrl.includes("locale=en"),
      );
      expect(localeCall).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────────
  // getClientToolSchemas(topology, locale) — cache selection
  // ────────────────────────────────────────────────────────

  describe("getClientToolSchemas cache selection", () => {
    it("should return caveman descriptions when locale is 'caveman' and cache is populated", async () => {
      // Populate the per-locale cache
      await ToolOrchestratorService.ensureSchemas("caveman");

      const schemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(readUrlSchema).toBeDefined();
      expect(readUrlSchema!.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
      expect(readUrlSchema!.description).not.toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should return english descriptions when locale is 'en'", async () => {
      // Default schemas are populated from the module-load fetchSchemas()
      // which fetches without locale param (English default)
      await ToolOrchestratorService.ensureSchemas();

      const schemas = ToolOrchestratorService.getClientToolSchemas(undefined, "en");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(readUrlSchema).toBeDefined();
      expect(readUrlSchema!.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should return different descriptions for 'caveman' vs 'en'", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const cavemanSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");
      const englishSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "en");

      const cavemanReadUrl = cavemanSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );
      const englishReadUrl = englishSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(cavemanReadUrl).toBeDefined();
      expect(englishReadUrl).toBeDefined();
      expect(cavemanReadUrl!.description).not.toBe(englishReadUrl!.description);
      expect(cavemanReadUrl!.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
      expect(englishReadUrl!.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should return caveman parameter descriptions, not just top-level descriptions", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const schemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      const parameters = readUrlSchema?.parameters as
        | { properties?: { url?: { description?: string } } }
        | undefined;
      const urlParamDescription = parameters?.properties?.url?.description;

      expect(urlParamDescription).toBe(CAVEMAN_REMOTE_PARAM);
      expect(urlParamDescription).not.toBe(ENGLISH_REMOTE_PARAM);
    });

    it("should fall back to default english cache when locale fetch fails", async () => {
      // Reset modules to get a fresh service instance
      vi.resetModules();

      // Override fetch: return English for default, but FAIL for caveman
      globalThis.fetch = vi.fn().mockImplementation((urlInput: string | URL | Request) => {
        const urlString = String(urlInput);

        if (urlString.includes("/admin/tool-schemas")) {
          if (urlString.includes("locale=caveman")) {
            // Simulate tools-service failure for caveman locale
            return Promise.resolve({ ok: false, status: 500, statusText: "Internal Server Error" });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve(buildMockToolSchemas("en")),
          });
        }
        if (urlString.includes("/admin/config")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ workspaceRoots: ["/home/test"], staticRoots: [] }),
          });
        }
        return Promise.resolve({ ok: false, status: 404 });
      });

      const freshModule = await import("../../ToolOrchestratorService.ts");
      const freshService = freshModule.default;

      // ensureSchemas("caveman") will attempt to fetch but fail → cache stays empty
      await freshService.ensureSchemas("caveman");

      const schemas = freshService.getClientToolSchemas(undefined, "caveman");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      // Caveman fetch failed, so it falls back to default English cache
      expect(readUrlSchema).toBeDefined();
      expect(readUrlSchema!.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should serve multiple remote tools from the same locale cache", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const schemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");

      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );
      const searchWebSchema = schemas.find(
        (schema: { name: string }) => schema.name === "search_web",
      );

      expect(readUrlSchema?.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
      expect(searchWebSchema?.description).toBe("search web using brave. give back result with title.");
    });
  });

  // ────────────────────────────────────────────────────────
  // getToolSchemas(topology, locale) — AI-clean cache selection
  // ────────────────────────────────────────────────────────

  describe("getToolSchemas AI-clean cache selection", () => {
    it("should return caveman descriptions in AI schemas when locale is 'caveman'", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const schemas = ToolOrchestratorService.getToolSchemas(undefined, "caveman");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(readUrlSchema).toBeDefined();
      expect(readUrlSchema!.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
    });

    it("should return english descriptions in AI schemas when locale is 'en'", async () => {
      await ToolOrchestratorService.ensureSchemas();

      const schemas = ToolOrchestratorService.getToolSchemas(undefined, "en");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(readUrlSchema).toBeDefined();
      expect(readUrlSchema!.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should strip domain and dataSource from AI schemas but keep localized descriptions", async () => {
      await ToolOrchestratorService.ensureSchemas("caveman");

      const schemas = ToolOrchestratorService.getToolSchemas(undefined, "caveman");
      const readUrlSchema = schemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      // AI schemas should NOT have domain/dataSource
      expect(readUrlSchema).not.toHaveProperty("domain");
      expect(readUrlSchema).not.toHaveProperty("dataSource");

      // But SHOULD have the localized description
      expect(readUrlSchema!.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
    });
  });

  // ────────────────────────────────────────────────────────
  // Adversarial: never serve wrong locale
  // ────────────────────────────────────────────────────────

  describe("adversarial: locale cache isolation", () => {
    it("should never contaminate english cache with caveman data", async () => {
      // Load caveman
      await ToolOrchestratorService.ensureSchemas("caveman");

      // English should still be English
      const englishSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "en");
      const englishReadUrl = englishSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(englishReadUrl?.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
      expect(englishReadUrl?.description).not.toBe(CAVEMAN_REMOTE_DESCRIPTION);
    });

    it("should never contaminate caveman cache with english data", async () => {
      // Load caveman
      await ToolOrchestratorService.ensureSchemas("caveman");

      // Caveman should still be Caveman
      const cavemanSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");
      const cavemanReadUrl = cavemanSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      expect(cavemanReadUrl?.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
      expect(cavemanReadUrl?.description).not.toBe(ENGLISH_REMOTE_DESCRIPTION);
    });

    it("should isolate independent locale caches when fetching multiple locales", async () => {
      // Load both locales
      await ToolOrchestratorService.ensureSchemas("caveman");

      // Verify isolation: getting one doesn't affect the other
      const cavemanSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "caveman");
      const englishSchemas = ToolOrchestratorService.getClientToolSchemas(undefined, "en");

      const cavemanReadUrl = cavemanSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );
      const englishReadUrl = englishSchemas.find(
        (schema: { name: string }) => schema.name === "read_url",
      );

      // Both should exist and be distinct
      expect(cavemanReadUrl!.description).toBe(CAVEMAN_REMOTE_DESCRIPTION);
      expect(englishReadUrl!.description).toBe(ENGLISH_REMOTE_DESCRIPTION);
      expect(cavemanReadUrl!.description).not.toBe(englishReadUrl!.description);
    });
  });
});
