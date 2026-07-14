// ────────────────────────────────────────────────────────────
// CleanupRegistry — Re-export from service-library GracefulShutdown
// ────────────────────────────────────────────────────────────
// Previously a standalone 116-line module; now delegates to the
// shared implementation in @rodrigo-barraza/service-library.
// ────────────────────────────────────────────────────────────

export {
  registerCleanup,
  runCleanupFunctions,
  installShutdownHandlers,
  cleanupCount,
} from "@rodrigo-barraza/utilities-library/service/shutdown";
