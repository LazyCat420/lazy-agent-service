// Constants for provider stream resilience, ported from prism-service
// src/constants.ts (HARNESS section). Kept in their own module so harness,
// provider and retry layers share one source without touching the large
// shared constants file.

/** How long a provider stream may produce nothing before the watchdog aborts the pass. */
export const STREAM_IDLE_TIMEOUT_MILLISECONDS = 300_000;

/** Retry attempts after the initial try for transient provider failures. */
export const PROVIDER_STREAM_MAX_RETRIES = 3;

/** Base delay for the exponential-with-jitter retry backoff. */
export const PROVIDER_STREAM_RETRY_BASE_MILLISECONDS = 1_000;
