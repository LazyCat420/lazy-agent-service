// POST /wallgarden/brainstorm telemetry (measurement only).
//
// The finance-feed arms used to be visible only in the dashboard console. The
// route now emits one structured line per request carrying the finance share
// of the interests, the focus the client's own-likes gate decided, and the
// seed-domain count. Pinned here:
//   1. the share is computed over the interests actually sent;
//   2. a focused request logs domain_focus="finance" and the seed count;
//   3. an unfocused request logs null/0 (the pre-focus path is unchanged);
//   4. the line never changes the response or the prompt inputs.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import router from "../WallgardenRoutes.ts";
import logger from "../../logger.ts";
import { financeShareOfInterests } from "../../services/wallgarden/WallgardenService.ts";
import type * as WallgardenService from "../../services/wallgarden/WallgardenService.ts";

vi.mock("../../logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../services/wallgarden/WallgardenService.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof WallgardenService>();
  return {
    ...actual,
    discoverModels: async () => [],
    brainstormTopics: async () => [{ topic: "equities", role: "core" as const }],
    rateTopics: async (topics: string[]) => ({
      rated: topics.map(t => ({ topic: t, weight: 5, role: "core" })),
      failedBatches: 0,
      totalBatches: 1,
    }),
  };
});

interface RouteLayer {
  route?: {
    path?: string;
    methods: Record<string, boolean>;
    stack: Array<{ handle: (req: unknown, res: unknown, next: unknown) => Promise<unknown> }>;
  };
}

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(payload: unknown): void;
}

const handlerFor = (target: unknown, method: string, path: string) => {
  // Express's Router.stack is internal and untyped in @types/express.
  const routerWithStack = target as unknown as { stack: RouteLayer[] };
  const layers = routerWithStack.stack;
  const layer = layers.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  if (!layer?.route) throw new Error(`${method} ${path} is not registered`);
  return layer.route.stack.at(-1)!.handle;
};

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
    },
  };
  return res;
}

const invokeBrainstorm = async (body: Record<string, unknown>) => {
  const res = fakeRes();
  const errors: unknown[] = [];
  await handlerFor(router, "post", "/brainstorm")({ body, params: {}, query: {} }, res, (e: unknown) =>
    errors.push(e),
  );
  return { res, errors };
};

/** Parse the JSON tail of the one /brainstorm telemetry line. */
function telemetryLine(): Record<string, unknown> {
  const calls = vi.mocked(logger.info).mock.calls.map(args => String(args[0]));
  const line = calls.find(text => text.includes("/brainstorm {"));
  expect(line, `no telemetry line in [${calls.join(" | ")}]`).toBeDefined();
  return JSON.parse(line!.slice(line!.indexOf("/brainstorm ") + "/brainstorm ".length));
}

beforeEach(() => {
  vi.mocked(logger.info).mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("financeShareOfInterests", () => {
  it("is null when there is nothing to divide by", () => {
    expect(financeShareOfInterests([])).toBeNull();
    expect(financeShareOfInterests(undefined)).toBeNull();
    expect(financeShareOfInterests(["   "])).toBeNull();
  });

  it("counts the client's lexicon terms and nothing else", () => {
    expect(financeShareOfInterests(["equities", "ceramics", "macro", "oil painting"])).toBe(0.5);
    expect(financeShareOfInterests(["raku firing", "kiln building"])).toBe(0);
    // Ambiguous everyday words only match as finance collocations.
    expect(financeShareOfInterests(["oil painting restoration"])).toBe(0);
    expect(financeShareOfInterests(["dividend investing"])).toBe(1);
  });
});

describe("POST /brainstorm telemetry line", () => {
  it("logs the finance share, focus and seed count for a focused request", async () => {
    const { res, errors } = await invokeBrainstorm({
      interests: ["equities", "ceramics", "macro"],
      domainFocus: "finance",
      seedDomains: ["equities", "macro"],
    });

    expect(errors).toEqual([]);
    expect(res.statusCode).toBe(200);
    expect(telemetryLine()).toEqual({
      finance_share: 0.667,
      domain_focus: "finance",
      seed_domains: 2,
    });
  });

  it("logs null focus and zero seeds when the gate stays closed", async () => {
    const { res } = await invokeBrainstorm({ interests: ["raku firing", "kiln building"] });

    expect(res.statusCode).toBe(200);
    expect(telemetryLine()).toEqual({
      finance_share: 0,
      domain_focus: null,
      seed_domains: 0,
    });
  });

  it("normalises a padded focus value", async () => {
    await invokeBrainstorm({
      interests: ["equities"],
      domainFocus: " FINANCE ",
      seedDomains: ["equities"],
    });
    expect(telemetryLine().domain_focus).toBe("finance");
  });

  it("does not log a telemetry line for an unknown focus (400 path)", async () => {
    const { res } = await invokeBrainstorm({ interests: ["equities"], domainFocus: "stocks" });
    expect(res.statusCode).toBe(400);
    expect(
      vi.mocked(logger.info).mock.calls.some(([text]) => String(text).includes("/brainstorm {")),
    ).toBe(false);
  });
});
