import { createHash } from "node:crypto";
import logger from "../../logger.js";

/**
 * The shared Dell request pool behind `/vllm-shim/qwen` (legacy route name;
 * kept as-is because callers' PROVIDER_VLLM_*_URL entries point at it).
 *
 * WHY (2026-11-19, user decision "option A"): the Dell boxes were addressed as
 * two independent shim routes, so a backlog on one box stayed there while the
 * other idled, even though the caller only cares that SOME box answers. This
 * module makes the boxes one pool at the REQUEST level: each arrival goes to
 * the member with the lowest load, so a queue on one box spills to the other
 * immediately instead of at the next caller restart.
 *
 * Load is `num_requests_running + num_requests_waiting` from the engine's own
 * `/metrics`, plus this shim's in-flight count for that member. The gauges are
 * cached for ~1s (they are a scrape, not a counter) and the local count is
 * what makes a burst of N arrivals spread across the members inside that
 * second instead of all landing on the same one.
 *
 * Session affinity: a request that carries a session key stays on the box that
 * served it before, so the engine's prompt cache stays warm — unless that box
 * is at least 2 requests deeper than the least-loaded member, at which point
 * latency wins over cache.
 *
 * The model is discovered live from each member's `/v1/models` (today both
 * boxes serve DeepSeek-V4.1-Flash-1017). Only boxes that answer AND serve the
 * same model id are pooled together, so a mixed deployment keeps a request on
 * the box that serves its model.
 *
 * Members come from `VLLM_SHIM_POOL_MEMBERS` (comma-separated upstream names,
 * trimmed, empty entries dropped). The default is `dell2` — the TP=2 layout:
 * the two Dells run one cluster whose only API is 10.0.0.37:8888 (member
 * `dell2`); 10.0.0.131 (`dell1`) has none. Set
 * `VLLM_SHIM_POOL_MEMBERS=dell2,dell1` when the Dells run two standalone
 * engines again.
 */

export interface PoolMember {
  /** Shim upstream name (legacy, SWAPPED vs the physical boxes). */
  name: string;
  /** Base URL of the engine. */
  url: string;
  /** Host as it appears in the `x-pool-box` response header. */
  ip: string;
}

/** Pool used when `VLLM_SHIM_POOL_MEMBERS` is unset or empty. */
const DEFAULT_POOL_MEMBERS = "dell2";

/**
 * Build the pool from a `VLLM_SHIM_POOL_MEMBERS` spec. Pure (env injectable) so
 * tests can exercise membership without re-importing this module. Unknown
 * names and unparsable URLs are warned about once and skipped; duplicates keep
 * the first entry.
 */
export function buildPoolMembers(
  spec: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): PoolMember[] {
  const raw = spec === undefined || spec.trim() === "" ? DEFAULT_POOL_MEMBERS : spec;
  const members: PoolMember[] = [];
  const seen = new Set<string>();
  for (const name of raw.split(",").map((n) => n.trim()).filter((n) => n.length > 0)) {
    if (seen.has(name)) continue;
    const url =
      name === "dell2"
        ? env.VLLM_SHIM_DELL2_URL || "http://10.0.0.37:8888" // physical dellbox1
        : name === "dell1"
          ? env.VLLM_SHIM_DELL1_URL || "http://10.0.0.131:8888" // physical dellbox2
          : undefined;
    if (!url) {
      logger.warn(`[VllmPool] unknown pool member "${name}" in VLLM_SHIM_POOL_MEMBERS; skipping`);
      continue;
    }
    let ip: string;
    try {
      ip = new URL(url).hostname;
    } catch {
      logger.warn(`[VllmPool] unparsable URL for pool member "${name}": ${url}; skipping`);
      continue;
    }
    seen.add(name);
    members.push({ name, url, ip });
  }
  // A spec whose every entry was skipped would leave selection with nothing to
  // pick; fall back to the known-good default rather than crash per request.
  if (members.length === 0 && raw !== DEFAULT_POOL_MEMBERS) {
    return buildPoolMembers(DEFAULT_POOL_MEMBERS, env);
  }
  return members;
}

/**
 * The pool. Route names are legacy and swapped (see UPSTREAMS in
 * VllmShimService): `dell2` reaches physical dellbox1@10.0.0.37 and `dell1`
 * reaches physical dellbox2@10.0.0.131. The `ip` field is the physical truth
 * and is what callers see in `x-pool-box`.
 */
