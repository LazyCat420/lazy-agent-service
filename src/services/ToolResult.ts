/** SWE-agent pattern: silence is ambiguous to LLMs, so an empty observation is
 * replaced with an explicit statement that the tool ran but produced nothing. */
export const EMPTY_TOOL_OUTPUT_MESSAGE =
  "The tool ran successfully and produced no output.";

/** Replace empty/whitespace-only tool output with an explicit no-output message. */
export function normalizeEmptyToolContent<T>(result: T): T {
  if (typeof result === "string" && result.trim() === "") {
    return EMPTY_TOOL_OUTPUT_MESSAGE as unknown as T;
  }
  return result;
}

/** Shared transport/cache failure classification. Empty successful results stay successful. */
export function classifyToolResult(result: unknown): {
  success: boolean;
  errorMessage?: string;
} {
  let value: unknown = result;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return { success: true };
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { success: true };
    }
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { success: true };
  }

  const record = value as Record<string, unknown>;
  const hasErrorKey =
    record.error !== undefined && record.error !== null && record.error !== false;
  const hasIsErrorFlag = record.is_error === true || record.isError === true;
  const hasErrorStatus = record.status === "error" || record.success === false;

  if (!hasErrorKey && !hasIsErrorFlag && !hasErrorStatus) {
    return { success: true };
  }

  let errorMessage: string;
  if (typeof record.error === "string" && record.error) {
    errorMessage = record.error;
  } else if (
    typeof record.error === "object" &&
    record.error !== null &&
    typeof (record.error as Record<string, unknown>).message === "string"
  ) {
    errorMessage = (record.error as Record<string, unknown>).message as string;
  } else if (typeof record.message === "string" && record.message) {
    errorMessage = record.message;
  } else {
    errorMessage = "tool_returned_error";
  }

  return { success: false, errorMessage };
}
