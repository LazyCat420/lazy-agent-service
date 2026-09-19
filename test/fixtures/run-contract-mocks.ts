import { CreateRunRequest, RunResult, RunEvent } from "../../src/types/run.ts";

export const mockCreateRunRequest: CreateRunRequest = {
  profileId: "test-profile-1",
  input: "Hello, agent!",
  model: "test-model-v1",
  budget: {
    maxTokens: 1000,
    maxToolCalls: 5,
    maxRetries: 2,
  },
  stream: true,
};

export const mockRunEventStream: RunEvent[] = [
  {
    id: "evt-1",
    runId: "run-123",
    type: "run.created",
    data: { status: "queued", profileId: "test-profile-1" },
    timestamp: "2026-09-18T23:00:00Z"
  },
  {
    id: "evt-2",
    runId: "run-123",
    type: "run.started",
    data: { status: "in_progress" },
    timestamp: "2026-09-18T23:00:01Z"
  },
  {
    id: "evt-3",
    runId: "run-123",
    type: "message.delta",
    data: { text: "Hello there!" },
    timestamp: "2026-09-18T23:00:02Z"
  },
  {
    id: "evt-4",
    runId: "run-123",
    type: "run.completed",
    data: {
      status: "completed",
      messages: [{ role: "assistant", content: "Hello there!" }],
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, toolCalls: 0 }
    },
    timestamp: "2026-09-18T23:00:03Z"
  }
];

export const mockRunResult: RunResult = {
  id: "run-123",
  status: "completed",
  messages: [{ role: "assistant", content: "Hello there!" }],
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    toolCalls: 0
  }
};
