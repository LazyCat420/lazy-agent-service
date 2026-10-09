import { describe, expect, it } from "vitest";
import { discoverContextWindow } from "../../../src/platform/models/discoverContextWindow.ts";

function fetchReturning(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof globalThis.fetch;
}

function fetchFailing(): typeof globalThis.fetch {
  return (async () => { throw new Error("connection refused"); }) as typeof globalThis.fetch;
}

describe("discoverContextWindow", () => {
  it("reads the context length from /v1/models for the named model", async () => {
    const tokens = await discoverContextWindow("http://localhost:8000", "Qwen3-8B", {
      fetch: fetchReturning({ data: [
        { id: "Qwen3-8B", context_length: 40_960 },
        { id: "other", context_length: 8_192 },
      ] }),
    });
    expect(tokens).toBe(40_960);
  });

  it("falls back to the first entry without a model name", async () => {
    const tokens = await discoverContextWindow("http://localhost:8000", undefined, {
      fetch: fetchReturning({ data: [{ id: "x", max_model_len: 32_768 }] }),
    });
    expect(tokens).toBe(32_768);
  });

  it("probes /model_info when /v1/models says nothing", async () => {
    const calls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
      }
      return new Response(JSON.stringify([{ id: "m", max_input_tokens: 65_536 }]), { status: 200 });
    }) as typeof globalThis.fetch;
    const tokens = await discoverContextWindow("http://localhost:8000/", "m", { fetch: fetchFn });
    expect(tokens).toBe(65_536);
    expect(calls).toEqual(["http://localhost:8000/v1/models", "http://localhost:8000/model_info"]);
  });

  it("recognizes the alternate field names", async () => {
    expect(await discoverContextWindow("http://b", undefined, {
      fetch: fetchReturning({ data: [{ id: "m", context_window: 131_072 }] }),
    })).toBe(131_072);
    expect(await discoverContextWindow("http://b", undefined, {
      fetch: fetchReturning({ data: [{ id: "m", "x-context-length": 8_192 }] }),
    })).toBe(8_192);
  });

  it("returns undefined on an unreachable endpoint", async () => {
    expect(await discoverContextWindow("http://localhost:1", "m", { fetch: fetchFailing() })).toBeUndefined();
  });

  it("returns undefined when no entry carries a context field", async () => {
    expect(await discoverContextWindow("http://b", undefined, {
      fetch: fetchReturning({ data: [{ id: "m" }] }),
    })).toBeUndefined();
  });

  it("returns undefined on a non-2xx response", async () => {
    expect(await discoverContextWindow("http://b", undefined, {
      fetch: fetchReturning({ error: "nope" }, 503),
    })).toBeUndefined();
  });
});
