import {
  DEFAULT_TOPOLOGY,
  CORE_AGENTIC_TOOLS as CORE_AGENTIC_TOOLS_LIST,
} from "@rodrigo-barraza/utilities-library/taxonomy";

const CORE_AGENTIC_TOOLS = new Set<string>(CORE_AGENTIC_TOOLS_LIST);
import { asyncHandler } from "@rodrigo-barraza/utilities-library/express";
import { errorMessage } from "@rodrigo-barraza/utilities-library";
import express, { Request, Response } from "express";
import {
  PROVIDERS,
  PROVIDER_LIST,
  TYPES,
  VOICES,
  DEFAULT_VOICES,
  getModelOptions,
  getDefaultModels,
  getParameterDescriptors,
  resolveRecommendedDefault,
} from "../config.ts";
import type { ModelOptionEntry } from "../config.ts";
import { listInstances } from "../providers/instance-registry.ts";
import { ARENA_SCORES } from "../arrays.ts";
import ToolOrchestratorService from "../services/ToolOrchestratorService.ts";
import AgentPersonaRegistry from "../services/AgentPersonaRegistry.ts";
import SettingsService from "../services/SettingsService.ts";
import SystemPromptAssembler from "../services/system-prompt/index.ts";
import rateLimitStore from "../services/RateLimitStore.ts";
import MinioWrapper from "../wrappers/MinioWrapper.ts";
import LocalProviderGateway from "../services/local-provider/index.ts";
import { THINKING_PATTERNS } from "../services/local-provider/constants.ts";
import { ORCHESTRATOR_ONLY_TOOLS } from "../services/OrchestratorPrompt.ts";
import { resolveToolEntriesToSet } from "../utils/resolveToolEntriesToSet.ts";
import { TOOL_NAMES } from "@rodrigo-barraza/utilities-library/taxonomy";
import PromptLocaleService from "../services/PromptLocaleService.ts";
import {
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_GEMINI_API_KEY,
  ELEVENLABS_API_KEY,
  INWORLD_BASIC,
} from "../../config.ts";

const router = express.Router();

// Map cloud providers to their secrets — provider is "available" when secret is truthy
const CLOUD_PROVIDER_SECRETS = {
  [PROVIDERS.OPENAI]: OPENAI_API_KEY,
  [PROVIDERS.ANTHROPIC]: ANTHROPIC_API_KEY,
  [PROVIDERS.GOOGLE]: GOOGLE_CLOUD_GEMINI_API_KEY,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_API_KEY,
  [PROVIDERS.INWORLD]: INWORLD_BASIC,
};

// Cloud providers available based on API keys
const AVAILABLE_CLOUD = new Set<string>(
  Object.entries(CLOUD_PROVIDER_SECRETS)
    .filter(([, secret]) => !!secret)
    .map(([provider]) => provider),
);

// Local provider instances from the instance registry
const localInstances = listInstances();

// Combined set: cloud providers + all local instance IDs
const AVAILABLE_PROVIDERS = new Set<string>([
  ...AVAILABLE_CLOUD,
  ...localInstances.map((inst) => inst.id),
]);

/**
 * Resolve availableTools entries (may contain "domain:X" / "domainKey:X" prefixes)
 * into a flat Set of concrete tool names using client schemas.
 */
function resolveAvailableToolsToSet(
  availableTools: string[] | undefined,
  defaultTopology?: string,
) {
  if (!availableTools || !Array.isArray(availableTools))
    return new Set<string>();

  // "*" wildcard means all tools — return null sentinel
  if (availableTools.includes("*")) return null;

  const hasPrefixed = availableTools.some(
    (e) => e.startsWith("domain:") || e.startsWith("domainKey:"),
  );
  if (!hasPrefixed) return new Set<string>(availableTools);

  const clientSchemas =
    ToolOrchestratorService.getClientToolSchemas(defaultTopology) || [];
  return resolveToolEntriesToSet(availableTools, clientSchemas);
}

