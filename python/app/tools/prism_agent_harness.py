"""
Prism Agent Harness — Phase 6: Onion Layered Architecture.

Delegates the agentic tool-calling loop to Prism Gateway so that:
  Layer 1 (trading-cycle-backend): Defines tools, holds data state.
  Layer 2 (Prism Gateway):         Runs the agentic loop, tracks everything.
  Layer 3 (Hermes/vLLM):           Executes raw LLM completions.

This module provides `run_prism_agent()` as a drop-in replacement for
`run_tool_agent()` when you want Prism to manage the loop instead of
the local executor.py while loop.

When Prism is unhealthy, it transparently falls back to the local
executor so the pipeline never stalls.

IMPORTANT: This only changes code in the trading-cycle-backend.
           No Prism code is modified.
"""

import asyncio
import json
import logging
import time
import uuid
from typing import Any

import httpx

from app.config import settings
from app.services.prism_client import PrismClient
from app.services.vllm_client import llm, Priority
from app.tools.registry import registry

logger = logging.getLogger(__name__)


# ── Data Structures ────────────────────────────────────────────────────

class PrismAgentResult:
    """Structured result from a Prism-delegated agent run."""

    def __init__(
        self,
        final_text: str,
        token_usage: int,
        execution_ms: int,
        conversation_id: str,
        routed_via: str,  # "prism" or "local_fallback"
    ):
        self.final_text = final_text
        self.token_usage = token_usage
        self.execution_ms = execution_ms
        self.conversation_id = conversation_id
        self.routed_via = routed_via

    def to_dict(self) -> dict[str, Any]:
        return {
            "final_text": self.final_text,
            "token_usage": self.token_usage,
            "execution_ms": self.execution_ms,
            "conversation_id": self.conversation_id,
            "routed_via": self.routed_via,
        }


# ── JSON Recovery Helper ───────────────────────────────────────────────

async def recover_json_output(
    final_text: str,
    agent_name: str,
    ticker: str,
    cycle_id: str,
    bot_id: str,
    priority: Priority,
) -> tuple[dict, str, int, int]:
    """Attempt fast JSON recovery based on agent schema."""
    from app.utils.text_utils import parse_json_response

    if agent_name == "pre_trade":
        recovery_system = (
            "You are a precise data converter. Your job is to extract the structured pre-trade risk decision "
            "from the provided unstructured analysis text and output it as a strictly valid JSON object."
        )
        recovery_user = (
            "Here is the unstructured analysis text:\n"
            f"{final_text}\n\n"
            "Extract the risk fields and output EXACTLY this JSON format (no markdown formatting, no other text, just the raw JSON object):\n"
            "{\n"
            '  "decision": "APPROVE" or "VETO",\n'
            '  "ticker": "<ticker>",\n'
            '  "shares": <shares count, integer>,\n'
            '  "entry_price": <entry price, float>,\n'
            '  "stop_loss": <stop loss price, float>,\n'
            '  "risk_reward_ratio": <risk reward ratio, float>,\n'
            '  "position_pct": <position percentage, float>,\n'
            '  "total_cost": <total trade cost, float>,\n'
            '  "veto_reason": null or "<veto reason string>",\n'
            '  "rationale": "<brief explanation of the decision>"\n'
            "}\n"
            "If the text does not specify some values, calculate them: total_cost = shares * entry_price. If the decision is not clear, decide based on the tone."
        )
    elif agent_name == "portfolio_allocator":
        recovery_system = (
            "You are a precise data converter. Your job is to extract the structured portfolio allocation decisions "
            "from the provided unstructured analysis text and output it as a strictly valid JSON object."
        )
        recovery_user = (
            "Here is the unstructured analysis text:\n"
            f"{final_text}\n\n"
            "Extract the allocations and output EXACTLY this JSON format (no markdown formatting, no other text, just the raw JSON object):\n"
            "{\n"
            '  "allocations": [\n'
            "    {\n"
            '      "ticker": "<ticker>",\n'
            '      "decision": "APPROVE" or "VETO",\n'
            '      "adjusted_size_pct": <percentage, float>,\n'
            '      "shares": <shares count, integer>,\n'
            '      "total_cost": <total trade cost, float>,\n'
            '      "veto_reason": null or "<veto reason string>",\n'
            '      "rationale": "<explanation>"\n'
            "    }\n"
            "  ]\n"
            "}\n"
            "If the decision is not clear, decide based on the tone."
        )
    else:
        recovery_system = (
            "You are a precise data converter. Your job is to extract the structured financial decision "
            "from the provided unstructured analysis text and output it as a strictly valid JSON object."
        )
        recovery_user = (
            "Here is the unstructured analysis text:\n"
            f"{final_text}\n\n"
            "Extract the following fields and output EXACTLY this JSON format (no markdown formatting or other text, just the raw JSON object):\n"
            "{\n"
            '  "action": "BUY" or "SELL",\n'
            '  "claims": ["claim 1 with source citation", "claim 2...", ...],\n'
            '  "confidence": <integer 0-100>,\n'
            '  "key_argument": "single strongest argument"\n'
            "}\n"
            "If the text does not specify claims or arguments, fill them in based on the text. If the action is not clear, decide based on the tone."
        )

    try:
        recovered_text, rec_tokens, rec_ms = await llm.chat(
            system=recovery_system,
            user=recovery_user,
            temperature=0.1,
            max_tokens=1024,
            priority=priority,
            agent_name=agent_name + "_recovery",
            ticker=ticker,
            cycle_id=cycle_id,
            bot_id=bot_id,
        )
        recovered_parsed = parse_json_response(recovered_text)

        # Verify success based on agent schema requirements
        success = False
        if agent_name == "pre_trade":
            if recovered_parsed and "decision" in recovered_parsed and "ticker" in recovered_parsed:
                success = True
        elif agent_name == "portfolio_allocator":
            if recovered_parsed and "allocations" in recovered_parsed:
                success = True
        else:
            if recovered_parsed and "action" in recovered_parsed and "claims" in recovered_parsed:
                success = True

        if success:
            logger.info(
                "[PrismHarness] Fast JSON recovery succeeded for %s: %s",
                agent_name,
                recovered_parsed.get("decision") or recovered_parsed.get("action") or "allocations"
            )
            return recovered_parsed, json.dumps(recovered_parsed), rec_tokens, rec_ms
    except Exception as re_err:
        logger.warning("[PrismHarness] Fast JSON recovery failed for %s: %s", agent_name, re_err)

    return {}, final_text, 0, 0


