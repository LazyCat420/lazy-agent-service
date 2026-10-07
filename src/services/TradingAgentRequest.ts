/** One trading /agent preparation for every route that runs a trading agent.
 *
 * Trading's agents reach a loop two ways: /prism-proxy (prism's loop) and our
 * native /agent. The trading boundary — the learning-boundary marker
 * (TradingLearningBoundary), the signed tool context (TradingToolContext) and
 * the `unattended` flag — used to be applied on /prism-proxy only. A trading
 * call on native /agent therefore reached the vLLM shim with no tool context,
 * and ToolDispatch answered every trading tool call PERMISSION_DENIED (found
 * 2026-10-07, harness cutover step 5; documentation ch.06 item 0). Both routes
 * call this, so the boundary cannot drift between them.
 *
 * A no-op for any project other than vllm-trading-bot. Throws on a trading
 * request the boundary cannot accept (no vLLM shim provider, no agent or
 * conversation identity); callers answer 422, as the proxy always has.
 */
import { markUnattended, prepareToolContext } from "./TradingToolContext.ts";
import { prepareTradingRequest } from "./learning/TradingLearningBoundary.ts";

export function prepareTradingAgentRequest<T extends Record<string, any>>(body: T): T {
  return markUnattended(prepareToolContext(prepareTradingRequest(body))) as T;
}
