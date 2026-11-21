import type { ExtractedFact, FactMismatch, FactVerificationResult, LedgerEntry } from "./types.ts";

const NUM_RE = /[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g;

function extractNumbersFromUnknown(value: unknown, out: number[], depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "number" && Number.isFinite(value)) {
    out.push(value);
    return;
  }
  if (typeof value === "string") {
    const matches = value.match(NUM_RE);
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

function numbersMatchWithinTolerance(candidate: number, ledgerNumbers: number[]): boolean {
  const scaledCandidates = [candidate, candidate / 100, candidate * 100];
  for (const target of scaledCandidates) {
    for (const ref of ledgerNumbers) {
      const diff = Math.abs(target - ref);
      const scale = Math.max(Math.abs(ref), 1);
      if (diff <= 0.02 || diff / scale <= 0.01) return true;
    }
  }
  return false;
}

function verifySingleFact(
  fact: ExtractedFact,
  deskTicker: string,
  ledgerById: Record<string, LedgerEntry>,
): FactMismatch | null {
  const factId = (fact.fact_id || "").trim();
  const entry = ledgerById[factId];
  if (!entry) {
    return {
      fact_id: factId || "(empty)",
      reason: "unknown_fact_id",
      detail: `Fact ID '${factId}' does not exist in whiteboard_ledger`,
    };
  }
  const factTicker = (fact.ticker || "").trim().toUpperCase();
  if (factTicker && factTicker !== deskTicker.toUpperCase()) {
    return {
      fact_id: factId,
      reason: "ticker_mismatch",
      detail: `Fact ticker '${factTicker}' does not match desk ticker '${deskTicker}'`,
    };
  }
  if (typeof fact.raw_number === "number" && Number.isFinite(fact.raw_number)) {
    const ledgerNumbers: number[] = [];
    extractNumbersFromUnknown(entry.summary, ledgerNumbers);
    extractNumbersFromUnknown(entry.raw, ledgerNumbers);
    if (!numbersMatchWithinTolerance(fact.raw_number, ledgerNumbers)) {
      return {
        fact_id: factId,
        reason: "number_mismatch",
        detail: `Number ${fact.raw_number} not found within tolerance in ledger entry ${factId}`,
      };
    }
  }
  return null;
}

/**
 * Deterministic zero-token verifier comparing extracted facts against raw
 * `whiteboard_ledger` entries (`fct_<sha1>`). Catches invented IDs, wrong-ticker
 * leaks, and numerical hallucinations before LLM criticism or final decisions.
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
