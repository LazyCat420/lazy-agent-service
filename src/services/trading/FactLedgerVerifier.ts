import type { ExtractedFact, FactMismatch, FactVerificationResult, LedgerEntry } from "./types.ts";

const ISO_DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ][0-9:.Z+-]+)?\b/g;
const UNIT_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
};
const NUM_WITH_UNIT_RE = /([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*([TBMK])?(?![a-zA-Z])/gi;
const NUMERIC_CATEGORIES = new Set(["price", "valuation", "fundamental", "technical"]);

function normalizeKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function extractNumbersFromUnknown(value: unknown, out: number[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(ISO_DATE_RE, " ");
    for (const match of cleaned.matchAll(NUM_WITH_UNIT_RE)) {
      const parsed = Number(match[1].replace(/,/g, ""));
      if (!Number.isFinite(parsed)) continue;
      out.push(parsed);
      const mult = match[2] ? UNIT_MULTIPLIERS[match[2].toLowerCase()] : undefined;
      if (mult && Number.isFinite(parsed * mult)) {
        out.push(parsed * mult);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractNumbersFromUnknown(item, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      extractNumbersFromUnknown(v, out, depth + 1);
    }
  }
}

function extractMatchedFieldNumbers(raw: unknown, metric: string): number[] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const target = normalizeKey(metric);
  if (!target) return null;
  const record = raw as Record<string, unknown>;
  const matched: number[] = [];
  let foundKey = false;
  for (const [k, v] of Object.entries(record)) {
    const nk = normalizeKey(k);
    if (
      nk === target ||
      nk.startsWith(`${target}pct`) ||
      target.startsWith(`${nk}pct`) ||
      (target === "lastclose" && (nk === "close" || nk === "price" || nk === "lastprice"))
    ) {
      foundKey = true;
      extractNumbersFromUnknown(v, matched);
    }
  }
  return foundKey && matched.length > 0 ? matched : null;
}

function numbersMatchWithinTolerance(
  candidate: number,
  ledgerNumbers: number[],
  allowPctScale: boolean,
): boolean {
  const scaledCandidates = allowPctScale ? [candidate, candidate / 100, candidate * 100] : [candidate];
  for (const target of scaledCandidates) {
    for (const ref of ledgerNumbers) {
      const diff = Math.abs(target - ref);
      if (diff <= 1e-4) return true;
      const refAbs = Math.abs(ref);
      if (refAbs > 0 && diff / refAbs <= 0.01) return true;
    }
  }
  return false;
}

function metricReferencedInText(metric: string, text: string | undefined): boolean {
  const normText = normalizeKey(text || "");
  if (!normText) return false;
  const parts = metric
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((p) => p.length >= 2);
  if (parts.length === 0) return false;
  return parts.some((p) => normText.includes(p));
}

function verifyRawAndValueConsistency(
  factId: string,
  fact: ExtractedFact,
  parsedValue: { num: number; isPercent: boolean } | null,
): FactMismatch | null {
  if (
    typeof fact.raw_number !== "number" ||
    !Number.isFinite(fact.raw_number) ||
    parsedValue === null
  ) {
    return null;
  }
  const allowPctScale = parsedValue.isPercent || (fact.value || "").includes("%");
  if (!numbersMatchWithinTolerance(fact.raw_number, [parsedValue.num], allowPctScale)) {
    return {
      fact_id: factId,
      reason: "number_mismatch",
      detail: `Fact value '${fact.value}' contradicts raw_number=${fact.raw_number} (${fact.metric})`,
    };
  }
  return null;
}

function collectCandidateLedgerNumbers(
  metric: string,
  category: ExtractedFact["category"],
  entry: LedgerEntry,
): { numbers: number[]; missingRequiredFieldMatch: boolean } {
  const fieldSpecific = extractMatchedFieldNumbers(entry.raw, metric);
  if (fieldSpecific) {
    return { numbers: fieldSpecific, missingRequiredFieldMatch: false };
  }
  const hasStructuredRaw =
    Boolean(entry.raw) && typeof entry.raw === "object" && !Array.isArray(entry.raw) &&
    Object.keys(entry.raw as Record<string, unknown>).length > 0;
  if (hasStructuredRaw && NUMERIC_CATEGORIES.has(category) && !metricReferencedInText(metric, entry.summary)) {
    return { numbers: [], missingRequiredFieldMatch: true };
  }
  const ledgerNumbers: number[] = [];
  extractNumbersFromUnknown(entry.summary, ledgerNumbers);
  if (!hasStructuredRaw) {
    extractNumbersFromUnknown(entry.raw, ledgerNumbers);
  }
  return { numbers: ledgerNumbers, missingRequiredFieldMatch: false };
}

function parseScalarValueNumber(value: string): { num: number; isPercent: boolean } | null {
  const trimmed = (value || "").trim().replace(ISO_DATE_RE, " ");
  if (!trimmed) return null;
  const m = trimmed.match(/^[$€£]?\s*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(%|x|T|B|M|K)?$/i);
  if (!m) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const suffix = (m[2] || "").toLowerCase();
  const mult = suffix ? UNIT_MULTIPLIERS[suffix] : undefined;
  const num = typeof mult === "number" ? base * mult : base;
  if (!Number.isFinite(num)) return null;
  return { num, isPercent: suffix === "%" };
}

function verifyTickerMatch(
  factId: string,
  fact: ExtractedFact,
  entry: LedgerEntry,
  wantTicker: string,
): FactMismatch | null {
  const entryTicker = (entry.ticker || "").trim().toUpperCase();
  if (entryTicker && entryTicker !== wantTicker) {
    return {
      fact_id: factId,
      reason: "ticker_mismatch",
      detail: `Ledger entry '${factId}' belongs to '${entryTicker}', not desk ticker '${wantTicker}'`,
    };
  }
  const factTicker = (fact.ticker || "").trim().toUpperCase();
  if (!factTicker || factTicker !== wantTicker) {
    return {
      fact_id: factId,
      reason: "ticker_mismatch",
      detail: factTicker
        ? `Fact ticker '${factTicker}' does not match desk ticker '${wantTicker}'`
        : `Fact '${factId}' omits required ticker '${wantTicker}'`,
    };
  }
  return null;
}

function verifyNumericClaim(
  factId: string,
  fact: ExtractedFact,
  entry: LedgerEntry,
): FactMismatch | null {
  const parsedValue = parseScalarValueNumber(fact.value);
  const consistencyMismatch = verifyRawAndValueConsistency(factId, fact, parsedValue);
  if (consistencyMismatch) return consistencyMismatch;

  const candidateNum =
    typeof fact.raw_number === "number" && Number.isFinite(fact.raw_number)
      ? fact.raw_number
      : parsedValue?.num ?? null;
  const expectsNumeric =
    NUMERIC_CATEGORIES.has(fact.category) || /\d/.test((fact.value || "").replace(ISO_DATE_RE, " "));
  if (candidateNum === null) {
    return expectsNumeric
      ? {
          fact_id: factId,
          reason: "number_mismatch",
          detail: `Numeric ${fact.category} claim '${fact.metric}' lacks a finite raw_number or parseable scalar value`,
        }
      : null;
  }
  const { numbers, missingRequiredFieldMatch } = collectCandidateLedgerNumbers(fact.metric, fact.category, entry);
  if (missingRequiredFieldMatch) {
    return {
      fact_id: factId,
      reason: "number_mismatch",
      detail: `Metric '${fact.metric}' not matched in structured ledger entry ${factId}`,
    };
  }
  const allowPctScale = Boolean(parsedValue?.isPercent || fact.value.includes("%"));
  if (!numbersMatchWithinTolerance(candidateNum, numbers, allowPctScale)) {
    return {
      fact_id: factId,
      reason: "number_mismatch",
      detail: `Number ${candidateNum} (${fact.metric}) not found within tolerance in ledger entry ${factId}`,
    };
  }
  return null;
}

function verifySingleFact(
  fact: ExtractedFact,
  deskTicker: string,
  ledgerByFactId: Map<string, LedgerEntry>,
): FactMismatch | null {
  const wantTicker = deskTicker.trim().toUpperCase();
  const factId = (fact.fact_id || "").trim();
  const entry = factId ? ledgerByFactId.get(factId) : undefined;
  if (!entry) {
    return {
      fact_id: factId || "(empty)",
      reason: "unknown_fact_id",
      detail: `Fact ID '${factId}' does not exist in whiteboard_ledger`,
    };
  }
  return verifyTickerMatch(factId, fact, entry, wantTicker) ?? verifyNumericClaim(factId, fact, entry);
}

/**
 * Deterministic zero-token verifier comparing extracted facts against raw
 * `whiteboard_ledger` entries (`fct_<sha1>`). Verifies fact_id existence, exact
 * ledger entry and fact ticker match, raw_number/value consistency, and numeric
 * values (requiring metric-matched raw or summary evidence and excluding date tokens).
 */
export function verifyFactsAgainstLedger(
  facts: ExtractedFact[],
  deskTicker: string,
  ledgerEntries: Record<string, LedgerEntry>,
): FactVerificationResult {
  const verifiedFacts: ExtractedFact[] = [];
  const invalidFacts: ExtractedFact[] = [];
  const mismatches: FactMismatch[] = [];
  const byFactId = new Map<string, LedgerEntry>();
  for (const [key, entry] of Object.entries(ledgerEntries || {})) {
    if (!entry) continue;
    const fid = (entry.fact_id || key).trim();
    if (fid) byFactId.set(fid, entry);
  }

  for (const fact of facts) {
    const mismatch = verifySingleFact(fact, deskTicker, byFactId);
    if (mismatch) {
      invalidFacts.push(fact);
      mismatches.push(mismatch);
    } else {
      verifiedFacts.push(fact);
    }
  }

  return {
    verifiedFacts,
    invalidFacts,
    mismatches,
    hallucinationCount: mismatches.length,
  };
}
