import openaiProvider from "./openai.js";
import anthropicProvider from "./anthropic.js";
import googleProvider from "./google.js";
import elevenlabsProvider from "./elevenlabs.js";
import inworldProvider from "./inworld.js";
import ActiveGenerationTracker from "../services/ActiveGenerationTracker.js";
import { getInstanceProvider, isInstance } from "./instance-registry.js";
import { PROVIDERS } from "../constants.js";
// Static cloud providers — local providers are resolved via instance registry
const providers = {
    [PROVIDERS.OPENAI]: openaiProvider,
    [PROVIDERS.ANTHROPIC]: anthropicProvider,
    [PROVIDERS.GOOGLE]: googleProvider,
    [PROVIDERS.ELEVENLABS]: elevenlabsProvider,
    [PROVIDERS.INWORLD]: inworldProvider,
};
/**
 * Method name prefixes that represent a provider API call.
 * Any method starting with one of these will be automatically
 * wrapped with ActiveGenerationTracker increment/decrement.
 */
const TRACKED_PREFIXES = ["generate", "transcribe"];
function isTrackedMethod(name) {
    return (typeof name === "string" &&
        TRACKED_PREFIXES.some((provider) => name.startsWith(provider)));
}
/**
 * Wrap an async generator (generateTextStream, generateTextStreamLive)
 * so the tracker stays incremented for the entire iteration lifetime.
 */
async function* wrapAsyncGenerator(gen) {
    try {
        yield* gen;
    }
    finally {
        ActiveGenerationTracker.decrement();
    }
}
/**
 * Wrap a provider object so all generate/transcribe calls
 * auto-increment/decrement ActiveGenerationTracker.
 *
 * - Async generators (streams): decrement when the iterator finishes/returns
 * - Promises (generateText, generateImage, etc.): decrement on settle
 */
function wrapProvider(provider) {
    return new Proxy(provider, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== "function" || !isTrackedMethod(prop)) {
                return value;
            }
            // Return a wrapper that tracks the call
            return function trackedProviderCall(...args) {
                ActiveGenerationTracker.increment();
                let result;
                try {
                    result = value.apply(target, args);
                }
                catch (error) {
                    // Synchronous throw (rare but possible)
                    ActiveGenerationTracker.decrement();
                    throw error;
                }
                // Async generator — wrap the iterator
                if (result &&
                    typeof result[Symbol.asyncIterator] ===
                        "function") {
                    return wrapAsyncGenerator(result);
                }
                // Promise — decrement on settle
                if (result && typeof result.then === "function") {
                    result.then(() => ActiveGenerationTracker.decrement(), () => ActiveGenerationTracker.decrement());
                    return result;
                }
                // Synchronous return (shouldn't happen for provider calls)
                ActiveGenerationTracker.decrement();
                return result;
            };
        },
    });
}
/** Per-name proxy cache so we don't create a new Proxy on every getProvider call. */
const wrappedCache = new Map();
export function getProvider(name) {
    // Check instance registry first (local providers + multi-instance)
    if (isInstance(name)) {
        if (wrappedCache.has(name))
            return wrappedCache.get(name);
        const instanceProvider = getInstanceProvider(name);
        const wrapped = wrapProvider(instanceProvider);
        wrappedCache.set(name, wrapped);
        return wrapped;
    }
    // Fall through to static cloud providers
    const provider = providers[name];
    if (!provider) {
        const available = [...Object.keys(providers), "(+ local instances)"].join(", ");
        throw new Error(`Unknown provider "${name}". Available: ${available}`);
    }
    // Return cached proxy
    if (wrappedCache.has(name))
        return wrappedCache.get(name);
    const wrapped = wrapProvider(provider);
    wrappedCache.set(name, wrapped);
    return wrapped;
}
export function listProviders() {
    return Object.keys(providers);
}
export { providers };
//# sourceMappingURL=index.js.map