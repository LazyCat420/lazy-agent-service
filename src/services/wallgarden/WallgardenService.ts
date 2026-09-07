import logger from "../../logger.js";
import { getInstancesByType } from "../../providers/instance-registry.js";
import type { InstanceEntry } from "../../types/ProviderTypes.js";
import { prismAttributionHeaders } from "../../utils/PrismAttribution.js";

// ── Prism Service URL ───────────────────────────────────────
const PRISM_URL = process.env.REAL_PRISM_URL || "http://10.0.0.16:7777";

// ── Model Cache ─────────────────────────────────────────────
interface VllmBoxInfo {
  id: string;           // e.g. "vllm", "vllm-2"
  nickname: string;     // e.g. "Jetson", "Gold Spark"
  url: string;          // e.g. "http://10.0.0.30:8000"
  model: string | null; // currently loaded model ID
  status: "online" | "offline";
}

let modelCache: VllmBoxInfo[] = [];
let modelCacheTimestamp = 0;
const MODEL_CACHE_TTL_MS = 60_000;

// ── Tool Definition ─────────────────────────────────────────
const TOPIC_TOOL_DEFINITION = {
  name: "suggest_topics",
  description:
    "Suggest new topics related to the user's interest graph. Each topic should be 1-3 words.",
  parameters: {
    type: "object",
    properties: {
      topics: {
        type: "array",
        items: {
          type: "string",
          description:
            "A 1-3 word topic phrase, representing a broader genre, theme, or tangential subject.",
        },
        minItems: 5,
        maxItems: 100,
      },
    },
    required: ["topics"],
  },
};

// ── System Prompts ──────────────────────────────────────────
// Shared across brainstorm/extract so the quality bar can't drift apart.
const ANCHOR_TEST_BLOCK = `THE ANCHOR TEST — apply to EVERY topic before you emit it:
Strip away all context and look at the phrase alone. Ask: "how many different industries could this phrase belong to?"
- ONE field, naming a specific process/object/scene inside it -> KEEP. ("trichome degradation", "raku kiln reduction", "one man sawmill")
- ONE field but enormous -> keep at most a few. ("chemical reactions", "plant health")
- ANY field — a floating abstraction that could be aviation, finance, or baking -> DELETE IT. It returns algorithmic slop on YouTube.

Floating abstractions are the #1 failure. They look smart and are worthless. Banned shapes:
- "<abstract noun> analysis/studies/methods/techniques/systems/protocols/principles/management/theory/development/optimization/control/science"
  e.g. "hazard analysis", "validation studies", "research methodology", "product development", "recovery protocols", "quality control", "thermal processing science", "material degradation studies"
- Wellness slop: "self care", "slow living", "chakra balancing", "mindfulness practices", "healing energy"
- Vague temporals: "long term aging", "environmental stressors"
- Umbrella filler words — NEVER emit a topic containing: "content", "videos", "guide", "tips", "hacks", "ideas", "basics", "101", "compilation".
A topic must name a THING — an object, an organism, a named process, a place, a scene, a technique with a practitioner. NEVER merely the ACT OF STUDYING a thing.`;

const BRAINSTORM_SYSTEM_PROMPT = `/no_think
You are the discovery engine for a personal YouTube curator. Your job: figure out what this person would LOVE to watch next but would never think to search for themselves.

You receive their taste profile: interest topics, titles of videos they actually liked, videos they saved to watch later, recent searches, plus things they dislike and phrases to avoid.

HOW TO THINK:
1. INFER THE PERSON, NOT THE LIST. Ask yourself: what kind of person likes these things? What underlying tastes connect them — aesthetics, eras, moods, level of depth, sense of humor? Generate topics for THAT person, not word-associations on the list.
2. WEIGHT THE SIGNALS. Liked videos and watchlist saves are the strongest evidence of real taste — read their titles carefully and reverse-engineer what hooked the user. Interest topics are broader hints. Searches show current curiosity.
3. THIS REQUEST HAS ONE ROLE, stated at the end of the message. Obey it exactly:
   - CORE: more of exactly what I already watch. Every topic must be a sub-niche, format, sub-community, or practitioner corner INSIDE a scene that is visibly in my liked videos. If I could not plausibly have already searched it myself, it is not core.
   - ADJACENT: same scene, new angle — one step away (likes "restoring old bikes" → "barn find restoration", "vintage moped rebuild"). Same person, same room, different shelf.
   - EXPLORE: a lateral or wildcard leap, or the same taste in another decade or country (→ "antique tool restoration", "70s custom van culture"). This is a small experiment slot: bold, but still recognisably this person.
4. NAME THE NICHE, NOT THE CATEGORY. "cozy game devlogs" beats "video games". "desert homestead build" beats "construction". A great topic names a specific YouTube subculture, scene, or format that a real fan would type into search.
5. MOODS AND FORMATS ARE TOPICS TOO: "ambient coding sessions", "silent workshop asmr", "engineering disasters explained", "one man sawmill" are excellent suggestions.

${ANCHOR_TEST_BLOCK}

Your ADJACENT and EXPLORE leaps must stay recognisably the same PERSON's taste. A leap that lands in a different personality (a cannabis grower does not become a wellness influencer) is a failed leap, not a bold one.

HARD RULES:
- NEVER suggest: individual people, character names, episode titles, cast members, or channel names.
- NEVER suggest anything in the disliked, recently-used, or failed-query lists, nor trivial rewordings of the user's existing interests.
- NEVER suggest single generic words ("music", "gaming", "history") — too broad returns algorithmic slop.
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Output format: ONLY the raw JSON object {"topics": ["topic one", "topic two", ...]}. No markdown, no commentary, no explanations.`;

const EXTRACT_SYSTEM_PROMPT = `/no_think
You label videos a user LIKED on YouTube. For each video you receive an id, its title, and its channel. Name 1-3 specific niche topics the video actually belongs to — the YouTube subculture, scene, or format a fan would type into search to find more videos exactly like it.

This is extraction, not brainstorming: name what IS there, grounded in the title. Use the channel name as context for inferring the niche, never as a topic itself.
Duration and age are context: a 40-minute video is a process/long-form scene, a 3-minute one is a clip format; name the format when it is the point.

${ANCHOR_TEST_BLOCK}

HARD RULES:
- NEVER emit: individual people, character names, episode titles, or channel names.
- NEVER emit single generic words ("music", "gaming", "history").
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Emit topics for EVERY video you are given, keyed by its id.
- Output format: ONLY the raw JSON object {"extractions":[{"id":"<video id>","topics":["topic one","topic two"]}]}. No markdown, no commentary.`;

const SIMILAR_SYSTEM_PROMPT = `/no_think
You are the discovery engine for a personal YouTube curator. The user just searched for something — treat that query as a doorway and map the interesting rooms behind it.

You receive the search query plus their taste profile: interest topics, titles of videos they liked, watch-later saves, and things they dislike or to avoid.

HOW TO THINK:
1. ASK WHY they searched this, given their taste profile. The same query means different things to different people — use their liked videos and watchlist to pick the right interpretation, then expand in THAT direction.
2. The seeds are things I ALREADY engaged with — stay close; this is not a brainstorm. SPREAD from the query:
   - ~60% ADJACENT: same subject, different angle, era, or format
   - ~30% LATERAL: the same underlying appeal in a neighboring domain
   - ~10% WILDCARD: a bold but taste-consistent leap they'd never search themselves
3. NAME THE NICHE, NOT THE CATEGORY. Suggest specific YouTube subcultures, scenes, and formats a real fan would type — "cab view train rides" beats "trains".
4. MOODS AND FORMATS ARE TOPICS TOO: "night drive pov", "process documentaries", "restoration timelapse" are excellent suggestions.

THE ANCHOR TEST — apply to EVERY topic before you emit it:
Strip away all context and look at the phrase alone. Ask: "how many different industries could this phrase belong to?" If the answer is "any of them", DELETE IT — it returns algorithmic slop on YouTube.
Banned shapes: "<abstract noun> analysis/studies/methods/techniques/systems/protocols/principles/management/development/control/science" ("hazard analysis", "validation studies", "research methodology", "quality control"); wellness slop ("self care", "slow living", "chakra balancing"); vague temporals ("long term aging", "environmental stressors").
A topic must name a THING — an object, an organism, a named process, a place, a scene, a technique with a practitioner. NEVER merely the ACT OF STUDYING a thing.

HARD RULES:
- NEVER suggest: individual people, character names, episode titles, cast members, or channel names.
- NEVER suggest anything in the disliked, recently-used, or failed-query lists, nor trivial rewordings of the query itself.
- NEVER suggest single generic words ("music", "gaming", "history").
- Every topic: lowercase, 1-4 words, and must work as a real YouTube search query.
- Output format: ONLY the raw JSON object {"topics": ["topic one", "topic two", ...]}. No markdown, no commentary, no explanations.`;

