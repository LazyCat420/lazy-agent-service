// ============================================================
// Lazy Agent Service — Bootstrapper Entrypoint
//
// 1. Hydrate process.env by parsing projects.json config
// 2. Import and start the express HTTP & WebSocket server
// ============================================================
import { fetch as undiciFetch } from "undici";

// Override native fetch with undici fetch to prevent "invalid onRequestStart method" dispatcher errors
(globalThis as any).fetch = undiciFetch;

import { bootstrapLocalEnvironment } from "./src/bootstrap.js";

bootstrapLocalEnvironment();

await import("./src/index.js");
