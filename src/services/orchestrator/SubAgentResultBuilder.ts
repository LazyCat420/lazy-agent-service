import type {
  SubAgentResult,
  SubAgentState,
  SubtreeMetrics,
  SubAgentChildSummary,
} from "../../types/orchestrator.ts";
import type { ConversationMessage } from "../harnesses/types.ts";

/*
 * Extract the text content from the last assistant message in a conversation.
 * Mirrors Claude Code's finalizeAgentTool pattern — only the final report is
 * returned to the orchestrator, keeping the parent context clean.
 *
 * If the last assistant message has no text (e.g. it was a pure tool_use),
 * walks backward to find the most recent assistant message with text.
 */
export function getLastAssistantText(messages: ConversationMessage[]): string {
  if (!messages?.length) return "";
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = (
      typeof message.content === "string" ? message.content : ""
    ).trim();
    if (text) return text;
    // Extract text blocks from Anthropic structured array format, ignoring thinking and tool_use blocks.
    if (Array.isArray(message.content)) {
      const textBlocks = message.content
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            "type" in block &&
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (textBlocks) return textBlocks;
    }
    // Fallback: harnesses store segmented output in textFragments when content
    // is split across interleaved tool-call turns. Join them as a last resort.
    if (Array.isArray(message.textFragments) && message.textFragments.length > 0) {
      const joined = message.textFragments
        .filter((fragment): fragment is string => typeof fragment === "string")
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

/*
 * Helper to estimate tokens from accumulated characters.
 * Falls back to chars/4 estimation from accumulated characters.
 */
export function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4);
}

export function buildSubAgentResult(subAgent: SubAgentState): SubAgentResult {
  const status = subAgent.status === "complete" ? "completed" : subAgent.status;

  // subAgent.output is set during _runSubAgentLoop from getLastAssistantText()
  // on the live messages array, then falls back to telemetry.output (streamed
  // chunks). subAgent.messages is nulled after the loop to release memory, so
  // we use subAgent.output directly as the primary text source.
  const lastText =
    (subAgent.output || "").trim() ||
    getLastAssistantText(subAgent.messages || []);

  const toolCallCount = subAgent.toolCalls?.length || 0;
  const iterationCount = subAgent.iterations || 0;
  const hasResult = !!lastText;

  // Build a diagnostic summary that explains WHY there's no result when applicable,
  // rather than the unhelpful "Agent X completed" boilerplate that gives no signal.
  const summary = buildDiagnosticSummary(
    status,
    subAgent.description,
    subAgent.error || null,
    hasResult,
    toolCallCount,
    iterationCount,
    subAgent.durationMs || 0,
  );

  // Construct a mapped tool usage count for frontend badge rendering.
  const toolNames: Record<string, number> = {};
  if (subAgent.toolCalls?.length) {
    for (const toolCall of subAgent.toolCalls) {
      const name = toolCall.name || "unknown";
      toolNames[name] = (toolNames[name] || 0) + 1;
    }
  }

  const result: SubAgentResult = {
    agent_id: subAgent.agentId,
    description: subAgent.description,
    status,
    summary,
    result: lastText || null,
    toolUses: toolCallCount,
    toolNames: Object.keys(toolNames).length > 0 ? toolNames : undefined,
    iterations: iterationCount,
    durationMs: subAgent.durationMs || 0,
    // Include full conversation for frontend MessageList rendering.
    // Strip system messages — they're large and not useful for display.
    messages: (subAgent.messages || []).filter(
      (message) => message.role !== "system",
    ),
  };

  if (subAgent.diff?.hasChanges) {
    result.diff = {
      additions: subAgent.diff.additions || 0,
      deletions: subAgent.diff.deletions || 0,
      files: subAgent.diff.files || [],
    };
  }

  // Populate error for both explicit failures AND silent empty-result completions.
  // This ensures the orchestrator LLM receives a machine-readable diagnostic
  // explaining why the sub-agent produced no output — enabling informed retry decisions.
  if (subAgent.error) {
    result.error = subAgent.error;
  } else if (status === "completed" && !hasResult) {
    result.error = buildEmptyResultDiagnostic(toolCallCount, iterationCount, subAgent.durationMs || 0);
  }

  if (typeof subAgent.recursionDepth === "number") {
    result.recursionDepth = subAgent.recursionDepth;
  }

  const subtreeMetrics = extractSubtreeMetrics(subAgent.messages || []);
  if (subtreeMetrics) {
    result.subtreeMetrics = subtreeMetrics;
  }

  return result;
}