// ── Context interface ───────────────────────────────────────
/** Measured performance of past suggestions, derived from the client's ledger. */
export interface TopicOutcomes {
  /** Topics whose videos the user liked or repeatedly played. */
  proven?: { t: string; likes?: number; plays?: number; opens?: number }[];
  /** Topics shown repeatedly and never once acted on — a MEASURED failure. */
  ignored?: { t: string; shown?: number }[];
  /** Topics whose real YouTube results the grounding gate judged generic. */
  slop?: string[];
}

/**
 * Render measured outcomes as an instruction, not a data dump.
 *
 * Every other field in this prompt restates what the user SAYS they like. This
 * one is the only feedback the model gets about what its own past suggestions
 * actually did — until now the system computed all of it (grounding verdicts,
 * A/B tiers, engagement) and threw it away.
 *
 * The `ignored` list is the valuable half and is why this is worth the tokens:
 * those topics looked right to a previous run of this very prompt, were shown
 * to the user repeatedly, and were never touched. The user never rejected them
 * by hand, so they appear in no blacklist. Only the counters know.
 *
 * Returns "" when there is nothing measured to say, so a new account gets the
 * plain prompt rather than a block full of empty brackets.
 */
export function buildOutcomesBlock(outcomes?: TopicOutcomes): string {
  if (!outcomes) return "";
  const proven = (outcomes.proven || []).filter(p => p && p.t);
  const ignored = (outcomes.ignored || []).filter(p => p && p.t);
  const slop = (outcomes.slop || []).filter(Boolean);
  if (!proven.length && !ignored.length && !slop.length) return "";

  const parts: string[] = ["\n\nMEASURED RESULTS OF PAST SUGGESTIONS — this is what actually happened, not what I said:"];

  if (proven.length) {
    const lines = proven
      .map(p => {
        const bits = [];
        if (p.likes) bits.push(`${p.likes} liked`);
        if (p.plays) bits.push(`${p.plays} played`);
        return `  - "${p.t}"${bits.length ? ` (${bits.join(", ")})` : ""}`;
      })
      .join("\n");
    parts.push(
      `\nWORKED — I played or liked videos from these. Infer WHY each one landed ` +
      `(the scene, the format, the depth) and aim at that:\n${lines}`
    );
  }

  if (ignored.length) {
    const lines = ignored.map(p => `  - "${p.t}"${p.shown ? ` (shown ${p.shown}x, never played)` : ""}`).join("\n");
    parts.push(
      `\nIGNORED — you suggested these before, I was shown them repeatedly, and I ` +
      `never once watched them. They are not merely unlucky: they are the SHAPE of ` +
      `topic that looks right for me and is not. Do not produce anything of the ` +
      `same shape:\n${lines}`
    );
  }

  if (slop.length) {
    parts.push(`\nSLOP — real YouTube results for these were generic filler: [${slop.join(", ")}]`);
  }

  return parts.join("\n");
}

export interface BrainstormContext {
  interests: string[];
  disliked: string[];
  recentUsed: string[];
  burnedQueries: string[];
  searches?: string[];
  likedVideos?: string[]; // "title (channel)" of videos the user liked
  watchlist?: string[];   // "title (channel)" of watch-later saves
  tasteProfile?: string;  // LLM-written summary of the whole like history
  // Liked videos grouped into taste clusters; when present, each brainstorm
  // batch expands a DIFFERENT cluster instead of one blended context.
  likedClusters?: { name?: string; videos: string[]; size?: number }[];
  // Burned/failed topics rendered as negative few-shots (avoid the SHAPE).
  failedExamples?: string[];
  // MEASURED outcomes from the client's signal ledger. Unlike every other field
  // here, these describe what HAPPENED to previous suggestions rather than
  // restating the user's declared taste — see buildOutcomesBlock.
  topicOutcomes?: TopicOutcomes;
  // "stats" | "flat" — which context shape the client built. Echoed to the
  // caller so the two arms can be told apart when scoring them.
  promptVariant?: string;
  // false = skip the FIT rubric in rateTopics (the free-baseline arm).
  rateFit?: boolean;
  numTopics?: number;
  model?: string;
  provider?: string;
}

export interface SimilarContext extends BrainstormContext {
  query: string;
  // Every seed the ledger flushed, strongest first. `query` is seeds[0] for
  // older clients; the model sees all of them.
  seeds?: string[];
}

export interface LikedVideoInput {
  id: string;           // youtube video id — used to map results back
  title: string;
  channel?: string;
  durationSecs?: number;
  ageDays?: number;
}

export interface VideoExtraction {
  id: string;
  topics: RatedTopic[];
}

// ── Helpers ─────────────────────────────────────────────────

/** Query a single vLLM box for its currently loaded model */
async function queryVllmBox(url: string): Promise<string | null> {
  try {
    const resp = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const models = data?.data;
    if (Array.isArray(models) && models.length > 0) {
      return models[0].id || null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Extract topics from a prism /chat response */
export function extractTopicsFromResponse(data: any): string[] {
  // The /chat response is { text, thinking, provider, model, usage, ... }
  const text = data?.text || "";

  // Try to parse as JSON first (prism may return the tool call result as text)
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.topics)) {
      return parsed.topics.map((t: any) =>
        typeof t === "string" ? t.trim().toLowerCase() : ""
      ).filter(Boolean);
    }
    if (Array.isArray(parsed)) {
      return parsed.map((t: any) =>
        typeof t === "string" ? t.trim().toLowerCase() : ""
      ).filter(Boolean);
    }
  } catch {
    // Not JSON, try regex extraction
  }

  // Try to extract JSON array from text
  const jsonMatch = text.match(/\[[\s\S]*?\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]);
      if (Array.isArray(arr)) {
        return arr.map((t: any) =>
          typeof t === "string" ? t.trim().toLowerCase() : ""
        ).filter(Boolean);
      }
    } catch { /* ignore */ }
  }

  // Try to find topics in tool call format within text
  const toolCallMatch = text.match(/"topics"\s*:\s*\[[\s\S]*?\]/);
  if (toolCallMatch) {
    try {
      const wrapper = `{${toolCallMatch[0]}}`;
      const parsed = JSON.parse(wrapper);
      if (Array.isArray(parsed.topics)) {
        return parsed.topics.map((t: any) =>
          typeof t === "string" ? t.trim().toLowerCase() : ""
        ).filter(Boolean);
      }
    } catch { /* ignore */ }
  }

  // Last resort: salvage a TRUNCATED array. When the model is asked for many
  // topics it can run past max_tokens and get cut mid-array, leaving no closing
  // "]" — every JSON.parse above then fails and we used to drop the whole
  // response on the floor even though it held dozens of perfectly good topics.
  // Scrape the complete quoted strings that follow the "topics" key instead.
  const topicsKey = text.indexOf('"topics"');
  if (topicsKey !== -1) {
    const salvaged = (text.slice(topicsKey).match(/"((?:[^"\\]|\\.)*)"/g) || [])
      .slice(1) // drop the "topics" key itself
      .map((s: string) => {
        try {
          return JSON.parse(s.replace(/\\+"/g, '\\"'));
        } catch {
          return "";
        }
      })
      .map((s: any) => (typeof s === "string" ? s.trim().toLowerCase() : ""))
      .filter((s: string) => s.length > 1 && s.length < 60);
    if (salvaged.length > 0) {
      logger.warn(
        `[WallgardenService] Response was malformed/truncated; salvaged ${salvaged.length} topics`
      );
      return salvaged;
    }
  }

  logger.warn("[WallgardenService] Could not extract topics from response text");
  return [];
}

