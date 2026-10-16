/**
 * Attribution headers for the outbound proxy calls PrismProxyService makes TO
 * the real prism gateway (host taken from the environment; see PrismProxyService).
 *
 * Prism files every inbound request by the `x-project` / `x-username` HTTP
 * HEADERS only — it does NOT read `project` / `username` out of the JSON body.
 * Any caller that omits the headers lands in prism's catch-all
 * "default"/"anonymous" bucket, which makes its traffic unattributable.
 *
 * PrismProxyService is the only remaining outbound prism caller in this repo
 * (kept for parity runs until 2026-10-23), so it is the only user of these
 * headers. When a call site also puts a meaningful `project` in the request
 * body, pass it here so the header and the body agree.
 */

/** Default project filed against prism for traffic originating in this service. */
export const PRISM_ATTRIBUTION_PROJECT = "lazy-agent-service";

/** Default username filed against prism for traffic originating in this service. */
export const PRISM_ATTRIBUTION_USERNAME = "admin";

/**
 * Build the `x-project` / `x-username` pair for an outbound prism request.
 * Blank/undefined values fall back to this service's defaults.
 */
export function prismAttributionHeaders(
  project?: string | null,
  username?: string | null,
): { "x-project": string; "x-username": string } {
  return {
    "x-project": project || PRISM_ATTRIBUTION_PROJECT,
    "x-username": username || PRISM_ATTRIBUTION_USERNAME,
  };
}
