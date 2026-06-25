"""
Minimal logger for lazy-tool-service.

The full-featured LogManager (cycle logging, crash recovery, telemetry)
lives in trading-service/app/log_manager.py. This stub provides a simple
get_logger() factory for tool-service code that just needs a named logger.

Future: replace with lazycat-sdk logging module.
"""

import logging


def get_logger(name: str) -> logging.Logger:
    """Return a named logger for lazy-tool-service modules."""
    return logging.getLogger(name)
