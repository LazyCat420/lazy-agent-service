import {
  OffloadStore,
  type OffloadRecord,
} from "./OffloadStore.ts";

// ─────────────────────────────────────────────────────────────
//  OffloadPolicy — bound a tool result for the model's context
//
//  Mirrors prism's truncateToolResult (prism-service
//  src/utils/FunctionCallingUtilities.ts) at the lazy-agent-service
//  budget (7,600 characters, see ModelVisibleToolResult.ts):
//
//   - Within the cap, the result passes through untouched.
//   - A top-level array over 10 items — or an array under one of
//     prism's known wrapper keys — is pre-emptively capped to 10
//     regardless of size, with an offload marker for the rest.
//   - Anything cut is RECOVERABLE: the full result is offloaded to
//     the OffloadStore and the model sees a pointer stub (kept
//     whole leading lines, or shortened strings then lists for
//     JSON) naming retrieve_offloaded_content and the offload_id.
//
//  Deterministic: the same input produces the same model-visible
//  bytes, because the offload_id is derived from the content.
// ─────────────────────────────────────────────────────────────

/** Where we cut the model-visible text (prism's pass-through budget minus headroom). */
export const DEFAULT_OFFLOAD_CAP_CHARS = 7600;
/** prism caps a top-level array, or an array under one of these keys, at 10 items whatever its size. */
export const PRISM_CAPPED_ARRAY_KEYS = [
  "events",
  "products",
  "trends",
  "articles",
  "earnings",
  "predictions",
  "commodities",
];
export const PRISM_ARRAY_ITEMS = 10;
/** Minimum model-visible budget when the note alone is unusually long. */
const MIN_PREVIEW_BUDGET = 200;
/** Strings at or below this length are never shortened (identity is preserved). */
const MIN_STRING_CHARS = 120;
/** Slack added when shortening a string, so escaped characters cannot keep it over budget. */
const SHORTEN_SLACK_CHARS = 16;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Stable first line of the appended note — also the idempotency sentinel. */
export const OFFLOAD_STUB_HEADER = "[Tool result offloaded — recoverable]";
/** How the note tells the model to recover the payload; `<id>` is replaced per record. */
const RETRIEVE_HINT =
  'call retrieve_offloaded_content with offload_id "<id>" to retrieve the full result';

export interface OffloadPolicyOptions {
  /** Model-visible character cap (default 7600, prism-compatible). */
  cap?: number;
  /** Tool that produced the result — recorded in the store and shown in the stub. */
  toolName?: string;
  /** Short summary of the call arguments, recorded in the store. */
  argsSummary?: string;
  /** Run the call belongs to, recorded in the store. */
  runId?: string | null;
  /** Store to offload into. Defaults to a process-wide store at data/offload_store/. */
  store?: OffloadStore;
}

export interface OffloadDecision {
  /** Whether the full result was stored and the model sees a cut-down view. */
  offloaded: boolean;
  /** What the model reads: the whole result, or the pointer stub. */
  modelVisible: string;
  /** Content-derived offload_id — present whenever offloaded. */
  offloadId?: string;
}

let defaultStore: OffloadStore | null = null;

/** The process-wide default store (data/offload_store/), created lazily. */
function defaultOffloadStore(): OffloadStore {
  defaultStore ??= new OffloadStore();
  return defaultStore;
}

const pretty = (value: Json) => JSON.stringify(value, null, 2);

/** True for values the JSON paths handle (arrays and plain objects). */
function isJsonContainer(result: unknown): result is Json[] | { [key: string]: Json } {
  return typeof result === "object" && result !== null;
}

/** Whether prism's list cap would fire on this value regardless of its size. */
function tripsListCap(result: Json): boolean {
  if (Array.isArray(result)) return result.length > PRISM_ARRAY_ITEMS;
  if (!result || typeof result !== "object") return false;
  return PRISM_CAPPED_ARRAY_KEYS.some((key) => {
    const items = (result as { [key: string]: Json })[key];
    return Array.isArray(items) && items.length > PRISM_ARRAY_ITEMS;
  });
}

