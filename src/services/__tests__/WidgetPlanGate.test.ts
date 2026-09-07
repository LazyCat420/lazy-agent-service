import { describe, it, expect } from "vitest";
import { evaluateWidgetPlan, checkCreateAgainstPlan } from "../WidgetPlanGate.ts";

// plan_widget used to set a boolean and answer "approved" to ANY call — an
// empty object approved create_widget. A plan is a contract: it names the
// type and says what the widget does, and create_widget must honour it.

describe("evaluateWidgetPlan", () => {
  it("rejects an empty plan", () => {
    const r = evaluateWidgetPlan({});
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(expect.arrayContaining(["widgetType", "title", "description"]));
  });

  it("rejects a description too short to be a design", () => {
    const r = evaluateWidgetPlan({ widgetType: "custom", title: "Counter", description: "counts" });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("description");
  });

  it("accepts a real plan and returns it normalised", () => {
    const r = evaluateWidgetPlan({
      widgetType: "custom", title: "  Push-up counter ",
      description: "A big number with +1 and reset buttons, persisted in a JS variable.",
    });
    expect(r.ok).toBe(true);
    expect(r.plan).toEqual({
      widgetType: "custom", title: "Push-up counter",
      description: "A big number with +1 and reset buttons, persisted in a JS variable.",
    });
  });

  it("rejects an unknown widget type", () => {
    const r = evaluateWidgetPlan({ widgetType: "rocket", title: "x", description: "a".repeat(30) });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain("widgetType");
  });
});

describe("checkCreateAgainstPlan", () => {
  const plan = { widgetType: "custom", title: "Counter", description: "a".repeat(30) };

  it("passes a create that matches the planned type", () => {
    expect(checkCreateAgainstPlan(plan, { widgetType: "custom", title: "Counter" }).ok).toBe(true);
  });

  it("refuses a create whose type differs from the plan", () => {
    const r = checkCreateAgainstPlan(plan, { widgetType: "clock", title: "Counter" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("PLAN_MISMATCH");
  });

  it("refuses a create with no plan at all", () => {
    const r = checkCreateAgainstPlan(undefined, { widgetType: "custom" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("PLANNING_REQUIRED");
  });
});
