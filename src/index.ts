import { installShutdownHandlers, registerCleanup } from "./utils/CleanupRegistry.ts";
import { createHttpRuntime } from "./boot/server.ts";
import {
  PORT,
  defaultListeningDeps,
  defaultRuntimeDeps,
  onListening,
  startRuntime,
} from "./boot/runtime.ts";
import logger from "./utils/logger.ts";

// Install process-level shutdown handlers (SIGTERM, SIGINT → runCleanupFunctions)
installShutdownHandlers();
// Flush OpenTelemetry spans (set by src/telemetry/otel.ts when tracing is on).
// The tracing module hangs its shutdown on globalThis so an untraced build has
// no dependency on it; the cast names that optional slot once.
const otelGlobal = globalThis as typeof globalThis & { __lazyOtelShutdown?: () => Promise<void> };
registerCleanup(async () => {
  await otelGlobal.__lazyOtelShutdown?.();
});

const runtime = createHttpRuntime();

// Start
(async () => {
  await startRuntime(defaultRuntimeDeps());
  runtime.server.listen(PORT, async () => {
    await onListening(defaultListeningDeps(runtime));
  });
})().catch((error: unknown) => {
  logger.error("Fatal startup error:", error);
  process.exitCode = 1;
});
