"""
Tool Registry wrapper for lazy-agent-service.
Imports the generic registry from lazycat-sdk and attaches DB telemetry.
"""

from lazycat.tool_registry import ToolRegistry, ToolMeta, PermissionLevel, registry
import logging

logger = logging.getLogger(__name__)

def _db_telemetry_callback(
    tool_name: str,
    agent_name: str | None,
    success: bool,
    execution_ms: int,
    error_message: str | None,
) -> None:
    """Log a tool usage event to PostgreSQL (fire-and-forget)."""
    try:
        from datetime import datetime, timezone
        from app.db.connection import get_db

        # Provide a default agent_name if None
        agent_name = agent_name or "unknown"
        
        with get_db() as db:
            db.execute(
                "INSERT INTO tool_usage_stats "
                "(tool_name, agent_name, success, execution_ms, error_message, service_source, called_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s)",
                [
                    tool_name,
                    agent_name,
                    success,
                    execution_ms,
                    error_message,
                    "lazy-tool-service",
                    datetime.now(timezone.utc),
                ],
            )
    except Exception as e:
        logger.debug(f"[ToolRegistry] Usage log failed (non-fatal): {e}")

# Attach the telemetry callback
registry.set_telemetry_callback(_db_telemetry_callback)

__all__ = ["ToolRegistry", "ToolMeta", "PermissionLevel", "registry"]
