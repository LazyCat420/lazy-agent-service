import type { Request } from "express";

/**
 * Response-mode negotiation shared by POST /chat and POST /agent.
 *
 * SSE is the default, as it was on prism. A caller gets plain JSON only by
 * opting out explicitly. The first explicit signal wins, in this order:
 *
 *   1. query   `?stream=true` → SSE, `?stream=false` → JSON
 *   2. body    `"stream": true` → SSE, `"stream": false` → JSON
 *   3. Accept  contains `text/event-stream` → SSE;
 *              contains `application/json` (and not text/event-stream) → JSON
 *   4. default → SSE
 *
 * `Accept: *\/*` (the default of fetch, undici, httpx and requests) and a
 * missing Accept header are not opt-outs.
 */
export function wantsSse(req: Pick<Request, "query" | "headers" | "body">): boolean {
  const streamQuery = req.query?.stream;
  if (streamQuery === "true") return true;
  if (streamQuery === "false") return false;

  const bodyStream = (req.body as { stream?: unknown } | undefined)?.stream;
  if (bodyStream === true) return true;
  if (bodyStream === false) return false;

  const accept = (req.headers?.accept ?? "").toLowerCase();
  if (accept.includes("text/event-stream")) return true;
  if (accept.includes("application/json")) return false;

  return true;
}
