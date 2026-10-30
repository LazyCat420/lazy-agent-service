/**
 * ConversationTimerService — timer creation validation, the daemon tick
 * (expiry, deferral, cron scheduling, atomic claim, one-shot wake-ups) and
 * the background agentic loop invocation.
 *
 * Mongo is a fake document store, AgenticLoopService/ConversationService are
 * fakes at the persistence boundary, and the clock is fixed with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  getDb: vi.fn(),
  appendMessages: vi.fn(),
  setGenerating: vi.fn(),
  runAgenticLoop: vi.fn(),
  getProvider: vi.fn(),
  getModelByName: vi.fn(),
  matchCron: vi.fn(),
  admit: vi.fn(),
}));

vi.mock("../../wrappers/MongoWrapper.ts", () => ({ default: { getDb: fakes.getDb } }));
vi.mock("../AgenticLoopService.ts", () => ({ default: { runAgenticLoop: fakes.runAgenticLoop } }));
vi.mock("../conversation/ConversationService.ts", () => ({
  default: { appendMessages: fakes.appendMessages, setGenerating: fakes.setGenerating },
}));
vi.mock("../../providers/index.ts", () => ({ getProvider: fakes.getProvider }));
vi.mock("../config.ts", () => ({ getModelByName: fakes.getModelByName }));
vi.mock("../ScheduledTaskService.ts", () => ({ matchCron: fakes.matchCron }));
vi.mock("../InternalLoopRunner.ts", () => ({ InternalLoopRunner: { admit: fakes.admit } }));
vi.mock("../../utils/CleanupRegistry.ts", () => ({ registerCleanup: vi.fn() }));
vi.mock("../../utils/logger.ts", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), success: vi.fn() },
}));

import ConversationTimerService from "../ConversationTimerService.ts";

type Any = Record<string, unknown>;

const AGENT_CONVERSATIONS = "agent_conversations";
const MODEL_CONVERSATIONS = "model_conversations";

interface FakeDbOptions {
  dueTimers?: Any[];
  conversations?: Record<string, Any | null>;
  claimResult?: Any | null;
}

const makeDb = ({ dueTimers = [], conversations = {}, claimResult = { id: "claimed" } }: FakeDbOptions = {}) => {
  const calls: Record<string, Any[]> = { updateOne: [], updateMany: [], findOneAndUpdate: [] };
  const collection = (name: string) => ({
    find: vi.fn(() => ({ toArray: vi.fn(async () => dueTimers) })),
    findOne: vi.fn(async () => conversations[name] ?? null),
    findOneAndUpdate: vi.fn(async (filter: Any, update: Any) => {
      calls.findOneAndUpdate.push({ filter, update });
      return claimResult;
    }),
    insertOne: vi.fn(async (document: Any) => {
      calls.insertOne = [document];
      return { acknowledged: true };
    }),
    updateOne: vi.fn(async (filter: Any, update: Any) => {
      calls.updateOne.push({ filter, update });
      return { modifiedCount: 1 };
    }),
    updateMany: vi.fn(async (filter: Any, update: Any) => {
      calls.updateMany.push({ filter, update });
      return { modifiedCount: 1 };
    }),
  });
  return { collection, calls };
};

const timer = (overrides: Any = {}) => ({
  id: "timer-1",
  conversationId: "conv-1",
  project: "proj",
  username: "alice",
  prompt: "remind me",
  mode: "one_shot",
  iterationCount: 0,
  firesAt: "2026-10-30T10:00:00.000Z",
  status: "active",
  createdAt: "2026-10-30T09:00:00.000Z",
  updatedAt: "2026-10-30T09:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z"));
  vi.clearAllMocks();
  fakes.appendMessages.mockResolvedValue({});
  fakes.setGenerating.mockResolvedValue(undefined);
  fakes.runAgenticLoop.mockResolvedValue(undefined);
  fakes.getProvider.mockReturnValue({ generateTextStream: vi.fn() });
  fakes.getModelByName.mockReturnValue({ maxOutputTokens: 8192 });
  fakes.matchCron.mockReturnValue(true);
  fakes.admit.mockRejectedValue(new Error("no profile"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTimer", () => {
  it("throws without a database", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(
      ConversationTimerService.createTimer({ conversationId: "c", project: "p", username: "u", prompt: "x" }),
    ).rejects.toThrow("Database connection unavailable");
  });

  it("rejects out-of-range one-shot durations", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    await expect(
      ConversationTimerService.createTimer({ conversationId: "c", project: "p", username: "u", prompt: "x", durationSeconds: 0 }),
    ).rejects.toThrow("One-shot duration must be between 1 and 86400 seconds");
    await expect(
      ConversationTimerService.createTimer({ conversationId: "c", project: "p", username: "u", prompt: "x", durationSeconds: 90000 }),
    ).rejects.toThrow("One-shot duration must be between 1 and 86400 seconds");
  });

  it("persists a one-shot timer with the computed fire time", async () => {
    const db = makeDb();
    fakes.getDb.mockReturnValue(db);

    const created = await ConversationTimerService.createTimer({
      conversationId: "conv-1",
      project: "proj",
      username: "alice",
      prompt: "remind me",
      durationSeconds: 60,
    });

    expect(created).toMatchObject({
      conversationId: "conv-1",
      mode: "one_shot",
      firesAt: "2026-10-30T10:01:00.000Z",
      iterationCount: 0,
      status: "active",
    });
    expect(db.calls.insertOne).toEqual([expect.objectContaining({ id: created.id })]);
  });

  it("rejects malformed cron expressions", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    await expect(
      ConversationTimerService.createTimer({ conversationId: "c", project: "p", username: "u", prompt: "x", cronExpression: "* * *" }),
    ).rejects.toThrow("A valid 5-field cron expression is required");
  });

  it("persists a recurring timer at the next minute boundary", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    const created = await ConversationTimerService.createTimer({
      conversationId: "conv-1",
      project: "proj",
      username: "alice",
      prompt: "every minute",
      cronExpression: "* * * * *",
    });
    expect(created).toMatchObject({ mode: "recurring", firesAt: "2026-10-30T10:01:00.000Z" });
  });
});

describe("tick", () => {
  it("does nothing without a database", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(ConversationTimerService.tick()).resolves.toBeUndefined();
    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("does nothing when no timer is due", async () => {
    fakes.getDb.mockReturnValue(makeDb({ dueTimers: [] }));
    await ConversationTimerService.tick();
    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("expires a timer whose conversation no longer exists", async () => {
    const db = makeDb({ dueTimers: [timer()] });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(db.calls.updateOne).toEqual([
      expect.objectContaining({ filter: { id: "timer-1" }, update: { $set: expect.objectContaining({ status: "expired" }) } }),
    ]);
    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("defers when the conversation is generating", async () => {
    const db = makeDb({
      dueTimers: [timer()],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1", isGenerating: true } },
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).not.toHaveBeenCalled();
    expect(db.calls.findOneAndUpdate).toHaveLength(0);
  });

  it("fires a one-shot timer, appends the reminder and starts the loop", async () => {
    const db = makeDb({
      dueTimers: [timer()],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1", settings: { provider: "lm-studio", model: "m" } } },
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).toHaveBeenCalledWith(
      "conv-1",
      "proj",
      "alice",
      [expect.objectContaining({ role: "user", content: "🔔 Notification: remind me", _alreadyPersisted: true })],
      null,
      { collection: AGENT_CONVERSATIONS },
    );
    expect(db.calls.findOneAndUpdate[0].update.$set).toMatchObject({ status: "fired", iterationCount: 1 });
    expect(db.calls.updateMany[0].filter).toMatchObject({ mode: "one_shot", id: { $ne: "timer-1" } });
    await vi.waitFor(() =>
      expect(fakes.setGenerating).toHaveBeenCalledWith(
        "conv-1", "proj", "alice", true, { collection: AGENT_CONVERSATIONS, agent: undefined },
      ),
    );
    expect(fakes.runAgenticLoop).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", userMessage: expect.objectContaining({ content: "🔔 Notification: remind me" }) }),
    );
  });

  it("falls back to model conversations when the agent conversation is absent", async () => {
    const db = makeDb({
      dueTimers: [timer()],
      conversations: { [MODEL_CONVERSATIONS]: { id: "conv-1", settings: {} } },
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).toHaveBeenCalledWith(
      "conv-1", "proj", "alice", expect.any(Array), null, { collection: MODEL_CONVERSATIONS },
    );
  });

  it("reschedules a recurring timer that is not due for its cron minute", async () => {
    const db = makeDb({
      dueTimers: [timer({ mode: "recurring", cronExpression: "0 12 * * *" })],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1" } },
    });
    fakes.getDb.mockReturnValue(db);
    fakes.matchCron.mockReturnValue(false);

    await ConversationTimerService.tick();

    expect(db.calls.updateOne[0].update.$set.firesAt).toBe("2026-10-30T10:01:00.000Z");
    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("skips a timer already fired in the same minute", async () => {
    const now = new Date("2026-10-30T10:00:00.000Z");
    const minuteKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const db = makeDb({
      dueTimers: [timer({ mode: "recurring", cronExpression: "* * * * *", lastFiredMinuteKey: minuteKey })],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1" } },
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("expires a recurring timer that reached maxIterations", async () => {
    const db = makeDb({
      dueTimers: [timer({ mode: "recurring", cronExpression: "* * * * *", iterationCount: 2, maxIterations: 3 })],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1" } },
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(db.calls.findOneAndUpdate[0].update.$set).toMatchObject({ status: "expired", iterationCount: 3 });
  });

  it("skips a timer already claimed by another tick", async () => {
    const db = makeDb({
      dueTimers: [timer()],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1" } },
      claimResult: null,
    });
    fakes.getDb.mockReturnValue(db);

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).not.toHaveBeenCalled();
  });

  it("continues to the next timer when one fails", async () => {
    const db = makeDb({
      dueTimers: [timer({ id: "timer-1" }), timer({ id: "timer-2" })],
      conversations: { [AGENT_CONVERSATIONS]: { id: "conv-1" } },
    });
    fakes.getDb.mockReturnValue(db);
    fakes.appendMessages.mockRejectedValueOnce(new Error("append failed"));

    await ConversationTimerService.tick();

    expect(fakes.appendMessages).toHaveBeenCalledTimes(2);
  });
});

describe("executeAgenticLoop", () => {
  const reminder = { role: "user", content: "🔔 Notification: remind me" };

  it("returns without a database", async () => {
    fakes.getDb.mockReturnValue(null);
    await expect(
      ConversationTimerService.executeAgenticLoop(timer() as never, {}, reminder as never),
    ).resolves.toBeUndefined();
  });

  it("throws when the conversation has no provider or model", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    await expect(
      ConversationTimerService.executeAgenticLoop(timer() as never, { settings: {} }, reminder as never),
    ).rejects.toThrow("Invalid model/provider settings");
  });

  it("throws when the provider is unavailable", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    fakes.getProvider.mockReturnValue(undefined);
    await expect(
      ConversationTimerService.executeAgenticLoop(
        timer() as never,
        { settings: { provider: "lm-studio", model: "m" } },
        reminder as never,
      ),
    ).rejects.toThrow("LLM provider lm-studio is unavailable");
  });

  it("runs the agentic loop and clears the generating flag", async () => {
    fakes.getDb.mockReturnValue(makeDb());

    await ConversationTimerService.executeAgenticLoop(
      timer() as never,
      {
        settings: { provider: "lm-studio", model: "m", agent: "CODING", toolConfig: { enabledTools: ["read_file"] } },
        messages: [{ role: "user", content: "earlier" }],
        title: "Session",
      },
      reminder as never,
    );

    expect(fakes.runAgenticLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        providerName: "lm-studio",
        resolvedModel: "m",
        messages: [{ role: "user", content: "earlier" }, reminder],
        conversationId: "conv-1",
        agent: "CODING",
        options: expect.objectContaining({ autoApprove: true, enabledTools: ["read_file"] }),
        conversationMeta: { title: "Session", settings: expect.objectContaining({ provider: "lm-studio" }) },
      }),
    );
    expect(fakes.setGenerating).toHaveBeenNthCalledWith(1, "conv-1", "proj", "alice", true, { collection: AGENT_CONVERSATIONS, agent: "CODING" });
    expect(fakes.setGenerating).toHaveBeenNthCalledWith(2, "conv-1", "proj", "alice", false, { collection: AGENT_CONVERSATIONS });
  });

  it("rethrows a loop failure but still clears the generating flag", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    fakes.runAgenticLoop.mockRejectedValue(new Error("loop crashed"));

    await expect(
      ConversationTimerService.executeAgenticLoop(
        timer() as never,
        { settings: { provider: "lm-studio", model: "m" } },
        reminder as never,
      ),
    ).rejects.toThrow("loop crashed");

    expect(fakes.setGenerating).toHaveBeenLastCalledWith("conv-1", "proj", "alice", false, { collection: AGENT_CONVERSATIONS });
  });

  it("passes admission runtime tools when the profile admits the run", async () => {
    fakes.getDb.mockReturnValue(makeDb());
    fakes.admit.mockResolvedValue({
      runtimeTools: [{ name: "read_file" }],
      runtimeToolExecutor: vi.fn(),
      runId: "run-1",
    });

    await ConversationTimerService.executeAgenticLoop(
      timer() as never,
      { settings: { provider: "lm-studio", model: "m" } },
      reminder as never,
    );

    expect(fakes.runAgenticLoop).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", runtimeTools: [{ name: "read_file" }] }),
    );
  });
});