function filterByAvailableProviders(
  modelsMap: Record<string, ModelOptionEntry[]>,
) {
  const filtered: Record<string, ModelOptionEntry[]> = {};
  for (const [provider, models] of Object.entries(modelsMap)) {
    if (AVAILABLE_PROVIDERS.has(provider)) {
      filtered[provider] = models;
    }
  }
  return filtered;
}

/** Filter defaults to only include available providers. */
function filterDefaults(defaults: Record<string, string>) {
  const filtered: Record<string, string> = {};
  for (const [provider, model] of Object.entries(defaults)) {
    if (AVAILABLE_PROVIDERS.has(provider)) {
      filtered[provider] = model;
    }
  }
  return filtered;
}

/**
 * Look up arena scores for a model name from ARENA_SCORES.
 * Tries exact match first, then checks if an arena entry name
 * is contained within the model name (for versioned names like
 * "claude-haiku-4-5-20251001" matching "claude-haiku-4-5-20251001").
 *
 * Returns an arena object like { text: 1406, code: 1310, ... } or null.
 */
function lookupArenaScores(modelName: string) {
  const arena: Record<string, number> = {};
  const key = modelName.toLowerCase();

  // Strip path prefix (e.g. "google/gemma-3-12b" → "gemma-3-12b")
  // and quantization suffix (e.g. "qwen3-32b@q4_k_m" → "qwen3-32b")
  const stripped = key.includes("/") ? key.split("/").pop() || key : key;
  const cleaned = stripped.includes("@") ? stripped.split("@")[0] : stripped;

  for (const [category, scores] of Object.entries(ARENA_SCORES)) {
    if (!scores || typeof scores !== "object") continue;

    let bestMatch: number | null = null;
    let bestLength = 0;

    for (const [arenaName, score] of Object.entries(scores)) {
      const normalizedArenaName = arenaName.toLowerCase();

      // Exact match on raw key or cleaned key
      if (key === normalizedArenaName || cleaned === normalizedArenaName) {
        bestMatch = score as number;
        break;
      }

      // Check both directions of startsWith/includes using cleaned key
      const matched =
        cleaned.startsWith(normalizedArenaName) ||
        normalizedArenaName.startsWith(cleaned) ||
        key.includes(normalizedArenaName) ||
        normalizedArenaName.includes(cleaned);

      if (matched && normalizedArenaName.length > bestLength) {
        bestMatch = score as number;
        bestLength = normalizedArenaName.length;
      }
    }

    if (bestMatch !== null) {
      arena[category] = bestMatch;
    }
  }

  return Object.keys(arena).length > 0 ? arena : null;
}

/**
 * Enrich all models in a provider map with arena scores from ARENA_SCORES.
 * Merges with any existing arena data on the model (existing takes priority).
 */
function enrichModelsWithArenaScores(
  modelsMap: Record<string, ModelOptionEntry[]>,
) {
  for (const provider of Object.keys(modelsMap)) {
    for (const model of modelsMap[provider]) {
      const scores = lookupArenaScores(model.name);
      if (scores) {
        // Merge: existing hardcoded arena data takes priority
        model.arena = { ...scores, ...(model.arena || {}) };
      }
    }
  }
  return modelsMap;
}

// ── Local provider instance metadata ────────────────────────────
// Built from the instance registry. Model fetching is now delegated
// to LocalProviderGateway.discoverModels() in GET /config-local.
const LOCAL_PROVIDERS = localInstances.map((inst) => {
  return {
    id: inst.id,
    type: inst.type,
    instanceNumber: inst.instanceNumber,
    concurrency: inst.concurrency,
    nickname: inst.nickname,
  };
});

