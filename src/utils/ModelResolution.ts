// ─────────────────────────────────────────────────────────────
// Model Resolution Utilities
// ─────────────────────────────────────────────────────────────
// Shared by the /chat route load balancer and OrchestratorService.
// Handles GGUF quantization-aware model matching across instances.

import logger from "./logger.ts";
import { getProvider } from "../providers/index.ts";
import type { InstanceEntry } from "../types/ProviderTypes.ts";
import { getErrorMessage } from "../utils/ErrorHelpers.ts";

// ── Types ────────────────────────────────────────────────────

interface ParsedQuant {
  base: string;
  quant: string | null;
}

interface AvailableModel {
  key?: string;
  id?: string;
  size_bytes?: number;
}

interface QuantCandidate {
  key: string;
  quant: string | null;
  sizeBytes: number;
}

interface ModelResolutionResult {
  usable: InstanceEntry[];
  modelOverrides: Map<string, string>;
}

// ── Implementation ───────────────────────────────────────────

/**
 * Regex to match quantization/precision suffixes including GGUF, AWQ, GPTQ, and FP/BF precision formats.
 * Captures tags like "Q8_0", "IQ4_XS", "F16", "BF16", "AWQ", "AWQ-4bit", "GPTQ", "FP8", etc.
 */
const QUANT_SUFFIX_REGEX =
  /[-_]((?:I?Q[0-9]+(?:_[A-Z0-9]+)*|[BF](?:16|32)|AWQ(?:-[0-9]+bit)?|GPTQ(?:-[0-9]+bit)?|FP[0-9]+|BF[0-9]+|INT[0-9]+))(?:\.gguf)?$/i;

/**
 * Extract the base model name from a GGUF/AWQ/FP model key by stripping the
 * quantization suffix. Handles both path-style and flat-style keys.
 *
 * Examples:
 *   "qwen3-32b@q4_k_m" → { base: "qwen3-32b", quant: "Q4_K_M" }
 *   "lmstudio-community/qwen3-32b-GGUF/qwen3-32b-Q8_0.gguf"
 *     → { base: "lmstudio-community/qwen3-32b-GGUF/qwen3-32b", quant: "Q8_0" }
 */
export function parseModelQuant(modelKey: string): ParsedQuant {
  // Handle @quant suffix (e.g. "qwen3-32b@q4_k_m")
  if (modelKey.includes("@")) {
    const [base, quant] = modelKey.split("@");
    return { base, quant: quant.toUpperCase() };
  }

  // Handle path-style keys — strip .gguf, then match the quant suffix via regex
  const stripped = modelKey.replace(/\.gguf$/i, "");
  const match = stripped.match(QUANT_SUFFIX_REGEX);
  if (match) {
    const quant = match[1].toUpperCase();
    const base = stripped.slice(0, match.index);
    return { base, quant };
  }

  return { base: modelKey, quant: null };
}

/**
 * Find the best available variant of a model among the available models
 * on a specific instance. Ranks by `size_bytes` (file size on disk) —
 * the largest file is the highest-quality quantization.
 */
export function findBestQuantFallback(
  targetModel: string,
  availableModels: AvailableModel[],
): string | null {
  const { base: targetBase, quant: targetQuant } = parseModelQuant(targetModel);

  // Find all available models that share the same base name (any quant variant)
  const candidates: QuantCandidate[] = [];
  for (const model of availableModels) {
    const mKey = model.key || model.id || "";
    const { base, quant } = parseModelQuant(mKey);

    // Compare bases case-insensitively.
    // GGUF paths have long bases like "lmstudio-community/Qwen3.6-27B-GGUF/Qwen3.6-27B"
    // while @quant syntax produces short bases like "qwen3.6-27b". When a direct
    // comparison fails, try matching just the last path segment (actual model name).
    const baseLower = base.toLowerCase();
    const targetBaseLower = targetBase.toLowerCase();
    if (baseLower !== targetBaseLower) {
      const baseLeaf = baseLower.split("/").pop();
      const targetLeaf = targetBaseLower.split("/").pop();
      if (baseLeaf !== targetLeaf) continue;
    }

    // Skip exact same key (already checked before calling this)
    if (mKey === targetModel) continue;
    // Skip identical quant (both could be null for no-quant keys)
    if (quant === targetQuant) continue;

    candidates.push({ key: mKey, quant, sizeBytes: model.size_bytes || 0 });
  }

  if (candidates.length === 0) return null;

  // Sort by file size descending — largest file = highest quality quant
  candidates.sort((firstItem, b) => b.sizeBytes - firstItem.sizeBytes);
  return candidates[0].key;
}

/**
 * Resolve model availability across multiple provider instances.
 * Returns only the instances where the model (or a quant variant) exists,
 * along with per-instance model overrides when a quant fallback is used.
 *
 * This is the same logic the OrchestratorService uses for sub-agents.
 */
export async function resolveModelForInstances(
  modelKey: string,
  siblings: InstanceEntry[],
): Promise<ModelResolutionResult> {
  const maxAttempts = 3;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const modelOverrides = new Map<string, string>();

    try {
      const checks = await Promise.allSettled(
        siblings.map(async (inst) => {
          const provider = getProvider(inst.id);
          if (!provider?.listModels) return { exact: false, fallback: null };

          const result = await Promise.race([
            provider.listModels(),
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error("timeout")), 3000),
            ),
          ]);

          const models: AvailableModel[] = result?.models || result?.data || [];
          const modelKeys = models.map((model) => model.key || model.id || "");
          const exactMatch = modelKeys.includes(modelKey);
          if (exactMatch) return { exact: true, fallback: null };

          // No exact key match — find the best variant with the same base name
          logger.info(
            `[ModelResolution] ${inst.id}: no exact match for "${modelKey}" — available: [${modelKeys.join(", ")}]`,
          );
          const fallback = findBestQuantFallback(modelKey, models);
          return { exact: false, fallback };
        }),
      );

      // Build usable instances list
      const usable: InstanceEntry[] = [];
      for (let i = 0; i < siblings.length; i++) {
        const check = checks[i];
        if (check.status !== "fulfilled") continue;
        const { exact, fallback } = check.value;

        if (exact) {
          usable.push(siblings[i]);
        } else if (fallback) {
          modelOverrides.set(siblings[i].id, fallback);
          usable.push(siblings[i]);
        }
      }

      const summary = usable
        .map((instance) => {
          const override = modelOverrides.get(instance.id);
          return override
            ? `${instance.id}→"${override}"`
            : `${instance.id} (exact)`;
        })
        .join(", ");
      logger.info(
        `[ModelResolution] Model "${modelKey}": ${usable.length}/${siblings.length} instances usable [${summary}]`,
      );

      if (usable.length > 0 || attempt === maxAttempts) {
        return { usable, modelOverrides };
      }

      logger.warn(
        `[ModelResolution] Model "${modelKey}" not found on any instance. Attempt ${attempt}/${maxAttempts} failed. Retrying in ${retryDelayMs}ms...`,
      );
      await new Promise((res) => setTimeout(res, retryDelayMs));

    } catch (error: unknown) {
      logger.warn(
        `[ModelResolution] Model availability check failed: ${getErrorMessage(error)}`,
      );
      if (attempt === maxAttempts) {
        return { usable: siblings, modelOverrides };
      }
      await new Promise((res) => setTimeout(res, retryDelayMs));
    }
  }

  return { usable: siblings, modelOverrides: new Map() };
}