export const POOL_MEMBERS: readonly PoolMember[] = buildPoolMembers(
  process.env.VLLM_SHIM_POOL_MEMBERS,
);

/** Members currently held out of rotation after a failed connect (ms). */
const MEMBER_DOWN_COOLDOWN_MS = 30_000;

/**
 * Consecutive `/v1/models` failures before a member leaves rotation. One ~1.2 s
 * timeout (configurable via `VLLM_SHIM_POOL_PROBE_TIMEOUT_MS`) is not evidence of a dead box: with a single strike, a simultaneous
 * blip on both Dells would otherwise produce a 503 storm while both engines
 * are serving. Two strikes are.
 */
const PROBE_STRIKE_LIMIT = 2;

/** Engine gauge cache lifetime — short on purpose (see module note). */
const GAUGE_TTL_MS = 1_000;

/** Max age before a carried-forward gauge reading from a failing `/metrics` scrape expires back to 0. */
const GAUGE_STALE_MAX_MS = 10_000;

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
  /** Timestamp of the last scrape attempt (controls the 1 s retry TTL). */
  at: number;
  /** Timestamp of the last successful `/metrics` scrape (0 if none / expired). */
  scrapedAt: number;
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
export function resetPoolState(): void {
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
export function poolAffinityKeys(): string[] {
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

function markDown(member: PoolMember, reason: string): void {
  const until = Date.now() + MEMBER_DOWN_COOLDOWN_MS;
  const previous = downUntil.get(member.name) || 0;
  lastFailureAt.set(member.name, Date.now());
  if (previous <= Date.now()) {
    logger.warn(
      `[VllmPool] member "${member.name}" (${member.ip}) out of rotation for ` +
        `${MEMBER_DOWN_COOLDOWN_MS}ms: ${reason}`,
    );
  }
  downUntil.set(member.name, until);
}

/** True while a failed connect has this member out of rotation. */
export function poolMemberDown(member: PoolMember): boolean {
  return (downUntil.get(member.name) || 0) > Date.now();
}

/** Remaining cooldown in ms for a pool member (0 when active). */
export function poolMemberCooldownMs(name: string): number {
  const until = downUntil.get(name) || 0;
  return Math.max(0, until - Date.now());
}

/** Take a member out of rotation after a failed connect (exported for tests). */
export function markPoolMemberDown(name: string): void {
  const member = POOL_MEMBERS.find((m) => m.name === name);
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

function probeTimeoutMs(): number {
  const n = Number(process.env.VLLM_SHIM_POOL_PROBE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1200;
}

function gaugeTimeoutMs(): number {
  const n = Number(process.env.VLLM_SHIM_POOL_GAUGE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 1500;
}

/** Read (and cache for ~1s) one member's engine gauges, preserving the last known reading on failure. */
export async function readGauges(member: PoolMember): Promise<GaugeSample> {
  const cached = gaugeCache.get(member.name);
  if (cached && Date.now() - cached.at < GAUGE_TTL_MS) return cached;
  const pending = gaugePending.get(member.name);
  if (pending) return pending;

  const promise = (async (): Promise<GaugeSample> => {
    try {
      const response = await fetch(`${member.url.replace(/\/$/, "")}/metrics`, {
        signal: AbortSignal.timeout(gaugeTimeoutMs()),
      });
      if (response.ok) {
        const parsed = parsePoolGauges(await response.text());
        const now = Date.now();
        const sample: GaugeSample = { at: now, scrapedAt: now, ...parsed };
        gaugeCache.set(member.name, sample);
        return sample;
      }
    } catch {
      // A gauge scrape failure is not evidence the box is down or idle — fall
      // through to preserve a bounded-age prior reading instead of resetting to 0.
    }
    const now = Date.now();
    const keepPrior =
      cached && cached.scrapedAt > 0 && now - cached.scrapedAt < GAUGE_STALE_MAX_MS;
    const fallback: GaugeSample = keepPrior
      ? { at: now, scrapedAt: cached.scrapedAt, running: cached.running, waiting: cached.waiting }
      : { at: now, scrapedAt: 0, running: 0, waiting: 0 };
    gaugeCache.set(member.name, fallback);
    return fallback;
  })().finally(() => gaugePending.delete(member.name));

  gaugePending.set(member.name, promise);
  return promise;
}

/** Probe one member's `/v1/models` for liveness and its served model id. */
async function probeHealth(member: PoolMember): Promise<HealthSample> {
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
        signal: AbortSignal.timeout(probeTimeoutMs()),
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
  member: PoolMember;
  /** Chosen member first, then other live members of the same model (failover order). */
  candidates: PoolMember[];
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
export async function selectPoolMember(req: PoolRequestShape): Promise<PoolSelection> {
  // Health probes and gauge scrapes are independent: run them together so a
  // cold cache costs one round (~1.5 s max under default timeouts), not two sequential ones.
  const [health, gauges] = await Promise.all([
    Promise.all(POOL_MEMBERS.map((m) => probeHealth(m))),
    Promise.all(POOL_MEMBERS.map((m) => readGauges(m))),
  ]);
  const loads: Record<string, number> = {};
  POOL_MEMBERS.forEach((m, i) => {
    loads[m.name] = gauges[i].running + gauges[i].waiting + (inFlight.get(m.name) || 0);
  });
  const sessionKey = poolSessionKey(req);

  const live = POOL_MEMBERS.filter((_, i) => health[i].up);
  if (live.length === 0) {
    // Every member is out of rotation. Still try the least recently failed
    // one: both engines can be serving while both probes blipped, and a 503
    // storm would be worse than one attempt against a possibly-live box.
    const fallback = POOL_MEMBERS.reduce((a, b) =>
      (lastFailureAt.get(a.name) ?? 0) <= (lastFailureAt.get(b.name) ?? 0) ? a : b,
    );
    logger.warn(
      `[VllmPool] every member is out of rotation; trying the least recently ` +
        `failed one (${fallback.name} / ${fallback.ip}) instead of shedding the request`,
    );
    acquirePoolInFlight(fallback.name);
    return { member: fallback, candidates: [fallback], loads, sessionKey };
  }

  // Group by model id; prefer a live member with a known model over a single-strike unknown one.
  const requestedModel = req.body?.model;
  const requested = typeof requestedModel === "string" ? requestedModel : null;
  const knownLive = live.find((m) => health[POOL_MEMBERS.indexOf(m)].model !== null);
  const firstModel = knownLive ? health[POOL_MEMBERS.indexOf(knownLive)].model : null;
  const targetModel =
    requested && live.some((m) => health[POOL_MEMBERS.indexOf(m)].model === requested)
      ? requested
      : firstModel;

  let candidates =
    targetModel === null
      ? [...live]
      : live.filter((m) => health[POOL_MEMBERS.indexOf(m)].model === targetModel);
  if (candidates.length === 0) candidates = [...live];

  const minLoad = Math.min(...candidates.map((m) => loads[m.name]));

  let chosen: PoolMember | undefined;
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

export interface PoolMemberStats {
  name: string;
  ip: string;
  up: boolean;
  model: string | null;
  running: number | null;
  waiting: number | null;
  inFlight: number;
  served: number;
}

export interface PoolStats {
  route: string;
  members: PoolMemberStats[];
  served: Record<string, number>;
}

/** Snapshot for `/health` and logs: which box served how much, and current load. */
export function poolStats(): PoolStats {
  const now = Date.now();
  return {
    route: "/vllm-shim/qwen",
    members: POOL_MEMBERS.map((m) => {
      const gauge = gaugeCache.get(m.name);
      const freshGauge =
        gauge && gauge.scrapedAt > 0 && now - gauge.scrapedAt < GAUGE_STALE_MAX_MS
          ? gauge
          : null;
      const health = healthCache.get(m.name);
      return {
        name: m.name,
        ip: m.ip,
        up: health ? health.up && !poolMemberDown(m) : !poolMemberDown(m),
        model: health?.model ?? null,
        running: freshGauge?.running ?? null,
        waiting: freshGauge?.waiting ?? null,
        inFlight: inFlight.get(m.name) || 0,
        served: served.get(m.name) || 0,
      };
    }),
    served: Object.fromEntries(POOL_MEMBERS.map((m) => [m.name, served.get(m.name) || 0])),
  };
}
