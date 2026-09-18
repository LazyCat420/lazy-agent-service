import { describe, it, expect, vi } from "vitest";
import { bootstrapLocalEnvironment } from "../../bootstrap.ts";

bootstrapLocalEnvironment();

import ScheduledTaskService, { ScheduledTask } from "../ScheduledTaskService.ts";
import AgenticLoopService from "../AgenticLoopService.ts";
import * as providerRegistry from "../../providers/index.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";

describe("ScheduledTaskService — dynamic model resolution", () => {
  it("resolves the live model on a vLLM provider when the configured model is absent", async () => {
    let loopParams: any = null;
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (params: any) => {
      loopParams = params;
      return {} as any;
    });

    const mockProvider = {
      id: "vllm-2",
      name: "Gold Spark",
      listModels: vi.fn().mockResolvedValue({
        data: [{ id: "GLM-5.3-Flash-EXL3" }],
      }),
    };
    vi.spyOn(providerRegistry, "getProvider").mockReturnValue(mockProvider as any);

    let updatedTaskDoc: any = null;
    const insertedConversations: any[] = [];
    const mockDb = {
      collection: (name: string) => ({
        findOne: vi.fn().mockResolvedValue(null),
        insertOne: vi.fn().mockImplementation(async (doc: any) => {
          if (name === "agent_conversations") insertedConversations.push(doc);
          return { insertedId: "mock_id" };
        }),
        updateOne: vi.fn().mockImplementation(async (query: any, update: any) => {
          if (name === "scheduled_tasks") updatedTaskDoc = { query, update };
          return { modifiedCount: 1 };
        }),
      }),
    };

    const originalGetDb = MongoWrapper.getDb;
    MongoWrapper.getDb = (() => mockDb as any);

    try {
      const task: ScheduledTask = {
        id: "task-test-123",
        name: "Test Research Task",
        project: "sun",
        prompt: "Run stock analysis",
        agent: "CUSTOM_OBSIDIAN_GENERAL_ASSISTANT",
        provider: "vllm-2",
        model: "deepseek-v4-flash-0731",
        scheduleType: "daily",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await ScheduledTaskService.executeTask(task);

      expect(loopParams).not.toBeNull();
      expect(loopParams.providerName).toBe("vllm-2");
      expect(loopParams.resolvedModel).toBe("GLM-5.3-Flash-EXL3");

      expect(insertedConversations.length).toBe(1);
      expect(insertedConversations[0].settings.model).toBe("GLM-5.3-Flash-EXL3");

      expect(updatedTaskDoc).not.toBeNull();
      expect(updatedTaskDoc.query).toEqual({ id: "task-test-123" });
      expect(updatedTaskDoc.update.$set.model).toBe("GLM-5.3-Flash-EXL3");
    } finally {
      MongoWrapper.getDb = originalGetDb;
      vi.restoreAllMocks();
    }
  });

  it("preserves the configured model if it is already loaded on the vLLM provider", async () => {
    let loopParams: any = null;
    vi.spyOn(AgenticLoopService, "runAgenticLoop").mockImplementation(async (params: any) => {
      loopParams = params;
      return {} as any;
    });

    const mockProvider = {
      id: "vllm-2",
      name: "Gold Spark",
      listModels: vi.fn().mockResolvedValue({
        data: [{ id: "GLM-5.3-Flash-EXL3" }],
      }),
    };
    vi.spyOn(providerRegistry, "getProvider").mockReturnValue(mockProvider as any);

    let taskUpdateCount = 0;
    const mockDb = {
      collection: (name: string) => ({
        findOne: vi.fn().mockResolvedValue(null),
        insertOne: vi.fn().mockResolvedValue({ insertedId: "mock_id" }),
        updateOne: vi.fn().mockImplementation(async () => {
          if (name === "scheduled_tasks") taskUpdateCount++;
          return { modifiedCount: 1 };
        }),
      }),
    };

    const originalGetDb = MongoWrapper.getDb;
    MongoWrapper.getDb = (() => mockDb as any);

    try {
      const task: ScheduledTask = {
        id: "task-test-valid",
        name: "Valid Task",
        project: "sun",
        prompt: "Run stock analysis",
        agent: "CUSTOM_OBSIDIAN_GENERAL_ASSISTANT",
        provider: "vllm-2",
        model: "GLM-5.3-Flash-EXL3",
        scheduleType: "daily",
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await ScheduledTaskService.executeTask(task);

      expect(loopParams).not.toBeNull();
      expect(loopParams.resolvedModel).toBe("GLM-5.3-Flash-EXL3");
      expect(taskUpdateCount).toBe(0);
    } finally {
      MongoWrapper.getDb = originalGetDb;
      vi.restoreAllMocks();
    }
  });
});