/**
 * GET /config
 * Returns the full catalog of providers, models, voices, and capabilities.
 *
 * Query params:
 *   ?includeLocal=true — Merge local provider models inline (3s timeout per
 *     provider). Eliminates the need for a separate GET /config-local round-trip.
 *     The recommendedDefault is re-validated against the merged model set.
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    await ToolOrchestratorService.ensureSchemas();
    // Get static model options (cloud-only — no network calls)
    let textToTextModels = getModelOptions(TYPES.TEXT, TYPES.TEXT);
    let textToImageModels = getModelOptions(TYPES.TEXT, TYPES.IMAGE);

    // Enrich ALL model lists with arena scores from the scraped leaderboard data
    enrichModelsWithArenaScores(textToTextModels);
    enrichModelsWithArenaScores(textToImageModels);

    // Filter to only available providers
    textToTextModels = filterByAvailableProviders(textToTextModels);
    textToImageModels = filterByAvailableProviders(textToImageModels);

    // Optionally merge local provider models inline
    const shouldIncludeLocal = _req.query.includeLocal === "true";
    if (shouldIncludeLocal && localInstances.length > 0) {
      try {
        const localModels = (await LocalProviderGateway.discoverModels({
          timeoutMs: 3000,
          enrich: true,
        })) as Record<string, ModelOptionEntry[]>;

        for (const [instanceId, models] of Object.entries(localModels)) {
          const enriched = { [instanceId]: models };
          enrichModelsWithArenaScores(enriched);
          const existing = textToTextModels[instanceId] || [];
          const existingNames = new Set(
            existing.map((modelOptionEntry) => modelOptionEntry.name),
          );
          const merged = [...existing];
          for (const model of enriched[instanceId]) {
            if (!existingNames.has(model.name)) merged.push(model);
          }
          textToTextModels[instanceId] = merged;
        }
      } catch {
        // Local providers are optional — fall back to cloud-only
      }
    }

    const availableProviderList = PROVIDER_LIST.filter((provider) =>
      AVAILABLE_PROVIDERS.has(provider),
    );
    const availableProviderMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(PROVIDERS)) {
      if (AVAILABLE_PROVIDERS.has(value)) {
        availableProviderMap[key] = value;
      }
    }

    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;

    // Build the dynamic Tool Calling system prompt
    const schemas =
      ToolOrchestratorService.getToolSchemas(defaultTopology) || [];
    const toolNames = schemas
      .map((schema) => {
        const toolSchema = schema as {
          name?: string;
          function?: { name?: string };
        };
        return toolSchema.name || toolSchema.function?.name;
      })
      .filter((name): name is string => typeof name === "string")
      .map((name: string) => {
        return name.replace(/^get_/, "").replace(/_/g, " ");
      });
    const toolList =
      toolNames.length > 0
        ? toolNames.join(", ")
        : "general web search and computation";

    const functionCallSystemPrompt = `You are a helpful AI assistant with access to real-time data APIs. You have tools for ${toolList}.

Guidelines:
- When asked about weather, events, prices, trends, or similar data, ALWAYS use the appropriate tool to fetch real-time data. Never guess or make up data.
- You may call multiple tools in a single response if the question requires data from multiple sources.
- Present data clearly with relevant formatting — use tables, bullet points, and emojis where appropriate.
- When data includes numbers, format them appropriately (currencies, percentages, temperatures).
- If a tool returns an error, inform the user and suggest alternatives.
- Be conversational and helpful, not just a data dump.
- For questions that don't require API data, respond naturally without tool calls.
- The current local date/time is: {{CURRENT_DATE_TIME}}`;

    res.json({
      // Direct MinIO URL for resolving minio:// file refs on the client
      // e.g. "http://<host>:9000/prism"
      fileBaseUrl: MinioWrapper.getBucketUrl() || null,
      fcSystemPrompt: functionCallSystemPrompt,
      providers: availableProviderMap,
      providerList: availableProviderList,
      availableProviders: availableProviderList,
      localProviders: LOCAL_PROVIDERS,
      thinkingPatterns: THINKING_PATTERNS,
      textToText: {
        models: textToTextModels,
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.TEXT)),
        recommendedDefault: resolveRecommendedDefault(
          TYPES.TEXT,
          TYPES.TEXT,
          AVAILABLE_PROVIDERS,
          false,
        ),
        recommendedAgenticDefault: resolveRecommendedDefault(
          TYPES.TEXT,
          TYPES.TEXT,
          AVAILABLE_PROVIDERS,
          true,
        ),
      },
      textToSpeech: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.TEXT, TYPES.AUDIO),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.AUDIO)),
        voices: VOICES,
        defaultVoices: DEFAULT_VOICES,
      },
      textToImage: {
        models: textToImageModels,
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.IMAGE)),
      },
      imageToText: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.IMAGE, TYPES.TEXT),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.IMAGE, TYPES.TEXT)),
      },
      embedding: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.TEXT, TYPES.EMBEDDING),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)),
      },
      audioToText: {
        models: filterByAvailableProviders(
          getModelOptions(TYPES.AUDIO, TYPES.TEXT),
        ),
        defaults: filterDefaults(getDefaultModels(TYPES.AUDIO, TYPES.TEXT)),
      },
      parameterDescriptors: getParameterDescriptors(),
    });
  }),
);

/**
 * GET /config-local
 * Fetches models from local/self-hosted providers (LM Studio, vLLM, Ollama)
 * with a 3-second timeout per provider so unreachable services fail fast.
 * Returns { models: { [provider]: [...] } } for the client to merge.
 * Mounted at /config-local (top-level, not under /config).
 *
 * Delegates all model discovery, normalization, and HF enrichment
 * to LocalProviderGateway.discoverModels(). Arena score enrichment
 * is applied here since it's a config-route concern.
 */