/**
 * Resolve which provider/model to use — ALWAYS the Jetson.
 *
 * Wallgarden is pinned to the Jetson (`vllm`, 10.0.0.30:8000) and deliberately
 * has NO fallback to Gold Spark (`vllm-2`) or to "any online box". Gold Spark
 * is shared with the trading stack; wallgarden's topic churn is background
 * work that must not contend for it. If the Jetson is down, these routes fail
 * loudly — the dashboard already toasts the failure and backs the refill loop
 * off exponentially, which is the correct behaviour for a non-urgent feature.
 *
 * The model id is DISCOVERED from the box's /v1/models rather than hardcoded:
 * this Jetson has been re-provisioned before (it served gemma-4-31B until
 * 2026-08), and prism routes by model NAME — so a stale hardcoded string would
 * silently re-home the job onto whichever box does serve that name.
 * EXPECTED_JETSON_MODEL is an assertion, not the source of truth.
 */
export const JETSON_PROVIDER = "vllm";
export const EXPECTED_JETSON_MODEL = "cyankiwi/Qwen3.6-35B-A3B-AWQ-4bit";

async function resolveProviderAndModel(
  preferredModel?: string,
  preferredProvider?: string
): Promise<{ model: string; provider: string }> {
  const boxes = await discoverModels();
  const jetson = boxes.find(
    b => b.id === JETSON_PROVIDER && b.status === "online" && b.model
  );

  if (!jetson || !jetson.model) {
    const seen = boxes.map(b => `${b.nickname}=${b.status}`).join(", ") || "none";
    throw new Error(
      `Jetson (${JETSON_PROVIDER}) is offline or has no model loaded. Wallgarden is ` +
      `pinned to the Jetson and does not fall back to another box. Discovered: ${seen}`
    );
  }

  // A caller-supplied model/provider is only honoured when it names the Jetson.
  // Browsers persist their last `provider::model` pick in localStorage and send
  // it on EVERY request; before this pin those saved values were taken verbatim,
  // so an old tab holding "vllm-2::…" would keep driving Gold Spark no matter
  // what the server preferred. Server wins.
  if (
    (preferredProvider && preferredProvider !== JETSON_PROVIDER) ||
    (preferredModel && preferredModel !== jetson.model)
  ) {
    logger.warn(
      `[WallgardenService] Ignoring client model hint ` +
      `${preferredProvider ?? "?"}::${preferredModel ?? "?"} — pinned to ` +
      `${JETSON_PROVIDER}::${jetson.model}`
    );
  }

  if (jetson.model !== EXPECTED_JETSON_MODEL) {
    logger.warn(
      `[WallgardenService] Jetson is serving "${jetson.model}", expected ` +
      `"${EXPECTED_JETSON_MODEL}" — the box was re-provisioned. Prompts and ` +
      `batch sizes are tuned for the expected model.`
    );
  }

  return { model: jetson.model, provider: JETSON_PROVIDER };
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
// Backoff before retry attempt N (attempt index 0 → first retry, then capped).
const RETRY_BACKOFF_MS = [1_000, 4_000];
const retryDelay = (attempt: number) =>
  RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];

/** Call prism /chat endpoint (non-streaming, no agent persona, no tools).
 *
 * Deliberately NOT /agent: that endpoint defaults to the full CODING persona
 * and attaches every tool schema (~106K tokens), which blows the local vLLM
 * context window and makes prism skip the model call entirely — returning an
 * empty 200. /chat is the plain server-to-server completion path. */
