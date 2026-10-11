import { describe, expect, it } from "vitest";
import { scheduleToolCalls } from "../ToolScheduling.ts";

describe("scheduleToolCalls (audit e23d775 parallel chat tools)", () => {
  it("bounds read concurrency and runs writes serially in model order", async () => {
    let live = 0;
    let peak = 0;
    let writesLive = 0;
    const order: string[] = [];
    const calls = ["r1", "w1", "r2", "r3", "w2", "r4", "r5"];
    await scheduleToolCalls(
      calls,
      async (name) => {
        live++;
        peak = Math.max(peak, live);
        if (name.startsWith("w")) {
          writesLive++;
          expect(writesLive).toBe(1);
        }
        await new Promise((r) => setTimeout(r, 5));
        order.push(name);
        if (name.startsWith("w")) writesLive--;
        live--;
      },
      (name) => name.startsWith("r"),
      2,
    );
    expect(peak).toBe(2);
    expect(order.filter((n) => n.startsWith("w"))).toEqual(["w1", "w2"]);
    expect(order.slice(-2)).toEqual(["w1", "w2"]);
  });
});