const localConfigRouter = express.Router();
localConfigRouter.get("/", async (_req: Request, res: Response) => {
  const models = (await LocalProviderGateway.discoverModels({
    timeoutMs: 3000,
    enrich: true,
  })) as Record<string, ModelOptionEntry[]>;

  // Enrich each instance's models with arena scores
  for (const key of Object.keys(models)) {
    const wrapped = { [key]: models[key] };
    enrichModelsWithArenaScores(wrapped);
    models[key] = wrapped[key];
  }

  res.json({ models });
});

export { localConfigRouter };

/**
 * GET /config/agents
 * Returns the list of registered agent personas with metadata for the frontend picker.
 */
router.get(
  "/agents",
  asyncHandler(async (_req: Request, res: Response) => {
    await ToolOrchestratorService.ensureSchemas();
    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const agents = AgentPersonaRegistry.list().map((first) => {
      const persona = AgentPersonaRegistry.get(first.id);
      const resolvedTools = resolveAvailableToolsToSet(
        persona?.availableTools,
        defaultTopology,
      );
      // null sentinel means "*" wildcard → all tools
      const isWildcard = resolvedTools === null;

      let finalToolsCount = isWildcard ? -1 : resolvedTools.size;
      let finalToolNames = isWildcard ? ["*"] : [...(resolvedTools || [])];

      if (!isWildcard) {
        const clientSchemas =
          ToolOrchestratorService.getClientToolSchemas(defaultTopology) || [];

        // Core tool bypass: system:true tools AND CORE_AGENTIC_TOOLS members
        // This must match AgenticToolResolver.resolve() bypass logic exactly
        const isCoreToolsLocked = persona?.coreToolsLocked ?? true;
        let coreBypassToolNames: string[] = isCoreToolsLocked
          ? clientSchemas
              .filter(
                (tool) =>
                  tool.system === true || CORE_AGENTIC_TOOLS.has(tool.name),
              )
              .map((tool) => tool.name)
          : [];

        // Apply persona blockedTools denylist to core bypass tools (enabledSet protects)
        if (persona?.blockedTools?.length) {
          const disabledSet = resolveToolEntriesToSet(
            persona.blockedTools,
            clientSchemas,
          );
          coreBypassToolNames = coreBypassToolNames.filter(
            (toolName) =>
              !disabledSet.has(toolName) || resolvedTools.has(toolName),
          );
        }

        const unionSet = new Set([...finalToolNames, ...coreBypassToolNames]);
        finalToolsCount = unionSet.size;
        finalToolNames = [...unionSet];
      }

      let finalEnabledByDefaultToolNames: string[];
      if (persona?.enabledByDefaultTools) {
        const resolvedEnabledByDefaultSet = resolveAvailableToolsToSet(
          persona.enabledByDefaultTools,
          defaultTopology,
        );
        if (resolvedEnabledByDefaultSet === null) {
          finalEnabledByDefaultToolNames = isWildcard
            ? ["*"]
            : [...(resolvedTools || [])];
        } else {
          finalEnabledByDefaultToolNames = [...resolvedEnabledByDefaultSet];
        }
      } else {
        finalEnabledByDefaultToolNames = isWildcard
          ? ["*"]
          : [...(resolvedTools || [])];
      }

      return {
        id: first.id,
        name: first.name,
        description: persona?.description || "",
        custom: first.custom || false,
        icon: persona?.icon || "",
        avatar: persona?.avatar || "",
        color: persona?.color || "",
        backgroundImage: persona?.backgroundImage || "",
        project: persona?.project,
        toolCount: finalToolsCount,
        enabledToolNames: finalToolNames,
        enabledByDefaultToolNames: finalEnabledByDefaultToolNames,
        coreToolsLocked: persona?.coreToolsLocked ?? true,
        canSpawnSubAgents: ORCHESTRATOR_ONLY_TOOLS.includes(
          TOOL_NAMES.CREATE_SUBAGENT,
        ),
        usesDirectoryTree: persona?.usesDirectoryTree || false,
        usesCodingGuidelines: persona?.usesCodingGuidelines || false,
      };
    });
    res.json(agents);
  }),
);

