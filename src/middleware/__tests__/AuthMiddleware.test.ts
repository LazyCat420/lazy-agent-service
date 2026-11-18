// Identity resolution in authMiddleware, exercised over real HTTP on loopback so that header
// names, query strings and JSON bodies are parsed by Node and express rather than by a fake.
import { DEFAULT_PROJECT, DEFAULT_USERNAME } from "@rodrigo-barraza/utilities-library/taxonomy";
import express from "express";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type LoopbackApp, type LoopbackRequest, serveOnLoopback } from "../../../test/support/loopbackExpress.ts";
import { requestContext } from "../../utils/RequestContext.ts";
import { authMiddleware } from "../AuthMiddleware.ts";

const WhoAmISchema = z.object({
  project: z.unknown(),
  username: z.unknown(),
  clientIp: z.unknown(),
  workspaceId: z.unknown(),
  workspaceRoot: z.unknown(),
  /** The AsyncLocalStorage request context as the route handler sees it; null when none is open. */
  ctx: z.record(z.string(), z.unknown()).nullable(),
});

/** When true, requests run inside a request context that already holds another identity. */
let seedContext = false;
let served: LoopbackApp;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => (seedContext ? requestContext.run({ project: "seed", username: "seed", clientIp: null }, next) : next()));
  app.use(authMiddleware);
  app.all("/whoami", (req, res) => {
    res.json({
      project: req.project,
      username: req.username,
      clientIp: req.clientIp ?? null,
      workspaceId: req.workspaceId ?? null,
      workspaceRoot: req.workspaceRoot ?? null,
      ctx: requestContext.getStore() ?? null,
    });
  });
  served = await serveOnLoopback(app);
});
afterAll(() => served.close());
afterEach(() => {
  seedContext = false;
});

const whoami = async (options: LoopbackRequest = {}, query = "") => WhoAmISchema.parse((await served.request(`/whoami${query}`, options)).body);

describe("authMiddleware identity resolution", () => {
  it("I1 a request with no identity headers gets the default project and username, no workspace, and its peer address", async () => {
    expect(await whoami()).toMatchObject({
      project: DEFAULT_PROJECT,
      username: DEFAULT_USERNAME,
      workspaceId: null,
      workspaceRoot: null,
      clientIp: "127.0.0.1",
    });
  });

  it("I2 the project comes from the query string, then the body, then the x-project header", async () => {
    const headers = { "x-project": "h" };
    expect((await whoami({ headers, json: { project: "b" } }, "?project=q")).project).toBe("q");
    expect((await whoami({ headers, json: { project: "b" } })).project).toBe("b");
    expect((await whoami({ headers })).project).toBe("h");
  });

  it("I3 identity headers are read whatever the casing of their names", async () => {
    const identity = await whoami({ headers: { "X-PROJECT": "p1", "X-Username": "u1", "X-Workspace-Id": "w1", "X-WORKSPACE-ROOT": "/srv/ws" } });
    expect(identity).toMatchObject({ project: "p1", username: "u1", workspaceId: "w1", workspaceRoot: "/srv/ws" });
  });

  it.each([
    ["the first of several hops", "203.0.113.7, 10.0.0.1", "203.0.113.7"],
    ["a padded address", "  203.0.113.9  ", "203.0.113.9"],
    ["an IPv4-mapped IPv6 address", "::ffff:198.51.100.4", "198.51.100.4"],
  ])("I4 the client address is taken from x-forwarded-for: %s", async (_name, forwardedFor, expected) => {
    expect((await whoami({ headers: { "x-forwarded-for": forwardedFor } })).clientIp).toBe(expected);
  });

  it("I5 the username never falls back to the client address", async () => {
    const identity = await whoami({ headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(identity.clientIp).toBe("203.0.113.7");
    expect(identity.username).toBe(DEFAULT_USERNAME);
  });

  it("I6 empty x-project and x-username headers fall back to the defaults", async () => {
    expect(await whoami({ headers: { "x-project": "", "x-username": "" } })).toMatchObject({ project: DEFAULT_PROJECT, username: DEFAULT_USERNAME });
  });

  it("I7 the resolved identity replaces what the open request context held", async () => {
    seedContext = true;
    const named = await whoami({ headers: { "x-project": "p2", "x-username": "u2", "x-workspace-id": "w2" } });
    expect(named.ctx).toMatchObject({ project: "p2", username: "u2", workspaceId: "w2", workspaceRoot: null, clientIp: "127.0.0.1" });

    const anonymous = await whoami();
    expect(anonymous.ctx).toMatchObject({ project: DEFAULT_PROJECT, username: DEFAULT_USERNAME });
  });

  // DEFECT: req.project is not type-checked. A JSON body can set it to an object, which then
  // reaches every consumer that treats it as a string (store keys, Mongo filters). Remove .fails
  // when resolveProject only returns strings.
  it.fails("I8a the project is a string when the body sends an object for it", async () => {
    expect(typeof (await whoami({ json: { project: { $ne: null } } })).project).toBe("string");
  });

  // DEFECT: req.project is not type-checked. A repeated query parameter makes it an array.
  // Remove .fails when resolveProject only returns strings.
  it.fails("I8b the project is a string when the query repeats the parameter", async () => {
    expect(typeof (await whoami({}, "?project=a&project=b")).project).toBe("string");
  });
});
