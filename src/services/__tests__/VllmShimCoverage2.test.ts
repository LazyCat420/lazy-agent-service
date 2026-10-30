/**
 * VllmShimService auto-recovery helpers — stale-model 404 healing and
 * embed context-overflow rescaling. Only the upstream HTTP endpoint is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VllmShimService } from "../vllm/VllmShimService.ts";

const shim = VllmShimService as unknown as {
  maybeAutoHealModel404: (
    response: Response,
    basePath: string,
    upstreamUrl: string,
    upstreamName: string,
    body: unknown,
    fetchOnce: () => Promise<Response>,
  ) => Promise<Response>;
  maybeRescaleEmbedOverflow: (
    isEmbedPost: boolean,
    response: Response,
    body: unknown,
    fetchOnce: () => Promise<Response>,
  ) => Promise<Response>;
};

interface FakeResponse {
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  clone: () => FakeResponse;
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  const response: FakeResponse = {
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    clone: () => fakeResponse(status, body),
  };
  return response;
}

const asUpstream = (value: FakeResponse) => value as unknown as Response;

beforeEach(() => {
  VllmShimService.clearActiveModels();
  vi.clearAllMocks();
});

afterEach(() => {
  VllmShimService.clearActiveModels();
  vi.unstubAllGlobals();
});

describe("maybeAutoHealModel404", () => {
  const path = "/v1/chat/completions";
  const url = "http://vllm.test";

  it("passes through non-404 responses", async () => {
    const response = fakeResponse(200, {});
    const fetchOnce = vi.fn();
    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      { model: "stale" },
      fetchOnce,
    );
    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("passes through 404s from other paths", async () => {
    const response = fakeResponse(404, {});
    const fetchOnce = vi.fn();
    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      "/v1/embeddings",
      url,
      "vllm",
      { model: "stale" },
      fetchOnce,
    );
    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("rewrites a stale model to the live model and retries", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "qwen3-live" }] }),
      })),
    );
    const retried = fakeResponse(200, { choices: [] });
    const fetchOnce = vi.fn(async () => asUpstream(retried));
    const body: Record<string, unknown> = { model: "qwen3-stale" };

    const result = await shim.maybeAutoHealModel404(
      asUpstream(
        fakeResponse(404, {
          error: { message: "The model `qwen3-stale` does not exist." },
        }),
      ),
      path,
      url,
      "vllm",
      body,
      fetchOnce,
    );

    expect(result).toBe(retried);
    expect(body.model).toBe("qwen3-live");
    expect(VllmShimService.getActiveModel("vllm")).toBe("qwen3-live");
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("reads the message field when there is no error.message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ models: [{ name: "live-model" }] }),
      })),
    );
    const body: Record<string, unknown> = { model: "old-model" };
    const fetchOnce = vi.fn(async () => asUpstream(fakeResponse(200, {})));

    await shim.maybeAutoHealModel404(
      asUpstream(fakeResponse(404, { message: "model does not exist" })),
      path,
      url,
      "vllm",
      body,
      fetchOnce,
    );

    expect(body.model).toBe("live-model");
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the error is unrelated to the model", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = fakeResponse(404, { error: { message: "route not found" } });
    const fetchOnce = vi.fn();

    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      { model: "x" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry when the live model equals the requested model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "same-model" }] }),
      })),
    );
    const response = fakeResponse(404, {
      error: { message: "model does not exist" },
    });
    const fetchOnce = vi.fn();

    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      { model: "same-model" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("does not retry when the live model cannot be resolved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
    const response = fakeResponse(404, {
      error: { message: "model does not exist" },
    });
    const fetchOnce = vi.fn();

    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      { model: "stale" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("skips healing when the body has no model", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: "live" }] }),
      })),
    );
    const response = fakeResponse(404, {
      error: { message: "model does not exist" },
    });
    const fetchOnce = vi.fn();

    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      null,
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("returns the original response when reading the error body throws", async () => {
    const response: FakeResponse = {
      status: 404,
      json: async () => {
        throw new Error("unreadable body");
      },
      text: async () => "",
      clone: () => response,
    };
    const fetchOnce = vi.fn();

    const result = await shim.maybeAutoHealModel404(
      asUpstream(response),
      path,
      url,
      "vllm",
      { model: "stale" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });
});

describe("maybeRescaleEmbedOverflow", () => {
  const overflowText =
    "This model's maximum context length is 2048 tokens. " +
    "However, you requested 0 output tokens and your prompt contains at least 4096 input tokens.";

  it("passes through non-embedding requests and non-400 responses", async () => {
    const fetchOnce = vi.fn();
    const ok = fakeResponse(200, {});
    expect(
      await shim.maybeRescaleEmbedOverflow(false, asUpstream(ok), { input: "x" }, fetchOnce),
    ).toBe(ok);

    const bad = fakeResponse(500, {});
    expect(
      await shim.maybeRescaleEmbedOverflow(true, asUpstream(bad), { input: "x" }, fetchOnce),
    ).toBe(bad);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("shrinks the input and retries when the window is exceeded", async () => {
    const body: Record<string, unknown> = { input: "a".repeat(8000) };
    const success = fakeResponse(200, { data: [] });
    const fetchOnce = vi.fn(async () => asUpstream(success));

    const result = await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(fakeResponse(400, overflowText)),
      body,
      fetchOnce,
    );

    expect(result).toBe(success);
    expect(fetchOnce).toHaveBeenCalledTimes(1);
    const input = body.input as string;
    expect(input.length).toBeLessThan(8000);
    // 2048 / 4096 * 0.9 = 0.45 → 3600 chars.
    expect(input.length).toBe(3600);
  });

  it("shrinks each string when input is an array", async () => {
    const body: Record<string, unknown> = { input: ["a".repeat(4000), 42, "b".repeat(4000)] };
    const fetchOnce = vi.fn(async () => asUpstream(fakeResponse(200, {})));

    await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(fakeResponse(400, overflowText)),
      body,
      fetchOnce,
    );

    const input = body.input as unknown[];
    expect((input[0] as string).length).toBe(1800);
    expect(input[1]).toBe(42);
    expect((input[2] as string).length).toBe(1800);
  });

  it("uses an aggressive cut when the report is uninformative", async () => {
    const body: Record<string, unknown> = { input: "a".repeat(10_000) };
    const fetchOnce = vi.fn(async () => asUpstream(fakeResponse(200, {})));

    await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(
        fakeResponse(
          400,
          "This model's maximum context length is 2048 tokens. However, you requested 0 output tokens and your prompt contains at least 2049 input tokens.",
        ),
      ),
      body,
      fetchOnce,
    );

    expect((body.input as string).length).toBe(6000);
  });

  it("stops when the error text does not describe a context overflow", async () => {
    const response = fakeResponse(400, "invalid request: input must be a string");
    const fetchOnce = vi.fn();

    const result = await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(response),
      { input: "abc" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("stops when the measured tokens fit the window", async () => {
    const response = fakeResponse(
      400,
      "maximum context length is 2048 tokens. your prompt contains at least 1000 input tokens",
    );
    const fetchOnce = vi.fn();

    const result = await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(response),
      { input: "abc" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("stops when the input cannot be shrunk", async () => {
    const response = fakeResponse(400, overflowText);
    const fetchOnce = vi.fn();

    const result = await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(response),
      { model: "embed" },
      fetchOnce,
    );

    expect(result).toBe(response);
    expect(fetchOnce).not.toHaveBeenCalled();
  });

  it("retries at most the configured attempt count", async () => {
    const body: Record<string, unknown> = { input: "a".repeat(100_000) };
    const fetchOnce = vi.fn(async () => asUpstream(fakeResponse(400, overflowText)));

    const result = await shim.maybeRescaleEmbedOverflow(
      true,
      asUpstream(fakeResponse(400, overflowText)),
      body,
      fetchOnce,
    );

    expect(result.status).toBe(400);
    expect(fetchOnce).toHaveBeenCalledTimes(3);
  });
});