/**
 * GET /config/tools
 * Returns tool schemas. Optionally filter by agent persona via ?agent=CODING.
 */
router.get(
  "/tools",
  asyncHandler(async (_req: Request, res: Response) => {
    await ToolOrchestratorService.ensureSchemas();
    const settings = await SettingsService.getSection("agents");
    const defaultTopology = settings?.topology || DEFAULT_TOPOLOGY;
    const schemas =
      ToolOrchestratorService.getClientToolSchemas(defaultTopology) || [];
    const agentId = _req.query.agent as string | undefined;

    if (agentId) {
      const persona = AgentPersonaRegistry.get(agentId);
      if (persona?.availableTools) {
        const enabledSet = resolveAvailableToolsToSet(
          persona.availableTools,
          defaultTopology,
        );
        const isCoreToolsLocked = persona.coreToolsLocked ?? true;
        // null = wildcard ("*") → return all schemas unfiltered
        if (enabledSet !== null) {
          let filteredSchemas = schemas.filter(
            (tool) =>
              enabledSet.has(tool.name) ||
              (isCoreToolsLocked &&
                (tool.system === true || CORE_AGENTIC_TOOLS.has(tool.name))),
          );

          // Apply persona blockedTools denylist (enabledSet protects)
          if (persona.blockedTools?.length) {
            const disabledSet = resolveToolEntriesToSet(
              persona.blockedTools,
              schemas,
            );
            filteredSchemas = filteredSchemas.filter(
              (tool) =>
                !disabledSet.has(tool.name) || enabledSet.has(tool.name),
            );
          }

          return res.json(filteredSchemas);
        }
      }
    }

    res.json(schemas);
  }),
);

/**
 * POST /config/tools/refresh
 * Re-fetches tool schemas from tools-api and updates the cache.
 * Returns the updated schema count.
 */
router.post(
  "/tools/refresh",
  asyncHandler(async (_req: Request, res: Response) => {
    try {
      const count = await ToolOrchestratorService.refreshSchemas();
      res.json({ ok: true, count });
    } catch (error: unknown) {
      res.status(500).json({ error: errorMessage(error) });
    }
  }),
);

