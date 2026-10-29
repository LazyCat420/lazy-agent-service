import { getModelByName, getModels, TYPES } from "../../../config.ts";

export interface JudgeSelection {
  model: string;
  /** True only when the judge is a different model than the author. */
  independent: boolean;
  reason: "configured" | "same_provider_alternate" | "only_model_available" | "no_author_model";
}

/**
 * Pick a critic/judge model that is not the author model.
 *
 * WHY: a judge that is the author model re-asks the same weights with the same
 * blind spots, so its approval carries no independent signal. The critic call
 * runs through the author's provider client, so independence is bounded to a
 * different model inside the same provider (a cross-provider judge needs its
 * own provider client and is deliberately out of scope here).
 */
export function resolveIndependentCriticModel(authorModel: string): JudgeSelection {
  if (!authorModel) {
    return { model: authorModel, independent: false, reason: "no_author_model" };
  }

  const author = getModelByName(authorModel) as { provider?: string } | null;
  const authorProvider = author?.provider;

  const sameProvider = getModels(TYPES.TEXT, TYPES.TEXT)
    .filter((model) => model.name !== authorModel)
    .filter((model) => (authorProvider ? model.provider === authorProvider : true))
    .map((model) => model as { name: string; default?: boolean });

  const alternate =
    sameProvider.find((model) => model.default) ?? sameProvider[0];

  if (!alternate) {
    return { model: authorModel, independent: false, reason: "only_model_available" };
  }

  return { model: alternate.name, independent: true, reason: "same_provider_alternate" };
}
