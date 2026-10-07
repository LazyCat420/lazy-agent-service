import type { ConversationMessage } from "./types.ts";

/**
 * RunningSummary — Hermes-pattern running-summary discipline.
 *
 * The model maintains a cumulative `<running_summary>` block of prior
 * findings, re-emitted (updated) each turn. After every tool observation
 * the harness extracts the newest block from the conversation and injects
 * it into the system prompt, replacing the stale one — so accumulated
 * findings survive even when the raw turns scroll out of the context
 * window. Pure functions; exported for tests.
 *
 * Reference: docs/harness-research/PLAN_hermes.md §3.
 */

export const RUNNING_SUMMARY_TAG_PATTERN = /<running_summary>([\s\S]*?)<\/running_summary>/;

/** Prompt section teaching the running-summary discipline. */
export const RUNNING_SUMMARY_INSTRUCTIONS = `Maintain a cumulative memory of your work in a <running_summary> block, emitted at the end of every reply that follows a tool result:
<running_summary>
A short synthesis of findings, decisions and open questions so far. Update it each turn — never a raw copy of tool output.
</running_summary>
The newest <running_summary> is carried forward into your context automatically; older ones are discarded. Keep it under 15 lines.`;

/** Extract the content of the LAST `<running_summary>` block in a text. */
export function extractRunningSummary(text: string): string | null {
  const matches = [...text.matchAll(new RegExp(RUNNING_SUMMARY_TAG_PATTERN.source, "g"))];
  const last = matches.at(-1);
  return last ? last[1].trim() : null;
}

/**
 * Extract the newest `<running_summary>` block from the conversation,
 * scanning newest-first. System messages are skipped — the harness itself
 * injects the carried-forward summary there, and that copy must never win
 * over (or echo back as) a model-emitted block.
 */
export function extractLatestRunningSummary(
  messages: ReadonlyArray<Pick<ConversationMessage, "role" | "content">>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role === "system") continue;
    if (typeof message.content !== "string") continue;
    const summary = extractRunningSummary(message.content);
    if (summary !== null) return summary;
  }
  return null;
}

/**
 * Return the system prompt with the newest summary injected: an existing
 * `<running_summary>` block (or blocks) is replaced in place so stale
 * copies never duplicate; otherwise the block is appended.
 */
export function applyRunningSummary(systemPrompt: string, summary: string): string {
  const block = `<running_summary>\n${summary.trim()}\n</running_summary>`;
  const globalPattern = new RegExp(RUNNING_SUMMARY_TAG_PATTERN.source, "g");
  if (!globalPattern.test(systemPrompt)) {
    return `${systemPrompt.trimEnd()}\n\n${block}`;
  }
  // Replace the first block in place; drop any additional stale copies so
  // exactly one — the newest — remains.
  let first = true;
  return systemPrompt.replace(
    new RegExp(RUNNING_SUMMARY_TAG_PATTERN.source, "g"),
    () => {
      if (first) {
        first = false;
        return block;
      }
      return "";
    },
  );
}
