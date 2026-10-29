import { describe, expect, it } from "vitest";
import { usesDeliveryModeSteering } from "../inworld.ts";

/**
 * Model-agnostic requirement: the provider must take its steering protocol
 * from the model catalog, never from the model name. A new TTS model added
 * to the catalog works without touching provider code.
 */
describe("Inworld TTS steering protocol", () => {
  it("uses delivery_mode when the catalog flags the model that way", () => {
    expect(usesDeliveryModeSteering("inworld-tts-2")).toBe(true);
  });

  it("uses temperature for legacy catalog models", () => {
    expect(usesDeliveryModeSteering("inworld-tts-1.5-max")).toBe(false);
    expect(usesDeliveryModeSteering("inworld-tts-1.5-mini")).toBe(false);
  });

  it("defaults an unknown model to the current protocol instead of guessing from its name", () => {
    expect(usesDeliveryModeSteering("inworld-tts-3")).toBe(true);
    expect(usesDeliveryModeSteering("some-future-tts")).toBe(true);
  });
});
