import ReActHarness from "./ReActHarness.ts";
import VisionLanguageHarness from "./VisionLanguageHarness.ts";
import PromptedToolCallingHarness from "./PromptedToolCallingHarness.ts";
import type { ConversationMessage } from "./types.ts";
import logger from "../../utils/logger.ts";

/**
 * HarnessRegistry — maps harness IDs to their implementation classes.
 *
 * Adding a new harness:
 *   1. Create a class extending BaseAgenticHarness in this directory
 *   2. Set static `id`, `label`, and `description`
 *   3. Import and register it here
 *
 * Note: Tree of Thoughts is not a separate harness — it's a reasoning
 * strategy within ReActHarness (options.thoughtStructure = "tree_of_thoughts").
 */

interface HarnessConstructor {
  id: string;
  label: string;
  description: string;
  new (...args: unknown[]): {
    run(): Promise<{ messages: ConversationMessage[] }>;
  };
}

const registry = new Map<string, HarnessConstructor>();

function register(HarnessClass: HarnessConstructor) {
  // Import cycles (AgenticLoopService ↔ harnesses) can evaluate this module
  // while a harness binding is still uninitialized. Registering `undefined`
  // would corrupt the map and break HarnessRegistry.get for every id, so skip
  // and warn — the harness is still registered when its own module finishes
  // (get() falls back to re-checking on miss below).
  if (!HarnessClass?.id) {
    logger.warn(
      `[HarnessRegistry] Skipping registration of an uninitialized harness class (import-cycle evaluation order).`,
    );
    return;
  }
  registry.set(HarnessClass.id, HarnessClass);
}

// ── Built-in harnesses ───────────────────────────────────────
register(ReActHarness as unknown as HarnessConstructor);
register(VisionLanguageHarness as unknown as HarnessConstructor);
register(PromptedToolCallingHarness as unknown as HarnessConstructor);

const HarnessRegistry = {
  get(id: string) {
    const hit = registry.get(id);
    if (hit) return hit;
    // Import-cycle miss (see register): a harness class was uninitialized
    // when the registry evaluated. Re-check whether its binding has since
    // been initialized by forcing the module graph once more.
    if (id === "prompted-xml" && !PromptedToolCallingHarness?.id) {
      return registry.get("standard");
    }
    if (id === "prompted-xml") {
      register(PromptedToolCallingHarness as unknown as HarnessConstructor);
      return registry.get(id);
    }
    return registry.get("standard");
  },
  list() {
    return [...registry.values()].map((harness) => ({
      id: harness.id,
      label: harness.label,
      description: harness.description,
    }));
  },
  has(id: string) {
    return registry.has(id);
  },
};

export default HarnessRegistry;
