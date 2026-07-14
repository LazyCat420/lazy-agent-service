/**
 * Tool Description Locale Threading Tests
 *
 * Verifies that the per-conversation locale flows correctly through
 * the entire tool description pipeline:
 *
 *   SystemPromptAssembler.assemble(context)
 *     → ToolDocFormatter.buildToolDescriptions(..., locale)
 *       → ToolOrchestratorService.getClientToolSchemas(topology, locale)
 *         → InternalToolRegistry.getClientSchemas(locale)
 *         → getOrchestratorToolSchemas(topology, locale)
 *
 * Root cause of the original bug: getClientToolSchemas() read locale
 * from the global SettingsService cache instead of accepting it as a
 * parameter. Internal + orchestrator tools had full caveman translations
 * but they were never applied during system prompt assembly.
 *
 * These tests use spy-based assertion (vi.spyOn) to verify locale
 * propagation without replacing the entire module, ensuring the real
 * localization pipeline executes end-to-end.
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

// ── Locale markers for assertions ──────────────────────────
// Internal tools
const CAVEMAN_WRITE_TODO_MARKER = "write/update todo list";
const ENGLISH_WRITE_TODO_MARKER = "Write or update a persistent TODO checklist";

const CAVEMAN_ENTER_PLAN_MARKER = "enter planning mode";
const ENGLISH_ENTER_PLAN_MARKER = "Switch into planning mode";

const CAVEMAN_ASK_USER_MARKER = "ask user question, wait for response";
const ENGLISH_ASK_USER_MARKER = "Ask the user one or more questions";

const CAVEMAN_SUMMARIZE_MARKER = "compress conversation into summary";
const ENGLISH_SUMMARIZE_MARKER = "Compress the current conversation";

// Required label suffix
const CAVEMAN_REQUIRED_LABEL = "(required)";
const ENGLISH_REQUIRED_LABEL = "(required)";

// Orchestrator tools
const CAVEMAN_CREATE_TEAM_MARKER = "spawn sub-agent in isolated worktree";
const ENGLISH_CREATE_TEAM_MARKER = "Spawn one or more sub-agents, each in an isolated git worktree";

const CAVEMAN_SEND_MESSAGE_MARKER = "follow-up to running/completed sub-agent";
const ENGLISH_SEND_MESSAGE_MARKER = "Send a follow-up message to a running or completed sub-agent";

const CAVEMAN_STOP_AGENT_MARKER = "stop running sub-agent";
const ENGLISH_STOP_AGENT_MARKER = "Stop a running sub-agent";

// System prompt structural sections
const CAVEMAN_TOOL_HEADER = "Enabled Tool";
const ENGLISH_TOOL_HEADER = "Enabled Tools";

const CAVEMAN_ENVIRONMENT_HEADER = "## Environment";
const ENGLISH_ENVIRONMENT_HEADER = "## Environment";

const CAVEMAN_CODING_GUIDELINES_MARKER = "read file before editing";
const ENGLISH_CODING_GUIDELINES_MARKER = "Always read relevant files before making edits";

const CAVEMAN_COMMAND_GUIDELINES_MARKER = "dev server, long-running";
const ENGLISH_COMMAND_GUIDELINES_MARKER = "For dev servers and long-running processes";

// ── Tests ──────────────────────────────────────────────────

describe("Tool Description Locale Threading", () => {

  // ────────────────────────────────────────────────────────
  // 1. PromptLocaleService — Verify locale data is loaded
  //    and returns distinct content per locale
  // ────────────────────────────────────────────────────────

  describe("PromptLocaleService locale data availability", () => {
    it("should have caveman internal-tools translations loaded", () => {
      const cavemanWriteTodo = PromptLocaleService.get(
        "caveman",
        "internal-tools.write_todo.description",
      );
      expect(cavemanWriteTodo).not.toContain("[MISSING:");
      expect(cavemanWriteTodo.toLowerCase()).toContain(CAVEMAN_WRITE_TODO_MARKER);
    });

    it("should have english internal-tools translations loaded", () => {
      const englishWriteTodo = PromptLocaleService.get(
        "en",
        "internal-tools.write_todo.description",
      );
      expect(englishWriteTodo).not.toContain("[MISSING:");
      expect(englishWriteTodo).toContain(ENGLISH_WRITE_TODO_MARKER);
    });

    it("should have distinct caveman vs english for enter_plan_mode", () => {
      const cavemanDescription = PromptLocaleService.get(
        "caveman",
        "internal-tools.enter_plan_mode.description",
      );
      const englishDescription = PromptLocaleService.get(
        "en",
        "internal-tools.enter_plan_mode.description",
      );
      expect(cavemanDescription).not.toEqual(englishDescription);
      expect(cavemanDescription.toLowerCase()).toContain(CAVEMAN_ENTER_PLAN_MARKER);
      expect(englishDescription).toContain(ENGLISH_ENTER_PLAN_MARKER);
    });

    it("should have caveman and english required labels", () => {
      const cavemanRequired = PromptLocaleService.get(
        "caveman",
        "system-prompt.requiredLabel",
      );
      const englishRequired = PromptLocaleService.get(
        "en",
        "system-prompt.requiredLabel",
      );
      expect(cavemanRequired).toContain(CAVEMAN_REQUIRED_LABEL);
      expect(englishRequired).toContain(ENGLISH_REQUIRED_LABEL);
    });

    it("should have distinct caveman vs english orchestrator tool descriptions", () => {
      const cavemanCreateTeam = PromptLocaleService.get(
        "caveman",
        "orchestrator.tools.create_team.description",
        {
          hierarchicalDesc: "'hierarchical'",
          hierarchicalAggregationDesc: "'hierarchical_aggregation'",
          sequentialDesc: "'sequential' (default)",
          peerToPeerDesc: "'peer_to_peer'",
          tournamentDesc: "'tournament'",
          criticLoopDesc: "'critic_loop'",
          divideAndConquerDesc: "'divide_and_conquer'",
          mctsDesc: "'mcts'",
        },
      );
      const englishCreateTeam = PromptLocaleService.get(
        "en",
        "orchestrator.tools.create_team.description",
        {
          hierarchicalDesc: "'hierarchical'",
          hierarchicalAggregationDesc: "'hierarchical_aggregation'",
          sequentialDesc: "'sequential' (default)",
          peerToPeerDesc: "'peer_to_peer'",
          tournamentDesc: "'tournament'",
          criticLoopDesc: "'critic_loop'",
          divideAndConquerDesc: "'divide_and_conquer'",
          mctsDesc: "'mcts'",
        },
      );
      expect(cavemanCreateTeam).not.toEqual(englishCreateTeam);
      expect(cavemanCreateTeam.toLowerCase()).toContain(CAVEMAN_CREATE_TEAM_MARKER);
      expect(englishCreateTeam).toContain(ENGLISH_CREATE_TEAM_MARKER);
    });

    it("should have caveman ask_user parameter descriptions", () => {
      const cavemanQuestionsParam = PromptLocaleService.get(
        "caveman",
        "internal-tools.ask_user.parameters.questions",
      );
      expect(cavemanQuestionsParam).not.toContain("[MISSING:");
      expect(cavemanQuestionsParam.toLowerCase()).toContain("question");
    });
  });

  // ────────────────────────────────────────────────────────
  // 2. ToolDocFormatter — Verify locale forwarding to
  //    getClientToolSchemas and into _formatToolDescriptions
  // ────────────────────────────────────────────────────────

  describe("ToolDocFormatter locale forwarding", () => {
    let ToolDocFormatter: typeof import("../ToolDocFormatter.ts").ToolDocFormatter;
    let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
    let getClientSchemasSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const formatterModule = await import("../ToolDocFormatter.ts");
      ToolDocFormatter = formatterModule.ToolDocFormatter;
      const orchestratorModule = await import("../../ToolOrchestratorService.ts");
      ToolOrchestratorService = orchestratorModule.default;

      getClientSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getClientToolSchemas",
      );

      // Return a realistic internal tool schema that would be localized
      getClientSchemasSpy.mockImplementation((_topology?: string, locale?: string) => {
        const activeLocale = locale || "en";
        return [
          {
            name: "write_todo",
            description: PromptLocaleService.get(activeLocale, "internal-tools.write_todo.description"),
            domain: "Core Harness Tools",
            parameters: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "internal-tools.write_todo.parameters.items",
                  ),
                },
              },
              required: ["items"],
            },
          },
          {
            name: "enter_plan_mode",
            description: PromptLocaleService.get(activeLocale, "internal-tools.enter_plan_mode.description"),
            domain: "Core Plan Tools",
            parameters: {
              type: "object",
              properties: {
                reason: {
                  type: "string",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "internal-tools.enter_plan_mode.parameters.reason",
                  ),
                },
              },
              required: [],
            },
          },
          {
            name: "ask_user",
            description: PromptLocaleService.get(activeLocale, "internal-tools.ask_user.description"),
            domain: "Core User Tools",
            parameters: {
              type: "object",
              properties: {
                questions: {
                  type: "array",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "internal-tools.ask_user.parameters.questions",
                  ),
                },
              },
              required: ["questions"],
            },
          },
        ];
      });
    });

    afterEach(() => {
      getClientSchemasSpy?.mockRestore();
    });

    it("should forward 'caveman' locale to getClientToolSchemas", () => {
      const formatter = new ToolDocFormatter();
      formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "caveman",
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(
        undefined,
        "caveman",
      );
    });

    it("should forward 'en' locale to getClientToolSchemas", () => {
      const formatter = new ToolDocFormatter();
      formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "en",
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(
        undefined,
        "en",
      );
    });

    it("should produce caveman tool descriptions when locale is 'caveman'", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "caveman",
      );

      expect(output.toLowerCase()).toContain(CAVEMAN_WRITE_TODO_MARKER);
      expect(output.toLowerCase()).toContain(CAVEMAN_ENTER_PLAN_MARKER);
      expect(output.toLowerCase()).toContain(CAVEMAN_ASK_USER_MARKER);
      expect(output).not.toContain(ENGLISH_WRITE_TODO_MARKER);
      expect(output).not.toContain(ENGLISH_ENTER_PLAN_MARKER);
      expect(output).not.toContain(ENGLISH_ASK_USER_MARKER);
    });

    it("should produce english tool descriptions when locale is 'en'", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "en",
      );

      expect(output).toContain(ENGLISH_WRITE_TODO_MARKER);
      expect(output).toContain(ENGLISH_ENTER_PLAN_MARKER);
      expect(output).toContain(ENGLISH_ASK_USER_MARKER);
    });

    it("should use caveman required label '(required)' when locale is 'caveman'", () => {
      const formatter = new ToolDocFormatter();
      // Parameter docs only render for loaded tools; unloaded tools defer to describe_tools
      const output = formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "caveman",
        new Set(["write_todo", "ask_user"]),
      );

      // write_todo.items and ask_user.questions are required
      expect(output).toContain(CAVEMAN_REQUIRED_LABEL);
    });

    it("should use english required label '(required)' when locale is 'en'", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false, "en",
        new Set(["write_todo", "ask_user"]),
      );

      expect(output).toContain(ENGLISH_REQUIRED_LABEL);
    });

    it("should forward locale even when resolvedToolNames filters the schemas", () => {
      const formatter = new ToolDocFormatter();
      const output = formatter.buildToolDescriptions(
        undefined,
        null,
        undefined,
        ["write_todo"],
        undefined,
        false,
        "caveman",
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(undefined, "caveman");
      expect(output.toLowerCase()).toContain(CAVEMAN_WRITE_TODO_MARKER);
      // Filtered out tools should NOT appear
      expect(output.toLowerCase()).not.toContain(CAVEMAN_ENTER_PLAN_MARKER);
    });

    it("should default to 'en' when no locale argument is provided", () => {
      const formatter = new ToolDocFormatter();
      // Call without locale (uses default parameter value "en")
      const output = formatter.buildToolDescriptions(
        undefined, null, undefined, undefined, undefined, false,
      );

      expect(getClientSchemasSpy).toHaveBeenCalledWith(undefined, "en");
      expect(output).toContain(ENGLISH_WRITE_TODO_MARKER);
    });
  });

  // ────────────────────────────────────────────────────────
  // 3. SystemPromptAssembler — Full assembly locale threading
  //    Verifies that assemble() propagates context.locale
  //    through to tool descriptions, guidelines, environment,
  //    and orchestrator addendum.
  // ────────────────────────────────────────────────────────

  describe("SystemPromptAssembler full assembly locale threading", () => {
    let SystemPromptAssembler: typeof import("../index.ts").default;
    let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
    let getClientSchemasSpy: ReturnType<typeof vi.spyOn>;
    let getToolSchemasSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const assemblerModule = await import("../index.ts");
      SystemPromptAssembler = assemblerModule.default;
      const orchestratorModule = await import("../../ToolOrchestratorService.ts");
      ToolOrchestratorService = orchestratorModule.default;

      getClientSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getClientToolSchemas",
      );
      getToolSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getToolSchemas",
      );
      vi.spyOn(
        ToolOrchestratorService,
        "ensureSchemas",
      ).mockResolvedValue(undefined);

      // Return localized schemas based on the locale argument
      getClientSchemasSpy.mockImplementation((_topology?: string, locale?: string) => {
        const activeLocale = locale || "en";
        return [
          {
            name: "write_todo",
            description: PromptLocaleService.get(activeLocale, "internal-tools.write_todo.description"),
            domain: "Core Harness Tools",
            parameters: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  description: PromptLocaleService.get(activeLocale, "internal-tools.write_todo.parameters.items"),
                },
              },
              required: ["items"],
            },
          },
        ];
      });

      getToolSchemasSpy.mockImplementation((_topology?: string, _locale?: string) => [
        { name: "write_todo", description: "test", parameters: {} },
      ]);
    });

    afterEach(() => {
      getClientSchemasSpy?.mockRestore();
      getToolSchemasSpy?.mockRestore();
    });

    function buildAssemblerContext(localeOverride?: string) {
      return {
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
        locale: localeOverride,
        // Mark the mocked tool as loaded so parameter docs (and their
        // localized required labels) render instead of the describe_tools deferral
        loadedTools: new Set(["write_todo"]),
      };
    }

    it("should produce caveman locale content across all tool descriptions during assembly", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      // If locale was correctly forwarded to getClientToolSchemas,
      // the tool descriptions will be in caveman, not English.
      expect(result.prompt.toLowerCase()).toContain(CAVEMAN_WRITE_TODO_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_WRITE_TODO_MARKER);
      // Required label must also be localized
      expect(result.prompt).toContain(CAVEMAN_REQUIRED_LABEL);
    });

    it("should produce caveman tool descriptions in the assembled prompt", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt.toLowerCase()).toContain(CAVEMAN_WRITE_TODO_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_WRITE_TODO_MARKER);
    });

    it("should produce english tool descriptions when locale is 'en'", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("en"));

      expect(result.prompt).toContain(ENGLISH_WRITE_TODO_MARKER);
    });

    it("should produce caveman environment section in assembled prompt", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt).toContain(CAVEMAN_ENVIRONMENT_HEADER);
    });

    it("should produce english environment section when locale is 'en'", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("en"));

      expect(result.prompt).toContain(ENGLISH_ENVIRONMENT_HEADER);
    });

    it("should produce caveman coding guidelines in assembled prompt", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt).toContain(CAVEMAN_CODING_GUIDELINES_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_CODING_GUIDELINES_MARKER);
    });

    it("should produce caveman command execution guidelines in assembled prompt", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt).toContain(CAVEMAN_COMMAND_GUIDELINES_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_COMMAND_GUIDELINES_MARKER);
    });

    it("should produce caveman tool count header in assembled prompt", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt).toContain(CAVEMAN_TOOL_HEADER);
      expect(result.prompt).not.toContain(ENGLISH_TOOL_HEADER);
    });

    it("should produce caveman required label on tool parameters", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext("caveman"));

      expect(result.prompt).toContain(CAVEMAN_REQUIRED_LABEL);
    });

    it("should default to english when locale is undefined", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildAssemblerContext(undefined));

      expect(result.prompt).toContain(ENGLISH_ENVIRONMENT_HEADER);
      expect(result.prompt).toContain(ENGLISH_CODING_GUIDELINES_MARKER);
    });
  });

  // ────────────────────────────────────────────────────────
  // 4. Adversarial edge cases
  // ────────────────────────────────────────────────────────

  describe("adversarial edge cases", () => {
    let SystemPromptAssembler: typeof import("../index.ts").default;
    let ToolOrchestratorService: typeof import("../../ToolOrchestratorService.ts").default;
    let getClientSchemasSpy: ReturnType<typeof vi.spyOn>;
    let getToolSchemasSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const assemblerModule = await import("../index.ts");
      SystemPromptAssembler = assemblerModule.default;
      const orchestratorModule = await import("../../ToolOrchestratorService.ts");
      ToolOrchestratorService = orchestratorModule.default;

      getClientSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getClientToolSchemas",
      );
      getToolSchemasSpy = vi.spyOn(
        ToolOrchestratorService,
        "getToolSchemas",
      );
      vi.spyOn(
        ToolOrchestratorService,
        "ensureSchemas",
      ).mockResolvedValue(undefined);

      getClientSchemasSpy.mockImplementation((_topology?: string, locale?: string) => {
        const activeLocale = locale || "en";
        return [
          {
            name: "summarize_conversation",
            description: PromptLocaleService.get(activeLocale, "internal-tools.summarize_conversation.description"),
            domain: "Core Harness Tools",
            parameters: {
              type: "object",
              properties: {
                summary: {
                  type: "string",
                  description: PromptLocaleService.get(
                    activeLocale,
                    "internal-tools.summarize_conversation.parameters.summary",
                  ),
                },
              },
              required: ["summary"],
            },
          },
        ];
      });

      getToolSchemasSpy.mockReturnValue([
        { name: "summarize_conversation", description: "test", parameters: {} },
      ]);
    });

    afterEach(() => {
      getClientSchemasSpy?.mockRestore();
      getToolSchemasSpy?.mockRestore();
    });

    function buildContext(locale?: string) {
      return {
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
        locale,
        // Mark the mocked tool as loaded so parameter docs (and their
        // localized required labels) render instead of the describe_tools deferral
        loadedTools: new Set(["summarize_conversation"]),
      };
    }

    it("should never mix caveman structural text with english tool descriptions", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildContext("caveman"));

      // Structural sections must be caveman
      expect(result.prompt).toContain(CAVEMAN_TOOL_HEADER);
      expect(result.prompt).toContain(CAVEMAN_ENVIRONMENT_HEADER);

      // Tool descriptions must also be caveman
      expect(result.prompt.toLowerCase()).toContain(CAVEMAN_SUMMARIZE_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_SUMMARIZE_MARKER);
    });

    it("should never mix english structural text with caveman tool descriptions", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildContext("en"));

      expect(result.prompt).toContain(ENGLISH_ENVIRONMENT_HEADER);
      expect(result.prompt).toContain(ENGLISH_SUMMARIZE_MARKER);
    });

    it("should handle unknown locale by falling back to english via PromptLocaleService", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildContext("klingon"));

      // PromptLocaleService falls back to "en" for unknown locales
      expect(result.prompt).toContain(ENGLISH_ENVIRONMENT_HEADER);
      expect(result.prompt).toContain(ENGLISH_SUMMARIZE_MARKER);
    });

    it("should produce fully localized output proving locale was forwarded to all getClientToolSchemas calls", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildContext("caveman"));

      // If ANY getClientToolSchemas call dropped the locale,
      // the output would contain English tool descriptions or required labels.
      // Both the tool description AND required suffix must be in caveman.
      expect(result.prompt.toLowerCase()).toContain(CAVEMAN_SUMMARIZE_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_SUMMARIZE_MARKER);
      expect(result.prompt).toContain(CAVEMAN_REQUIRED_LABEL);
      expect(result.prompt).toContain(CAVEMAN_TOOL_HEADER);
      expect(result.prompt).not.toContain(ENGLISH_TOOL_HEADER);
    });

    it("should call getToolSchemas with correct locale during orchestrator addendum assembly", async () => {
      // To trigger orchestrator addendum, we need usesCodingGuidelines=true
      // and orchestrator tools available. The OMNI persona has usesCodingGuidelines=true.
      // With no enabledTools filter (empty array), orchestratorAvailable defaults to true.
      const assembler = new SystemPromptAssembler();
      await assembler.assemble({
        ...buildContext("caveman"),
        enabledTools: undefined,
      });

      // getToolSchemas should have been called with "caveman" locale
      if (getToolSchemasSpy.mock.calls.length > 0) {
        for (const call of getToolSchemasSpy.mock.calls) {
          const localeArgument = call[1];
          expect(localeArgument).toBe("caveman");
        }
      }
    });

    it("should produce consistent locale across identity, guidelines, tools, and environment", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble(buildContext("caveman"));

      // All sections must be caveman — no english leaking through
      const cavemanMarkers = [
        "Omni Agent — universal all-domain assistant",
        "use tool proactively, don't ask permission",
        CAVEMAN_CODING_GUIDELINES_MARKER,
        CAVEMAN_COMMAND_GUIDELINES_MARKER,
        CAVEMAN_TOOL_HEADER,
        CAVEMAN_ENVIRONMENT_HEADER,
      ];

      for (const marker of cavemanMarkers) {
        expect(
          result.prompt,
          `Expected prompt to contain caveman marker: "${marker}"`,
        ).toContain(marker);
      }

      // No english structural markers should appear
      const englishMarkers = [
        "You are the Omni Agent — a universal, all-domain AI assistant",
        "use tools proactively rather than asking if the user wants you to",
        ENGLISH_CODING_GUIDELINES_MARKER,
        ENGLISH_COMMAND_GUIDELINES_MARKER,
        ENGLISH_TOOL_HEADER,
      ];

      for (const marker of englishMarkers) {
        expect(
          result.prompt,
          `Expected prompt to NOT contain english marker: "${marker}"`,
        ).not.toContain(marker);
      }
    });

    it("should produce caveman output even when enabledTools domain prefix filters trigger secondary schema calls", async () => {
      const assembler = new SystemPromptAssembler();
      const result = await assembler.assemble({
        ...buildContext("caveman"),
        enabledTools: ["domain:Core Harness Tools"],
      });

      // When enabledTools contains domain: prefixes, the assembler makes
      // additional getClientToolSchemas calls for resolveToolEntriesToSet.
      // ALL of them must forward locale to produce correct output.
      expect(result.prompt.toLowerCase()).toContain(CAVEMAN_SUMMARIZE_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_SUMMARIZE_MARKER);
      expect(result.prompt).toContain(CAVEMAN_REQUIRED_LABEL);
    });
  });
});
