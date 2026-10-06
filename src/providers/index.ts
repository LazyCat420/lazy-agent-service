import openaiProvider from "./openai.ts";
import { EmbeddingGemma2Client, EMBEDDING_PROVIDER } from "../services/EmbeddingGemma2Client.ts";
import anthropicProvider from "./anthropic.ts";
import googleProvider from "./google.ts";
import elevenlabsProvider from "./elevenlabs.ts";
import inworldProvider from "./inworld.ts";
import ActiveGenerationTracker from "../services/ActiveGenerationTracker.ts";
import { getInstanceProvider, isInstance } from "./instance-registry.ts";
import type { Provider } from "../types/provider.ts";
import { PROVIDERS } from "../constants.ts";

// Static cloud providers — local providers are resolved via instance registry
const providers: Record<string, Provider> = {
  [EMBEDDING_PROVIDER]: { generateEmbedding: async (content, _model, options = {}) =>
    EmbeddingGemma2Client.generate(content, options.taskType, options.dimensions) } as Provider,
  [PROVIDERS.OPENAI]: openaiProvider as unknown as Provider,
  [PROVIDERS.ANTHROPIC]: anthropicProvider as Provider,
  [PROVIDERS.GOOGLE]: googleProvider as Provider,
  [PROVIDERS.ELEVENLABS]: elevenlabsProvider as unknown as Provider,
  [PROVIDERS.INWORLD]: inworldProvider as unknown as Provider,
};

/**
 * Method name prefixes that represent a provider API call.
 * Any method starting with one of these will be automatically
 * wrapped with ActiveGenerationTracker increment/decrement.
 */
const TRACKED_PREFIXES = ["generate", "transcribe"];
function isTrackedMethod(name: string | symbol): boolean {
  return (
    typeof name === "string" &&
    TRACKED_PREFIXES.some((provider) => name.startsWith(provider))
  );
}

/**
 * Wrap an async generator (generateTextStream, generateTextStreamLive)
 * so the tracker stays incremented for the entire iteration lifetime.
 */
async function* wrapAsyncGenerator(
  gen: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  try {
    yield* gen;
  } finally {
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
function wrapProvider(provider: Provider): Provider {
  return new Proxy(provider, {
    get(target: Provider, prop: string | symbol, receiver: unknown): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || !isTrackedMethod(prop)) {
        return value;
      }

      // Return a wrapper that tracks the call
      return function trackedProviderCall(...args: unknown[]): unknown {
        ActiveGenerationTracker.increment();
        let result: unknown;
        try {
          result = (value as (...agent: unknown[]) => unknown).apply(
            target,
            args,
          );
        } catch (error: unknown) {
          // Synchronous throw (rare but possible)
          ActiveGenerationTracker.decrement();
          throw error;
        }

        // Async generator — wrap the iterator
        if (
          result &&
          typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] ===
            "function"
        ) {
          return wrapAsyncGenerator(result as AsyncIterable<unknown>);
        }

        // Promise — decrement on settle
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>).then(
            () => ActiveGenerationTracker.decrement(),
            () => ActiveGenerationTracker.decrement(),
          );
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
const wrappedCache = new Map<string, Provider>();

export function getProvider(name: string): Provider {
  // Check instance registry first (local providers + multi-instance)
  if (isInstance(name)) {
    if (wrappedCache.has(name)) return wrappedCache.get(name)!;
    const instanceProvider = getInstanceProvider(name);
    const wrapped = wrapProvider(instanceProvider as Provider);
    wrappedCache.set(name, wrapped);
    return wrapped;
  }

  // Fall through to static cloud providers
  const provider = providers[name];
  if (!provider) {
    const available = [...Object.keys(providers), "(+ local instances)"].join(
      ", ",
    );
    throw new Error(`Unknown provider "${name}". Available: ${available}`);
  }

  // Return cached proxy
  if (wrappedCache.has(name)) return wrappedCache.get(name)!;

  const wrapped = wrapProvider(provider);
  wrappedCache.set(name, wrapped);
  return wrapped;
}

export function listProviders(): string[] {
  return Object.keys(providers);
}

export { providers };
