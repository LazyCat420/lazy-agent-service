import type { ToolCallSpec } from "./types.ts";

const PLACEHOLDER_REGEX = /\{\{tool_output:([^}]+)\}\}/g;
const MAX_SUBSTITUTION_CHARS = 32_768;

function resolveJsonPath(rawJson: string, fieldPath: string): string {
  let current: unknown;
  try {
    current = JSON.parse(rawJson);
  } catch {
    return rawJson;
  }

  const segments = fieldPath
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  for (const seg of segments) {
    if (current === null || current === undefined) return "";
    if (Array.isArray(current)) {
      const idx = Number.parseInt(seg, 10);
      if (Number.isNaN(idx)) return "";
      current = current[idx];
    } else if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return String(current);
    }
  }

  if (current === null || current === undefined) return "";
  if (typeof current === "object") return JSON.stringify(current);
  return String(current);
}

function substituteValue(
  value: unknown,
  outputByRef: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    if (!value.includes("{{tool_output:")) return value;
    return value.replace(PLACEHOLDER_REGEX, (fullMatch: string, expr: string) => {
      const dotIdx = expr.indexOf(".");
      const refKey = dotIdx === -1 ? expr.trim() : expr.slice(0, dotIdx).trim();
      const fieldPath = dotIdx === -1 ? null : expr.slice(dotIdx + 1).trim();

      const rawOutput = outputByRef.get(refKey);
      if (rawOutput === undefined) {
        return fullMatch;
      }

      let resolved = fieldPath ? resolveJsonPath(rawOutput, fieldPath) : rawOutput;
      if (resolved.length > MAX_SUBSTITUTION_CHARS) {
        resolved =
          resolved.slice(0, MAX_SUBSTITUTION_CHARS) + "\n...[truncated]";
      }
      return resolved;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => substituteValue(item, outputByRef));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substituteValue(v, outputByRef);
    }
    return out;
  }

  return value;
}

/**
 * H7: Zero-Token Tool-Output Placeholder Substitution.
 *
 * Resolves `{{tool_output:<call_id>}}`, `{{tool_output:<tool_name>}}`, and
 * `{{tool_output:<ref>.field.path}}` placeholders in a `ToolCallSpec`'s
 * arguments against completed tool outputs from earlier turns or batches.
 */
export function substituteToolCallPlaceholders(
  call: ToolCallSpec,
  outputByRef: ReadonlyMap<string, string>,
): ToolCallSpec {
  if (outputByRef.size === 0 || !call.args || typeof call.args !== "object") {
    return call;
  }
  const serialized = JSON.stringify(call.args);
  if (!serialized.includes("{{tool_output:")) {
    return call;
  }
  const substitutedArgs = substituteValue(call.args, outputByRef) as Record<
    string,
    unknown
  >;
  return {
    ...call,
    args: substitutedArgs,
  };
}

export function substituteToolBatchPlaceholders(
  calls: ToolCallSpec[],
  outputByRef: ReadonlyMap<string, string>,
): ToolCallSpec[] {
  if (outputByRef.size === 0 || calls.length === 0) return calls;
  return calls.map((c) => substituteToolCallPlaceholders(c, outputByRef));
}
