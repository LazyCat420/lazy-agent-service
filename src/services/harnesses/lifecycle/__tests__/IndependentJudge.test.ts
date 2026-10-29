import { describe, expect, it } from "vitest";
import { getModels, TYPES } from "../../../../config.ts";
import CriticGate from "../CriticGate.ts";
import { resolveIndependentCriticModel } from "../IndependentJudge.ts";

const textModels = getModels(TYPES.TEXT, TYPES.TEXT);
const providerWithAlternate = Object.entries(
  textModels.reduce<Record<string, string[]>>((acc, model) => {
    acc[model.provider] = [...(acc[model.provider] ?? []), model.name];
    return acc;
  }, {}),
).find(([, names]) => names.length >= 2);

const authorModel = providerWithAlternate?.[1][0] ?? "";
const authorProvider = providerWithAlternate?.[0] ?? "";

describe("independent judge selection", () => {
  it("never picks the author model when the provider has an alternate", () => {
    const selection = resolveIndependentCriticModel(authorModel);

    expect(selection.independent).toBe(true);
    expect(selection.model).not.toBe(authorModel);
    expect(selection.reason).toBe("same_provider_alternate");
  });

  it("picks the alternate from the author's provider (the critic runs on that provider client)", () => {
    const selection = resolveIndependentCriticModel(authorModel);
    const chosen = textModels.find((model) => model.name === selection.model);

    expect(chosen?.provider).toBe(authorProvider);
  });

  it("treats an unknown author model as needing an independent judge", () => {
    const selection = resolveIndependentCriticModel("totally-unknown-model");

    expect(selection.independent).toBe(true);
    expect(selection.model).not.toBe("totally-unknown-model");
  });

  it("reports judgeIndependent=false when the configured critic is the author", async () => {
    const gate = new CriticGate({ model: authorModel });
    const result = await gate.review(
      { name: "web_search", args: {} } as never,
      { resolvedModel: authorModel, provider: {} } as never,
    );

    expect(result.criticModel).toBe(authorModel);
    expect(result.judgeIndependent).toBe(false);
  });

  it("reports judgeIndependent=true by default for a provider with an alternate", async () => {
    const gate = new CriticGate();
    const result = await gate.review(
      { name: "web_search", args: {} } as never,
      { resolvedModel: authorModel, provider: {} } as never,
    );

    expect(result.judgeIndependent).toBe(true);
    expect(result.criticModel).not.toBe(authorModel);
  });
});