function buildDiagnosticSummary(
  status: string,
  description: string,
  error: string | null,
  hasResult: boolean,
  toolCallCount: number,
  iterationCount: number,
  durationMs: number,
): string {
  if (status === "failed") {
    return `Agent "${description}" failed: ${error || "Unknown error"}`;
  }
  if (status === "stopped") {
    return `Agent "${description}" was stopped`;
  }
  if (status === "completed" && hasResult) {
    return `Agent "${description}" completed successfully`;
  }
  // Completed but no result — build an informative diagnostic
  if (status === "completed" && !hasResult) {
    const durationSeconds = (durationMs / 1000).toFixed(1);
    if (toolCallCount === 0 && iterationCount <= 1) {
      return (
        `Agent "${description}" completed but produced no output ` +
        `(0 tool calls, ${iterationCount} iteration, ${durationSeconds}s). ` +
        `The model likely failed to engage with the task — ` +
        `verify the prompt is self-contained and tools are enabled.`
      );
    }
    if (toolCallCount > 0) {
      return (
        `Agent "${description}" completed ${iterationCount} iteration(s) ` +
        `with ${toolCallCount} tool call(s) in ${durationSeconds}s, ` +
        `but did not produce a final text summary. ` +
        `The model may have ended on a tool_use turn without a follow-up response.`
      );
    }
    return (
      `Agent "${description}" completed ${iterationCount} iteration(s) ` +
      `in ${durationSeconds}s but produced no output.`
    );
  }
  return `Agent "${description}" — status: ${status}`;
}

function buildEmptyResultDiagnostic(
  toolCallCount: number,
  iterationCount: number,
  durationMs: number,
): string {
  const durationSeconds = (durationMs / 1000).toFixed(1);
  if (toolCallCount === 0 && iterationCount <= 1) {
    return (
      `Sub-agent produced no output after ${durationSeconds}s ` +
      `(0 tool calls, ${iterationCount} iteration). ` +
      `Probable causes: model did not engage with the task, ` +
      `prompt was not self-contained, or required tools were not enabled.`
    );
  }
  if (toolCallCount > 0) {
    return (
      `Sub-agent executed ${toolCallCount} tool call(s) over ${iterationCount} iteration(s) ` +
      `(${durationSeconds}s) but did not produce a final text response. ` +
      `The model likely ended on a tool_use turn without generating a summary.`
    );
  }
  return (
    `Sub-agent ran ${iterationCount} iteration(s) (${durationSeconds}s) ` +
    `but produced no text output.`
  );
}

/**
 * Build a structured fallback summary from tool-call metadata when the
 * agent's result text is null. Used by PeerToPeerRouter and SequentialRouter
 * to inject at least some useful context into the Shared Discussion Board
 * instead of the useless boilerplate summary ("Agent X completed").
 */
export function buildToolCallFallbackSummary(
  agentResult: SubAgentResult,
): string | null {
  if (agentResult.toolUses === 0 && !agentResult.iterations) return null;

  const toolBreakdown = agentResult.toolNames
    ? Object.entries(agentResult.toolNames)
        .map(([toolName, callCount]) => `${toolName} (${callCount}×)`)
        .join(", ")
    : null;

  const iterationLabel =
    agentResult.iterations === 1
      ? "1 iteration"
      : `${agentResult.iterations} iterations`;

  if (toolBreakdown) {
    return (
      `Agent completed ${iterationLabel} using ${toolBreakdown} ` +
      `but did not produce a final summary.`
    );
  }

  return `Agent completed ${iterationLabel} with ${agentResult.toolUses} tool call(s) but did not produce a final summary.`;
}

interface SerializedSubAgentResult {
  agent_id: string | number;
  status: string;
  description?: string;
  recursionDepth?: number;
  durationMs?: number;
  toolUses?: number;
  result?: string | null;
  error?: string | null;
  subtreeMetrics?: SubtreeMetrics;
}

function isSerializedSubAgentResult(
  value: unknown,
): value is SerializedSubAgentResult {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const hasAgentId =
    typeof candidate['agent_id'] === "string" ||
    typeof candidate['agent_id'] === "number";
  const hasStatus = typeof candidate['status'] === "string";
  return hasAgentId && hasStatus;
}

