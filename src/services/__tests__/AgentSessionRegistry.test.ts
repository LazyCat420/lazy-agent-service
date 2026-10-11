import { describe, expect, it } from "vitest";
import AgentSessionRegistry from "../AgentSessionRegistry.ts";

describe("AgentSessionRegistry cleanup ownership (audit D9)", () => {
  it("a finished older request does not remove the newer request's entry", () => {
    const first = AgentSessionRegistry.register("conv-overlap");
    const second = AgentSessionRegistry.register("conv-overlap");
    expect(first.signal.aborted).toBe(true); // superseded
    AgentSessionRegistry.cleanup("conv-overlap", first);
    expect(AgentSessionRegistry.isActive("conv-overlap")).toBe(true);
    expect(AgentSessionRegistry.stop("conv-overlap")).toBe(true);
    expect(second.signal.aborted).toBe(true);
    AgentSessionRegistry.cleanup("conv-overlap", second);
    expect(AgentSessionRegistry.stop("conv-overlap")).toBe(false);
  });
});
