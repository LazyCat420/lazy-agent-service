// ─── Multi-Instance Local Provider Support ──────────────────
import logger from "../utils/logger.js";
import { PROVIDER_LM_STUDIO, PROVIDER_VLLM, PROVIDER_OLLAMA, PROVIDER_LLAMA_CPP, } from "../../config.js";
import { PROVIDERS } from "../constants.js";
// Import factories
import { createLmStudioProvider } from "./lm-studio.js";
import { createOllamaProvider } from "./ollama.js";
import { createVllmProvider } from "./vllm.js";
import { createLlamaCppProvider } from "./llama-cpp.js";
// ── Factory map ─────────────────────────────────────────────
const FACTORIES = {
    [PROVIDERS.LM_STUDIO]: createLmStudioProvider,
    [PROVIDERS.OLLAMA]: createOllamaProvider,
    [PROVIDERS.VLLM]: createVllmProvider,
    [PROVIDERS.LLAMA_CPP]: createLlamaCppProvider,
};
// ── Provider arrays from secrets ────────────────────────────
const PROVIDER_ARRAYS = {
    [PROVIDERS.LM_STUDIO]: PROVIDER_LM_STUDIO || [],
    [PROVIDERS.VLLM]: PROVIDER_VLLM || [],
    [PROVIDERS.OLLAMA]: PROVIDER_OLLAMA || [],
    [PROVIDERS.LLAMA_CPP]: PROVIDER_LLAMA_CPP || [],
};
// ── Registry ────────────────────────────────────────────────
/**
 * @property {string} id            - Unique instance ID (e.g. "lm-studio-2")
 * @property {string} type          - Provider type (e.g. "lm-studio")
 * @property {string} baseUrl       - Server URL
 * @property {number} concurrency   - Max concurrent requests for this instance
 * @property {number} instanceNumber - 1-based instance number within its type
 * @property {string} [nickname]    - Optional display label (e.g. "Desktop")
 * @property {object} provider      - The instantiated provider object
 */
const registry = new Map();
function registerType(type, instances) {
    const factory = FACTORIES[type];
    if (!factory)
        return;
    for (let i = 0; i < instances.length; i++) {
        const { url, concurrency = 1, nickname } = instances[i];
        if (!url)
            continue;
        const instanceNumber = i + 1;
        const id = instanceNumber === 1 ? type : `${type}-${instanceNumber}`;
        const maxConcurrency = Math.max(1, typeof concurrency === "number"
            ? concurrency
            : parseInt(String(concurrency), 10) || 1);
        const provider = factory(url, id);
        const entry = {
            id,
            type,
            baseUrl: url,
            concurrency: maxConcurrency,
            instanceNumber,
            provider,
        };
        if (nickname)
            entry.nickname = nickname;
        registry.set(id, entry);
        const label = nickname ? `${id} (${nickname})` : id;
        logger.info(`[InstanceRegistry] ${label} → ${url} (concurrency: ${maxConcurrency})`);
    }
}
// ── Register all instances from secrets ─────────────────────
for (const [type, instances] of Object.entries(PROVIDER_ARRAYS)) {
    registerType(type, instances);
}
// ── Public API ──────────────────────────────────────────────
export function getInstanceProvider(id) {
    return registry.get(id)?.provider || null;
}
export function getInstance(id) {
    return registry.get(id) || null;
}
export function isInstance(id) {
    return registry.has(id);
}
export function listInstances() {
    return [...registry.values()];
}
export function listInstanceTypes() {
    return [...new Set([...registry.values()].map((e) => e.type))];
}
export function getInstancesByType(type) {
    return [...registry.values()].filter((e) => e.type === type);
}
/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"


 */
export function getInstanceType(id) {
    return registry.get(id)?.type || null;
}
//# sourceMappingURL=instance-registry.js.map