/**
 * Collect SubAgentResult entries from a raw payload (parsed JSON or live object).
 * Used by both scan passes in extractSubtreeMetrics.
 */
function collectChildSummariesFromPayload(
  payload: unknown,
  childSummaries: SubAgentChildSummary[],
): void {
  const resultsArray: unknown[] = Array.isArray(payload) ? payload : [payload];
  const MAX_RESULT_LENGTH_FOR_PROPAGATION = 2000;

  for (const entry of resultsArray) {
    if (!isSerializedSubAgentResult(entry)) {
      continue;
    }

    const childSummary: SubAgentChildSummary = {
      agent_id: String(entry.agent_id),
      description: entry.description || "",
      status: entry.status,
      recursionDepth: entry.recursionDepth || 0,
      durationMs: entry.durationMs || 0,
      toolUses: entry.toolUses || 0,
      cost: 0,
    };

    if (typeof entry.result === "string" && entry.result.trim()) {
      const trimmedResult = entry.result.trim();
      childSummary.result =
        trimmedResult.length > MAX_RESULT_LENGTH_FOR_PROPAGATION
          ? trimmedResult.slice(0, MAX_RESULT_LENGTH_FOR_PROPAGATION) + "…"
          : trimmedResult;
    } else {
      childSummary.result = null;
    }

    if (typeof entry.error === "string" && entry.error.trim()) {
      childSummary.error = entry.error.trim();
    }

    if (entry.subtreeMetrics) {
      childSummary.subtreeMetrics = entry.subtreeMetrics;
    }

    childSummaries.push(childSummary);
  }
}

/**
 * Scan a sub-agent's conversation for create_team tool results that contain
 * SubAgentResult payloads. When a child agent spawned grandchildren, those
 * results are propagated upward so the parent has full subtree visibility.
 *
 * Two scan passes cover both conversation formats:
 *   1. Anthropic-style: separate `role: "tool"` messages with JSON string content
 *   2. ReAct-style: assistant messages with `toolCalls[].result` objects (our primary format)
 *
 * Paper alignment: THREAD (arXiv:2405.17402) — hierarchical result aggregation.
 */
export function extractSubtreeMetrics(
  messages: ConversationMessage[],
): SubtreeMetrics | null {
  const childSummaries: SubAgentChildSummary[] = [];

  for (const message of messages) {
    // Pass 1: Anthropic-style separate tool_result messages (JSON string content)
    if (message.role === "tool" || message.role === "tool_result") {
      const content = typeof message.content === "string" ? message.content : "";
      if (!content.includes("agent_id")) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        continue;
      }

      collectChildSummariesFromPayload(parsed, childSummaries);
      continue;
    }

    // Pass 2: ReAct-style — tool results stored inline on assistant messages
    // as toolCalls[].result (already-parsed objects, not JSON strings).
    // This is the primary format used by our ReActHarness.
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        if ((toolCall.name !== "create_subagents" && toolCall.name !== "create_subagent") || !toolCall.result) continue;

        // toolCall.result is the raw return value from OrchestratorService.createTeam(),
        // which is SubAgentResult[] — already a parsed object, not a JSON string.
        collectChildSummariesFromPayload(toolCall.result, childSummaries);
      }
    }
  }

  if (childSummaries.length === 0) return null;

  let totalDescendants = 0;
  let maxDepthReached = 0;
  let aggregatedCost = 0;
  let aggregatedDurationMs = 0;
  let aggregatedToolUses = 0;

  for (const child of childSummaries) {
    totalDescendants += 1;
    aggregatedDurationMs += child.durationMs;
    aggregatedToolUses += child.toolUses;
    aggregatedCost += child.cost;
    maxDepthReached = Math.max(maxDepthReached, child.recursionDepth);

    if (child.subtreeMetrics) {
      totalDescendants += child.subtreeMetrics.totalDescendants;
      maxDepthReached = Math.max(
        maxDepthReached,
        child.subtreeMetrics.maxDepthReached,
      );
      aggregatedCost += child.subtreeMetrics.aggregatedCost;
      aggregatedDurationMs += child.subtreeMetrics.aggregatedDurationMs;
      aggregatedToolUses += child.subtreeMetrics.aggregatedToolUses;
    }
  }

  return {
    totalDescendants,
    maxDepthReached,
    aggregatedCost,
    aggregatedDurationMs,
    aggregatedToolUses,
    childResults: childSummaries,
  };
}