async function callPrismChat(
  model: string,
  provider: string,
  messages: Array<{ role: string; content: string }>,
  temperature: number = 0.1,
  maxTokens: number = 4000,
): Promise<any> {
  const url = `${PRISM_URL}/chat?stream=false`;
  const body = {
    model,
    provider,
    messages,
    maxTokens, // camelCase — /chat silently drops snake_case max_tokens
    temperature,
    thinkingEnabled: false,
    skipConversation: true, // don't persist a conversation doc per call
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Prism attributes requests by header only — without these the call is
      // filed under its catch-all "default"/"anonymous" project.
      ...prismAttributionHeaders("youtube-wallgarden"),
    },
    body: JSON.stringify(body),
    // Kept below nginx's 110s and the browser's 120s so each layer sees a
    // real error from the layer below instead of racing its own timer.
    signal: AbortSignal.timeout(100_000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Prism /chat returned ${resp.status}: ${errText.substring(0, 300)}`);
  }

  const data: any = await resp.json();
  // Empty text is a gateway/provider failure, never valid model output —
  // distinct from "the model answered but we couldn't parse topics".
  if (!data || typeof data.text !== "string" || !data.text.trim()) {
    throw new Error(
      `Prism /chat returned empty text (provider=${data?.provider ?? provider}, ` +
      `model=${data?.model ?? model}, usage=${JSON.stringify(data?.usage ?? null)})`
    );
  }
  return data;
}

// ── Public API ──────────────────────────────────────────────

export async function discoverModels(): Promise<VllmBoxInfo[]> {
  const now = Date.now();
  if (modelCache.length > 0 && now - modelCacheTimestamp < MODEL_CACHE_TTL_MS) {
    return modelCache;
  }

  const instances = getInstancesByType("vllm");
  const results: VllmBoxInfo[] = [];

  for (const inst of instances) {
    const entry = inst as InstanceEntry;
    const model = await queryVllmBox(entry.baseUrl);
    results.push({
      id: entry.id,
      nickname: entry.nickname || entry.id,
      url: entry.baseUrl,
      model,
      status: model ? "online" : "offline",
    });
  }

  // If no instances in registry, try known defaults
  if (results.length === 0) {
    const defaults = [
      { id: "vllm", nickname: "Jetson", url: "http://10.0.0.30:8000" },
      { id: "vllm-2", nickname: "Gold Spark", url: "http://10.0.0.141:8000" },
    ];
    for (const d of defaults) {
      const model = await queryVllmBox(d.url);
      results.push({
        ...d,
        model,
        status: model ? "online" : "offline",
      });
    }
  }

  modelCache = results;
  modelCacheTimestamp = now;
  logger.info(`[WallgardenService] Discovered ${results.length} vLLM boxes: ${results.map(r => `${r.nickname}=${r.status}${r.model ? ` (${r.model})` : ""}`).join(", ")}`);
  return results;
}

// Asking for more than ~25 topics in one call overruns the token budget and the
// reply gets cut off mid-array. Measured against Gold Spark: 25 topics returns
// cleanly every time, while 50/75/100 yielded ZERO usable topics across every
// trial. So we fan out in batches of 25 and merge, which is both reliable and
// faster than the single doomed call it replaces.
const BRAINSTORM_BATCH_SIZE = 25;

// ── Roles: decided by the BATCH, not by the model ───────────
// The old prompt asked every batch for 25% adjacent / 40% lateral / 25%
// wildcard / 10% time-shift — 75% of every call told to leave the user's
// scene, at temperature 0.9-1.05, each batch seeing ONE liked cluster and
// told to ignore the others. That quota was the manufacturer of "random
// topics". Exploration is now a small dedicated slot instead of a share of
// every call, and a topic's role is stamped from which batch produced it —
// asking the model to self-label would break the truncation salvage in
// extractTopicsFromResponse.
export type TopicRole = "core" | "adjacent" | "explore";
export interface BrainstormedTopic { topic: string; role: TopicRole; cluster?: string }
export const BRAINSTORM_ROLE_MIX = { core: 0.35, adjacent: 0.50, explore: 0.15 } as const;
export const BRAINSTORM_MAX_TOPICS = 100;   // server clamp; the client asks for 60
export const BRAINSTORM_MAX_BATCHES = 6;
export const ROLE_TEMPERATURE: Record<TopicRole, number> = { core: 0.6, adjacent: 0.7, explore: 0.9 };
const MIN_BATCH = 5;

type ClusterIn = { name?: string; videos: string[]; size?: number };
export interface PlannedBatch { role: TopicRole; size: number; cluster?: ClusterIn; temperature: number }

/** Integer slots per bucket by largest remainder; sums exactly to n. */
function largestRemainder(n: number, shares: number[]): number[] {
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  const exact = shares.map(sh => (n * sh) / total);
  const floors = exact.map(Math.floor);
  let left = n - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - floors[i] })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; floors[i] += 1; left -= 1; }
  return floors;
}

/**
 * One blended CORE batch (all clusters), ADJACENT batches allocated across
 * clusters in proportion to their size (Steck-style calibration on the topic
 * side), and one small EXPLORE batch once there is room for it. Pure.
 */
export function planBrainstormBatches(requested: number, clusters: ClusterIn[]): PlannedBatch[] {
  const n = Math.max(1, Math.min(BRAINSTORM_MAX_TOPICS, Math.floor(requested) || 0));
  const core = Math.min(BRAINSTORM_BATCH_SIZE, Math.max(1, Math.round(n * BRAINSTORM_ROLE_MIX.core)));
  const explore = n >= 20
    ? Math.min(BRAINSTORM_BATCH_SIZE, Math.max(MIN_BATCH, Math.round(n * BRAINSTORM_ROLE_MIX.explore)))
    : 0;
  const adjacent = Math.max(0, n - core - explore);
  const batches: PlannedBatch[] = [{ role: "core", size: core, temperature: ROLE_TEMPERATURE.core }];

  if (adjacent > 0) {
    const maxAdjBatches = BRAINSTORM_MAX_BATCHES - 1 - (explore ? 1 : 0);
    const usable = (clusters || [])
      .filter(c => c && Array.isArray(c.videos) && c.videos.length > 0)
      .map(c => ({ c, size: Math.max(1, c.size ?? c.videos.length) }))
      .sort((a, b) => b.size - a.size);
    // The largest clusters get their own batch; everything else pools into one
    // mixed adjacent batch so a long tail of tiny clusters cannot fan out.
    const targeted = usable.slice(0, Math.max(0, maxAdjBatches - 1));
    const pooledSize = usable.slice(targeted.length).reduce((a, s) => a + s.size, 0);
    const shares = targeted.map(s => s.size).concat(pooledSize > 0 ? [pooledSize] : []);
    const alloc = shares.length ? largestRemainder(adjacent, shares) : [adjacent];
    let mixed = pooledSize > 0 && shares.length ? alloc[alloc.length - 1] : (targeted.length ? 0 : adjacent);
    const adj: PlannedBatch[] = [];
    targeted.forEach((s, i) => {
      const want = alloc[i];
      if (want < MIN_BATCH) { mixed += want; return; }
      const size = Math.min(BRAINSTORM_BATCH_SIZE, want);
      mixed += want - size;
      adj.push({ role: "adjacent", size, cluster: s.c, temperature: ROLE_TEMPERATURE.adjacent + adj.length * 0.03 });
    });
    // A remainder too small to be its own call folds into the first cluster
    // batch (bounded by the batch ceiling) rather than becoming a 3-topic call.
    if (mixed > 0 && mixed < MIN_BATCH && adj.length && adj[0].size + mixed <= BRAINSTORM_BATCH_SIZE) {
      adj[0].size += mixed; mixed = 0;
    }
    while (mixed > 0) {
      const size = Math.min(BRAINSTORM_BATCH_SIZE, mixed);
      adj.push({ role: "adjacent", size, temperature: ROLE_TEMPERATURE.adjacent + adj.length * 0.03 });
      mixed -= size;
    }
    batches.push(...adj);
  }
  if (explore > 0) batches.push({ role: "explore", size: explore, temperature: ROLE_TEMPERATURE.explore });
  return batches;
}

export async function brainstormTopics(ctx: BrainstormContext): Promise<BrainstormedTopic[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);

  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const searches = (ctx.searches || []).slice(-10).join(", ");
  const likedVideos = (ctx.likedVideos || []).slice(-15).join("; ");
  const watchlist = (ctx.watchlist || []).slice(-15).join("; ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 100;

  const clusters = (ctx.likedClusters || []).filter(c => c && Array.isArray(c.videos) && c.videos.length > 0);
  const failedExamples = (ctx.failedExamples || []).slice(-10).join(", ");

  // The CORE batch sees every cluster at once — the blended centre of gravity
  // that no single-cluster batch could ever show the model.
  const blendedLikedLine = clusters.length > 0
    ? clusters.map(c => `${c.name ? c.name + ": " : ""}${c.videos.slice(0, 6).join("; ")}`).join(" | ")
    : likedVideos;

  const buildMessage = (batch: PlannedBatch) => {
    const likedLine = batch.role === "core" ? blendedLikedLine : likedVideos;
    const profileLine = ctx.tasteProfile
      ? `WHO I AM AS A VIEWER: ${ctx.tasteProfile}\n\n`
      : "";
    const failedLine = failedExamples
      ? `\nTopics that FAILED for this user — study their SHAPE and avoid producing anything of the same shape, not just the same words: [${failedExamples}]`
      : "";
    const outcomesBlock = buildOutcomesBlock(ctx.topicOutcomes);
    let roleBlock: string;
    if (batch.role === "core") {
      roleBlock = `\nTHIS BATCH — CORE. Stay INSIDE the scenes in the liked videos above (all of my clusters are listed). Name what a long-time fan of each scene watches next. No leaps.`;
    } else if (batch.role === "adjacent" && batch.cluster) {
      const name = batch.cluster.name ? ` ("${batch.cluster.name}")` : "";
      roleBlock = `\nTHIS BATCH — ADJACENT, from this cluster of my liked videos${name}: [${batch.cluster.videos.slice(0, 10).join("; ")}]. One step away from THIS scene only; the other clusters are context, not targets.`;
    } else if (batch.role === "adjacent") {
      roleBlock = `\nTHIS BATCH — ADJACENT. One step away from the scenes in the liked videos above.`;
    } else {
      roleBlock = `\nTHIS BATCH — EXPLORE. Lateral leaps, wildcards, and time/culture shifts that share the deeper taste. Every topic must still pass: "would this person, not a generic viewer, click it?"`;
    }

    return `${profileLine}My interest topics: [${liked}]
Videos I actually liked (strongest signal): [${likedLine}]
Videos I saved to watch later (strong signal): [${watchlist}]
Recent searches: [${searches}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases, they returned bad results): [${burnedList}]${failedLine}${outcomesBlock}${roleBlock}

Suggest ${batch.size} new topics.`;
  };

  /** One batch, with its own retry ladder. Resolves to [] rather than throwing. */
  const runBatch = async (batch: PlannedBatch, batchIndex: number): Promise<string[]> => {
    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Role sets the heat (core is cool, explore is hot); retries cool
        // further so a model that failed to produce valid JSON gets more
        // deterministic.
        const temperature = Math.max(0.4, batch.temperature - attempt * 0.25);
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: BRAINSTORM_SYSTEM_PROMPT },
            { role: "user", content: buildMessage(batch) },
          ],
          temperature,
        );
        const topics = extractTopicsFromResponse(data);
        if (topics.length > 0) return topics;
        throw new Error("No topics extracted from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Brainstorm batch ${batchIndex + 1} (${batch.role}) attempt ${attempt + 1} failed: ${err.message}`
        );
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return [];
  };

  const plan = planBrainstormBatches(numTopics, clusters);
  const settled = await Promise.all(plan.map((b, i) => runBatch(b, i)));

  // Merge, dedupe. Batches run blind to each other and will overlap; the
  // plan is ordered core -> adjacent -> explore, so the first role wins and a
  // topic the core batch also produced is core.
  const seen = new Set<string>();
  const topics: BrainstormedTopic[] = [];
  plan.forEach((batch, i) => {
    for (const t of settled[i]) {
      if (seen.has(t)) continue;
      seen.add(t);
      topics.push({ topic: t, role: batch.role, cluster: batch.cluster?.name });
    }
  });

  if (topics.length === 0) {
    throw new Error("Brainstorm failed: every batch returned no topics");
  }

  const okBatches = settled.filter(b => b.length > 0).length;
  const byRole = topics.reduce((m, t) => { m[t.role] = (m[t.role] || 0) + 1; return m; }, {} as Record<string, number>);
  logger.info(
    `[WallgardenService] Brainstorm returned ${topics.length} unique topics ` +
    `(${JSON.stringify(byRole)}) from ${okBatches}/${plan.length} batches ` +
    `${ctx.promptVariant ? `[${ctx.promptVariant}] ` : ""}via ${provider}/${model}`
  );
  return topics;
}

// ── Topic rating ────────────────────────────────────────────
// The brainstormer's failure mode is not randomness, it is BLANDNESS: phrases
// like "hazard analysis" or "research methodology" that belong to no field in
// particular and so return algorithmic filler on YouTube. We grade every topic
// on how tightly it pins down a search space, then let the caller weight (or
// drop) accordingly. A tiny model pass beats a keyword blacklist here — tried
// both, and keyword rules kept killing good topics like "ceramic glaze science"
// purely for containing the word "science".
const RATE_SYSTEM_PROMPT = `/no_think
You rate YouTube search topics on DOMAIN ANCHORING.

Ask one question about each topic: if I showed you ONLY this phrase, with no context, how many different industries or fields could it belong to?

A = ONE field, and it names a specific process, object, or scene inside it. Typing it into YouTube returns focused, expert content. ("trichome degradation", "raku kiln reduction", "one man sawmill")
B = ONE field, but a huge one. A real subject, just broad. ("chemical reactions", "plant health", "fermentation")
C = ANY field. A floating abstraction, a corporate/academic process word, or a wellness-slop category. Typing it into YouTube returns generic algorithmic filler. ("hazard analysis", "validation studies", "research methodology", "self care", "long term aging")

Rate EVERY topic you are given. Output ONLY the raw JSON object {"ratings":[{"t":"topic","tier":"A"}]}. No markdown, no commentary.`;

