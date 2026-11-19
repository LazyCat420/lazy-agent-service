import { createHash } from "node:crypto";
import logger from "../../logger.js";

/**
 * The shared Qwen request pool behind `/vllm-shim/qwen`.
 *
 * WHY (2026-11-19, user decision "option A"): the two Dell boxes each serve
 * Qwen3.8-Flash-Next (TensorFold, max_batch_size 5) and are addressed today as
 * two independent shim routes. A backlog on one box therefore stays on that
 * box while the other idles, even though the caller only cares that SOME box
 * answers. This module makes the two boxes one pool at the REQUEST level: each
 * arrival goes to the member with the lowest load, so a queue on one box
 * spills to the other immediately instead of at the next caller restart.
 *
 * Load is `num_requests_running + num_requests_waiting` from the engine's own
 * `/metrics`, plus this shim's in-flight count for that member. The gauges are
 * cached for ~1s (they are a scrape, not a counter) and the local count is
 * what makes a burst of N arrivals spread across both boxes inside that
 * second instead of all landing on the same member.
 *
 * Session affinity: a request that carries a session key stays on the box that
 * served it before, so the engine's prompt cache stays warm — unless that box
 * is at least 2 requests deeper than the least-loaded member, at which point
 * latency wins over cache.
 *
 * Members: only boxes that answer `/v1/models` AND serve the same model id.
 * When the Dells are switched to the GLM TP=2 layout (.131 down), the pool
 * shrinks to the single live member without any config change.
 */

export interface QwenPoolMember {
  /** Shim upstream name (legacy, SWAPPED vs the physical boxes). */
  name: string;
  /** Base URL of the engine. */
  url: string;
  /** Host as it appears in the `x-pool-box` response header. */
  ip: string;
}

/**
 * The pool. Route names are legacy and swapped (see UPSTREAMS in
 * VllmShimService): `dell2` reaches physical dellbox1@10.0.0.37 and `dell1`
 * reaches physical dellbox2@10.0.0.131. The `ip` field is the physical truth
 * and is what callers see in `x-pool-box`.
 */
export const QWEN_POOL_MEMBERS: readonly QwenPoolMember[] = [
  {
    name: "dell2",
    url: process.env.VLLM_SHIM_DELL2_URL || "http://10.0.0.37:8888", // physical dellbox1
    ip: "10.0.0.37",
  },
  {
    name: "dell1",
    url: process.env.VLLM_SHIM_DELL1_URL || "http://10.0.0.131:8888", // physical dellbox2
    ip: "10.0.0.131",
  },
];

/** Members currently held out of rotation after a failed connect (ms). */
const MEMBER_DOWN_COOLDOWN_MS = 30_000;

/**
 * Consecutive `/v1/models` failures before a member leaves rotation. One 3 s
 * timeout is not evidence of a dead box: with a single strike, a simultaneous
 * blip on both Dells would otherwise produce a 503 storm while both engines
 * are serving. Two strikes are.
 */
const PROBE_STRIKE_LIMIT = 2;

/** Engine gauge cache lifetime — short on purpose (see module note). */
const GAUGE_TTL_MS = 1_000;

/** `/v1/models` liveness/model-id cache lifetime. */
const MODEL_TTL_MS = 10_000;

/** How long a session's affinity survives without another request. */
const AFFINITY_TTL_MS = 600_000;

/** Cap on the affinity map so a stream of unique callers cannot leak it. */
const AFFINITY_MAX_ENTRIES = 2_048;

/** Model ids the shim never treats as generation models (mirrors NON_LLM_MODELS). */
const NON_GENERATION_MODELS: Record<string, true> = {
  gliner: true,
  market_cnn: true,
  timeseries_rnn: true,
};

interface GaugeSample {
  at: number;
  running: number;
  waiting: number;
}

interface HealthSample {
  at: number;
  up: boolean;
  model: string | null;
}

const gaugeCache = new Map<string, GaugeSample>();
const gaugePending = new Map<string, Promise<GaugeSample>>();
const healthCache = new Map<string, HealthSample>();
const healthPending = new Map<string, Promise<HealthSample>>();
const downUntil = new Map<string, number>();
const probeFailures = new Map<string, number>();
const lastFailureAt = new Map<string, number>();
const inFlight = new Map<string, number>();
const served = new Map<string, number>();
const affinity = new Map<string, { member: string; at: number }>();
let tieBreakCursor = 0;

/** Test seam: forget every cached sample, counter and affinity. */
export function resetQwenPoolState(): void {
  gaugeCache.clear();
  gaugePending.clear();
  healthCache.clear();
  healthPending.clear();
  downUntil.clear();
  probeFailures.clear();
  lastFailureAt.clear();
  inFlight.clear();
  served.clear();
  affinity.clear();
  tieBreakCursor = 0;
}

