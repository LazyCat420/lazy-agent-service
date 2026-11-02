import { describe, expect, it } from "vitest";
import { buildCoreLoopHooks } from "../RunsAdapter.ts";
import type { ChatMessage } from "../types.ts";

const msgs = [{ role: "user", content: "hi" }] as unknown as ChatMessage[];

describe("buildCoreLoopHooks", () => {
  it("preserves external hooks after the built-in beforeModelCall", () => {
    const ext = () => undefined;
    const hooks = buildCoreLoopHooks(msgs, [{ name: "a" }], undefined, {
      beforeModelCall: [ext as never],
    });
    expect(hooks.beforeModelCall).toHaveLength(2);
    expect(hooks.beforeModelCall?.[1]).toBe(ext);
  });
  it("emits a tool-loadout delta reminder once after the tool set changes", async () => {
    const tools = [{ name: "a" }];
    const hooks = buildCoreLoopHooks(msgs, tools, 1_000_000);
    const before = hooks.beforeModelCall?.[0] as (m: ChatMessage[], s: number) => ChatMessage[];
    expect(before(msgs, 0)).toHaveLength(1);
    tools.push({ name: "b" });
    const withDelta = before(msgs, 1);
    expect(withDelta).toHaveLength(2);
    expect(before(msgs, 2)).toHaveLength(1);
  });
});