// Appended to the rubric only when the caller supplies taste evidence. The
// anchoring rater alone cannot see the viewer: "raku kiln reduction" is a
// perfect A for a finance viewer. This is the second question.
const RATE_FIT_BLOCK = `
You ALSO rate FIT — does this topic belong to THIS viewer, given who they are and what they liked?
HIGH = a fan of the liked videos would plausibly search this; it sits in or beside a scene in evidence.
MED = same broad taste but a different scene; a maybe.
LOW = a different person's taste (a finance viewer does not want "raku kiln reduction" no matter how well-anchored it is), or wellness/lifestyle drift.
Output ONLY the raw JSON object {"ratings":[{"t":"topic","tier":"A","fit":"HIGH"}]}. No markdown, no commentary.`;

export type TopicTier = "A" | "B" | "C";
export type TopicFit = "HIGH" | "MED" | "LOW";
export interface RatedTopic {
  topic: string;
  tier: TopicTier;
  weight: number;
  fit?: TopicFit;
  role?: TopicRole;
  cluster?: string;
  /** The rater never graded this topic (batch failed or it was skipped). */
  unrated?: boolean;
}

export interface TasteEvidence {
  tasteProfile?: string;
  likedTitles?: string[];
  interests?: string[];
}
export interface RateOptions {
  /** When present, the FIT rubric runs and LOW-fit topics are dropped. */
  taste?: TasteEvidence;
  /** Role per topic (lowercased); explore topics survive LOW fit at the floor. */
  roles?: Map<string, TopicRole>;
}

// Tier -> starting weight in the client's topic pool. Tier C is not returned at
// all. Tier B is deliberately kept, just outranked: broad topics like "chemical
// reactions" are worth watching, they simply must not crowd out the specific
// ones.
const TIER_WEIGHT: Record<TopicTier, number> = { A: 8, B: 4, C: 0 };
// With taste evidence the weight is a function of BOTH questions.
const WEIGHT_TABLE: Record<"A" | "B", Record<TopicFit, number>> = {
  A: { HIGH: 8, MED: 6, LOW: 0 },
  B: { HIGH: 4, MED: 3, LOW: 0 },
};
// Explore is allowed to look wrong — it gets the floor, not the drop.
export const EXPLORE_LOW_FIT_WEIGHT = 2;
// A rater failure must not INFLATE: unrated used to fall back to B (4), which
// let a dead Jetson upgrade junk. Lowest positive weight instead.
export const UNRATED_WEIGHT = 2;
const RATE_BATCH_SIZE = 25;

export interface RateResult {
  rated: RatedTopic[];
  /** Batches whose rating call failed outright — their topics fell back to
   * tier B. failedBatches === totalBatches means the rater never ran at all. */
  failedBatches: number;
  totalBatches: number;
}

/**
 * Grade topics by domain-anchoring, and — when taste evidence is supplied —
 * by fit for this viewer. Without evidence the prompt and message are
 * byte-identical to the anchoring-only rater (the extract path).
 */
export async function rateTopics(
  topics: string[],
  modelHint?: string,
  providerHint?: string,
  opts?: RateOptions
): Promise<RateResult> {
  if (topics.length === 0) return { rated: [], failedBatches: 0, totalBatches: 0 };
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);
  const taste = opts?.taste;
  const withFit = Boolean(taste);
  const systemPrompt = withFit ? RATE_SYSTEM_PROMPT + RATE_FIT_BLOCK : RATE_SYSTEM_PROMPT;
  const evidenceHeader = withFit
    ? [
        taste?.tasteProfile ? `WHO THEY ARE: ${taste.tasteProfile}` : "",
        `VIDEOS THEY LIKED: [${(taste?.likedTitles || []).slice(-15).join("; ")}]`,
        `INTERESTS: [${(taste?.interests || []).slice(0, 15).join(", ")}]`,
        "TOPICS TO RATE: ",
      ].filter(Boolean).join("\n")
    : "";

  type Grade = { tier: TopicTier; fit?: TopicFit };
  // null = this batch's LLM call failed (as opposed to rated-but-skipped topics)
  const rateBatch = async (chunk: string[]): Promise<Record<string, Grade> | null> => {
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: evidenceHeader + JSON.stringify(chunk) },
          ],
          0.1, // grading, not brainstorming — keep it deterministic
        );
        const text = data?.text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object in rating response");
        const parsed = JSON.parse(match[0]);
        const out: Record<string, Grade> = {};
        for (const r of parsed?.ratings || []) {
          const t = typeof r?.t === "string" ? r.t.trim().toLowerCase() : "";
          if (t && (r.tier === "A" || r.tier === "B" || r.tier === "C")) {
            const fit = (r.fit === "HIGH" || r.fit === "MED" || r.fit === "LOW") ? r.fit : undefined;
            out[t] = { tier: r.tier, fit };
          }
        }
        return out;
      } catch (err: any) {
        logger.warn(`[WallgardenService] Topic rating batch attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return null;
  };

  const chunks: string[][] = [];
  for (let i = 0; i < topics.length; i += RATE_BATCH_SIZE) {
    chunks.push(topics.slice(i, i + RATE_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(rateBatch));
  const failedBatches = results.filter(r => r === null).length;
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Topic rating degraded: ${failedBatches}/${chunks.length} batches failed — their topics fall back to ` +
      (withFit ? `weight ${UNRATED_WEIGHT} (unrated)` : "tier B")
    );
  }
  const ratings: Record<string, Grade> = Object.assign({}, ...results.filter(Boolean));

  const rated: RatedTopic[] = topics.map(t => {
    const key = t.toLowerCase();
    const g = ratings[key];
    const role = opts?.roles?.get(key);
    if (!withFit) {
      // Legacy contract (extract path): a skipped topic is B — keep it, but
      // never let an unrated topic outrank one that actually earned an A.
      const tier: TopicTier = g?.tier || "B";
      return { topic: t, tier, weight: TIER_WEIGHT[tier], role };
    }
    if (!g) {
      return { topic: t, tier: "B", weight: UNRATED_WEIGHT, role, unrated: true };
    }
    if (g.tier === "C") return { topic: t, tier: "C", weight: 0, fit: g.fit, role };
    if (!g.fit) {
      return { topic: t, tier: g.tier, weight: UNRATED_WEIGHT, role, unrated: true };
    }
    let weight = WEIGHT_TABLE[g.tier][g.fit];
    if (g.fit === "LOW" && role === "explore") weight = EXPLORE_LOW_FIT_WEIGHT;
    return { topic: t, tier: g.tier, weight, fit: g.fit, role };
  });
  const dropped = rated.filter(r => r.tier === "C").length;
  const lowFitDropped = rated.filter(r => r.tier !== "C" && r.fit === "LOW" && r.weight === 0).length;
  logger.info(
    `[WallgardenService] Rated ${topics.length} topics: ` +
    `${rated.filter(r => r.tier === "A").length}A ` +
    `${rated.filter(r => r.tier === "B").length}B ${dropped}C(dropped)` +
    (withFit ? ` | fit: ${rated.filter(r => r.fit === "HIGH").length}H ${rated.filter(r => r.fit === "MED").length}M ` +
      `${rated.filter(r => r.fit === "LOW").length}L (${lowFitDropped} dropped) ${rated.filter(r => r.unrated).length} unrated` : "")
  );
  return {
    rated: rated.filter(r => r.tier !== "C" && r.weight > 0),
    failedBatches,
    totalBatches: chunks.length,
  };
}

// ── Liked-video topic extraction ────────────────────────────
// Turns liked videos into the specific niches they belong to. Grounded in the
// given titles (temperature low), so unlike the brainstormer this cannot
// drift: it names what the user demonstrably already loves.

// 8 videos × ≤3 topics = ≤24 topics per call, under the measured 25-topic
// output ceiling (50+ in one call yields ZERO usable output — see
// BRAINSTORM_BATCH_SIZE above).
const EXTRACT_BATCH_SIZE = 8;