/**
 * GET /config/rate-limits
 * Returns the latest rate-limit snapshots for all cloud providers.
 * OpenAI and Anthropic update dynamically from API response headers.
 * Google is seeded with static tier-2 limits.
 */
router.get("/rate-limits", (_req: Request, res: Response) => {
  res.json(rateLimitStore.getAll());
});

/**
 * POST /config/system-prompt-preview
 * Assembles the full system prompt that would be sent to the LLM, given the
 * current agent, tool, and workspace configuration. Returns the assembled
 * text without making any LLM calls. Used by the Raw view in prism-client
 * to display a live preview of the system prompt on new conversations.
 */
router.post(
  "/system-prompt-preview",
  asyncHandler(async (req: Request, res: Response) => {
    try {
      const {
        agent,
        disabledTools,
        workspaceEnabled,
        systemPrompt: userSystemPrompt,
        locale,
      } = req.body as {
        agent?: string;
        disabledTools?: string[];
        workspaceEnabled?: boolean;
        systemPrompt?: string;
        locale?: string;
      };

      const agentSettings = await SettingsService.getSection("agents");
      const defaultTopology = agentSettings?.topology || DEFAULT_TOPOLOGY;
      const resolvedLocale = locale || agentSettings?.locale || PromptLocaleService.getDefaultLocale();

      await ToolOrchestratorService.ensureSchemas(resolvedLocale);

      const allSchemas = ToolOrchestratorService.getClientToolSchemas(defaultTopology, resolvedLocale);
      const disabledSet = new Set(disabledTools || []);
      const enabledToolNames = allSchemas
        .map((tool: { name: string }) => tool.name)
        .filter((name: string) => !disabledSet.has(name));

      const resolvedToolNames = ToolOrchestratorService.getToolSchemas(defaultTopology, resolvedLocale)
        .map((tool: { name: string }) => tool.name)
        .filter((name: string) => !disabledSet.has(name));

      const assembler = new SystemPromptAssembler({
        workspaceRoot: req.workspaceRoot || undefined,
      });

      const placeholderSystemMessage = { role: "system" as const, content: "" };
      const placeholderUserMessage = { role: "user" as const, content: "(preview)" };

      const assemblerContext = {
        agent: agent || null,
        project: req.project || null,
        username: req.username || undefined,
        messages: [placeholderSystemMessage, placeholderUserMessage],
        enabledTools: enabledToolNames,
        resolvedToolNames,
        workspaceEnabled: workspaceEnabled !== false,
        locale: resolvedLocale,
      };

      const result = await assembler.assemble(assemblerContext);

      const sections: string[] = [];

      if (result.prompt) {
        sections.push(result.prompt);
      }

      if (userSystemPrompt) {
        sections.push(
          `## User System Instruction\n${userSystemPrompt}`,
        );
      }

      if (result.skillsText) {
        sections.push(result.skillsText);
      }

      if (result.memoriesText) {
        sections.push(result.memoriesText);
      }

      if (result.workflowsText) {
        sections.push(result.workflowsText);
      }

      const fullPrompt = sections.join("\n\n");

      res.json({
        prompt: fullPrompt,
        characterCount: fullPrompt.length,
        estimatedTokens: Math.ceil(fullPrompt.length / 4),
      });
    } catch (error: unknown) {
      res.status(500).json({ error: errorMessage(error) });
    }
  }),
);

// ─── Available Locales ─────────────────────────────────────────

const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  pt: "Português",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  it: "Italiano",
  ru: "Русский",
  ar: "العربية",
  caveman: "Caveman",
};

/**
 * GET /config/locales
 * Returns the list of available prompt locale codes with display labels.
 */
router.get("/locales", (_req: Request, res: Response) => {
  const availableLocaleCodes = PromptLocaleService.getAvailableLocales();
  const localeOptions = availableLocaleCodes.map((code) => ({
    value: code,
    label: LOCALE_LABELS[code] || code.toUpperCase(),
  }));
  res.json(localeOptions);
});

export default router;
