import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { CodingPersona } from "./CodingPersona.ts";
// Client personas: one tailor-made agent per consuming repo, so each caller
// runs with exactly its own tool set and prompt instead of a generic identity
// + forced core tools. Add new client agents under ./clients/.
import { HtmlNotesPersona } from "./clients/HtmlNotesPersona.ts";
import { MusicResearchPersona } from "./clients/MusicResearchPersona.ts";
// Universal (repo-agnostic) research agent — see DeepResearchPersona.ts. Any
// caller names "DEEP_RESEARCH" and supplies the task + output contract.
import { DeepResearchPersona } from "./clients/DeepResearchPersona.ts";

export * from "./types.ts";
export * from "./utils.ts";

export const BUILT_IN_PERSONAS = new Map<string, Persona>([
  [AGENT_IDS.CODING, CodingPersona],
  [HtmlNotesPersona.id, HtmlNotesPersona],
  [MusicResearchPersona.id, MusicResearchPersona],
  [DeepResearchPersona.id, DeepResearchPersona],
]);