# ── Core Function ──────────────────────────────────────────────────────

async def run_prism_agent(
    system_prompt: str,
    user_prompt: str,
    ticker: str,
    agent_name: str = "prism_agent",
    cycle_id: str = "",
    bot_id: str = "",
    priority: Priority = Priority.NORMAL,
    tools_override: list[dict] | None = None,
    max_tokens: int = 2048,
    temperature: float = 0.3,
    timeout_seconds: int = 120,
    actor_label: str | None = None,
) -> dict[str, Any]:
    """Run an agent via Prism Gateway's /agent endpoint.

    Prism handles the full agentic loop (LLM → tool call → LLM → ...),
    logging every step natively. This gives you complete visibility
    in the Prism dashboard.

    When Prism is unhealthy, falls back to the local `run_tool_agent`.

    Args:
        system_prompt: System prompt for the agent.
        user_prompt: User prompt / task description.
        ticker: Stock ticker context.
        agent_name: Agent identifier for tracking.
        cycle_id: Trading cycle ID for session grouping.
        bot_id: Bot ID for tracking.
        priority: Queue priority level.
        tools_override: Optional tool schemas. If None, uses all registry tools.
        max_tokens: Max tokens for the LLM response.
        temperature: LLM temperature.
        timeout_seconds: Max time for the full agent run.
        actor_label: Optional label for the actor/username overriding default.

    Returns:
        dict with keys: final_text, token_usage, execution_ms,
        conversation_id, routed_via.
    """
    prism = llm.prism_client
    start = time.monotonic()

    if ticker:
        ticker = ticker.upper()

    # Check if Prism is available
    prism_healthy = await prism.check_health()

    if not prism_healthy or not settings.PRISM_ENABLED:
        logger.info(
            "[PrismHarness] Prism unavailable — falling back to local executor for %s",
            agent_name,
        )
        return await _fallback_to_local(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            ticker=ticker,
            agent_name=agent_name,
            cycle_id=cycle_id,
            bot_id=bot_id,
            priority=priority,
            tools_override=tools_override,
        )

    # Build the tools list
    active_tools = tools_override if tools_override is not None else registry.schemas

    # Build messages
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    # Get the model from the active endpoint
    model = llm.model or settings.ACTIVE_MODEL or "auto"

    # Build Prism payload — agentic_mode=True so Prism runs the loop
    payload, url, headers = prism.get_chat_payload_and_url(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
        system_prompt=system_prompt,
        agent_name=agent_name,
        ticker=ticker,
        cycle_id=cycle_id,
        enable_thinking=False,
        tools=active_tools,
        agentic_mode=True,
        actor_label=actor_label,
    )

    # Add metadata for tracking
    title_parts = [agent_name]
    if ticker:
        title_parts.append(ticker)
    if cycle_id:
        title_parts.append(cycle_id[:12])
    payload["conversationMeta"]["title"] = " · ".join(title_parts)

    logger.info(
        "[PrismHarness] Delegating %s to Prism /agent (model=%s, tools=%d, ticker=%s)",
        agent_name,
        model,
        len(active_tools),
        ticker,
    )

    # Execute via Prism
    try:
        client = await llm._get_client()
        response = await asyncio.wait_for(
            client.post(url, json=payload, headers=headers, timeout=float(timeout_seconds)),
            timeout=float(timeout_seconds) + 5,
        )
        response.raise_for_status()

        elapsed_ms = int((time.monotonic() - start) * 1000)
        result_data = response.json()

        # Extract the final assistant response from Prism's response
        final_text = _extract_final_text(result_data)
        token_usage = result_data.get("usage", {}).get("total_tokens", 0)
        conversation_id = payload.get("conversationId", "")

        # All base/analytical agents require valid JSON outputs.
        # Fallback to local if the response does not parse into a valid JSON object.
        from app.utils.text_utils import parse_json_response
        parsed = parse_json_response(final_text)
        if not parsed:
            # Attempt fast JSON recovery before falling back to local
            logger.info(
                "[PrismHarness] %s response from Prism is not valid JSON. Attempting fast JSON recovery...",
                agent_name
            )
            parsed, recovered_text, rec_tokens, rec_ms = await recover_json_output(
                final_text=final_text,
                agent_name=agent_name,
                ticker=ticker,
                cycle_id=cycle_id,
                bot_id=bot_id,
                priority=priority,
            )
            if parsed:
                final_text = recovered_text
                token_usage += rec_tokens
                elapsed_ms += rec_ms

        if not parsed:
            logger.warning(
                "[PrismHarness] %s returned invalid/empty JSON response from Prism — falling back to local: %s",
                agent_name,
                repr(final_text[:200])
            )
            return await _fallback_to_local(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                ticker=ticker,
                agent_name=agent_name,
                cycle_id=cycle_id,
                bot_id=bot_id,
                priority=priority,
                tools_override=tools_override,
            )

        logger.info(
            "[PrismHarness] %s completed via Prism in %dms (%d tokens)",
            agent_name,
            elapsed_ms,
            token_usage,
        )

        return PrismAgentResult(
            final_text=final_text,
            token_usage=token_usage,
            execution_ms=elapsed_ms,
            conversation_id=conversation_id,
            routed_via="prism",
        ).to_dict()

    except asyncio.TimeoutError:
        elapsed_ms = int((time.monotonic() - start) * 1000)
        logger.error(
            "[PrismHarness] %s timed out after %ds — falling back to local",
            agent_name,
            timeout_seconds,
        )
        return await _fallback_to_local(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            ticker=ticker,
            agent_name=agent_name,
            cycle_id=cycle_id,
            bot_id=bot_id,
            priority=priority,
            tools_override=tools_override,
        )

    except Exception as e:
        logger.error(
            "[PrismHarness] %s failed via Prism (%s) — falling back to local",
            agent_name,
            e,
        )
        return await _fallback_to_local(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            ticker=ticker,
            agent_name=agent_name,
            cycle_id=cycle_id,
            bot_id=bot_id,
            priority=priority,
            tools_override=tools_override,
        )


