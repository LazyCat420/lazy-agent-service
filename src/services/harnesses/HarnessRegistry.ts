import ReActHarness from "./ReActHarness.ts";
import VisionLanguageHarness from "./VisionLanguageHarness.ts";
import PromptedToolCallingHarness from "./PromptedToolCallingHarness.ts";
import type { ConversationMessage } from "./types.ts";

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
  registry.set(HarnessClass.id, HarnessClass);
}

// ── Built-in harnesses ───────────────────────────────────────
register(ReActHarness as unknown as HarnessConstructor);
register(VisionLanguageHarness as unknown as HarnessConstructor);
register(PromptedToolCallingHarness as unknown as HarnessConstructor);

const HarnessRegistry = {
  get(id: string) {
    return registry.get(id) || registry.get("standard");
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
