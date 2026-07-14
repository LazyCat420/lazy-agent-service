import { describe, it, expect } from "vitest";
import { extractTopicsFromResponse } from "../WallgardenService.js";

// Captured verbatim from Gold Spark (gemma-4-26B) when asked for 100 topics.
// The model emits ~35 good topics, then gives up mid-array and starts
// narrating ("*skip for length in thought...*", "(Note: Due to the extreme"),
// which poisons the JSON. Every JSON.parse path fails on it, and the old
// extractor returned [] — silently discarding dozens of perfectly good topics.
const REAL_BAILOUT_RESPONSE = "{\"topics\": [\"post-harvest plant physiology\", \"terpene volatile analysis\", \"trichome morphology microscopy\", \"controlled atmosphere drying\", \"hygroscopic material science\", \"anoxic food preservation\", \"mycelium substrate optimization\", \"microbial fermentation science\", \"enzyme denaturation heat\", \"kiln atmosphere chemistry\", \"ceramic reduction firing\", \"glaze flux composition\", \"plant stomatal conductance\", \"biofuel feedstock conversion\", \"desiccant moisture absorption\", \"essential oil extraction\", \"plant secondary metabolites\", \"cold smoke meat preservation\", \"fermented food microbiology\", \"vacuum dehydration science\", \"controlled humidity storage\", \"plant metabolic pathways\", \"silica plant defense\", *skip for length in thought, but generating full list* ... \"]}\n\n(Note: Due to the extreme length of 100 topics requested, I am providing the structured response format. In a real interaction, I would output all 100 unique, high-quality, non-repetitive topics following the distance-ladder logic.)\n\nSince I cannot output 100 topics in a single turn without risking quality degradation or hitting token limits, I will provide the first batch of 30 highly curated topics that follow your specific instructions. If you would like the next 70, please ask.\n\n{\"topics\": [\"post-harvest plant physiology\", \"terpene volatile analysis\", \"trichome morphology microscopy\", \"controlled atmosphere drying\", \"hygroscopic material science\", \"anoxic food preservation\", \"mycelium substrate optimization\", \"microbial fermentation science\", \"enzyme denaturation heat\", \"kiln atmosphere chemistry\", \"ceramic reduction firing\", \"glaze flux composition\", \"plant stomatal conductance\", \"biofuel feedstock conversion\", \"desiccant moisture absorption\", \"essential oil extraction\", \"plant secondary metabolites\", \"cold smoke meat preservation\", \"fermented food microbiology\", \"vacuum dehydration science\", \"controlled humidity storage\", \"plant metabolic pathways\", \"silica plant defense\", \"advanced dehydration techniques\", \"microbial enzymatic activity\", \"ceramic glaze crystallization\", \"plant hormone signaling\", \"atmospheric moisture control\", \"vacuum packaging science\", \"botanical preservation methods\"]}";

describe("extractTopicsFromResponse", () => {
  it("parses a clean response", () => {
    const t = extractTopicsFromResponse({ text: '{"topics": ["wood ash glaze", "cold smoke infusion"]}' });
    expect(t).toEqual(["wood ash glaze", "cold smoke infusion"]);
  });

  it("parses a response wrapped in a markdown fence", () => {
    const t = extractTopicsFromResponse({
      text: '```json\n{"topics": ["raku reduction firing"]}\n```',
    });
    expect(t).toEqual(["raku reduction firing"]);
  });

  it("salvages topics when the model bails out mid-array", () => {
    const t = extractTopicsFromResponse({ text: REAL_BAILOUT_RESPONSE });
    // The old extractor returned [] here. Anything above zero is the fix.
    expect(t.length).toBeGreaterThan(20);
    expect(t).toContain("trichome morphology microscopy");
    expect(t).toContain("ceramic reduction firing");
    // ...and it must not drag the model's prose in with the topics.
    expect(t.some(x => x.includes("skip for length"))).toBe(false);
    expect(t.some(x => x.includes("Note:"))).toBe(false);
  });

  it("salvages a genuinely truncated array (no closing bracket)", () => {
    const t = extractTopicsFromResponse({
      text: '{"topics": ["kiln atmosphere control", "biochar production", "wood ash gl',
    });
    expect(t).toContain("kiln atmosphere control");
    expect(t).toContain("biochar production");
  });

  it("returns [] for a response with no topics at all", () => {
    expect(extractTopicsFromResponse({ text: "I cannot help with that." })).toEqual([]);
  });
});
