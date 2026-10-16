// ported from prism-service src/utils/ToolArgsValidator.ts
import { z } from "zod";

/**
 * Validate a tool call's arguments against the tool's JSON-Schema
 * `parameters` — used when the user edits a call's arguments on its approval
 * card, so a hand-typed call is held to the same contract as a model-typed
 * one before it runs.
 *
 * Built on zod's `fromJSONSchema` (already a dependency). Tool schemas in
 * this codebase sometimes carry Gemini-style upper-case type names
 * ("OBJECT", "STRING"), which JSON Schema does not know; they are lowered
 * first. A schema zod cannot translate falls back to the checks every tool
 * shares: a plain object that carries each `required` key.
 */

export type ToolArgsValidation = { ok: true } | { ok: false; error: string };

interface ParameterSchema {
  type?: unknown;
  properties?: Record<string, unknown>;
  required?: unknown;
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lower-case every `type` (string or string[]) in a schema tree. */
function normalizeTypeNames(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalizeTypeNames);
  if (!isPlainObject(schema)) return schema;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type" && typeof value === "string") {
      normalized[key] = value.toLowerCase();
    } else if (key === "type" && Array.isArray(value)) {
      normalized[key] = value.map((entry) =>
        typeof entry === "string" ? entry.toLowerCase() : entry,
      );
    } else {
      normalized[key] = normalizeTypeNames(value);
    }
  }
  return normalized;
}

function checkRequiredKeys(
  schema: ParameterSchema,
  args: Record<string, unknown>,
): ToolArgsValidation {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter(
    (key) => typeof key === "string" && !(key in args),
  );
  return missing.length > 0
    ? { ok: false, error: `missing required argument(s): ${missing.join(", ")}` }
    : { ok: true };
}

export function validateToolArgs(
  schema: ParameterSchema | null | undefined,
  args: unknown,
): ToolArgsValidation {
  if (!isPlainObject(args)) {
    return { ok: false, error: "arguments must be a JSON object" };
  }
  if (!isPlainObject(schema)) return { ok: true };

  let validator: z.ZodType;
  try {
    validator = z.fromJSONSchema(normalizeTypeNames(schema) as never);
  } catch {
    return checkRequiredKeys(schema, args);
  }

  const parsed = validator.safeParse(args);
  if (parsed.success) return { ok: true };
  const detail = parsed.error.issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
  return { ok: false, error: detail || "arguments do not match the tool's schema" };
}
