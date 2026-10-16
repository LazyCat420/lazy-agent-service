/**
 * ch.06 item 10 — `X-Vllm-Priority` on background utility calls.
 *
 * Ported from prism-service providers/local-request-features.ts: on an
 * instance started with --scheduling-policy priority, a background call
 * (memory extraction) carries `X-Vllm-Priority: 10` so interactive turns are
 * served first. Never sent otherwise — a non-zero priority is an error on a
 * server without priority scheduling.
 */
import { describe, expect, it } from "vitest";

import { BACKGROUND_PRIORITY, vllmRequestHeaders } from "../../providers/vllm.ts";
import { runWithRequestPriority } from "../../services/RequestPriority.ts";

describe("vllmRequestHeaders", () => {
  const FLAG = "PROVIDER_VLLM_PRIORITY_SCHEDULING";

  it("background + priority scheduling sends X-Vllm-Priority: 10", () => {
    process.env[FLAG] = "true";
    try {
      const headers = runWithRequestPriority("background", () => vllmRequestHeaders());
      expect(headers["X-Vllm-Priority"]).toBe(String(BACKGROUND_PRIORITY));
    } finally {
      delete process.env[FLAG];
    }
  });

  it("an interactive turn never carries the header", () => {
    process.env[FLAG] = "true";
    try {
      const headers = runWithRequestPriority("interactive", () => vllmRequestHeaders());
      expect(headers["X-Vllm-Priority"]).toBeUndefined();
    } finally {
      delete process.env[FLAG];
    }
  });

  it("a background call on a server without priority scheduling never carries the header", () => {
    delete process.env[FLAG];
    const headers = runWithRequestPriority("background", () => vllmRequestHeaders());
    expect(headers["X-Vllm-Priority"]).toBeUndefined();
  });
});
