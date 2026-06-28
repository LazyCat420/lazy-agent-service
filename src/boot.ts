// ─── Boot Sequence ──────────────────────────────────────────

import { bootstrapEnvironment } from "@rodrigo-barraza/utilities-library/vault";

try {
  await bootstrapEnvironment();
} catch (error: any) {
  console.warn(
    `⚠️ [Vault Bootstrap Failed] Proceeding with local environment variables. Error: ${error.message}`
  );
}

await import("./server.js");
