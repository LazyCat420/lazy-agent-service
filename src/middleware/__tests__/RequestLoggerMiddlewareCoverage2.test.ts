/**
 * Coverage2 for requestLoggerMiddleware: identity resolution, path-based
 * fallback, forwarded-IP normalization, finish-time logging with sizes and
 * the SSE/audio skip rules.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

const fakes = vi.hoisted(() => ({
  requestLogs: [] as unknown[][],
}));

vi.mock("../../utils/logger.ts", () => ({
  default: {
    request: (...args: unknown[]) => {
      fakes.requestLogs.push(args);
    },
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
}));

import { requestLoggerMiddleware } from "../RequestLoggerMiddleware.ts";
import { getRequestContext } from "../../utils/RequestContext.ts";

interface FakeResState {
  statusCode: number;
  headers: Record<string, string | number>;
  finishHandlers: Array<() => void>;
}

const makeRes = () => {
  const state: FakeResState = {
    statusCode: 200,
    headers: {},
    finishHandlers: [],
  };
  const res = {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(code: number) {
      state.statusCode = code;
    },
    getHeader(name: string) {
      return state.headers[name];
    },
    setHeader(name: string, value: string | number) {
      state.headers[name] = value;
      return res;
    },
    on(event: string, handler: () => void) {
      if (event === "finish") state.finishHandlers.push(handler);
      return res;
    },
  };
  const finish = () => state.finishHandlers.forEach((handler) => handler());
  return { res, state, finish };
};

const makeReq = (overrides: Record<string, unknown> = {}) => ({
  headers: {},
  method: "GET",
  originalUrl: "/admin/requests",
  ip: "127.0.0.1",
  on() {
    return undefined;
  },
  ...overrides,
});

describe("requestLoggerMiddleware", () => {
  beforeEach(() => {
    fakes.requestLogs.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the chain inside the async context and logs on finish", async () => {
    const { res, finish } = makeRes();
    const seenContexts: unknown[] = [];
    const next = (() => {
      seenContexts.push(getRequestContext());
    }) as NextFunction;

    const req = makeReq({
      headers: {
        "x-project": "proj",
        "x-username": "alice",
        "x-agent": "coding",
        "x-forwarded-for": "::ffff:10.0.0.9, 10.0.0.1",
        "content-length": "12",
      },
      originalUrl: "/chat",
    });

    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(1000);
    requestLoggerMiddleware(req as unknown as Request, res as unknown as Response, next);

    expect(seenContexts[0]).toEqual({
      project: "proj",
      username: "alice",
      clientIp: "10.0.0.9",
      agent: "coding",
    });
    expect((req as unknown as { agent?: string }).agent).toBe("coding");

    res.setHeader("content-length", "2048");
    res.statusCode = 201;
    nowSpy.mockReturnValueOnce(2250);
    finish();

    expect(fakes.requestLogs).toEqual([
      [
        "proj",
        "alice",
        "10.0.0.9",
        expect.stringMatching(
          /^GET \/chat 201 — 1\.25s \(in: 12\.0 B, out: 2\.00 KB, total: 2\.01 KB\)$/,
        ),
      ],
    ]);
  });

  it("derives project and username from /files/projects paths", () => {
    const { res } = makeRes();
    const seenContexts: unknown[] = [];
    const next = (() => {
      seenContexts.push(getRequestContext());
    }) as NextFunction;

    requestLoggerMiddleware(
      makeReq({
        originalUrl: "/files/projects/notes/bob/file.png?token=1",
        headers: {},
      }) as unknown as Request,
      res as unknown as Response,
      next,
    );

    expect(seenContexts[0]).toMatchObject({
      project: "notes",
      username: "bob",
    });
  });

  it("skips SSE and audio responses", () => {
    const next = (() => undefined) as NextFunction;

    const sse = makeRes();
    sse.res.setHeader("content-type", "text/event-stream");
    requestLoggerMiddleware(
      makeReq() as unknown as Request,
      sse.res as unknown as Response,
      next,
    );
    sse.finish();

    const audio = makeRes();
    audio.res.setHeader("content-type", "audio/mpeg");
    requestLoggerMiddleware(
      makeReq() as unknown as Request,
      audio.res as unknown as Response,
      next,
    );
    audio.finish();

    expect(fakes.requestLogs).toEqual([]);
  });

  it("logs sub-second durations in milliseconds and defaults missing values", () => {
    const { res, finish } = makeRes();
    const next = (() => undefined) as NextFunction;

    const nowSpy = vi.spyOn(performance, "now");
    nowSpy.mockReturnValueOnce(0);
    requestLoggerMiddleware(
      makeReq({ headers: {}, ip: null }) as unknown as Request,
      res as unknown as Response,
      next,
    );

    nowSpy.mockReturnValueOnce(42);
    finish();

    expect(fakes.requestLogs).toEqual([
      [
        "any",
        "any",
        null,
        "GET /admin/requests 200 — 42ms (in: 0 B, out: 0 B, total: 0 B)",
      ],
    ]);
  });
});
