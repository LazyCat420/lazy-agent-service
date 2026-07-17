import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { Persona } from "./types.ts";
import { CodingPersona } from "./CodingPersona.ts";
import { LuposPersona } from "./LuposPersona.ts";
import { StickersPersona } from "./StickersPersona.ts";
import { LightsPersona } from "./LightsPersona.ts";
import { OogPersona } from "./OogPersona.ts";
import { DigestPersona } from "./DigestPersona.ts";
import { MetaPersona } from "./MetaPersona.ts";
import { OmniPersona } from "./OmniPersona.ts";
import { ImagePersona } from "./ImagePersona.ts";
import { MeepoPersona } from "./MeepoPersona.ts";
// Client personas: one tailor-made agent per consuming repo, so each caller
// runs with exactly its own tool set and prompt instead of the generic Omni
// identity + forced core tools. Add new client agents under ./clients/.
import { HtmlNotesPersona } from "./clients/HtmlNotesPersona.ts";
import { MusicResearchPersona } from "./clients/MusicResearchPersona.ts";
// Universal (repo-agnostic) research agent — see DeepResearchPersona.ts. Any
// caller names "DEEP_RESEARCH" and supplies the task + output contract.
import { DeepResearchPersona } from "./clients/DeepResearchPersona.ts";

export * from "./types.ts";
export * from "./utils.ts";

export const BUILT_IN_PERSONAS = new Map<string, Persona>([
  [AGENT_IDS.CODING, CodingPersona],
  [AGENT_IDS.LUPOS, LuposPersona],
  [AGENT_IDS.STICKERS, StickersPersona],
  [AGENT_IDS.LIGHTS, LightsPersona],
  [AGENT_IDS.OOG, OogPersona],
  [AGENT_IDS.DIGEST, DigestPersona],
  [AGENT_IDS.META, MetaPersona],
  [AGENT_IDS.OMNI, OmniPersona],
  [AGENT_IDS.IMAGE, ImagePersona],
  [AGENT_IDS.MEEPO, MeepoPersona],
  [HtmlNotesPersona.id, HtmlNotesPersona],
  [MusicResearchPersona.id, MusicResearchPersona],
  [DeepResearchPersona.id, DeepResearchPersona],
]);
