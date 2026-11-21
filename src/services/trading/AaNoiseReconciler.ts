import type {
  AaNoiseMetrics,
  ExtractedFact,
  ResearchExtractionOutput,
} from "./types.ts";

export interface ReconcileInput {
  boxA: string;
  boxB: string;
  modelId: string;
  modelA?: string;
  modelB?: string;
  sameBoxFallback: boolean;
  outputA: ResearchExtractionOutput;
  outputB: ResearchExtractionOutput;
}

export interface ReconciledResearch {
  corroboratedFacts: ExtractedFact[];
  uncorroboratedFacts: ExtractedFact[];
  catalysts: string[];
  risks: string[];
  dataGaps: string[];
  summary: string;
  metrics: AaNoiseMetrics;
}

function round4(val: number): number {
  return Math.round(val * 10_000) / 10_000;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? round4(sorted[mid])
    : round4((sorted[mid - 1] + sorted[mid]) / 2);
}

function factKey(f: ExtractedFact): string {
  const metricSlug = (f.metric || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return `${(f.fact_id || "").trim()}::${(f.category || "").toLowerCase()}::${metricSlug}`;
}

function mergeUniqueText(listA: string[], listB: string[]): string[] {
  const seen = new Map<string, string>();
  for (const item of [...listA, ...listB]) {
    const clean = item.trim();
    const key = clean.toLowerCase();
    if (clean && !seen.has(key)) seen.set(key, clean);
  }
  return [...seen.values()];
}

function computeJaccard(factsA: ExtractedFact[], factsB: ExtractedFact[]): number {
  const setA = new Set(factsA.map((f) => f.fact_id.trim()).filter(Boolean));
  const setB = new Set(factsB.map((f) => f.fact_id.trim()).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const id of setA) {
    if (setB.has(id)) inter += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return round4(inter / Math.max(1, union));
}

function pairSeedFacts(
  factsA: ExtractedFact[],
  factsB: ExtractedFact[],
): {
  corroboratedFacts: ExtractedFact[];
  uncorroboratedFacts: ExtractedFact[];
  spreads: number[];
  dedupCountA: number;
  dedupCountB: number;
  dedupListA: ExtractedFact[];
  dedupListB: ExtractedFact[];
} {
  const mapA = new Map<string, ExtractedFact>();
  const mapB = new Map<string, ExtractedFact>();
  for (const f of factsA) mapA.set(factKey(f), f);
  for (const f of factsB) mapB.set(factKey(f), f);

  const dedupListA = [...mapA.values()];
  const dedupListB = [...mapB.values()];
  const corroboratedFacts: ExtractedFact[] = [];
  const uncorroboratedFacts: ExtractedFact[] = [];
  const spreads: number[] = [];

  for (const [k, fa] of mapA) {
    const fb = mapB.get(k);
    if (fb) {
      if (typeof fa.raw_number === "number" && typeof fb.raw_number === "number") {
        const denom = Math.max(Math.abs(fb.raw_number), 1e-9);
        spreads.push(Math.abs(fa.raw_number - fb.raw_number) / denom);
      }
      corroboratedFacts.push({ ...fa, uncorroborated: false });
      mapB.delete(k);
    } else {
      uncorroboratedFacts.push({ ...fa, uncorroborated: true });
    }
  }
  for (const fb of mapB.values()) {
    uncorroboratedFacts.push({ ...fb, uncorroborated: true });
  }
  return {
    corroboratedFacts,
    uncorroboratedFacts,
    spreads,
    dedupCountA: dedupListA.length,
    dedupCountB: dedupListB.length,
    dedupListA,
    dedupListB,
  };
}

/**
 * Reconcile two identical-prompt A/A extractions across `gold-spark` and
 * `dell2` (`aa_noise_band` style). Logs `fact_flip_share` and isolates single-seed
 * claims (`uncorroborated: true`) for downstream ledger verification and pruning.
 */
export function reconcileAaExtractions(input: ReconcileInput): ReconciledResearch {
  const factsA = input.outputA.facts || [];
  const factsB = input.outputB.facts || [];
  const {
    corroboratedFacts,
    uncorroboratedFacts,
    spreads,
    dedupCountA,
    dedupCountB,
    dedupListA,
    dedupListB,
  } = pairSeedFacts(factsA, factsB);

  const totalCount = dedupCountA + dedupCountB;
  const flipShare =
    totalCount === 0 ? 0 : round4(Math.max(0, 1 - (2 * corroboratedFacts.length) / totalCount));
  const modelA = input.modelA || input.modelId;
  const modelB = input.modelB || input.modelId;
  const modelMismatch = Boolean(input.modelA && input.modelB && input.modelA !== input.modelB);

  return {
    corroboratedFacts,
    uncorroboratedFacts,
    catalysts: mergeUniqueText(input.outputA.catalysts || [], input.outputB.catalysts || []),
    risks: mergeUniqueText(input.outputA.risks || [], input.outputB.risks || []),
    dataGaps: mergeUniqueText(input.outputA.data_gaps || [], input.outputB.data_gaps || []),
    summary: (input.outputA.summary || input.outputB.summary || "").trim(),
    metrics: {
      box_a: input.boxA,
      box_b: input.boxB,
      model_id: input.modelId,
      model_a: modelA,
      model_b: modelB,
      model_mismatch: modelMismatch,
      same_box_fallback: input.sameBoxFallback,
      fact_flip_share: flipShare,
      citation_jaccard: computeJaccard(dedupListA, dedupListB),
      numeric_rel_spread_median: median(spreads),
      count_a: dedupCountA,
      count_b: dedupCountB,
      corroborated_count: corroboratedFacts.length,
      uncorroborated_count: uncorroboratedFacts.length,
    },
  };
}