/** Parse {"extractions":[{"id","topics":[...]}]} defensively. Exported for tests. */
export function extractVideoExtractionsFromResponse(data: any): { id: string; topics: string[] }[] {
  const text = data?.text || "";
  const clean = (arr: any[]): { id: string; topics: string[] }[] =>
    arr
      .map((e: any) => ({
        id: typeof e?.id === "string" ? e.id.trim() : "",
        topics: Array.isArray(e?.topics)
          ? e.topics
              .map((t: any) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
              .filter((t: string) => t.length > 1 && t.length < 60)
          : [],
      }))
      .filter(e => e.id && e.topics.length > 0);

  // Direct parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.extractions)) return clean(parsed.extractions);
    if (Array.isArray(parsed)) return clean(parsed);
  } catch { /* fall through */ }

  // Outer-object regex parse (handles markdown fences / prose around it)
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed?.extractions)) return clean(parsed.extractions);
    } catch { /* fall through */ }
  }

  // Truncation salvage: scrape complete {"id":...,"topics":[...]} objects out
  // of a reply that got cut mid-array.
  const salvaged: { id: string; topics: string[] }[] = [];
  const objRe = /\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"topics"\s*:\s*(\[[^\]]*\])\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    try {
      const topics = JSON.parse(m[2]);
      if (Array.isArray(topics)) {
        salvaged.push({ id: m[1], topics });
      }
    } catch { /* skip this object */ }
  }
  if (salvaged.length > 0) {
    logger.warn(`[WallgardenService] Extraction response malformed; salvaged ${salvaged.length} entries`);
    return clean(salvaged);
  }

  logger.warn("[WallgardenService] Could not extract video extractions from response text");
  return [];
}

export async function extractVideoTopics(
  videos: LikedVideoInput[],
  modelHint?: string,
  providerHint?: string
): Promise<VideoExtraction[]> {
  if (videos.length === 0) return [];
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  const runBatch = async (chunk: LikedVideoInput[], batchIndex: number): Promise<{ id: string; topics: string[] }[]> => {
    const lines = chunk.map(v => {
      const bits = [`id: ${v.id}`, `title: ${v.title}`];
      if (v.channel) bits.push(`channel: ${v.channel}`);
      if (typeof v.durationSecs === "number") bits.push(`duration: ${Math.round(v.durationSecs / 60)}min`);
      if (typeof v.ageDays === "number") bits.push(`age: ${Math.round(v.ageDays)}d`);
      return "- " + bits.join(" | ");
    });
    const userMessage = `Videos I liked:\n${lines.join("\n")}\n\nName 1-3 niche topics per video.`;

    const MAX_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Extraction is grounded — start cool and get colder on retries.
        const temperature = Math.max(0.1, 0.3 - attempt * 0.1);
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: EXTRACT_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          temperature,
        );
        const extractions = extractVideoExtractionsFromResponse(data);
        if (extractions.length > 0) return extractions;
        throw new Error("No extractions parsed from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Extract batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${err.message}`
        );
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return [];
  };

  const chunks: LikedVideoInput[][] = [];
  for (let i = 0; i < videos.length; i += EXTRACT_BATCH_SIZE) {
    chunks.push(videos.slice(i, i + EXTRACT_BATCH_SIZE));
  }
  const settled = await Promise.all(chunks.map((c, i) => runBatch(c, i)));
  const flat = settled.flat();

  // One rating pass over the union, then map tiers back per video. C-tier
  // topics are dropped here exactly like the brainstorm path.
  const uniqueTopics = Array.from(new Set(flat.flatMap(e => e.topics)));
  const { rated, failedBatches } = await rateTopics(uniqueTopics, model, provider);
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Extraction rating pass degraded (${failedBatches} failed batches)`
    );
  }
  const ratedByTopic = new Map(rated.map(r => [r.topic.toLowerCase(), r]));

  const out: VideoExtraction[] = [];
  for (const e of flat) {
    const topics = e.topics
      .map(t => ratedByTopic.get(t.toLowerCase()))
      .filter((r): r is RatedTopic => Boolean(r));
    if (topics.length > 0) out.push({ id: e.id, topics });
  }
  logger.info(
    `[WallgardenService] Extracted topics for ${out.length}/${videos.length} liked videos ` +
    `(${uniqueTopics.length} unique topics, ${rated.length} survived rating) via ${provider}/${model}`
  );
  return out;
}

// ── Taste profile ───────────────────────────────────────────
// One call over the user's ENTIRE like history (input-side scaling is safe —
// the 25-item ceiling is an output-array failure mode). The resulting
// paragraph is cached client-side and prepended to brainstorm/similar.
const TASTE_SYSTEM_PROMPT = `/no_think
You are given every video a person has liked on YouTube ("title (channel)" per line), plus their current interest topics. Write WHO THIS PERSON IS as a viewer.

Rules for the profile:
- At most 120 words. Concrete, not horoscope-vague: name their recurring obsessions, preferred formats and depth (long-form process video vs quick explainers), aesthetics and eras they gravitate to, and what visibly hooks them.
- Written in second person plural-free prose ("Watches ...", "Drawn to ..."), no preamble.

Then name their distinct taste clusters (2-6). Each cluster: a short name a YouTube fan would recognise, plus the liked titles that are evidence for it.

Output ONLY the raw JSON object:
{"profile":"...","clusters":[{"name":"...","evidence":["title one","title two"]}]}
No markdown, no commentary.`;

export interface TasteProfile {
  profile: string;
  clusters: { name: string; evidence: string[] }[];
}

/** Parse the taste-profile response defensively. Exported for tests. */
export function extractProfileFromResponse(data: any): TasteProfile | null {
  const text = data?.text || "";
  const tryParse = (s: string): TasteProfile | null => {
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed.profile === "string" && parsed.profile.trim()) {
        return {
          profile: parsed.profile.trim(),
          clusters: Array.isArray(parsed.clusters)
            ? parsed.clusters
                .map((c: any) => ({
                  name: typeof c?.name === "string" ? c.name.trim() : "",
                  evidence: Array.isArray(c?.evidence)
                    ? c.evidence.filter((e: any) => typeof e === "string")
                    : [],
                }))
                .filter((c: any) => c.name)
            : [],
        };
      }
    } catch { /* fall through */ }
    return null;
  };

  const direct = tryParse(text);
  if (direct) return direct;
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    const fromMatch = tryParse(objMatch[0]);
    if (fromMatch) return fromMatch;
  }
  // Salvage just the profile string from a truncated reply — the clusters are
  // nice-to-have, the paragraph is the payload.
  const profMatch = text.match(/"profile"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (profMatch) {
    try {
      const profile = JSON.parse(`"${profMatch[1]}"`);
      if (profile.trim()) {
        logger.warn("[WallgardenService] Taste profile response malformed; salvaged profile text only");
        return { profile: profile.trim(), clusters: [] };
      }
    } catch { /* give up */ }
  }
  logger.warn("[WallgardenService] Could not extract taste profile from response text");
  return null;
}

export async function generateTasteProfile(
  videos: string[],
  interests: string[] = [],
  modelHint?: string,
  providerHint?: string
): Promise<TasteProfile> {
  if (videos.length === 0) throw new Error("No liked videos to profile");
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  const userMessage = `Liked videos (${videos.length}):\n${videos.map(v => `- ${v}`).join("\n")}\n\nCurrent interest topics: [${interests.slice(0, 20).join(", ")}]`;

  const MAX_RETRIES = 2;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await callPrismChat(
        model,
        provider,
        [
          { role: "system", content: TASTE_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        0.3,
        1200,
      );
      const profile = extractProfileFromResponse(data);
      if (profile) {
        logger.info(
          `[WallgardenService] Taste profile generated from ${videos.length} likes ` +
          `(${profile.clusters.length} clusters) via ${provider}/${model}`
        );
        return profile;
      }
      throw new Error("No profile parsed from response");
    } catch (err: any) {
      lastError = err;
      logger.warn(`[WallgardenService] Taste profile attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
    }
  }
  throw lastError || new Error("Taste profile generation failed");
}

