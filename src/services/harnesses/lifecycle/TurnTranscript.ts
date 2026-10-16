// ported from prism-service src/services/harnesses/lifecycle/TurnTranscript.ts
import { PROMPT_DELIMITERS } from "../../../constants.ts";
import { pristineOf } from "../../compact/MessageLineage.ts";
import type AgenticLoopState from "../../AgenticLoopState.ts";
import type { ConversationMessage, AgenticContext } from "../types.ts";
import type { MessagePayload } from "../../conversation/types.ts";
import { computeNewTurnMessages } from "./Finalizer.ts";

// ────────────────────────────────────────────────────────────
// TurnTranscript — what a turn persists, independent of what the model sees
// ────────────────────────────────────────────────────────────
// The loop's message array is a VIEW: micro-compaction replaces old tool
// results with stubs, truncation caps or drops what is left. Persistence
// used to slice that same array (computeNewTurnMessages from
// originalMessageCount), which only worked while those layers never
// touched the current turn. With recency protection they do — a long run
// shrinks its own early iterations — and the slice would lose them.
//
// So the turn keeps a transcript: at every point where the view is about
// to shrink (enforceContextWindow, ContextPressureManager) and at
// finalize, every message not yet classified is recorded by its VERBATIM
// original (MessageLineage.pristineOf). The first recording uses the
// long-standing slice semantics, so which messages belong to the turn is
// unchanged; from then on, anything the loop adds is recorded before the
// next shrink can hide it.
// ────────────────────────────────────────────────────────────

/** A message the turn produced (not history, not a synthetic context artifact). */
function belongsToTurn(message: ConversationMessage): boolean {
  if ((message as MessagePayload)._alreadyPersisted === true) return false;
  if ((message as { isCompactSummary?: boolean }).isCompactSummary === true)
    return false;
  return !(
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.startsWith(PROMPT_DELIMITERS.CONTEXT_NOTE_PREFIX)
  );
}

/**
 * Record every not-yet-classified message of the view. Call before any
 * layer shrinks the view, and before reading the transcript.
 */
export function syncTurnTranscript(
  context: Pick<AgenticContext, "messages">,
  state: AgenticLoopState,
  view: ConversationMessage[],
): void {
  if (!state.turnTranscript) {
    state.turnTranscript = (
      computeNewTurnMessages(
        context.messages as MessagePayload[],
        view as unknown as MessagePayload[],
        state.originalMessageCount,
      ) as unknown as ConversationMessage[]
    ).map(pristineOf);
    for (const message of view) state.turnTranscriptSeen.add(pristineOf(message));
    for (const message of state.turnTranscript) state.turnTranscriptSeen.add(message);
    return;
  }
  for (const viewMessage of view) {
    const message = pristineOf(viewMessage);
    if (state.turnTranscriptSeen.has(message)) continue;
    state.turnTranscriptSeen.add(message);
    if (belongsToTurn(message)) state.turnTranscript.push(message);
  }
}

/**
 * The turn's messages for persistence, verbatim and in order. Before the
 * transcript exists (a harness that never reached a pressure boundary) this
 * is the classic slice of the view.
 */
export function collectTurnMessages(
  context: Pick<AgenticContext, "messages">,
  state: AgenticLoopState,
  view: ConversationMessage[],
): ConversationMessage[] {
  if (!state.turnTranscript) {
    return (
      computeNewTurnMessages(
        context.messages as MessagePayload[],
        view as unknown as MessagePayload[],
        state.originalMessageCount,
      ) as unknown as ConversationMessage[]
    ).map(pristineOf);
  }
  syncTurnTranscript(context, state, view);
  return [...state.turnTranscript];
}