/** The appended note: what was stored, and how to get it back. */
function offloadNote(record: OffloadRecord, totalChars: number): string {
  const lines = record.full_result.split("\n").length;
  return [
    OFFLOAD_STUB_HEADER,
    `offload_id: ${record.offload_id} (${record.tool_name}, ${lines} lines, ${totalChars} characters — too large to include in full)`,
    `[Truncated here — ${RETRIEVE_HINT.replace("<id>", record.offload_id)}.]`,
  ].join("\n");
}

/** Text cut to whole leading lines (or the head of the first line) under the budget. */
function leadingLines(text: string, budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const line of text.split("\n")) {
    if (used + line.length + 1 > budget) {
      if (lines.length === 0) lines.push(`${line.slice(0, Math.max(0, budget))}…`);
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Pre-empt prism's list cap: a top-level array over PRISM_ARRAY_ITEMS items —
 * or an array under a known wrapper key — is capped to 10 items, with an
 * offload marker carrying the offload_id for the rest. Returns `changed` so
 * the caller can skip the re-serialization when nothing tripped.
 */
function capArrays(result: Json, offloadId: string): { value: Json; changed: boolean } {
  const marker = (shown: number, total: number) => ({
    _truncated: `Showing ${shown} of ${total}`,
    offload_id: offloadId,
    retrieve: RETRIEVE_HINT,
  });
  if (Array.isArray(result)) {
    if (result.length <= PRISM_ARRAY_ITEMS) return { value: result, changed: false };
    const capped = result.slice(0, PRISM_ARRAY_ITEMS);
    capped.push(marker(PRISM_ARRAY_ITEMS, result.length));
    return { value: capped, changed: true };
  }
  if (!result || typeof result !== "object") return { value: result, changed: false };
  let changed = false;
  const record = result as { [key: string]: Json };
  for (const key of PRISM_CAPPED_ARRAY_KEYS) {
    const items = record[key];
    if (!Array.isArray(items) || items.length <= PRISM_ARRAY_ITEMS) continue;
    if (!changed) {
      changed = true;
      record._offload = { offload_id: offloadId, retrieve: RETRIEVE_HINT };
    }
    record[key] = items.slice(0, PRISM_ARRAY_ITEMS);
    record[`_${key}Truncated`] = `Showing ${PRISM_ARRAY_ITEMS} of ${items.length}`;
  }
  return { value: changed ? record : result, changed };
}

/** A mutable slot holding a string somewhere in the tree. */
interface StringSlot {
  get: () => string;
  set: (s: string) => void;
  len: number;
}

/** Locate the longest string leaf over `minLen`, with read/write access to its slot. */
function longestStringSlot(value: Json, minLen: number): StringSlot | null {
  let best: StringSlot | null = null;
  const visit = (node: Json, slot: StringSlot | null): void => {
    if (typeof node === "string") {
      if (node.length > minLen && (!best || node.length > best.len)) best = slot;
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, index) => {
        visit(item, {
          get: () => node[index] as string,
          set: (s) => { node[index] = s; },
          len: typeof item === "string" ? item.length : 0,
        });
      });
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const item = (node as { [key: string]: Json })[key];
        visit(item, {
          get: () => (node as { [key: string]: Json })[key] as string,
          set: (s) => { (node as { [key: string]: Json })[key] = s; },
          len: typeof item === "string" ? item.length : 0,
        });
      }
    }
  };
  visit(value, null);
  return best;
}

/** A mutable slot holding an array somewhere in the tree. */
interface ArraySlot {
  get: () => Json[];
  set: (items: Json[]) => void;
  len: number;
}

