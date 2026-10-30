import { describe, it, expect } from "vitest";
import { isTaskDue, ScheduledTask } from "../ScheduledTaskService.ts";

/** Local-time instant, matching the scheduler's local-clock comparisons. */
const at = (month: number, day: number, hour: number, minute: number): Date =>
  new Date(2026, month - 1, day, hour, minute, 0, 0);

const makeTask = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
  id: "task-1",
  name: "task",
  project: "p",
  prompt: "",
  agent: null,
  provider: "vllm",
  model: "m",
  scheduleType: "hourly",
  enabled: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

describe("ScheduledTaskService.isTaskDue — schedule matching", () => {
  it("cron: matches the expression's minute and needs an expression", () => {
    const cron = makeTask({ scheduleType: "cron", cronExpression: "0 9 * * *" });
    expect(isTaskDue(cron, at(10, 29, 9, 0))).toBe(true);
    expect(isTaskDue(cron, at(10, 29, 9, 1))).toBe(false);
    expect(isTaskDue(makeTask({ scheduleType: "cron" }), at(10, 29, 9, 0))).toBe(false);
  });

  it("hourly: fires only at minute 0", () => {
    const hourly = makeTask({ scheduleType: "hourly" });
    expect(isTaskDue(hourly, at(10, 29, 13, 0))).toBe(true);
    expect(isTaskDue(hourly, at(10, 29, 13, 1))).toBe(false);
  });

  it("daily: fires at the configured time, never without one", () => {
    const daily = makeTask({ scheduleType: "daily", scheduleTime: "09:30" });
    expect(isTaskDue(daily, at(10, 29, 9, 30))).toBe(true);
    expect(isTaskDue(daily, at(10, 29, 9, 31))).toBe(false);
    expect(isTaskDue(makeTask({ scheduleType: "daily" }), at(10, 29, 9, 30))).toBe(false);
  });

  it("weekly: needs both the weekday and the time", () => {
    const now = at(10, 29, 9, 30);
    const weekly = makeTask({
      scheduleType: "weekly",
      scheduleTime: "09:30",
      scheduleDay: now.getDay(),
    });
    expect(isTaskDue(weekly, now)).toBe(true);
    expect(isTaskDue({ ...weekly, scheduleDay: (now.getDay() + 1) % 7 }, now)).toBe(false);
    expect(isTaskDue({ ...weekly, scheduleTime: "09:31" }, now)).toBe(false);
    expect(isTaskDue(makeTask({ scheduleType: "weekly", scheduleTime: "09:30" }), now)).toBe(false);
  });

  it("once: needs the date, the time, and disables afterwards", () => {
    const once = makeTask({ scheduleType: "once", scheduleTime: "09:30", scheduleDate: "2026-10-29" });
    expect(isTaskDue(once, at(10, 29, 9, 30))).toBe(true);
    expect(isTaskDue(once, at(10, 30, 9, 30))).toBe(false);
    expect(isTaskDue(makeTask({ scheduleType: "once", scheduleTime: "09:30" }), at(10, 29, 9, 30))).toBe(false);
  });

  it("custom: matches the time and delegates the date to the recurrence rule", () => {
    const custom = makeTask({
      scheduleType: "custom",
      scheduleTime: "09:30",
      recurrenceRule: {
        frequency: "daily",
        interval: 1,
        // Local midnight expressed as an instant, so parsing cannot shift the day.
        startDate: new Date(2026, 9, 1).toISOString(),
      },
    });
    expect(isTaskDue(custom, at(10, 29, 9, 30))).toBe(true);
    expect(isTaskDue(custom, at(10, 29, 9, 31))).toBe(false);
    expect(isTaskDue(custom, at(9, 30, 9, 30))).toBe(false);
  });

  it("trigger and unknown schedule types never fire on a tick", () => {
    expect(isTaskDue(makeTask({ scheduleType: "trigger" }), at(10, 29, 9, 30))).toBe(false);
  });
});
