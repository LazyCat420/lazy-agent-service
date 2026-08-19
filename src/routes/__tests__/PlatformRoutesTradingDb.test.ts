import { describe, it, expect } from "vitest";

import MongoWrapper from "../../wrappers/MongoWrapper.ts";
import { TRADING_MONGO_DB } from "../../../config.ts";

/**
 * The /platform endpoints read `tool_usage_stats` out of the TRADING database,
 * which is a DIFFERENT database from prism's on the same server.
 *
 * MongoManager keys its connections by NAME and throws
 * `Database not connected: trading_bot` for one nobody registered — it does not
 * return an empty database. Before 2026-08-19 `src/index.ts` registered only
 * MONGO_DB_NAME, so every one of the four endpoints threw on its first line and
 * answered **500** on every call, in every environment, since the Postgres path
 * was removed.
 *
 * Two facts are pinned here:
 *
 *   1. an unregistered trading database is a 503 with a reason, not a 500 —
 *      "the data source is not configured here" is this service's own answer
 *      about someone else's collection, exactly as the old `getPlatformPool()`
 *      null-check answered before the rewrite;
 *   2. boot registers it, so the 503 branch is not what production runs.
 *
 * The second is the one that would have caught the shipped defect: a 503 guard
 * alone is a tidy error message on a permanently broken endpoint.
 */

describe("the /platform endpoints' trading database", () => {
  it("throws rather than returning empty when the database is not registered", () => {
    // The premise the guard exists for. If MongoManager ever starts returning
    // an empty Db instead, the endpoints would answer 200 with zero rows —
    // silently wrong, and this test is where that change gets noticed.
    expect(() => MongoWrapper.getDb("a-database-nobody-registered")).toThrow(
      /not connected/i,
    );
  });

  it("answers 503 with a reason, not 500, when it is missing", async () => {
    const { default: router } = await import("../PlatformRoutes.ts");

    // The handler is invoked directly rather than over HTTP: this repo has no
    // HTTP test client, and adding a dependency to reach one endpoint would
    // cost more than it proves.
    const layer = (router as any).stack.find(
      (l: any) => l.route?.path === "/stats",
    );
    expect(layer, "GET /platform/stats is gone").toBeTruthy();

    let status = 200;
    let body: any = null;
    const res: any = {
      status(code: number) {
        status = code;
        return res;
      },
      json(payload: any) {
        body = payload;
        return res;
      },
    };

    // In this test process nothing has called createClient(), so the trading
    // database is unregistered — the production-misconfiguration case.
    await layer.route.stack[0].handle({ query: {} }, res, (e: unknown) => {
      throw e;
    });

    expect(status).toBe(503);
    expect(body.error).toContain(TRADING_MONGO_DB);
    expect(body.hint).toMatch(/MONGO_URI/);
  });

  it("is registered at boot, beside the prism one and after it", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../index.ts", import.meta.url), "utf-8"),
    );

    const prism = src.indexOf("createClient(MONGO_DB_NAME");
    const trading = src.indexOf("createClient(TRADING_MONGO_DB");

    expect(prism).toBeGreaterThan(-1);
    expect(trading).toBeGreaterThan(-1);
    // ORDER MATTERS: MongoManager takes the FIRST connection as the default for
    // name-less getDb() calls. Registering the trading database first would
    // hand every unnamed prism read the wrong database.
    expect(trading).toBeGreaterThan(prism);
  });

  it("does not take the process down when the trading database is unreachable", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../index.ts", import.meta.url), "utf-8"),
    );
    const at = src.indexOf("createClient(TRADING_MONGO_DB");
    const window = src.slice(Math.max(0, at - 400), at + 400);

    // This service is a dashboard over the trading collection, not the cycle.
    // An unreachable trading database must degrade to 503 per request, not
    // abort a boot that every LLM request in the ecosystem goes through.
    expect(window).toMatch(/try\s*{/);
    expect(window).toMatch(/catch/);
  });
});
