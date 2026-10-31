/** One trading /agent preparation for every route that runs a trading agent.
 *
 * Trading's agents reach a loop through our native /agent. The trading
 * boundary — the learning-boundary marker (TradingLearningBoundary), the
 * signed tool context (TradingToolContext) and the `unattended` flag — used to
 * be applied on the retired /prism-proxy route only. A trading call on native
 * /agent therefore reached the vLLM shim with no tool context, and ToolDispatch
 * answered every trading tool call PERMISSION_DENIED (found 2026-10-07, harness
 * cutover step 5; documentation ch.06 item 0). Every route that runs a trading
 * agent calls this, so the boundary cannot drift between them.
 *
 * A no-op for any project other than vllm-trading-bot. Throws on a trading
 * request the boundary cannot accept (no vLLM shim provider, no agent or
 * conversation identity); callers answer 422, as the proxy always has.
 */
import { markUnattended, prepareToolContext } from "./TradingToolContext.ts";
import {
  excludesLearnedState,
  prepareTradingRequest,
} from "./learning/TradingLearningBoundary.ts";

export { excludesLearnedState };

export function shouldSkipLearningForProject(
  project: string | null | undefined,
  flags?: { skipMemoryExtraction?: boolean; skipWorkflowExtraction?: boolean },
): boolean {
  return (
    excludesLearnedState(project) ||
    flags?.skipMemoryExtraction === true ||
    flags?.skipWorkflowExtraction === true
  );
}

export function prepareTradingAgentRequest<T extends Record<string, any>>(
  body: T,
): T {
  const prepared = markUnattended(
    prepareToolContext(prepareTradingRequest(body)),
  ) as T;
  if (excludesLearnedState(prepared?.project)) {
    return {
      ...prepared,
      skipMemoryExtraction: true,
      skipWorkflowExtraction: true,
    };
  }
  return prepared;
}