# ── Helpers ────────────────────────────────────────────────────────────

def _extract_final_text(prism_response: dict) -> str:
    """Extract the final assistant text from Prism's /agent response.

    Prism returns different shapes depending on streaming vs non-streaming.
    This handles both.
    """
    # Non-streaming: { "choices": [{ "message": { "content": "..." } }] }
    choices = prism_response.get("choices", [])
    if choices:
        message = choices[0].get("message", {})
        content = message.get("content", "")
        if content:
            return content

    # Direct content field
    if "content" in prism_response:
        return prism_response["content"]

    # Fallback: stringify the whole response
    return json.dumps(prism_response)


async def _fallback_to_local(
    system_prompt: str,
    user_prompt: str,
    ticker: str,
    agent_name: str,
    cycle_id: str,
    bot_id: str,
    priority: Priority,
    tools_override: list[dict] | None,
) -> dict[str, Any]:
    """Fall back to the local executor.py when Prism is unavailable."""
    from app.tools.executor import run_tool_agent

    logger.info(
        "[PrismHarness] Using local executor fallback for %s (ticker=%s)",
        agent_name,
        ticker,
    )

    result = await run_tool_agent(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        ticker=ticker,
        agent_name=agent_name,
        cycle_id=cycle_id,
        bot_id=bot_id,
        priority=priority,
        tools_override=tools_override,
    )

    fallback_text = result.get("final_text", "")
    token_usage = result.get("token_usage", 0)
    execution_ms = result.get("execution_ms", 0)

    from app.utils.text_utils import parse_json_response
    parsed = parse_json_response(fallback_text)
    if not parsed:
        logger.info(
            "[PrismHarness] Local fallback response for %s is not valid JSON. Attempting fast JSON recovery on local output...",
            agent_name
        )
        parsed, recovered_text, rec_tokens, rec_ms = await recover_json_output(
            final_text=fallback_text,
            agent_name=agent_name,
            ticker=ticker,
            cycle_id=cycle_id,
            bot_id=bot_id,
            priority=priority,
        )
        if parsed:
            fallback_text = recovered_text
            token_usage += rec_tokens
            execution_ms += rec_ms

    # Normalize to PrismAgentResult shape
    return PrismAgentResult(
        final_text=fallback_text,
        token_usage=token_usage,
        execution_ms=execution_ms,
        conversation_id="",
        routed_via="local_fallback",
    ).to_dict()
