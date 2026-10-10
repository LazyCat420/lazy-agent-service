// ============================================================
// MongoDB query text for traces (db.query.text), with private
// values hidden.
//
// The instrumentation's default replaces EVERY value with "?", so a
// trace shows the query shape but not "limit 20" or "project
// trading". Full reporting would copy usernames, titles, prompts and
// message text into Tempo. This keeps what explains a slow query and
// hides what identifies a person or holds their content:
//
//   shown   numbers, booleans, dates, null, ObjectIds and Longs;
//           field references ("$createdAt"); sort/projection values;
//           the collection name; strings under SAFE_STRING_FIELDS
//   hidden  every other string ("?"), binary data
//
// Operators ($in, $gt, $eq …) inherit their field, so
// { project: { $in: ["a", "b"] } } shows both projects.
// ============================================================

/** Fields whose string values are ids or enums, never user content. */
export const SAFE_STRING_FIELDS = new Set([
  "_id",
  "id",
  "project",
  "agent",
  "type",
  "status",
  "state",
  "role",
  "kind",
  "source",
  "provider",
  "providers",
  "model",
  "modelNames",
  "modalities",
  "conversationId",
  "parentConversationId",
  "parentAgentConversationId",
  "traceId",
  "taskId",
  "runId",
  "toolName",
  "ticker",
  "symbol",
]);

/** Driver and session bookkeeping that says nothing about the query. */
const DROPPED_KEYS = new Set(["lsid", "$clusterTime", "$readPreference", "signature", "txnNumber", "autocommit"]);

const MAX_ARRAY_ITEMS = 20;
const MAX_LENGTH = 4000;
const MAX_DEPTH = 12;

function bsonValue(value: { _bsontype?: string; toHexString?: () => string; toString(): string }): unknown {
  switch (value._bsontype) {
    case "ObjectId":
    case "ObjectID":
      return value.toHexString ? value.toHexString() : String(value);
    case "Long":
    case "Int32":
    case "Double":
    case "Decimal128":
    case "Timestamp":
      return String(value);
    default:
      return "?"; // Binary, Code, UUID…: opaque or content
  }
}

function redact(value: unknown, field: string | null, depth: number): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? String(value) : value;
  }
  if (typeof value === "string") {
    if (value.startsWith("$")) return value; // field reference, e.g. "$createdAt"
    return field !== null && SAFE_STRING_FIELDS.has(field) ? value : "?";
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "?" : value.toISOString();
  if (value instanceof RegExp) return "?"; // a search pattern is user input
  if (depth >= MAX_DEPTH) return "…";
  if (typeof value === "object" && "_bsontype" in (value as object)) {
    return bsonValue(value as never);
  }
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => redact(v, field, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…${value.length - MAX_ARRAY_ITEMS} more`);
    return items;
  }
  // The driver keeps sort (and some options) as a Map; JSON would print {}.
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  const out: Record<string, unknown> = {};
  for (const [rawKey, v] of entries) {
    const key = String(rawKey);
    if (depth === 0 && DROPPED_KEYS.has(key)) continue;
    // An operator keeps the field it applies to: { project: { $in: [...] } }.
    out[key] = redact(v, key.startsWith("$") ? field : key, depth + 1);
  }
  return out;
}

/** dbStatementSerializer for @opentelemetry/instrumentation-mongodb. */
export function serializeMongoCommand(command: Record<string, unknown>): string {
  const entries = Object.entries(command);
  const out: Record<string, unknown> = {};
  entries.forEach(([key, value], index) => {
    if (DROPPED_KEYS.has(key)) return;
    // The first key is the command and its value the collection: { find: "conversations" }.
    if (index === 0 && typeof value === "string") out[key] = value;
    else if (key === "sort" || key === "projection") out[key] = redact(value, null, 1);
    else out[key] = redact(value, null, 1);
  });
  const text = JSON.stringify(out);
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…` : text;
}
