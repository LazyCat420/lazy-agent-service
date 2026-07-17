import logger from "../utils/logger.ts";
import SettingsService, { SettingsData } from "./SettingsService.ts";
import { getInstancesByType } from "../providers/instance-registry.ts";
import { getProvider } from "../providers/index.ts";

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

function isVllmProvider(provider: string): boolean {
  return provider === "vllm" || provider.startsWith("vllm-");
}

/**
 * Embedding models must never be auto-selected for a generation role
 * (extraction / consolidation / critic / sub-agent). They only expose
 * `/v1/embeddings`, so a chat-completion call against one 404s.
 *
 * Two signals: a name heuristic (`embeddinggemma`, `bge-*-embed`, `e5-embed`,
 * `text-embedding-*` all contain "embed"), and the exact model configured as
 * the embedding role in settings. `scoreLargeModel` otherwise scores
 * "embeddinggemma" at 60 (via its "gemma" substring), so without this filter
 * the daemon happily heals a generation role onto the embedding instance
 * whenever the preferred chat model is briefly unloaded.
 */
function isEmbeddingModel(
  modelName: string,
  configuredEmbeddingModel: string,
): boolean {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();
  if (/embed/.test(lower)) return true;
  if (
    configuredEmbeddingModel &&
    lower === configuredEmbeddingModel.toLowerCase()
  ) {
    return true;
  }
  return false;
}

function scoreLargeModel(modelName: string): number {
  const lower = modelName.toLowerCase();
  if (lower.includes("qwen3.6") || lower.includes("qwen3")) return 100;
  if (lower.includes("qwen")) return 80;
  if (lower.includes("gemma")) return 60;
  if (lower.includes("minimax")) return 40;
  return 10;
}

function scoreGeneralModel(modelName: string): number {
  const lower = modelName.toLowerCase();
  if (lower.includes("minimax")) return 100;
  if (lower.includes("gemma")) return 80;
  if (lower.includes("qwen")) return 60;
  return 10;
}

