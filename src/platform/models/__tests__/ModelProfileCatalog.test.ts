import { describe, expect, it } from "vitest";
import { getModelProfile } from "../ModelProfiles.ts";

/**
 * Model-agnostic requirement: request-surface facts come from the catalog when
 * the model is listed there, and from safe "unknown" traits when it is not.
 * Name-derived family traits remain a fallback, never the authority.
 */
describe("getModelProfile catalog-first capabilities", () => {
  it("takes context and output limits from the catalog", () => {
    const profile = getModelProfile("gpt-5");

    expect(profile.contextWindow).toBe(400_000);
    expect(profile.maxOutputTokens).toBe(128_000);
  });

  it("keeps the family effort vocabulary and adds catalog-declared levels", () => {
    const profile = getModelProfile("gpt-5");

    expect(profile.efforts).toEqual(
      expect.arrayContaining(["minimal", "low", "medium", "high"]),
    );
  });

  it("drops effort control for a catalog model that does not think", () => {
    expect(getModelProfile("gpt-5-nano").efforts).toBeNull();
  });

  it("uses the catalog's own limits for Claude instead of the family default", () => {
    const profile = getModelProfile("claude-sonnet-4-5-20250929");

    expect(profile.contextWindow).toBe(200_000);
    expect(profile.maxOutputTokens).toBe(64_000);
    expect(profile.efforts).toEqual(expect.arrayContaining(["medium", "high"]));
  });

  it("treats an unlisted model as unknown rather than guessing from its name", () => {
    const profile = getModelProfile("brand-new-model-9000");

    expect(profile.family).toBe("unknown");
    expect(profile.contextWindow).toBeNull();
    expect(profile.efforts).toBeNull();
  });
});
