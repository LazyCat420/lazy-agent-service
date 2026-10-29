import ReActHarness from "./ReActHarness.js";
import VisionLanguageHarness from "./VisionLanguageHarness.js";
const registry = new Map();
function register(HarnessClass) {
    registry.set(HarnessClass.id, HarnessClass);
}
// ── Built-in harnesses ───────────────────────────────────────
register(ReActHarness);
register(VisionLanguageHarness);
const HarnessRegistry = {
    get(id) {
        return registry.get(id) || registry.get("standard");
    },
    list() {
        return [...registry.values()].map((harness) => ({
            id: harness.id,
            label: harness.label,
            description: harness.description,
        }));
    },
    has(id) {
        return registry.has(id);
    },
};
export default HarnessRegistry;
//# sourceMappingURL=HarnessRegistry.js.map