async function updateSettings(mergedData: Partial<SettingsData>) {
  try {
    const response = await fetch("http://localhost:7777/settings", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(mergedData),
    });
    if (response.ok) {
      logger.info("[VllmModelSyncService] Successfully updated settings via prism-service PUT /settings");
      // Also update local cache
      await SettingsService.update(mergedData);
      return;
    } else {
      const text = await response.text();
      logger.warn(`[VllmModelSyncService] prism-service PUT /settings returned status ${response.status}: ${text}`);
    }
  } catch (error) {
    logger.warn(`[VllmModelSyncService] Failed to update settings via prism-service, falling back to direct DB update: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Fallback: direct update
  await SettingsService.update(mergedData);
}

export const VllmModelSyncService = {
  intervalId: null as ReturnType<typeof setInterval> | null,

  async checkAndSync() {
    try {
      const instances = getInstancesByType("vllm");
      const loadedModelsByInstance = new Map<string, string[]>();

      for (const inst of instances) {
        try {
          const provider = getProvider(inst.id);
          if (!provider?.listModels) continue;

          const result = await Promise.race([
            provider.listModels(),
            new Promise<any>((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), 3000),
            ),
          ]);

          const models: Array<{ key?: string; id?: string }> = result?.models || result?.data || [];
          const modelKeys = models.map((m) => m.key || m.id || "").filter(Boolean);
          loadedModelsByInstance.set(inst.id, modelKeys);
        } catch (error) {
          logger.warn(`[VllmModelSyncService] Failed to query models for instance ${inst.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Compile all loaded models
      const allLoaded: Array<{ instanceId: string; modelName: string }> = [];
      for (const [instanceId, models] of loadedModelsByInstance.entries()) {
        for (const modelName of models) {
          allLoaded.push({ instanceId, modelName });
        }
      }

      // If no local instances are online, skip healing to avoid blanking configurations during brief restarts
      if (allLoaded.length === 0) {
        return;
      }

      const settings = await SettingsService.get();
      if (!settings) {
        return;
      }

      // Candidates eligible for a *generation* role. Embedding models
      // (e.g. embeddinggemma on the embedding-only vLLM instance) are
      // excluded so healing never points a chat role at a `/v1/embeddings`
      // server, which would 404 every consolidation/extraction call.
      const configuredEmbeddingModel = settings.memory?.embeddingModel || "";
      const generationCandidates = allLoaded.filter(
        (c) => !isEmbeddingModel(c.modelName, configuredEmbeddingModel),
      );

      const dataCopy = JSON.parse(JSON.stringify(settings));
      let updated = false;

      const roles = [
        {
          section: "memory",
          providerKey: "extractionProvider",
          modelKey: "extractionModel",
          type: "large",
        },
        {
          section: "memory",
          providerKey: "consolidationProvider",
          modelKey: "consolidationModel",
          type: "large",
        },
        {
          section: "agents",
          providerKey: "criticProvider",
          modelKey: "criticModel",
          type: "large",
        },
        {
          section: "agents",
          providerKey: "subAgentProvider",
          modelKey: "subAgentModel",
          type: "general",
        },
      ];

      for (const role of roles) {
        if (!dataCopy[role.section]) {
          continue;
        }

        const currentProvider = dataCopy[role.section][role.providerKey] || "";
        const currentModel = dataCopy[role.section][role.modelKey] || "";

        // Skip healing if this role is currently mapped to a non-vLLM provider (e.g. OpenAI, Anthropic, Google)
        if (currentProvider && !isVllmProvider(currentProvider)) {
          continue;
        }

        // A generation role currently pinned to an embedding model is corrupt
        // (a prior heal mis-selected it). Force re-selection even though the
        // model is "loaded" on its instance — otherwise the bad value is sticky.
        const currentIsEmbedding = isEmbeddingModel(
          currentModel,
          configuredEmbeddingModel,
        );
        if (currentIsEmbedding) {
          logger.warn(
            `[VllmModelSyncService] ${role.section}.${role.modelKey} is pinned to embedding model "${currentModel}" — forcing re-heal onto a generation model.`,
          );
        }

        const loadedOnCurrent =
          !currentIsEmbedding &&
          currentProvider &&
          loadedModelsByInstance.get(currentProvider)?.includes(currentModel);

        if (loadedOnCurrent) {
          continue;
        }

        // Check if the current model is loaded on a different vLLM instance.
        // Skip this shortcut for an embedding-pinned role — matching it would
        // just re-point the provider at another embedding instance.
        let foundInstanceId: string | null = null;
        if (!currentIsEmbedding) {
          for (const [instanceId, models] of loadedModelsByInstance.entries()) {
            if (models.includes(currentModel)) {
              foundInstanceId = instanceId;
              break;
            }
          }
        }

        if (foundInstanceId) {
          logger.info(`[VllmModelSyncService] Auto-healing ${role.section}.${role.providerKey} from "${currentProvider}" to "${foundInstanceId}" to match model "${currentModel}"`);
          dataCopy[role.section][role.providerKey] = foundInstanceId;
          updated = true;
          continue;
        }

        // Model not loaded on any instance, pick the best candidate — but
        // only from generation-capable models. If the only thing online is an
        // embedding instance, leave the role untouched rather than corrupt it
        // with a model that can't serve chat completions.
        if (generationCandidates.length === 0) {
          logger.warn(
            `[VllmModelSyncService] "${currentModel}" for ${role.section}.${role.modelKey} is not loaded and no generation-capable model is online — leaving unchanged.`,
          );
          continue;
        }

        const scoreFn = role.type === "large" ? scoreLargeModel : scoreGeneralModel;
        let bestCandidate = generationCandidates[0];
        let bestScore = scoreFn(bestCandidate.modelName);

        for (let i = 1; i < generationCandidates.length; i++) {
          const score = scoreFn(generationCandidates[i].modelName);
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = generationCandidates[i];
          }
        }

        logger.info(`[VllmModelSyncService] Auto-healing ${role.section}.${role.providerKey} and ${role.modelKey} because "${currentModel}" is not loaded on any instance. Selected "${bestCandidate.modelName}" on "${bestCandidate.instanceId}"`);
        dataCopy[role.section][role.providerKey] = bestCandidate.instanceId;
        dataCopy[role.section][role.modelKey] = bestCandidate.modelName;
        updated = true;
      }

      if (updated) {
        await updateSettings(dataCopy);
      }
    } catch (error) {
      logger.error(`[VllmModelSyncService] Error during check and sync: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  async init() {
    if (this.intervalId) return;

    logger.info("[VllmModelSyncService] Initializing background model sync daemon");
    
    // Run an initial sync immediately on boot
    await this.checkAndSync();

    this.intervalId = setInterval(async () => {
      await this.checkAndSync();
    }, CHECK_INTERVAL_MS);
  },

  destroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info("[VllmModelSyncService] Background model sync daemon stopped");
    }
  },
};

export default VllmModelSyncService;