/** Locate the longest array leaf over one item, with read/write access to its slot. */
function longestArraySlot(value: Json): ArraySlot | null {
  let best: ArraySlot | null = null;
  const visit = (node: Json, slot: ArraySlot | null): void => {
    if (Array.isArray(node)) {
      if (node.length > 1 && (!best || node.length > best.len)) best = slot;
      node.forEach((item, index) => {
        visit(item, {
          get: () => node[index] as Json[],
          set: (items) => { node[index] = items; },
          len: Array.isArray(item) ? item.length : 0,
        });
      });
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        const item = (node as { [key: string]: Json })[key];
        visit(item, {
          get: () => (node as { [key: string]: Json })[key] as Json[],
          set: (items) => { (node as { [key: string]: Json })[key] = items; },
          len: Array.isArray(item) ? item.length : 0,
        });
      }
    }
  };
  visit(value, null);
  return best;
}

/**
 * A JSON value shortened until its pretty-printed form fits `budget`:
 * first the longest strings (leading characters kept — identity preserved,
 * keys never dropped), then the longest lists (leading items kept). Returns
 * null when nothing can give way — the caller falls back to a text preview.
 */
function fitJson(root: Json, budget: number): Json | null {
  let value = root;
  for (;;) {
    const size = pretty(value).length;
    if (size <= budget) return value;
    const over = size - budget;
    const stringSlot = longestStringSlot(value, MIN_STRING_CHARS);
    if (stringSlot) {
      const current = stringSlot.get();
      const cutTo = Math.max(MIN_STRING_CHARS, current.length - over - SHORTEN_SLACK_CHARS);
      stringSlot.set(`${current.slice(0, cutTo)}…`);
      continue;
    }
    const arraySlot = longestArraySlot(value);
    if (!arraySlot) return null;
    const perItem = Math.max(1, Math.floor(size / arraySlot.len));
    const drop = Math.min(arraySlot.len - 1, Math.max(1, Math.ceil(over / perItem)));
    arraySlot.set(arraySlot.get().slice(0, arraySlot.len - drop));
  }
}

export class OffloadPolicy {
  /**
   * Bound a tool result for the model's context window. Within the cap the
   * result passes through untouched; anything cut is offloaded to the store
   * and the model sees a recoverable pointer stub instead.
   */
  static async apply(
    result: unknown,
    options: OffloadPolicyOptions = {},
  ): Promise<OffloadDecision> {
    const cap = options.cap ?? DEFAULT_OFFLOAD_CAP_CHARS;
    const text =
      typeof result === "string"
        ? result
        : isJsonContainer(result)
          ? pretty(result as Json)
          : String(result);

    // prism caps over-long lists whatever their size: pre-empt it even when
    // the serialized result would fit the character budget.
    if (text.length <= cap && !(isJsonContainer(result) && tripsListCap(result as Json))) {
      return { offloaded: false, modelVisible: text };
    }

    const store = options.store ?? defaultOffloadStore();
    const record = await store.put({
      tool_name: options.toolName ?? "tool_result",
      args_summary: options.argsSummary ?? "",
      full_result: text,
      run_id: options.runId ?? null,
    });
    const note = offloadNote(record, text.length);
    const budget = Math.max(MIN_PREVIEW_BUDGET, cap - note.length - 2);

    if (isJsonContainer(result)) {
      const parsed = JSON.parse(record.full_result) as Json;
      const { value: capped, changed } = capArrays(parsed, record.offload_id);
      if (changed && pretty(capped).length <= budget) {
        return {
          offloaded: true,
          modelVisible: `${pretty(capped)}\n\n${note}`,
          offloadId: record.offload_id,
        };
      }
      const fitted = fitJson(capped, budget);
      if (fitted !== null) {
        return {
          offloaded: true,
          modelVisible: `${pretty(fitted)}\n\n${note}`,
          offloadId: record.offload_id,
        };
      }
    }

    return {
      offloaded: true,
      modelVisible: `${leadingLines(record.full_result, budget)}\n\n${note}`,
      offloadId: record.offload_id,
    };
  }
}