// ── Grounding gate ──────────────────────────────────────────
// Judges candidate topics by the ACTUAL YouTube results they return —
// evidence instead of guessing. Fail-open by design: an item the judge
// skips defaults to MIXED, because grounding must never brick the feed.
const JUDGE_SYSTEM_PROMPT = `/no_think
You judge YouTube search topics by their ACTUAL top search results. For each topic you receive the titles (and channels) currently returned for it, with view counts and upload years when known.

Verdicts:
- REAL = the results are a coherent niche: enthusiast/practitioner channels, specific recurring scene vocabulary, videos a fan of this topic would genuinely want. The topic names a real YouTube subculture.
- MIXED = some real signal amid filler; the topic works but isn't sharp.
- SLOP = generic listicles, clickbait compilations, corporate explainers, or results unrelated to each other — the topic is a floating phrase the algorithm fills with junk.
- DEAD = results exist but nobody is making this any more: nearly all under ~500 views and nothing uploaded in the last five years.

Judge EVERY topic you are given. Output ONLY the raw JSON object {"verdicts":[{"t":"topic","verdict":"REAL"}]}. No markdown, no commentary.`;

export type GroundingVerdict = "REAL" | "MIXED" | "SLOP" | "DEAD";
export interface GroundingResult {
  title: string;
  channel?: string;
  views?: number;
  year?: number;
}
export interface GroundingItem {
  topic: string;
  titles: string[];
  channels?: string[];
  // Richer evidence (views + upload year) from clients that have it; titles
  // and channels stay for the ones that do not.
  results?: GroundingResult[];
}
export interface JudgedTopic {
  topic: string;
  verdict: GroundingVerdict;
}

const JUDGE_BATCH_SIZE = 10;

export interface JudgeResult {
  judged: JudgedTopic[];
  /** Batches whose judge call failed outright — their topics fell back to
   * MIXED (fail-open by design; grounding must never brick the feed). */
  failedBatches: number;
  totalBatches: number;
}

export async function judgeTopicGrounding(
  items: GroundingItem[],
  modelHint?: string,
  providerHint?: string
): Promise<JudgeResult> {
  if (items.length === 0) return { judged: [], failedBatches: 0, totalBatches: 0 };
  const { model, provider } = await resolveProviderAndModel(modelHint, providerHint);

  // null = this batch's LLM call failed (vs. a verdict the judge skipped)
  const judgeBatch = async (chunk: GroundingItem[]): Promise<Record<string, GroundingVerdict> | null> => {
    const fmtViews = (n: number) => n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : n >= 1e3 ? `${Math.round(n / 100) / 10}k` : String(n);
    const lines = chunk.map(i => {
      const rich = (i.results || []).filter(r => r && r.title).slice(0, 8);
      if (rich.length) {
        const parts = rich.map(r => {
          const meta = [typeof r.views === "number" ? `${fmtViews(r.views)} views` : "", r.year ? String(r.year) : ""].filter(Boolean);
          return `"${r.title}"${meta.length ? ` (${meta.join(", ")})` : ""}`;
        });
        const channels = Array.from(new Set(rich.map(r => r.channel).filter(Boolean)));
        const chanPart = channels.length ? ` | channels: ${channels.join(", ")}` : "";
        return `- topic: "${i.topic}" | results: [${parts.join(", ")}]${chanPart}`;
      }
      const titles = i.titles.slice(0, 8).map(t => `"${t}"`).join(", ");
      const channels = (i.channels || []).slice(0, 8).filter(Boolean);
      const chanPart = channels.length ? ` | channels: ${channels.join(", ")}` : "";
      return `- topic: "${i.topic}" | results: [${titles}]${chanPart}`;
    });
    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: JUDGE_SYSTEM_PROMPT },
            { role: "user", content: lines.join("\n") },
          ],
          0.1, // grading, not brainstorming
        );
        const text = data?.text || "";
        const match = text.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object in judge response");
        const parsed = JSON.parse(match[0]);
        const out: Record<string, GroundingVerdict> = {};
        for (const v of parsed?.verdicts || []) {
          const t = typeof v?.t === "string" ? v.t.trim().toLowerCase() : "";
          if (t && (v.verdict === "REAL" || v.verdict === "MIXED" || v.verdict === "SLOP" || v.verdict === "DEAD")) {
            out[t] = v.verdict;
          }
        }
        return out;
      } catch (err: any) {
        logger.warn(`[WallgardenService] Grounding judge batch attempt ${attempt + 1} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return null;
  };

  const chunks: GroundingItem[][] = [];
  for (let i = 0; i < items.length; i += JUDGE_BATCH_SIZE) {
    chunks.push(items.slice(i, i + JUDGE_BATCH_SIZE));
  }
  const results = await Promise.all(chunks.map(judgeBatch));
  const failedBatches = results.filter(r => r === null).length;
  if (failedBatches > 0) {
    logger.error(
      `[WallgardenService] Grounding judge degraded: ${failedBatches}/${chunks.length} batches failed — their topics default to MIXED`
    );
  }
  const verdicts: Record<string, GroundingVerdict> = Object.assign({}, ...results.filter(Boolean));

  const judged = items.map(i => ({
    topic: i.topic,
    verdict: verdicts[i.topic.toLowerCase()] || ("MIXED" as GroundingVerdict),
  }));
  logger.info(
    `[WallgardenService] Judged ${judged.length} topics: ` +
    `${judged.filter(j => j.verdict === "REAL").length} REAL, ` +
    `${judged.filter(j => j.verdict === "MIXED").length} MIXED, ` +
    `${judged.filter(j => j.verdict === "SLOP").length} SLOP, ` +
    `${judged.filter(j => j.verdict === "DEAD").length} DEAD`
  );
  return { judged, failedBatches, totalBatches: chunks.length };
}

export async function generateSimilarTopics(ctx: SimilarContext): Promise<string[]> {
  const { model, provider } = await resolveProviderAndModel(ctx.model, ctx.provider);

  const liked = ctx.interests.slice(0, 15).join(", ");
  const disliked = ctx.disliked.slice(0, 10).join(", ");
  const likedVideos = (ctx.likedVideos || []).slice(-15).join("; ");
  const watchlist = (ctx.watchlist || []).slice(-15).join("; ");
  const recentUsed = ctx.recentUsed.slice(-20).join(", ");
  const burnedList = ctx.burnedQueries.slice(-30).join(", ");
  const numTopics = ctx.numTopics || 10;

  const profileLine = ctx.tasteProfile ? `WHO I AM AS A VIEWER: ${ctx.tasteProfile}\n\n` : "";
  const seeds = Array.from(new Set(
    [ctx.query].concat(ctx.seeds || []).map(x => (x || "").trim()).filter(Boolean)
  )).slice(0, 8);
  const seedLine = seeds.length > 1
    ? `\nSeed topics I have shown real interest in, strongest first: [${seeds.map(x => `"${x}"`).join(", ")}]`
    : "";
  const failedExamples = (ctx.failedExamples || []).slice(-10).join(", ");
  const failedLine = failedExamples
    ? `\nTopics that FAILED for this user — study their SHAPE and avoid producing anything of the same shape, not just the same words: [${failedExamples}]`
    : "";
  const ask = seeds.length > 1
    ? `Suggest ${numTopics} topics related to these seeds — at least half must be directly adjacent to "${seeds[0]}".`
    : `Suggest ${numTopics} topics related to "${ctx.query}".`;
  const userMessage = `${profileLine}Search query: "${ctx.query}"${seedLine}
My interest topics: [${liked}]
Videos I actually liked (strongest signal): [${likedVideos}]
Videos I saved to watch later (strong signal): [${watchlist}]
Disliked: [${disliked}]
Recently used (avoid these): [${recentUsed}]
Failed queries (don't reuse these exact phrases): [${burnedList}]${failedLine}${buildOutcomesBlock(ctx.topicOutcomes)}

${ask}`;

  const MAX_RETRIES = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        logger.info(`[WallgardenService] Similar retry ${attempt + 1}/${MAX_RETRIES + 1}`);
      }

      // Adjacent-first, so cooler than the old 0.9 brainstorm heat.
      const temperature = Math.max(0.4, 0.7 - attempt * 0.25);
      const data = await callPrismChat(
        model,
        provider,
        [
          { role: "system", content: SIMILAR_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        temperature,
      );

      const topics = extractTopicsFromResponse(data);
      if (topics.length > 0) {
        logger.info(`[WallgardenService] Similar topics for "${ctx.query}" returned ${topics.length} topics via ${provider}/${model}`);
        return topics;
      }

      throw new Error("No topics extracted from response");
    } catch (err: any) {
      lastError = err;
      logger.error(`[WallgardenService] Similar attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
    }
  }

  throw lastError || new Error("Similar topic generation failed after all retries");
}

