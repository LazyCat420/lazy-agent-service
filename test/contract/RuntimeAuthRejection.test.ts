// Every way runtimeAuth and runtimeAuthOrTrustedPeer turn a caller away: no credential, wrong
// credential, expired or tampered session, wrong-shaped scope, rotated secret, untrusted peer.
// Header cases go over real HTTP on loopback; clock and peer-address cases call the middleware
// directly, because neither can be set from a loopback client. RuntimeAuth.test.ts covers the
// accepted paths.
import crypto from "node:crypto";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { authMiddleware } from "../../src/middleware/AuthMiddleware.ts";
import { issueRuntimeSession, runtimeAuth, runtimeAuthOrTrustedPeer, scopeOwnsRun } from "../../src/middleware/RuntimeAuth.ts";
import { type LoopbackApp, serveOnLoopback } from "../support/loopbackExpress.ts";

const SECRET = crypto.randomBytes(32).toString("hex");
const OTHER_SECRET = crypto.randomBytes(32).toString("hex");
const T = 1_800_000_000_000;
const DAY_MS = 24 * 3_600_000;
const UNAUTHORIZED = { error: { code: "RUNTIME_UNAUTHORIZED" } };
const UNAVAILABLE = { error: { code: "RUNTIME_AUTH_UNAVAILABLE" } };

const validScope = () => ({
  app_id: "obsidian",
  username: "fixture",
  session_id: "vault-1",
  profile_id: "default",
  expires_at: Date.now() + 60_000,
  nonce: crypto.randomUUID(),
});
/** Signs any payload the way issueRuntimeSession does. A string is used as the raw payload text. */
const forge = (scope: unknown, secret = SECRET): string => {
  const payload = Buffer.from(typeof scope === "string" ? scope : JSON.stringify(scope)).toString("base64url");
  return `${payload}.${crypto.createHmac("sha256", secret).update(`runtime-session.v1:${payload}`).digest("base64url")}`;
};
const bearer = (scope: unknown, secret = SECRET) => ({ authorization: `Bearer ${forge(scope, secret)}` });

const GuardedSchema = z.object({ project: z.unknown(), username: z.unknown(), backend: z.boolean(), scope: z.unknown() });

let served: LoopbackApp;
beforeAll(async () => {
  const app = express();
  const handler = (req: Request, res: Response) => {
    res.json({
      project: req.project ?? null,
      username: req.username ?? null,
      backend: res.locals.runtimeBackend === true,
      scope: res.locals.runtimeScope ?? null,
    });
  };
  app.use(authMiddleware);
  app.get("/guarded", runtimeAuth, handler);
  app.get("/read", runtimeAuthOrTrustedPeer, handler);
  served = await serveOnLoopback(app);
});
afterAll(() => served.close());

