/**
 * Locale Assembly Tests
 *
 * Validates that the SystemPromptAssembler correctly uses the locale from
 * the AssemblerContext (the per-request locale sent by the client) rather
 * than falling back to English. This reproduces the bug where the preview
 * path (ConfigRoutes /system-prompt-preview) correctly localized the prompt,
 * but the agent chat path (ReActHarness → beforePrompt hook) did not.
 *
 * Symptom: Selecting "Caveman" locale in the chat sidebar produces a
 * correctly localized preview ("Who You Are"), but after sending a message,
 * the persisted system prompt reverts to English ("Identity").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import PromptLocaleService from "../../PromptLocaleService.ts";
import type { AssemblerContext } from "../types.ts";

// ── Mock heavy services that require DB / network ──────────
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

// ── Shared fixtures ────────────────────────────────────────
const CAVEMAN_IDENTITY_MARKER = "Coding agent with file system, git, shell, web access.";
const ENGLISH_IDENTITY_MARKER = "You are a coding agent with access to file system, git, shell, and web tools.";

const CAVEMAN_RESPONSE_GUIDELINES_MARKER = "- read file before editing";
const ENGLISH_RESPONSE_GUIDELINES_MARKER = "- Always read relevant files before making edits";

function buildMinimalAssemblerContext(
  overrides: Partial<AssemblerContext> = {},
): AssemblerContext {
  return {
    agent: "CODING",
    project: "prism-chat",
    username: "test-user",
    messages: [
      { role: "system", content: "" },
      { role: "user", content: "hello" },
    ],
    enabledTools: [],
    resolvedToolNames: [],
    workspaceEnabled: false,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────

describe("Locale Assembly", () => {
  let SystemPromptAssembler: typeof import("../index.ts").default;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await import("../index.ts");
    SystemPromptAssembler = module.default;
  });

  describe("PromptLocaleService sanity checks", () => {
    it("should have caveman locale loaded with persona keys", () => {
      const cavemanIdentity = PromptLocaleService.get(
        "caveman",
        "system-prompt.codingFallbackIdentity",
      );
      expect(cavemanIdentity).not.toContain("[MISSING:");
      expect(cavemanIdentity).toContain(CAVEMAN_IDENTITY_MARKER);
    });

    it("should have english locale loaded with persona keys", () => {
      const englishIdentity = PromptLocaleService.get(
        "en",
        "system-prompt.codingFallbackIdentity",
      );
      expect(englishIdentity).not.toContain("[MISSING:");
      expect(englishIdentity).toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should return distinct text for caveman vs english", () => {
      const cavemanIdentity = PromptLocaleService.get(
        "caveman",
        "system-prompt.codingFallbackIdentity",
      );
      const englishIdentity = PromptLocaleService.get(
        "en",
        "system-prompt.codingFallbackIdentity",
      );
      expect(cavemanIdentity).not.toEqual(englishIdentity);
    });
  });

  describe("assembler.assemble() with explicit locale", () => {
    it("should produce caveman identity text when locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "caveman" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should produce caveman response guidelines when locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "caveman" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toContain(CAVEMAN_RESPONSE_GUIDELINES_MARKER);
      expect(result.prompt).not.toContain(ENGLISH_RESPONSE_GUIDELINES_MARKER);
    });

    it("should produce english identity when locale is 'en'", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: "en" });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(ENGLISH_IDENTITY_MARKER);
      expect(result.prompt).not.toContain(CAVEMAN_IDENTITY_MARKER);
    });

    it("should default to english when no locale is provided", async () => {
      const assembler = new SystemPromptAssembler();
      const context = buildMinimalAssemblerContext({ locale: undefined });

      const result = await assembler.assemble(context);

      expect(result.prompt).toBeDefined();
      expect(result.prompt).toContain(ENGLISH_IDENTITY_MARKER);
    });
  });

  describe("createHook() locale propagation (simulates ReActHarness beforePrompt)", () => {
    it("should produce caveman prompt when hookContext.locale is 'caveman'", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({ locale: "caveman" }) as AssemblerContext &
          Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should produce english prompt when hookContext.locale is undefined", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({ locale: undefined }) as AssemblerContext &
          Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should set _assembledSystemPrompt with caveman text when locale propagates through hook", async () => {
      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();

      const hookContext: AssemblerContext & Record<string, unknown> =
        buildMinimalAssemblerContext({ locale: "caveman" }) as AssemblerContext &
          Record<string, unknown>;
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeTruthy();
      expect(assembledPrompt.length).toBeGreaterThan(100);
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).toContain(CAVEMAN_RESPONSE_GUIDELINES_MARKER);
    });
  });

  describe("end-to-end: simulates ReActHarness hookContext construction from options.locale", () => {
    it("should correctly construct hookContext.locale from options.locale = 'caveman'", async () => {
      const mockOptions = {
        locale: "caveman",
        workspaceEnabled: true,
        agentContext: undefined,
      };

      const hookContext: AssemblerContext & Record<string, unknown> = {
        ...buildMinimalAssemblerContext(),
        locale: mockOptions.locale as string | undefined,
        workspaceEnabled: mockOptions.workspaceEnabled as boolean | undefined,
      } as AssemblerContext & Record<string, unknown>;

      expect(hookContext.locale).toBe("caveman");

      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(CAVEMAN_IDENTITY_MARKER);
      expect(assembledPrompt).not.toContain(ENGLISH_IDENTITY_MARKER);
    });

    it("should default to english when options.locale is undefined (simulates missing locale in request)", async () => {
      const mockOptions = {
        locale: undefined as string | undefined,
        workspaceEnabled: true,
      };

      const hookContext: AssemblerContext & Record<string, unknown> = {
        ...buildMinimalAssemblerContext(),
        locale: mockOptions.locale,
      } as AssemblerContext & Record<string, unknown>;

      expect(hookContext.locale).toBeUndefined();

      const assembler = new SystemPromptAssembler();
      const hook = assembler.createHook();
      await hook(hookContext);

      const assembledPrompt = hookContext._assembledSystemPrompt as string;

      expect(assembledPrompt).toBeDefined();
      expect(assembledPrompt).toContain(ENGLISH_IDENTITY_MARKER);
    });
  });
});
