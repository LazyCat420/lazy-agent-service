/**
 * Tool Update Message Locale Tests
 *
 * Validates that the [TOOL SET UPDATED] system message injected by
 * BaseAgenticHarness.refreshToolSet() correctly localizes:
 *
 * 1. Structural strings (header, preamble, guidelines heading) via
 *    PromptLocaleService harness.toolSetUpdated.* keys
 * 2. Tool descriptions via ToolDocFormatter.buildToolDescriptions(locale)
 *    which delegates to ToolOrchestratorService.getClientToolSchemas(topology, locale)
 *
 * Root cause of the original bug:
 * - buildToolDescriptions was called without the locale argument, defaulting
 *   to English tool descriptions in the injected system message
 * - The header, preamble, and guidelines heading were hardcoded English strings
 *   instead of PromptLocaleService.get() lookups
 *
 * These tests verify the locale keys exist, are distinct per locale, and that
 * the ToolDocFormatter correctly forwards locale through the entire pipeline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import PromptLocaleService from "../../PromptLocaleService.ts";

// ── Mock heavy services that require DB / network ──────────

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
  default: {
    logRequest: vi.fn(),
  },
}));

// ── Locale markers ─────────────────────────────────────────

// harness.toolSetUpdated.header
const CAVEMAN_HEADER_MARKER = "[NEW TOOL]";
const ENGLISH_HEADER_MARKER = "[TOOL SET UPDATED]";

// harness.toolSetUpdated.availableDocumentation
const CAVEMAN_AVAILABLE_MARKER = "Tool ready with documentation:";
const ENGLISH_AVAILABLE_MARKER = "The following tools are now available with full documentation:";

// harness.toolSetUpdated.usageGuidelines
const CAVEMAN_GUIDELINES_MARKER = "## Tool Usage";
const ENGLISH_GUIDELINES_MARKER = "## Tool Usage Guidelines";

// ── Tests ──────────────────────────────────────────────────

describe("Tool Update Message Locale", () => {

  // ────────────────────────────────────────────────────────
  // 1. PromptLocaleService — harness.toolSetUpdated.* keys
  //    Verify locale data is loaded and returns distinct
  //    content per locale for the tool update message
  // ────────────────────────────────────────────────────────

  describe("PromptLocaleService harness.toolSetUpdated keys", () => {
    it("should have caveman header translation", () => {
      const header = PromptLocaleService.get("caveman", "harness.toolSetUpdated.header", {
        count: "3",
        toolNames: "draw_turtle_graphics, create_3d_model, create_3d_scene",
      });
      expect(header).not.toContain("[MISSING:");
      expect(header).toContain(CAVEMAN_HEADER_MARKER);
      expect(header).not.toContain(ENGLISH_HEADER_MARKER);
    });

    it("should have english header translation", () => {
      const header = PromptLocaleService.get("en", "harness.toolSetUpdated.header", {
        count: "3",
        toolNames: "draw_turtle_graphics, create_3d_model, create_3d_scene",
      });
      expect(header).not.toContain("[MISSING:");
      expect(header).toContain(ENGLISH_HEADER_MARKER);
    });

    it("should produce distinct caveman vs english headers", () => {
      const cavemanHeader = PromptLocaleService.get("caveman", "harness.toolSetUpdated.header", {
        count: "2",
        toolNames: "tool_a, tool_b",
      });
      const englishHeader = PromptLocaleService.get("en", "harness.toolSetUpdated.header", {
        count: "2",
        toolNames: "tool_a, tool_b",
      });
      expect(cavemanHeader).not.toEqual(englishHeader);
    });

    it("should interpolate count and toolNames into header", () => {
      const header = PromptLocaleService.get("en", "harness.toolSetUpdated.header", {
        count: "5",
        toolNames: "alpha, beta, gamma, delta, epsilon",
      });
      expect(header).toContain("5");
      expect(header).toContain("alpha, beta, gamma, delta, epsilon");
    });

    it("should have caveman availableDocumentation translation", () => {
      const available = PromptLocaleService.get(
        "caveman",
        "harness.toolSetUpdated.availableDocumentation",
      );
      expect(available).not.toContain("[MISSING:");
      expect(available).toContain(CAVEMAN_AVAILABLE_MARKER);
    });

    it("should have english availableDocumentation translation", () => {
      const available = PromptLocaleService.get(
        "en",
        "harness.toolSetUpdated.availableDocumentation",
      );
      expect(available).not.toContain("[MISSING:");
      expect(available).toContain(ENGLISH_AVAILABLE_MARKER);
    });

    it("should have caveman usageGuidelines translation", () => {
      const guidelines = PromptLocaleService.get(
        "caveman",
        "harness.toolSetUpdated.usageGuidelines",
      );
      expect(guidelines).not.toContain("[MISSING:");
      expect(guidelines).toContain(CAVEMAN_GUIDELINES_MARKER);
    });

    it("should have english usageGuidelines translation", () => {
      const guidelines = PromptLocaleService.get(
        "en",
        "harness.toolSetUpdated.usageGuidelines",
      );
      expect(guidelines).not.toContain("[MISSING:");
      expect(guidelines).toContain(ENGLISH_GUIDELINES_MARKER);
    });

    it("should produce distinct caveman vs english for all three keys", () => {
      const keys = [
        "harness.toolSetUpdated.availableDocumentation",
        "harness.toolSetUpdated.usageGuidelines",
      ];

      for (const key of keys) {
        const cavemanValue = PromptLocaleService.get("caveman", key);
        const englishValue = PromptLocaleService.get("en", key);
        expect(
          cavemanValue,
          `Key "${key}" should be different for caveman vs english`,
        ).not.toEqual(englishValue);
      }
    });
  });

  // ────────────────────────────────────────────────────────
  // 2. ToolDocFormatter — Verify that buildToolDescriptions
  //    forwards locale to getClientToolSchemas so tool
  //    descriptions in the addendum message are localized
  // ────────────────────────────────────────────────────────

  describe("ToolDocFormatter locale forwarding for tool update addendum", () => {
    let ToolDocFormatter: typeof import("../../system-prompt/ToolDocFormatter.ts").ToolDocFormatter;
    let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
    let getClientSchemasSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const formatterModule = await import("../../system-prompt/ToolDocFormatter.ts");
      ToolDocFormatter = formatterModule.ToolDocFormatter;
      const orchestratorModule = await import("../../ToolOrchestratorService.ts");
      ToolOrchestratorService = orchestratorModule.default;

      getClientSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getClientToolSchemas",
      );

      getClientSchemasSpy.mockImplementation((_topology?: string, locale?: string) => {
        const activeLocale = locale || "en";
        return [
          {
            name: "draw_turtle_graphics",
            description: activeLocale === "caveman"
              ? "make turtle picture using LOGO code language. write code, turtle draw for you."
              : "Draw animated 2D turtle graphics using the LOGO programming language.",
            domain: "Creative",
            parameters: {
              type: "object",
              properties: {
                code: {
                  type: "string",
                  description: activeLocale === "caveman"
                    ? "LOGO code for turtle drawing."
                    : "LOGO source code for the turtle drawing.",
                },
              },
              required: ["code"],
            },
          },
          {
            name: "create_3d_model",
            description: activeLocale === "caveman"
              ? "make 3d thing from shape with material and move."
              : "Create a 3D object/model by composing primitive shapes with PBR materials.",
            domain: "Creative",
            parameters: {
              type: "object",
              properties: {},
              required: [],
            },
          },
        ];
      });
    });

    afterEach(() => {
      getClientSchemasSpy?.mockRestore();
    });

    it("should forward caveman locale to getClientToolSchemas when building addendum", () => {
      const formatter = new ToolDocFormatter();
      formatter.buildToolDescriptions(
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        "caveman",
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(undefined, "caveman");
    });

    it("should produce caveman tool descriptions in addendum output", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        "caveman",
      );

      expect(output).toContain("make turtle picture");
      expect(output).toContain("make 3d thing");
      expect(output).not.toContain("Draw animated 2D turtle");
      expect(output).not.toContain("Create a 3D object/model");
    });

    it("should produce english tool descriptions in addendum when locale is 'en'", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        ["draw_turtle_graphics", "create_3d_model"],
        undefined,
        undefined,
        "en",
      );

      expect(output).toContain("Draw animated 2D turtle");
      expect(output).toContain("Create a 3D object/model");
      expect(output).not.toContain("make turtle picture");
    });

    it("should default to english when locale is omitted", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        ["draw_turtle_graphics"],
        undefined,
        undefined,
        ["draw_turtle_graphics"],
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(undefined, "en");
      expect(output).toContain("Draw animated 2D turtle");
    });
  });

  // ────────────────────────────────────────────────────────
  // 3. End-to-end: Simulated tool update message assembly
  //    Reconstructs the BaseAgenticHarness.refreshToolSet()
  //    message assembly pattern to verify the complete
  //    localized output
  // ────────────────────────────────────────────────────────

  describe("simulated tool update message assembly", () => {
    let ToolDocFormatter: typeof import("../../system-prompt/ToolDocFormatter.ts").ToolDocFormatter;
    let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
    let getClientSchemasSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const formatterModule = await import("../../system-prompt/ToolDocFormatter.ts");
      ToolDocFormatter = formatterModule.ToolDocFormatter;
      const orchestratorModule = await import("../../ToolOrchestratorService.ts");
      ToolOrchestratorService = orchestratorModule.default;

      getClientSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getClientToolSchemas",
      );

      getClientSchemasSpy.mockImplementation((_topology?: string, locale?: string) => {
        const activeLocale = locale || "en";
        return [
          {
            name: "search_events",
            description: activeLocale === "caveman"
              ? "find thing happening nearby. search by place, time, what kind."
              : "Search for events by location, date range, and category.",
            domain: "Events",
            parameters: {
              type: "object",
              properties: {
                location: {
                  type: "string",
                  description: activeLocale === "caveman"
                    ? "where to look for thing."
                    : "Location to search for events.",
                },
              },
              required: ["location"],
            },
          },
        ];
      });
    });

    afterEach(() => {
      getClientSchemasSpy?.mockRestore();
    });

    function assembleToolUpdateMessage(locale: string): string {
      const formatter = new ToolDocFormatter();
      const toolNames = ["search_events"];
      const toolNamesList = toolNames.join(", ");

      const addendumDocumentation = formatter.buildToolDescriptions(
        toolNames,
        undefined,
        undefined,
        toolNames,
        undefined,
        undefined,
        locale,
      );

      const headerText = PromptLocaleService.get(locale, "harness.toolSetUpdated.header", {
        count: String(toolNames.length),
        toolNames: toolNamesList,
      });
      const availableText = PromptLocaleService.get(
        locale,
        "harness.toolSetUpdated.availableDocumentation",
      );
      const guidelinesHeader = PromptLocaleService.get(
        locale,
        "harness.toolSetUpdated.usageGuidelines",
      );

      return (
        `<tool-update>\n` +
        `${headerText}\n\n` +
        `${availableText}\n\n` +
        addendumDocumentation +
        `\n\n${guidelinesHeader}\n\nSome policy text` +
        `\n</tool-update>`
      );
    }

    it("should produce fully caveman tool update message", () => {
      const message = assembleToolUpdateMessage("caveman");

      // Header
      expect(message).toContain(CAVEMAN_HEADER_MARKER);
      expect(message).not.toContain(ENGLISH_HEADER_MARKER);

      // Preamble
      expect(message).toContain(CAVEMAN_AVAILABLE_MARKER);
      expect(message).not.toContain(ENGLISH_AVAILABLE_MARKER);

      // Guidelines heading
      expect(message).toContain(CAVEMAN_GUIDELINES_MARKER);
      expect(message).not.toContain(ENGLISH_GUIDELINES_MARKER);

      // Tool descriptions
      expect(message).toContain("find thing happening nearby");
      expect(message).not.toContain("Search for events by location");
    });

    it("should produce fully english tool update message", () => {
      const message = assembleToolUpdateMessage("en");

      // Header
      expect(message).toContain(ENGLISH_HEADER_MARKER);

      // Preamble
      expect(message).toContain(ENGLISH_AVAILABLE_MARKER);

      // Guidelines heading
      expect(message).toContain(ENGLISH_GUIDELINES_MARKER);

      // Tool descriptions
      expect(message).toContain("Search for events by location");
      expect(message).not.toContain("find thing happening nearby");
    });

    it("should never mix caveman structural text with english tool descriptions", () => {
      const message = assembleToolUpdateMessage("caveman");

      // Structural text must be caveman
      expect(message).toContain(CAVEMAN_HEADER_MARKER);
      expect(message).toContain(CAVEMAN_AVAILABLE_MARKER);

      // Tool descriptions must also be caveman
      expect(message).toContain("find thing happening nearby");

      // Nothing English should leak through
      expect(message).not.toContain(ENGLISH_HEADER_MARKER);
      expect(message).not.toContain(ENGLISH_AVAILABLE_MARKER);
      expect(message).not.toContain("Search for events by location");
    });

    it("should interpolate tool count into caveman header", () => {
      const message = assembleToolUpdateMessage("caveman");
      expect(message).toContain("1 enabled: search_events");
    });

    it("should interpolate tool count into english header", () => {
      const message = assembleToolUpdateMessage("en");
      expect(message).toContain(
        "1 new tool(s) have been dynamically enabled: search_events",
      );
    });
  });

  // ────────────────────────────────────────────────────────
  // 4. Adversarial: lol locale support
  // ────────────────────────────────────────────────────────

  describe("lol locale support", () => {
    it("should have lol header translation", () => {
      const header = PromptLocaleService.get("lol", "harness.toolSetUpdated.header", {
        count: "1",
        toolNames: "test_tool",
      });
      expect(header).not.toContain("[MISSING:");
    });

    it("should have lol availableDocumentation translation", () => {
      const available = PromptLocaleService.get(
        "lol",
        "harness.toolSetUpdated.availableDocumentation",
      );
      expect(available).not.toContain("[MISSING:");
      expect(available.toLowerCase()).toContain("tools");
    });

    it("should have lol usageGuidelines translation", () => {
      const guidelines = PromptLocaleService.get(
        "lol",
        "harness.toolSetUpdated.usageGuidelines",
      );
      expect(guidelines).not.toContain("[MISSING:");
    });
  });
});