/**
 * Test seam: drop only the cached gauge/model samples so a suite can simulate
 * a different load without losing affinity, counters or probe strikes.
 */
export function clearPoolCaches(): void {
  gaugeCache.clear();
  gaugePending.clear();
  healthCache.clear();
  healthPending.clear();
}

/**
 * Affinity keys in LRU order (oldest first). Diagnostics and the LRU test use
 * it; the keys themselves are session identifiers, so `/health` never exports
 * them.
 */
export function qwenPoolAffinityKeys(): string[] {
  return [...affinity.keys()];
}

/**
 * Sum a Prometheus gauge family out of a `/metrics` body.
 *
 * The Dells expose `tensorfold:num_requests_running` / `..._waiting` (the
 * `vllm:` spellings are accepted too — same engine, different build). All
 * label sets of the first matching family are summed, so a per-model split
 * still reports the box's true load. Exported for unit tests.
 */
export function parsePoolGauges(text: string): { running: number; waiting: number } {
  const family = (names: string[]): number | null => {
    for (const name of names) {
      const re = new RegExp(`^${name.replace(/[:]/g, ":")}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)\\s*$`, "gm");
      let sum = 0;
      let found = false;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const value = Number(m[2]);
        if (Number.isFinite(value)) {
          sum += value;
          found = true;
        }
      }
      if (found) return sum;
    }
    return null;
  };
  return {
    running: family(["tensorfold:num_requests_running", "vllm:num_requests_running"]) ?? 0,
    waiting: family(["tensorfold:num_requests_waiting", "vllm:num_requests_waiting"]) ?? 0,
  };
}

/**
 * First generation model id in a `/v1/models` payload (embedders and
 * extraction-only models excluded). Exported for unit tests.
 */
export function pickPoolModel(payload: unknown): string | null {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
    if (!id) continue;
    if (NON_GENERATION_MODELS[id.toLowerCase()] || /embed/i.test(id)) continue;
    return id;
  }
  return null;
}

function markDown(member: QwenPoolMember, reason: string): void {
  const until = Date.now() + MEMBER_DOWN_COOLDOWN_MS;
  const previous = downUntil.get(member.name) || 0;
  lastFailureAt.set(member.name, Date.now());
  if (previous <= Date.now()) {
    logger.warn(
      `[VllmQwenPool] member "${member.name}" (${member.ip}) out of rotation for ` +
        `${MEMBER_DOWN_COOLDOWN_MS}ms: ${reason}`,
    );
  }
  downUntil.set(member.name, until);
}

/** True while a failed connect has this member out of rotation. */
export function poolMemberDown(member: QwenPoolMember): boolean {
  return (downUntil.get(member.name) || 0) > Date.now();
}

/** Take a member out of rotation after a failed connect (exported for tests). */
export function markPoolMemberDown(name: string): void {
  const member = QWEN_POOL_MEMBERS.find((m) => m.name === name);
  if (member) markDown(member, "connect failed");
}

/** Count a request this shim has in flight to a member. */
export function acquirePoolInFlight(name: string): void {
  inFlight.set(name, (inFlight.get(name) || 0) + 1);
}

/** Drop one in-flight count; a no-op at zero so a double release cannot go negative. */
export function releasePoolInFlight(name: string): void {
  const current = inFlight.get(name) || 0;
  if (current > 0) inFlight.set(name, current - 1);
}

/** Attribute one delivered response to the member that served it. */
export function recordPoolServed(name: string): void {
  served.set(name, (served.get(name) || 0) + 1);
}

/** Read (and cache for ~1s) one member's engine gauges. Never throws. */
async function readGauges(member: QwenPoolMember): Promise<GaugeSample> {
  const cached = gaugeCache.get(member.name);
  if (cached && Date.now() - cached.at < GAUGE_TTL_MS) return cached;
  const pending = gaugePending.get(member.name);
  if (pending) return pending;

  const promise = (async (): Promise<GaugeSample> => {
    let sample: GaugeSample = { at: Date.now(), running: 0, waiting: 0 };
    try {
      const response = await fetch(`${member.url.replace(/\/$/, "")}/metrics`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        const parsed = parsePoolGauges(await response.text());
        sample = { at: Date.now(), ...parsed };
      }
    } catch {
      // A gauge scrape failure is not evidence the box is down — the models
      // probe decides liveness. Treat unknown load as zero and keep going.
    }
    gaugeCache.set(member.name, sample);
    return sample;
  })().finally(() => gaugePending.delete(member.name));

  gaugePending.set(member.name, promise);
  return promise;
}

