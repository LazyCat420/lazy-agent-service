/**
 * CodeInterpreter — Hermes escape-hatch tests (PLAN_hermes.md §4).
 *
 *   - safe javascript blocks execute and return console output
 *   - forbidden capabilities (require/import/process/fs/child_process) are
 *     refused with a structured observation
 *   - python blocks get the "not available on this runtime" observation
 *   - a registered code tool is preferred over the local fallback
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../wrappers/MongoWrapper.ts", () => {
  class MongoWrapper {
    static getDb() {
      return null;
    }
    static getCollection() {
      return null;
    }
    static getClient() {
      return null;
    }
  }
  return { default: MongoWrapper };
});

vi.mock("../RequestLogger.ts", () => ({
  default: {
    insertPending: async () => null,
    logChatGeneration: async () => {},
    log: async () => {},
  },
}));

vi.mock("../../../platform/trace/TraceExporter.ts", () => {
  class TraceExporter {
    private static instance = new TraceExporter();
    static getGlobalInstance() {
      return TraceExporter.instance;
    }
    enqueueSpan() {}
    getQueuedSpans() {
      return [];
    }
  }
  return { TraceExporter };
});

import PromptedToolCallingHarness from "../PromptedToolCallingHarness.ts";
import AgenticLoopState from "../../AgenticLoopState.ts";
import {
  executeJavaScript,
  extractCodeFence,
  partitionCodeInterpreterCalls,
  runCodeInterpreter,
  scanForForbiddenCode,
} from "../CodeInterpreter.ts";
import type { AgenticContext, ConversationMessage, ToolCall, ToolSchema } from "../types.ts";

const TOOLS: ToolSchema[] = [
  {
    name: "get_market_data",
    description: "Fetch market data for a ticker.",
    parameters: {
      type: "object",
      properties: { ticker: { type: "string" } },
      required: ["ticker"],
    },
  },
];

const TOOLS_WITH_CODE_INTERPRETER: ToolSchema[] = [
  ...TOOLS,
  {
    name: "code_interpreter",
    description: "Registered sandboxed code execution.",
    parameters: { type: "object", properties: {} },
  },
];

interface ProviderCall {
  messages: Array<{ role: string; content: unknown }>;
  model: string;
  options: Record<string, unknown>;
}

function scriptedProvider(responses: string[], calls: ProviderCall[] = []) {
  return {
    generateTextStream(
      messages: Array<{ role: string; content: unknown }>,
      model: string,
      options: Record<string, unknown>,
    ) {
      calls.push({ messages, model, options });
      const text = responses.shift() ?? "";
      return (async function* () {
        if (text) yield text;
      })();
    },
  };
}

function makeContext(
  provider: unknown,
  finalTools: ToolSchema[],
): { context: AgenticContext; executed: Array<{ name: string; args: Record<string, unknown> }> } {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const context = {
    options: { maxIterations: 6, maxTokens: 100000, autoApprove: true },
    messages: [{ role: "user", content: "compute something" }],
    project: "test",
    username: "tester",
    modelDefinition: null,
    agentConversationId: "conv-test",
    conversationId: "conv-test",
    provider,
    providerName: "mock",
    resolvedModel: "mock-model",
    signal: null,
    emit: () => {},
    runtimeTools: { finalTools, resolvedEnabledTools: null },
    runtimeToolExecutor: async (call: { name: string; args: Record<string, unknown> }) => {
      executed.push({ name: call.name, args: call.args });
      return { ok: true, via: "registered-tool" };
    },
    requestId: "test-req",
    traceId: "test-trace",
  } as unknown as AgenticContext;
  return { context, executed };
}

async function runHarness(context: AgenticContext) {
  const harness = new PromptedToolCallingHarness(
    context,
    new AgenticLoopState({ originalMessageCount: 1 }),
    context.runtimeTools,
  );
  return harness.run();
}

function codeInterpreterCall(args: Record<string, unknown>): ToolCall {
  return { id: "ci-1", name: "code_interpreter", args };
}

describe("static guard scan", () => {
  it("flags each forbidden capability", () => {
    expect(scanForForbiddenCode('const p = require("fs");')).toBe("require(");
    expect(scanForForbiddenCode("import path from 'path'")).toBe("import");
    expect(scanForForbiddenCode("process.exit(0)")).toBe("process.");
    expect(scanForForbiddenCode("fs.readFileSync('/etc/passwd')")).toBe("fs");
    expect(scanForForbiddenCode("spawn via child_process")).toBe("child_process");
  });

  it("passes pure computation", () => {
    expect(scanForForbiddenCode("const offset = 3; [1,2,3].map(x => x + offset)")).toBeNull();
  });
});

describe("extractCodeFence", () => {
  it("extracts language and body", () => {
    const fence = extractCodeFence("here:\n```javascript\nconsole.log(1 + 1);\n```\ndone");
    expect(fence?.info).toBe("javascript");
    expect(fence?.code).toBe("console.log(1 + 1);\n");
  });
});

describe("runCodeInterpreter (pure fallback)", () => {
  it("executes a safe javascript block and captures console output", async () => {
    const result = await runCodeInterpreter({
      code: "```javascript\nconst squares = [1, 2, 3].map(n => n * n);\nconsole.log('squares:', squares);\nconsole.log('sum', 6);\n```",
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual(["squares: [1,4,9]", "sum 6"]);
  });

  it("surfaces the completion value", async () => {
    const result = await runCodeInterpreter({
      code: "```js\nreturn 40 + 2;\n```",
    });
    expect(result.success).toBe(true);
    expect(result.returned).toBe(42);
  });

  it("refuses code containing require( with a structured observation", async () => {
    const result = await runCodeInterpreter({
      code: "```javascript\nconst fs = require('fs');\nconsole.log(fs);\n```",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("CODE_INTERPRETER_REFUSED");
    expect(result.message).toContain("forbidden");
    expect(result.message).toContain("require(");
  });

  it("refuses import/process/fs/child_process access", async () => {
    for (const snippet of [
      "```javascript\nimport { readFile } from 'node:fs';\n```",
      "```javascript\nprocess.env.SECRET;\n```",
      "```javascript\nfs.writeFile('x', 'y');\n```",
      "```javascript\nchild_process.exec('ls');\n```",
    ]) {
      const result = await runCodeInterpreter({ code: snippet });
      expect(result.success).toBe(false);
      expect(result.error).toBe("CODE_INTERPRETER_REFUSED");
    }
  });

  it("returns the python-unavailable observation for python blocks", async () => {
    const result = await runCodeInterpreter({
      code: "```python\nprint('hello')\n```",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("PYTHON_UNAVAILABLE");
    expect(result.message).toBe("python execution is not available on this runtime");
  });

  it("reports a structured error for a failing javascript block", async () => {
    const result = await runCodeInterpreter({
      code: "```javascript\nnull.property;\n```",
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe("CODE_INTERPRETER_ERROR");
  });

  it("enforces the completion deadline", async () => {
    const result = await executeJavaScript("return new Promise(() => {});", 50);
    expect(result.success).toBe(false);
    expect(result.error).toBe("CODE_INTERPRETER_ERROR");
    expect(result.message).toContain("timed out");
  });
});

describe("partitionCodeInterpreterCalls prefers a registered tool", () => {
  it("intercepts only when no code tool is registered", () => {
    const calls = [codeInterpreterCall({ code: "```js\n1```" })];
    expect(partitionCodeInterpreterCalls(calls, TOOLS).interpreterCalls).toHaveLength(1);
    expect(partitionCodeInterpreterCalls(calls, TOOLS_WITH_CODE_INTERPRETER)).toEqual({
      dispatchable: calls,
      interpreterCalls: [],
    });
  });

  it("leaves other tools dispatchable", () => {
    const calls: ToolCall[] = [
      { id: "a", name: "get_market_data", args: { ticker: "COF" } },
      codeInterpreterCall({ code: "```js\n1```" }),
    ];
    const partition = partitionCodeInterpreterCalls(calls, TOOLS);
    expect(partition.dispatchable.map((c) => c.name)).toEqual(["get_market_data"]);
  });
});

describe("PromptedToolCallingHarness code_interpreter escape hatch", () => {
  it("evaluates a javascript block locally and feeds the output as a tool observation", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```javascript\\nconsole.log(\\"total:\\", 2 + 3);\\n```"}}</tool_call>',
        "The total is 5.",
      ],
      calls,
    );
    const { context, executed } = makeContext(provider, TOOLS);
    const { messages } = await runHarness(context);

    // Never dispatched to the executor — handled in-harness.
    expect(executed).toEqual([]);

    // The next model call carries the interpreter output as an observation.
    const observation = calls[1].messages.at(-1);
    const content = String(observation?.content ?? "");
    expect(content).toContain("tool_result");
    expect(content).toContain("total: 5");
    expect(assistantTexts(messages)).toContain("The total is 5.");
  });

  it("surfaces the python-unavailable observation for python blocks", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```python\\nprint(1)\\n```"}}</tool_call>',
        "Understood, no python.",
      ],
      calls,
    );
    const { context, executed } = makeContext(provider, TOOLS);
    const { messages } = await runHarness(context);

    expect(executed).toEqual([]);
    const content = String(calls[1].messages.at(-1)?.content ?? "");
    expect(content).toContain("PYTHON_UNAVAILABLE");
    expect(content).toContain("python execution is not available on this runtime");
  });

  it("refuses require( with a structured observation", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```javascript\\nconst fs = require(\\"fs\\");\\n```"}}</tool_call>',
        "OK, I will not.",
      ],
      calls,
    );
    const { context, executed } = makeContext(provider, TOOLS);
    const { messages } = await runHarness(context);

    expect(executed).toEqual([]);
    const content = String(calls[1].messages.at(-1)?.content ?? "");
    expect(content).toContain("CODE_INTERPRETER_REFUSED");
    expect(content).toContain("forbidden");
  });

  it("dispatches code_interpreter to the registered tool instead", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```javascript\\nconsole.log(1);\\n```"}}</tool_call>',
        "Done via registered tool.",
      ],
      calls,
    );
    const { context, executed } = makeContext(provider, TOOLS_WITH_CODE_INTERPRETER);
    const { messages } = await runHarness(context);

    expect(executed).toEqual([
      {
        name: "code_interpreter",
        args: { code: "```javascript\nconsole.log(1);\n```" },
      },
    ]);
    const content = String(calls[1].messages.at(-1)?.content ?? "");
    expect(content).toContain("registered-tool");
  });
});

function assistantTexts(messages: ConversationMessage[]): string[] {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.content ?? ""));
}