beforeEach(() => {
  vi.stubEnv("RUNTIME_API_TOKEN", SECRET);
  vi.stubEnv("RUNTIME_AUTH_SECRET", "");
  vi.stubEnv("INTERNAL_EXECUTE_TOKEN", "");
  vi.stubEnv("TRUSTED_INTERNAL_IPS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const guarded = (headers: Record<string, string> = {}) => served.request("/guarded", { headers });
const status = async (headers: Record<string, string>) => (await guarded(headers)).status;

type Middleware = (req: Request, res: Response, next: NextFunction) => void;
interface DirectOutcome {
  /** True when the middleware let the request through. */
  passed: boolean;
  /** What the middleware answered with, when it answered instead of passing the request on. */
  status?: number;
  body?: unknown;
}
/** Calls a middleware with a stand-in request, so the test controls the peer address and the clock. */
function direct(middleware: Middleware, request: { headers?: Record<string, string>; ip?: string } = {}): DirectOutcome {
  const headers = request.headers ?? {};
  const outcome: DirectOutcome = { passed: false };
  const response = {
    locals: {},
    status(code: number) {
      outcome.status = code;
      return response;
    },
    json(body: unknown) {
      outcome.body = body;
      return response;
    },
  };
  // Stand-ins for the Express objects: only the members the guards read exist.
  const req = { ip: request.ip ?? "203.0.113.50", method: "GET", originalUrl: "/x", get: (name: string) => headers[name.toLowerCase()] } as unknown as Request;
  const res = response as unknown as Response;
  middleware(req, res, () => {
    outcome.passed = true;
  });
  return outcome;
}
/** A response carrying only `locals`, which is all scopeOwnsRun reads. */
const responseWith = (locals: Record<string, unknown>) => ({ locals }) as unknown as Response;

describe("runtimeAuth rejections", () => {
  it("R1 a request with no credentials is refused with RUNTIME_UNAUTHORIZED", async () => {
    expect(await guarded()).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R2 with no secret configured every request gets 503 and no session can be issued", async () => {
    vi.stubEnv("RUNTIME_API_TOKEN", "");
    expect(await guarded({ "x-runtime-token": SECRET })).toEqual({ status: 503, body: UNAVAILABLE });
    expect(() => issueRuntimeSession({ ...validScope() })).toThrow("Runtime authentication unavailable");
  });

  it("R3 only the first configured secret source is accepted", async () => {
    const [a, b, c] = [1, 2, 3].map(() => crypto.randomBytes(32).toString("hex"));
    const token = (value: string) => ({ "x-runtime-token": value });
    vi.stubEnv("RUNTIME_API_TOKEN", a);
    vi.stubEnv("RUNTIME_AUTH_SECRET", b);
    vi.stubEnv("INTERNAL_EXECUTE_TOKEN", c);
    expect([await status(token(a)), await status(token(b)), await status(token(c))]).toEqual([200, 401, 401]);

    vi.stubEnv("RUNTIME_API_TOKEN", "");
    expect([await status(token(b)), await status(token(c))]).toEqual([200, 401]);

    vi.stubEnv("RUNTIME_AUTH_SECRET", "");
    expect(await status(token(c))).toBe(200);
  });

  it("R4 credential headers are read whatever the casing of their names", async () => {
    const backend = await guarded({ "X-Runtime-Token": SECRET });
    expect(backend.status).toBe(200);
    expect(GuardedSchema.parse(backend.body)).toMatchObject({ backend: true, scope: null });

    const session = await guarded({ AUTHORIZATION: `Bearer ${forge(validScope())}` });
    expect(session.status).toBe(200);
    expect(GuardedSchema.parse(session.body).backend).toBe(false);
  });

  it.each([
    ["one character short", () => SECRET.slice(0, -1)],
    ["one character long", () => `${SECRET}x`],
    ["a different first character", () => (SECRET.startsWith("0") ? "1" : "0") + SECRET.slice(1)],
    ["a single character", () => "x"],
  ])("R5 a backend token that is %s is refused", async (_name, token) => {
    expect(await guarded({ "x-runtime-token": token() })).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R6 a valid session fixes the identity, whatever the identity headers claim", async () => {
    const scope = validScope();
    const reply = await guarded({ ...bearer(scope), "x-project": "other", "x-username": "mallory" });
    expect(reply.status).toBe(200);
    expect(GuardedSchema.parse(reply.body)).toEqual({ project: "obsidian", username: "fixture", backend: false, scope });
  });

  it("R7a a session whose expiry has passed is refused", async () => {
    expect(await guarded(bearer({ ...validScope(), expires_at: Date.now() - 1 }))).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R7b a session is accepted one millisecond before its expiry and refused at it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const headers = bearer({ ...validScope(), expires_at: T });
    vi.setSystemTime(T - 1);
    expect(direct(runtimeAuth, { headers }).passed).toBe(true);
    vi.setSystemTime(T);
    expect(direct(runtimeAuth, { headers })).toMatchObject({ passed: false, status: 401, body: UNAUTHORIZED });
  });

  it.each<[string, () => unknown]>([
    ["no profile_id", () => (({ profile_id: _profile, ...rest }) => rest)(validScope())],
    ["an extra admin key", () => ({ ...validScope(), admin: true })],
    ["a nonce that is not a UUID", () => ({ ...validScope(), nonce: "not-a-uuid" })],
    ["expires_at as text", () => ({ ...validScope(), expires_at: "soon" })],
    ["a fractional expires_at", () => ({ ...validScope(), expires_at: Date.now() + 60_000.5 })],
    ["an empty app_id", () => ({ ...validScope(), app_id: "" })],
    ["a 129-character username", () => ({ ...validScope(), username: "u".repeat(129) })],
    ["a 257-character session_id", () => ({ ...validScope(), session_id: "s".repeat(257) })],
    ["an array payload", () => []],
    ["a JSON string payload", () => JSON.stringify("str")],
    ["a payload that is not JSON", () => "not json"],
  ])("R8a a correctly signed session with %s is refused", async (_name, payload) => {
    expect(await guarded(bearer(payload()))).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R8b a session at the length limits (128-character username, 256-character session_id) is accepted", async () => {
    expect(await status(bearer({ ...validScope(), username: "u".repeat(128), session_id: "s".repeat(256) }))).toBe(200);
  });

  it.each<[string, () => string]>([
    ["another scope under the first token's signature", () => `${forge({ ...validScope(), username: "admin" }).split(".")[0]}.${forge(validScope()).split(".")[1]}`],
    ["a token signed with another secret", () => forge(validScope(), OTHER_SECRET)],
    ["a third segment", () => `${forge(validScope())}.x`],
    ["an empty signature", () => `${forge(validScope()).split(".")[0]}.`],
    ["no signature", () => forge(validScope()).split(".")[0]],
    ["4,096 characters", () => "x".repeat(4096)],
  ])("R9a a bearer token with %s is refused", async (_name, token) => {
    expect(await guarded({ authorization: `Bearer ${token()}` })).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R9b a valid session sent under the Basic scheme is refused", async () => {
    expect(await guarded({ authorization: `Basic ${forge(validScope())}` })).toEqual({ status: 401, body: UNAUTHORIZED });
  });

  it("R10 a session stops being accepted when the secret is rotated", async () => {
    const headers = bearer(validScope());
    expect(await status(headers)).toBe(200);
    vi.stubEnv("RUNTIME_API_TOKEN", OTHER_SECRET);
    expect(await status(headers)).toBe(401);
  });

  // DEFECT: auth scheme compared case-sensitively (RFC 9110 §11.1 says case-insensitive).
  // "bearer <token>" is refused with 401. Remove .fails when the scheme match ignores case.
  it.fails("R14 a valid session is accepted with the scheme written in lower case", async () => {
    expect(await status({ authorization: `bearer ${forge(validScope())}` })).toBe(200);
  });
});

describe("issueRuntimeSession", () => {
  const request = () => ({ app_id: "obsidian", username: "fixture", session_id: "vault-1", profile_id: "default" });
  const accepted = (token: string) => direct(runtimeAuth, { headers: { authorization: `Bearer ${token}` } }).passed;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
  });

  it("R11a an expiry of now, or more than 24 hours ahead, is refused", () => {
    expect(() => issueRuntimeSession({ ...request(), expires_at: T })).toThrow("Session expiry must be within 24 hours");
    expect(() => issueRuntimeSession({ ...request(), expires_at: T + DAY_MS + 1 })).toThrow("Session expiry must be within 24 hours");
  });

  it("R11b an expiry exactly 24 hours ahead yields a session that runtimeAuth accepts", () => {
    expect(accepted(issueRuntimeSession({ ...request(), expires_at: T + DAY_MS }))).toBe(true);
  });

  it("R11c a scope with an empty app_id is refused", () => {
    expect(() => issueRuntimeSession({ ...request(), app_id: "", expires_at: T + 60_000 })).toThrow();
  });

  it("R11d two sessions for the same scope are different tokens and both are accepted", () => {
    const scope = { ...request(), expires_at: T + 60_000 };
    const [first, second] = [issueRuntimeSession(scope), issueRuntimeSession(scope)];
    expect(first).not.toBe(second);
    expect([accepted(first), accepted(second)]).toEqual([true, true]);
  });
});

describe("scopeOwnsRun", () => {
  it("R12a a backend caller, which has no session scope, owns every run", () => {
    expect(scopeOwnsRun(responseWith({}), { session_id: "anything", profile_id: "anything" })).toBe(true);
  });

  it("R12b a session owns a run only when both its session and its profile match", () => {
    const scope = validScope();
    const response = responseWith({ runtimeScope: scope });
    expect(scopeOwnsRun(response, { session_id: scope.session_id, profile_id: scope.profile_id })).toBe(true);
    expect(scopeOwnsRun(response, { session_id: "vault-2", profile_id: scope.profile_id })).toBe(false);
    expect(scopeOwnsRun(response, { session_id: scope.session_id, profile_id: "other" })).toBe(false);
    expect(scopeOwnsRun(response, { profile_id: scope.profile_id })).toBe(false);
  });
});

describe("runtimeAuthOrTrustedPeer", () => {
  it("R13a an untrusted peer is refused even when x-forwarded-for names a trusted address", () => {
    const outcome = direct(runtimeAuthOrTrustedPeer, { ip: "10.0.0.99", headers: { "x-forwarded-for": "127.0.0.1" } });
    expect(outcome).toMatchObject({ passed: false, status: 401, body: UNAUTHORIZED });
  });

  it("R13b TRUSTED_INTERNAL_IPS adds exact addresses, ignoring the spaces around them", () => {
    vi.stubEnv("TRUSTED_INTERNAL_IPS", " 10.0.0.99 , 10.0.0.98");
    expect(direct(runtimeAuthOrTrustedPeer, { ip: "10.0.0.99" }).passed).toBe(true);
    expect(direct(runtimeAuthOrTrustedPeer, { ip: "10.0.0.9" })).toMatchObject({ passed: false, status: 401 });
  });

  it("R13c a request with no peer address is refused", () => {
    expect(direct(runtimeAuthOrTrustedPeer, { ip: "" })).toMatchObject({ passed: false, status: 401, body: UNAUTHORIZED });
  });

  it("R13d a trusted peer that presents a bad credential is refused", () => {
    const outcome = direct(runtimeAuthOrTrustedPeer, { ip: "127.0.0.1", headers: { authorization: "garbage" } });
    expect(outcome).toMatchObject({ passed: false, status: 401, body: UNAUTHORIZED });
  });

  it("R13e with no secret configured a trusted peer may still read, but any presented credential gets 503", () => {
    vi.stubEnv("RUNTIME_API_TOKEN", "");
    expect(direct(runtimeAuthOrTrustedPeer, { ip: "127.0.0.1" }).passed).toBe(true);
    const outcome = direct(runtimeAuthOrTrustedPeer, { ip: "127.0.0.1", headers: { "x-runtime-token": "anything" } });
    expect(outcome).toMatchObject({ passed: false, status: 503, body: UNAVAILABLE });
  });

  it("R13f over HTTP, a loopback caller reads without credentials and is refused with a wrong one", async () => {
    expect((await served.request("/read")).status).toBe(200);
    expect(await served.request("/read", { headers: { "x-runtime-token": "wrong" } })).toEqual({ status: 401, body: UNAUTHORIZED });
  });
});
