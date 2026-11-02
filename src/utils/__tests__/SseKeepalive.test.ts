import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import { shouldSendKeepalive, writeSseKeepalive } from "../SseUtilities.ts";

function mockRes(overrides: Record<string, unknown> = {}) {
  return {
    write: vi.fn(),
    destroyed: false,
    writableEnded: false,
    ...overrides,
  } as unknown as Response;
}

describe("shouldSendKeepalive", () => {
  it("is true for an open, unaborted connection", () => {
    expect(shouldSendKeepalive(new AbortController().signal, mockRes())).toBe(true);
  });
  it("is false when aborted, destroyed or ended", () => {
    const c = new AbortController();
    c.abort();
    expect(shouldSendKeepalive(c.signal, mockRes())).toBe(false);
    const live = new AbortController().signal;
    expect(shouldSendKeepalive(live, mockRes({ destroyed: true }))).toBe(false);
    expect(shouldSendKeepalive(live, mockRes({ writableEnded: true }))).toBe(false);
  });
});

describe("writeSseKeepalive", () => {
  it("writes the comment and flushes when flush exists", () => {
    const flush = vi.fn();
    const res = mockRes({ flush });
    writeSseKeepalive(res);
    expect(res.write).toHaveBeenCalledWith(": keepalive\n\n");
    expect(flush).toHaveBeenCalledOnce();
  });
  it("cork/uncorks the socket when no flush exists", () => {
    const socket = { destroyed: false, cork: vi.fn(), uncork: vi.fn() };
    writeSseKeepalive(mockRes({ socket }));
    expect(socket.uncork).toHaveBeenCalledTimes(2);
    expect(socket.cork).toHaveBeenCalledOnce();
  });
  it("skips a destroyed socket", () => {
    const socket = { destroyed: true, cork: vi.fn(), uncork: vi.fn() };
    writeSseKeepalive(mockRes({ socket }));
    expect(socket.cork).not.toHaveBeenCalled();
  });
  it("swallows write errors", () => {
    const res = mockRes({
      write: vi.fn(() => {
        throw new Error("boom");
      }),
    });
    expect(() => writeSseKeepalive(res)).not.toThrow();
  });
});