/** Probe one member's `/v1/models` for liveness and its served model id. */
async function probeHealth(member: QwenPoolMember): Promise<HealthSample> {
  if (poolMemberDown(member)) {
    return { at: Date.now(), up: false, model: null };
  }
  const cached = healthCache.get(member.name);
  if (cached && Date.now() - cached.at < MODEL_TTL_MS) return cached;
  const pending = healthPending.get(member.name);
  if (pending) return pending;

  const promise = (async (): Promise<HealthSample> => {
    const fail = (reason: string): HealthSample => {
      const strikes = (probeFailures.get(member.name) || 0) + 1;
      probeFailures.set(member.name, strikes);
      lastFailureAt.set(member.name, Date.now());
      if (strikes >= PROBE_STRIKE_LIMIT) {
        markDown(member, `${reason} (${strikes} consecutive probe failures)`);
      }
      // One strike keeps the member eligible: a transient blip must not evict
      // a healthy box. Its model id is unknown for this probe, though.
      return { at: Date.now(), up: strikes < PROBE_STRIKE_LIMIT, model: null };
    };

    let sample: HealthSample;
    try {
      const response = await fetch(`${member.url.replace(/\/$/, "")}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        sample = { at: Date.now(), up: true, model: pickPoolModel(await response.json()) };
        probeFailures.set(member.name, 0);
        downUntil.delete(member.name);
      } else {
        sample = fail(`HTTP ${response.status} on /v1/models`);
      }
    } catch (error: unknown) {
      sample = fail(`fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    healthCache.set(member.name, sample);
    return sample;
  })().finally(() => healthPending.delete(member.name));

  healthPending.set(member.name, promise);
  return promise;
}

/**
 * Derive the session key that pins a request to its previous box.
 *
 * Order: OpenAI `user` field, `x-session-id` header, then a hash of the first
 * system + user message prefix (callers that send neither still get affinity
 * for the same conversation prefix). Returns null when nothing identifies the
 * session — those requests are pure least-loaded.
 */
/** Shape the pool reads off a request: the parsed body and the raw headers. */
export interface PoolRequestShape {
  body?: Record<string, unknown> | undefined;
  headers?: Record<string, unknown> | undefined;
}

export function poolSessionKey(req: PoolRequestShape): string | null {
  const user = req.body?.user;
  if (typeof user === "string" && user.trim()) return `u:${user.trim()}`;

  const rawHeader = req.headers?.["x-session-id"];
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof header === "string" && header.trim()) return `h:${header.trim()}`;

  const messages = req.body?.messages;
  if (!Array.isArray(messages)) return null;
  const pick = (role: string): string => {
    const msg = messages.find(
      (m): m is Record<string, unknown> =>
        !!m && typeof m === "object" && (m as Record<string, unknown>).role === role &&
        typeof (m as Record<string, unknown>).content === "string",
    );
    return msg ? (msg.content as string).slice(0, 256) : "";
  };
  const prefix = `${pick("system")}\u0000${pick("user")}`;
  if (prefix === "\u0000") return null;
  return `m:${createHash("sha1").update(prefix).digest("hex")}`;
}

function pruneAffinity(): void {
  const now = Date.now();
  for (const [key, entry] of affinity) {
    if (now - entry.at > AFFINITY_TTL_MS) affinity.delete(key);
  }
  const cap =
    Number(process.env.VLLM_SHIM_POOL_AFFINITY_MAX_ENTRIES) > 0
      ? Number(process.env.VLLM_SHIM_POOL_AFFINITY_MAX_ENTRIES)
      : AFFINITY_MAX_ENTRIES;
  while (affinity.size > cap) {
    const oldest = affinity.keys().next().value;
    if (oldest === undefined) break;
    affinity.delete(oldest);
  }
}

/**
 * Record (or refresh) a session's box. Delete-then-set is what makes the map
 * LRU: `Map.set` on an existing key keeps its original insertion position, so
 * without the delete a hot session would be evicted like a cold one.
 */
function rememberAffinity(key: string, member: string): void {
  affinity.delete(key);
  affinity.set(key, { member, at: Date.now() });
  pruneAffinity();
}

export interface PoolSelection {
  /** The member chosen for this request; its in-flight count is already taken. */
  member: QwenPoolMember;
  /** Chosen member first, then other live members of the same model (failover order). */
  candidates: QwenPoolMember[];
  /** Per-member load used for the pick (running + waiting + shim in-flight). */
  loads: Record<string, number>;
  sessionKey: string | null;
}

/**
 * Pick the member for one request.
 *
 * Only members that pass the two-strike liveness probe are candidates; when
 * every member is out of rotation the least recently failed one is returned
 * anyway, so a simultaneous probe blip never turns into a 503 storm. The
 * chosen member's in-flight count is incremented here (at selection time) so
 * a burst spreads before the gauges catch up; the caller MUST release it via
 * `releasePoolInFlight`.
 */
export async function selectQwenMember(req: PoolRequestShape): Promise<PoolSelection> {
  // Health probes and gauge scrapes are independent: run them together so a
  // cold cache costs one 3 s round, not two sequential ones.
  const [health, gauges] = await Promise.all([
    Promise.all(QWEN_POOL_MEMBERS.map((m) => probeHealth(m))),
    Promise.all(QWEN_POOL_MEMBERS.map((m) => readGauges(m))),
  ]);
  const loads: Record<string, number> = {};
  QWEN_POOL_MEMBERS.forEach((m, i) => {
    loads[m.name] = gauges[i].running + gauges[i].waiting + (inFlight.get(m.name) || 0);
  });
  const sessionKey = poolSessionKey(req);

  const live = QWEN_POOL_MEMBERS.filter((_, i) => health[i].up);
  if (live.length === 0) {
    // Every member is out of rotation. Still try the least recently failed
    // one: both engines can be serving while both probes blipped, and a 503
    // storm would be worse than one attempt against a possibly-live box.
    const fallback = QWEN_POOL_MEMBERS.reduce((a, b) =>
      (lastFailureAt.get(a.name) ?? 0) <= (lastFailureAt.get(b.name) ?? 0) ? a : b,
    );
    logger.warn(
      `[VllmQwenPool] every member is out of rotation; trying the least recently ` +
        `failed one (${fallback.name} / ${fallback.ip}) instead of shedding the request`,
    );
    acquirePoolInFlight(fallback.name);
    return { member: fallback, candidates: [fallback], loads, sessionKey };
  }

  // Group by model id; a member whose model is unknown can only serve alone.
  const requestedModel = req.body?.model;
  const requested = typeof requestedModel === "string" ? requestedModel : null;
  const firstModel = health[QWEN_POOL_MEMBERS.indexOf(live[0])].model;
  const targetModel =
    requested && live.some((m) => health[QWEN_POOL_MEMBERS.indexOf(m)].model === requested)
      ? requested
      : firstModel;

  let candidates = live.filter((m) => health[QWEN_POOL_MEMBERS.indexOf(m)].model === targetModel);
  if (candidates.length === 0) candidates = [live[0]];

  const minLoad = Math.min(...candidates.map((m) => loads[m.name]));

  let chosen: QwenPoolMember | undefined;
  if (sessionKey) {
    pruneAffinity();
    const previous = affinity.get(sessionKey)?.member;
    const prevMember = previous ? candidates.find((m) => m.name === previous) : undefined;
    // Keep the warm prompt cache unless the old box is >= 2 deeper.
    if (prevMember && loads[prevMember.name] - minLoad < 2) chosen = prevMember;
  }
  if (!chosen) {
    const lowest = candidates.filter((m) => loads[m.name] === minLoad);
    chosen = lowest[tieBreakCursor % lowest.length];
    tieBreakCursor = (tieBreakCursor + 1) % 1_000_000;
  }

  acquirePoolInFlight(chosen.name);
  if (sessionKey) rememberAffinity(sessionKey, chosen.name);

  const ordered = [chosen, ...candidates.filter((m) => m.name !== chosen.name)];
  return { member: chosen, candidates: ordered, loads, sessionKey };
}

export interface QwenPoolMemberStats {
  name: string;
  ip: string;
  up: boolean;
  model: string | null;
  running: number | null;
  waiting: number | null;
  inFlight: number;
  served: number;
}

export interface QwenPoolStats {
  route: string;
  members: QwenPoolMemberStats[];
  served: Record<string, number>;
}

/** Snapshot for `/health` and logs: which box served how much, and current load. */
export function qwenPoolStats(): QwenPoolStats {
  return {
    route: "/vllm-shim/qwen",
    members: QWEN_POOL_MEMBERS.map((m) => {
      const gauge = gaugeCache.get(m.name);
      const health = healthCache.get(m.name);
      return {
        name: m.name,
        ip: m.ip,
        up: health ? health.up && !poolMemberDown(m) : !poolMemberDown(m),
        model: health?.model ?? null,
        running: gauge?.running ?? null,
        waiting: gauge?.waiting ?? null,
        inFlight: inFlight.get(m.name) || 0,
        served: served.get(m.name) || 0,
      };
    }),
    served: Object.fromEntries(QWEN_POOL_MEMBERS.map((m) => [m.name, served.get(m.name) || 0])),
  };
}
