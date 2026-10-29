import logger from "../utils/logger.ts";
import SettingsService, { SettingsData } from "./SettingsService.ts";
import { getInstancesByType } from "../providers/instance-registry.ts";
import { getProvider } from "../providers/index.ts";
import MongoWrapper from "../wrappers/MongoWrapper.ts";
import { MONGO_DB_NAME } from "../../config.ts";
import { COLLECTIONS } from "../constants.ts";

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

export function isVllmProvider(provider: string): boolean {
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
export function isEmbeddingModel(
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

// This service IS the gateway now (lazy-agent-service on :5591), so healed
// settings are written through our own SettingsService — no outbound call to
// prism-service. The old PUT to prism /settings + direct-DB fallback is gone:
// writing two stores let the running gateway serve stale cached settings
// (embedding-model-on-a-generation-role) until someone restarted it.
async function updateSettings(mergedData: Partial<SettingsData>) {
  await SettingsService.update(mergedData);
  logger.info("[VllmModelSyncService] Successfully updated settings via SettingsService");
}

// ─── Role Heal Targets ──────────────────────────────────────────────────────

interface VllmHealRole {
  section: string;
  providerKey: string;
  modelKey: string;
  type: "large" | "general";
}

const HEALED_ROLES: VllmHealRole[] = [
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
  // The critic role is deliberately NOT healed like the others — see the
  // clearing block below the loop. Prism's CriticGate ignores
  // agents.criticProvider entirely: the review call always runs on the
  // CONVERSATION's provider (CriticGate.ts builds it from
  // context.provider) with the pinned model *name*. With single-model
  // vLLM hosts, any pinned name 404s on every other host — measured 869
  // failed reviews in 24h, each burning ~4 stream retries (8-12s)
  // before "Defaulting to approve". Empty criticModel makes the gate
  // fall back to context.resolvedModel (the conversation's own model),
  // which is valid on every host. So the only correct heal for this
  // role is to clear a vLLM pin, never to set one.
  {
    section: "agents",
    providerKey: "subAgentProvider",
    modelKey: "subAgentModel",
    type: "general",
  },
];

// ─── Per-instance Model Loading ─────────────────────────────────────────────

/** Ask every vLLM instance for its loaded models; a 3s timeout skips a host. */
async function fetchLoadedModelsByInstance(
  instances: ReturnType<typeof getInstancesByType>,
): Promise<Map<string, string[]>> {
  const loadedModelsByInstance = new Map<string, string[]>();

  for (const inst of instances) {
    try {
      const provider = getProvider(inst.id);
      if (!provider?.listModels) continue;

      const result = await Promise.race([
        provider.listModels(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000),
        ),
      ]);

      const models: Array<{ key?: string; id?: string }> =
        result?.models || result?.data || [];
      const modelKeys = models.map((m) => m.key || m.id || "").filter(Boolean);
      loadedModelsByInstance.set(inst.id, modelKeys);
    } catch (error) {
      logger.warn(
        `[VllmModelSyncService] Failed to query models for instance ${inst.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return loadedModelsByInstance;
}

function flattenLoadedModels(
  loadedModelsByInstance: Map<string, string[]>,
): Array<{ instanceId: string; modelName: string }> {
  const allLoaded: Array<{ instanceId: string; modelName: string }> = [];
  for (const [instanceId, models] of loadedModelsByInstance.entries()) {
    for (const modelName of models) {
      allLoaded.push({ instanceId, modelName });
    }
  }
  return allLoaded;
}

// ─── Merge / Removal Helpers ────────────────────────────────────────────────

function findInstanceWithModel(
  loadedModelsByInstance: Map<string, string[]>,
  modelName: string,
): string | null {
  for (const [instanceId, models] of loadedModelsByInstance.entries()) {
    if (models.includes(modelName)) return instanceId;
  }
  return null;
}

function selectBestCandidate(
  generationCandidates: Array<{ instanceId: string; modelName: string }>,
  scoreFn: (modelName: string) => number,
) {
  let bestCandidate = generationCandidates[0];
  let bestScore = scoreFn(bestCandidate.modelName);
  for (let i = 1; i < generationCandidates.length; i++) {
    const score = scoreFn(generationCandidates[i].modelName);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = generationCandidates[i];
    }
  }
  return bestCandidate;
}

/** Heal one generation role. Returns whether the settings copy changed. */
function healRole(
  role: VllmHealRole,
  dataCopy: Record<string, unknown>,
  loadedModelsByInstance: Map<string, string[]>,
  generationCandidates: Array<{ instanceId: string; modelName: string }>,
  configuredEmbeddingModel: string,
): boolean {
  // Settings sections are plain objects; this one is validated by the guard.
  const section = dataCopy[role.section] as Record<string, string> | undefined;
  if (!section) return false;

  const currentProvider = section[role.providerKey] || "";
  const currentModel = section[role.modelKey] || "";

  // Skip healing if this role is currently mapped to a non-vLLM provider (e.g. OpenAI, Anthropic, Google)
  if (currentProvider && !isVllmProvider(currentProvider)) return false;

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
  if (loadedOnCurrent) return false;

  // Check if the current model is loaded on a different vLLM instance.
  // Skip this shortcut for an embedding-pinned role — matching it would
  // just re-point the provider at another embedding instance.
  const foundInstanceId = currentIsEmbedding
    ? null
    : findInstanceWithModel(loadedModelsByInstance, currentModel);
  if (foundInstanceId) {
    logger.info(
      `[VllmModelSyncService] Auto-healing ${role.section}.${role.providerKey} from "${currentProvider}" to "${foundInstanceId}" to match model "${currentModel}"`,
    );
    section[role.providerKey] = foundInstanceId;
    return true;
  }

  // Model not loaded on any instance, pick the best candidate — but
  // only from generation-capable models. If the only thing online is an
  // embedding instance, leave the role untouched rather than corrupt it
  // with a model that can't serve chat completions.
  if (generationCandidates.length === 0) {
    logger.warn(
      `[VllmModelSyncService] "${currentModel}" for ${role.section}.${role.modelKey} is not loaded and no generation-capable model is online — leaving unchanged.`,
    );
    return false;
  }

  const scoreFn =
    role.type === "large" ? scoreLargeModel : scoreGeneralModel;
  const bestCandidate = selectBestCandidate(generationCandidates, scoreFn);
  logger.info(
    `[VllmModelSyncService] Auto-healing ${role.section}.${role.providerKey} and ${role.modelKey} because "${currentModel}" is not loaded on any instance. Selected "${bestCandidate.modelName}" on "${bestCandidate.instanceId}"`,
  );
  section[role.providerKey] = bestCandidate.instanceId;
  section[role.modelKey] = bestCandidate.modelName;
  return true;
}

function healRoles(
  dataCopy: Record<string, unknown>,
  loadedModelsByInstance: Map<string, string[]>,
  generationCandidates: Array<{ instanceId: string; modelName: string }>,
  configuredEmbeddingModel: string,
): boolean {
  let updated = false;
  for (const role of HEALED_ROLES) {
    if (healRole(role, dataCopy, loadedModelsByInstance, generationCandidates, configuredEmbeddingModel)) {
      updated = true;
    }
  }
  return updated;
}

/**
 * Clear a vLLM-pinned critic model (see the comment in HEALED_ROLES). A
 * non-vLLM pin (openai/anthropic) is left alone as an explicit operator
 * choice, though it suffers the same cross-provider caveat.
 */
function clearVllmCriticPin(dataCopy: Record<string, unknown>): boolean {
  const agentsSection = dataCopy.agents;
  if (!agentsSection || typeof agentsSection !== "object") return false;
  // Settings agents section is a plain string map.
  const agents = agentsSection as Record<string, string>;
  if ((agents.criticModel || "") === "") return false;
  if (agents.criticProvider && !isVllmProvider(agents.criticProvider)) {
    return false;
  }
  logger.warn(
    `[VllmModelSyncService] Clearing agents.criticModel "${agents.criticModel}" — prism's CriticGate runs the critic on the conversation's provider, so a pinned vLLM model 404s on every other host. Empty falls back to the conversation's own model.`,
  );
  agents.criticModel = "";
  agents.criticProvider = "";
  return true;
}

export const VllmModelSyncService = {
  intervalId: null as ReturnType<typeof setInterval> | null,

  async checkAndSync() {
    try {
      const loadedModelsByInstance = await fetchLoadedModelsByInstance(
        getInstancesByType("vllm"),
      );
      const allLoaded = flattenLoadedModels(loadedModelsByInstance);

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

      // Deep copy so a partial heal never mutates the cached settings object.
      const dataCopy = JSON.parse(JSON.stringify(settings)) as SettingsData;

      const rolesHealed = healRoles(
        dataCopy,
        loadedModelsByInstance,
        generationCandidates,
        configuredEmbeddingModel,
      );
      const criticCleared = clearVllmCriticPin(dataCopy);
      if (rolesHealed || criticCleared) {
        await updateSettings(dataCopy);
      }

      // Also auto-heal scheduled tasks whose configured vLLM models are stale
      await this.syncScheduledTasks(
        loadedModelsByInstance,
        generationCandidates,
        configuredEmbeddingModel,
      );
    } catch (error) {
      logger.error(`[VllmModelSyncService] Error during check and sync: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  async syncScheduledTasks(
    loadedModelsByInstance: Map<string, string[]>,
    generationCandidates: Array<{ instanceId: string; modelName: string }>,
    configuredEmbeddingModel: string,
  ): Promise<number> {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return 0;

      const tasks = await db
        .collection(COLLECTIONS.SCHEDULED_TASKS)
        .find({ enabled: true })
        .toArray();

      let healedCount = 0;

      for (const task of tasks) {
        if (!isVllmProvider(task.provider)) continue;

        const currentProvider = task.provider;
        const currentModel = task.model || "";
        const loadedOnCurrent = loadedModelsByInstance.get(currentProvider) || [];

        const currentIsEmbedding = isEmbeddingModel(
          currentModel,
          configuredEmbeddingModel,
        );

        if (loadedOnCurrent.includes(currentModel) && !currentIsEmbedding) {
          continue;
        }

        // Check if currentModel is loaded on another vLLM instance
        let foundInstanceId: string | null = null;
        if (!currentIsEmbedding && currentModel) {
          for (const [instanceId, models] of loadedModelsByInstance.entries()) {
            if (models.includes(currentModel)) {
              foundInstanceId = instanceId;
              break;
            }
          }
        }

        if (foundInstanceId) {
          logger.info(
            `[VllmModelSyncService] Healing scheduled task "${task.name}" (${task.id}) provider from "${currentProvider}" to "${foundInstanceId}" to match model "${currentModel}"`,
          );
          await db.collection(COLLECTIONS.SCHEDULED_TASKS).updateOne(
            { id: task.id },
            {
              $set: {
                provider: foundInstanceId,
                updatedAt: new Date().toISOString(),
              },
            },
          );
          healedCount++;
          continue;
        }

        // Model not loaded on any instance. Prefer candidate on currentProvider, else best global candidate
        const providerCandidates = loadedOnCurrent.filter(
          (m) => !isEmbeddingModel(m, configuredEmbeddingModel),
        );

        let targetProvider = currentProvider;
        let targetModel = "";

        if (providerCandidates.length > 0) {
          targetModel = providerCandidates[0];
        } else if (generationCandidates.length > 0) {
          targetProvider = generationCandidates[0].instanceId;
          targetModel = generationCandidates[0].modelName;
        } else {
          continue;
        }

        logger.info(
          `[VllmModelSyncService] Auto-healing scheduled task "${task.name}" (${task.id}) from "${currentProvider}/${currentModel}" to "${targetProvider}/${targetModel}"`,
        );

        await db.collection(COLLECTIONS.SCHEDULED_TASKS).updateOne(
          { id: task.id },
          {
            $set: {
              provider: targetProvider,
              model: targetModel,
              updatedAt: new Date().toISOString(),
            },
          },
        );
        healedCount++;
      }

      return healedCount;
    } catch (error) {
      logger.warn(
        `[VllmModelSyncService] Failed to sync scheduled tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 0;
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
