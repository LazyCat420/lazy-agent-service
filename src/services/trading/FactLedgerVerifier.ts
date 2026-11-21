import type { ExtractedFact, FactMismatch, FactVerificationResult, LedgerEntry } from "./types.ts";

const ISO_DATE_RE = /\b\d{4}-\d{1,2}-\d{1,2}(?:[T ][0-9:.Z+-]+)?\b/g;
const NUM_RE = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;
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
    const matches = cleaned.match(NUM_RE);
    if (matches) {
      for (const token of matches) {
        const parsed = Number(token.replace(/,/g, ""));
        if (Number.isFinite(parsed)) out.push(parsed);
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
      const scale = Math.max(Math.abs(ref), 1);
      if (diff <= 0.02 || diff / scale <= 0.01) return true;
    }
  }
  return false;
}

function parseScalarValueNumber(value: string): { num: number; isPercent: boolean } | null {
  const trimmed = (value || "").trim().replace(ISO_DATE_RE, " ");
  if (!trimmed) return null;
  const m = trimmed.match(/^[$€£]?\s*([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(%|x|B|M|K)?$/i);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) return null;
  return { num, isPercent: m[2] === "%" };
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
  const fieldSpecific = extractMatchedFieldNumbers(entry.raw, fact.metric);
  const ledgerNumbers: number[] = [];
  if (fieldSpecific) {
    ledgerNumbers.push(...fieldSpecific);
  } else {
    extractNumbersFromUnknown(entry.summary, ledgerNumbers);
    extractNumbersFromUnknown(entry.raw, ledgerNumbers);
  }
  const allowPctScale = Boolean(parsedValue?.isPercent || fact.value.includes("%"));
  if (!numbersMatchWithinTolerance(candidateNum, ledgerNumbers, allowPctScale)) {
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
  ledgerById: Record<string, LedgerEntry>,
): FactMismatch | null {
  const wantTicker = deskTicker.trim().toUpperCase();
  const factId = (fact.fact_id || "").trim();
  const entry = Object.hasOwn(ledgerById, factId) ? ledgerById[factId] : undefined;
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
 * ledger entry and fact ticker match, and numeric values (preferring metric-matched
 * structured raw fields and excluding date tokens).
 */
export function verifyFactsAgainstLedger(
  facts: ExtractedFact[],
  deskTicker: string,
  ledgerEntries: Record<string, LedgerEntry>,
): FactVerificationResult {
  const verifiedFacts: ExtractedFact[] = [];
  const invalidFacts: ExtractedFact[] = [];
  const mismatches: FactMismatch[] = [];

  for (const fact of facts) {
    const mismatch = verifySingleFact(fact, deskTicker, ledgerEntries);
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