// ── Candidate Classification Gate ───────────────────────────
// Classifies candidate videos against a specific topic intent to filter
// out novelty builds (e.g. LEGO/Minecraft fish tanks), off-topic crossover,
// and low-quality results before they enter the feed ranking.
const CLASSIFY_CANDIDATES_SYSTEM_PROMPT = `/no_think
You are the semantic relevance gate for a curated YouTube feed.
Given a target TOPIC, its intended DOMAIN/INTENT, and any EXCLUSIONS, evaluate whether candidate video titles/channels are genuinely on-topic or whether they are novelty/crossover bait, off-topic, or low-quality.

Classifications:
- ON_TOPIC: Genuinely represents the intended craft, enthusiast domain, practitioner scene, or informational subject. (e.g. for "fish tanks" [aquariums]: aquascaping guides, planted tank filtration, freshwater fish care).
- ADJACENT: Closely related enthusiast topic from a neighboring scene that an enthusiast would still welcome (e.g. for "fish tanks": aquatic plant propagation, pond building).
- NOVELTY: Novelty builds, toy/crossover content, viral spectacle, prank/experiment stunts, or gimmick projects that hijack the topic words without belonging to the actual hobby/niche (e.g. for "fish tanks": "I built a fish tank entirely from LEGO", "Minecraft working aquarium", "giant gummy fish tank challenge").
- OFF_TOPIC: Unrelated subject, completely different domain (e.g. "military tank battle", "synthesis" meaning corporate mergers when intended music production).

For each candidate video, return:
- id: video id
- classification: "ON_TOPIC" | "ADJACENT" | "NOVELTY" | "OFF_TOPIC"
- reason: brief 3-8 word explanation

Output ONLY the raw JSON object:
{"classifications":[{"id":"<id>","classification":"ON_TOPIC","reason":"aquascaping tutorial"}]}
No markdown, no commentary.`;

export type CandidateClassification = "ON_TOPIC" | "ADJACENT" | "NOVELTY" | "OFF_TOPIC";

export interface CandidateItem {
  id: string;
  title: string;
  channel?: string;
  durationSecs?: number;
  // First ~200 chars of the results-card snippet (scraper 2026-09-06).
  description?: string;
}

export interface CandidateClassificationResult {
  id: string;
  classification: CandidateClassification;
  reason?: string;
}

export interface ClassifyCandidatesInput {
  topic: string;
  intent?: string;
  includeFacets?: string[];
  excludeFacets?: string[];
  candidates: CandidateItem[];
  model?: string;
  provider?: string;
}

/** Parse candidate classifications defensively from model response */
export function extractCandidateClassificationsFromResponse(
  data: any
): CandidateClassificationResult[] {
  const text = data?.text || "";
  const clean = (arr: any[]): CandidateClassificationResult[] =>
    arr
      .map((c: any) => {
        const id = typeof c?.id === "string" ? c.id.trim() : "";
        const rawClass = typeof c?.classification === "string" ? c.classification.toUpperCase().trim() : "";
        const classification: CandidateClassification =
          rawClass === "ON_TOPIC" || rawClass === "ADJACENT" || rawClass === "NOVELTY" || rawClass === "OFF_TOPIC"
            ? rawClass
            : "ADJACENT";
        const reason = typeof c?.reason === "string" ? c.reason.trim() : undefined;
        return { id, classification, reason };
      })
      .filter(c => c.id);

  // Direct parse
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed?.classifications)) return clean(parsed.classifications);
    if (Array.isArray(parsed)) return clean(parsed);
  } catch { /* fall through */ }

  // Outer-object regex match
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed?.classifications)) return clean(parsed.classifications);
    } catch { /* fall through */ }
  }

  // Truncation salvage
  const salvaged: CandidateClassificationResult[] = [];
  const objRe = /\{\s*"id"\s*:\s*"([^"]+)"\s*,\s*"classification"\s*:\s*"([^"]+)"(?:\s*,\s*"reason"\s*:\s*"([^"]*)")?\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) !== null) {
    const id = m[1];
    const rawClass = m[2].toUpperCase();
    const classification: CandidateClassification =
      rawClass === "ON_TOPIC" || rawClass === "ADJACENT" || rawClass === "NOVELTY" || rawClass === "OFF_TOPIC"
        ? rawClass
        : "ADJACENT";
    salvaged.push({ id, classification, reason: m[3] || undefined });
  }

  if (salvaged.length > 0) {
    logger.warn(`[WallgardenService] Classify candidates response malformed; salvaged ${salvaged.length} entries`);
    return clean(salvaged);
  }

  logger.warn("[WallgardenService] Could not extract classifications from response text");
  return [];
}

const CLASSIFY_BATCH_SIZE = 15;

export async function classifyCandidateVideos(
  input: ClassifyCandidatesInput
): Promise<{ classifications: CandidateClassificationResult[]; failed: boolean }> {
  if (!input.candidates || input.candidates.length === 0) {
    return { classifications: [], failed: false };
  }

  const { model, provider } = await resolveProviderAndModel(input.model, input.provider);

  const intentPart = input.intent ? `\nTarget Domain/Intent: ${input.intent}` : "";
  const incPart = input.includeFacets && input.includeFacets.length ? `\nInclude Facets: [${input.includeFacets.join(", ")}]` : "";
  const excPart = input.excludeFacets && input.excludeFacets.length ? `\nExclude / Novelty Patterns: [${input.excludeFacets.join(", ")}]` : "";

  const runBatch = async (
    chunk: CandidateItem[],
    batchIndex: number
  ): Promise<CandidateClassificationResult[]> => {
    const lines = chunk.map(c => {
      const parts = [`id: ${c.id}`, `title: "${c.title}"`];
      if (c.channel) parts.push(`channel: "${c.channel}"`);
      if (typeof c.durationSecs === "number") parts.push(`duration: ${Math.round(c.durationSecs / 60)}min`);
      if (typeof c.description === "string" && c.description.trim()) parts.push(`desc: "${c.description.trim().slice(0, 200)}"`);
      return "- " + parts.join(" | ");
    });

    const userMessage = `Target Topic: "${input.topic}"${intentPart}${incPart}${excPart}

Candidate Videos to classify:
${lines.join("\n")}

Classify each video as ON_TOPIC, ADJACENT, NOVELTY, or OFF_TOPIC.`;

    const MAX_RETRIES = 1;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await callPrismChat(
          model,
          provider,
          [
            { role: "system", content: CLASSIFY_CANDIDATES_SYSTEM_PROMPT },
            { role: "user", content: userMessage },
          ],
          0.1, // deterministic grading
          1200
        );

        const results = extractCandidateClassificationsFromResponse(data);
        if (results.length > 0) return results;
        throw new Error("No classifications parsed from response");
      } catch (err: any) {
        logger.warn(
          `[WallgardenService] Classify candidates batch ${batchIndex + 1} attempt ${attempt + 1} failed: ${err.message}`
        );
        if (attempt < MAX_RETRIES) await sleep(retryDelay(attempt));
      }
    }
    return [];
  };

  const chunks: CandidateItem[][] = [];
  for (let i = 0; i < input.candidates.length; i += CLASSIFY_BATCH_SIZE) {
    chunks.push(input.candidates.slice(i, i + CLASSIFY_BATCH_SIZE));
  }

  const settled = await Promise.all(chunks.map((c, i) => runBatch(c, i)));
  const flat = settled.flat();
  const failed = flat.length === 0 && input.candidates.length > 0;

  // Map results back by ID; candidates skipped or unclassified fall back to ADJACENT
  const byId = new Map(flat.map(r => [r.id, r]));
  const fullResults = input.candidates.map(c => byId.get(c.id) || {
    id: c.id,
    classification: "ADJACENT" as CandidateClassification,
    reason: "unclassified",
  });

  logger.info(
    `[WallgardenService] Classified ${fullResults.length} candidates for "${input.topic}": ` +
    `${fullResults.filter(r => r.classification === "ON_TOPIC").length} ON_TOPIC, ` +
    `${fullResults.filter(r => r.classification === "ADJACENT").length} ADJACENT, ` +
    `${fullResults.filter(r => r.classification === "NOVELTY").length} NOVELTY, ` +
    `${fullResults.filter(r => r.classification === "OFF_TOPIC").length} OFF_TOPIC`
  );

  return { classifications: fullResults, failed };
}

