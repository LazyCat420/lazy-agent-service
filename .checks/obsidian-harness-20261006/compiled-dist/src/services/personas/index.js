import { AGENT_IDS } from "@rodrigo-barraza/utilities-library/taxonomy";
import { CodingPersona } from "./CodingPersona.js";
import { LuposPersona } from "./LuposPersona.js";
import { StickersPersona } from "./StickersPersona.js";
import { LightsPersona } from "./LightsPersona.js";
import { OogPersona } from "./OogPersona.js";
import { DigestPersona } from "./DigestPersona.js";
import { MetaPersona } from "./MetaPersona.js";
import { OmniPersona } from "./OmniPersona.js";
import { ImagePersona } from "./ImagePersona.js";
import { MeepoPersona } from "./MeepoPersona.js";
// Client personas: one tailor-made agent per consuming repo, so each caller
// runs with exactly its own tool set and prompt instead of the generic Omni
// identity + forced core tools. Add new client agents under ./clients/.
import { HtmlNotesPersona } from "./clients/HtmlNotesPersona.js";
import { MusicResearchPersona } from "./clients/MusicResearchPersona.js";
// Universal (repo-agnostic) research agent — see DeepResearchPersona.ts. Any
// caller names "DEEP_RESEARCH" and supplies the task + output contract.
import { DeepResearchPersona } from "./clients/DeepResearchPersona.js";
export * from "./types.js";
export * from "./utils.js";
export const BUILT_IN_PERSONAS = new Map([
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
//# sourceMappingURL=index.js.map