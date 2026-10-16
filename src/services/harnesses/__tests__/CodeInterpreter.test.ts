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
  { profileAdmitted = true, autoApprove = true }: { profileAdmitted?: boolean; autoApprove?: boolean } = {},
): { context: AgenticContext; executed: Array<{ name: string; args: Record<string, unknown> }> } {
  const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
  const context = {
    options: { maxIterations: 6, maxTokens: 100000, autoApprove },
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
    runtimeToolExecutor: profileAdmitted
      ? async (call: { name: string; args: Record<string, unknown> }) => {
          executed.push({ name: call.name, args: call.args });
          return { ok: true, via: "registered-tool" };
        }
      : undefined,
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

describe("sandbox process isolation (2026-10-11 hardening)", () => {
  it("the runtime probe shows every capability denied and an empty env", async () => {
    const { checkSandbox } = await import("../CodeInterpreter.ts");
    const check = await checkSandbox();
    expect(check.available).toBe(true);
    const caps = check.capabilities as Record<string, unknown>;
    for (const k of ["fs", "net", "dns", "child_process", "worker", "binding", "codegen"]) {
      expect(String(caps[k]), k).toMatch(/^denied/);
    }
    expect(caps.env).toBe(0);
  });

  it("fails closed when any capability is not denied", async () => {
    const { evaluateSandboxProbe } = await import("../CodeInterpreter.ts");
    const base = { fs: "denied", net: "denied", dns: "denied", child_process: "denied", worker: "denied", binding: "denied", codegen: "denied", env: 0 };
    expect(evaluateSandboxProbe(base).available).toBe(true);
    expect(evaluateSandboxProbe({ ...base, net: "ALLOWED" })).toMatchObject({ available: false });
    expect(evaluateSandboxProbe({ ...base, env: 3 }).reason).toContain("env");
    expect(evaluateSandboxProbe({ ...base, codegen: undefined }).available).toBe(false);
  });

  it("each snippet gets a fresh process: state does not leak between calls", async () => {
    await executeJavaScript("globalThis.carry = 42; return 1;");
    const second = await executeJavaScript("return typeof globalThis.carry;");
    expect(second.returned).toBe("undefined");
  });
});

describe("executeJavaScript isolation (audit D3)", () => {
  it("cannot reach the host process through computed property access", async () => {
    const result = await executeJavaScript('return typeof globalThis["proc" + "ess"];');
    expect(result.success).toBe(true);
    expect(result.returned).toBe("undefined");
  });

  it("refuses Function-constructor escapes", async () => {
    const result = await executeJavaScript(
      'return console.log.constructor("return globalThis")();',
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Code generation from strings disallowed/);
  });

  it("kills a synchronous infinite loop without blocking the host event loop", async () => {
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 20);
    const started = Date.now();
    const result = await executeJavaScript("while (true) {}", 400);
    clearInterval(ticker);
    expect(result.success).toBe(false);
    expect(result.message).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ticks).toBeGreaterThan(5);
  });

  it("a returned thenable never receives a worker-realm function (security review 2026-10-11)", async () => {
    const result = await executeJavaScript(
      'return { then(ok, bad) { try { const p = ok.constructor("return globalThis[\'pro\' + \'cess\']")(); ok(p ? "ESCAPED:" + typeof p.getBuiltinModule : "no-process"); } catch (e) { ok("blocked:" + e.message); } } };',
    );
    expect(JSON.stringify(result)).not.toContain("ESCAPED");
    expect(result.success).toBe(true);
    expect(String(result.returned)).toMatch(/^blocked:|^no-process/);
  });

  it("an overridden Promise.prototype.then cannot capture worker functions either", async () => {
    const result = await executeJavaScript(
      'const orig = Promise.prototype.then; Promise.prototype.then = function (ok, bad) { try { const p = ok.constructor("return globalThis[\'pro\' + \'cess\']")(); if (p) return orig.call(this, () => ok("ESCAPED"), bad); } catch {} return orig.call(this, ok, bad); }; return Promise.resolve(1);',
    );
    expect(JSON.stringify(result)).not.toContain("ESCAPED");
  });

  it("the snippet cannot replace the boundary helpers", async () => {
    const result = await executeJavaScript('globalThis.__settle = () => {}; return 5;');
    expect(result.success).toBe(false); // assignment to a non-writable global throws in strict mode
    const ok = await executeJavaScript("return 5;");
    expect(ok.returned).toBe(5);
  });

  it("caps worker memory", async () => {
    const result = await executeJavaScript(
      "const a = []; while (true) a.push(new Array(1e6).fill(1));",
      5_000,
    );
    expect(result.success).toBe(false);
    // The snippet's own 5 s budget equalled vitest's default test timeout, so
    // under deploy's sharded load the test timed out before the worker did.
  }, 15_000);

  it("does not expose the service environment", async () => {
    const result = await executeJavaScript("return Object.keys(globalThis);");
    expect(result.success).toBe(true);
    expect(result.returned).not.toContain("process");
    expect(result.returned).not.toContain("require");
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
    const { context, executed } = makeContext(provider, TOOLS, { profileAdmitted: false });
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
    const { context, executed } = makeContext(provider, TOOLS, { profileAdmitted: false });
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
    const { context, executed } = makeContext(provider, TOOLS, { profileAdmitted: false });
    const { messages } = await runHarness(context);

    expect(executed).toEqual([]);
    const content = String(calls[1].messages.at(-1)?.content ?? "");
    expect(content).toContain("CODE_INTERPRETER_REFUSED");
    expect(content).toContain("forbidden");
  });

  it("refuses the local interpreter on a profile-admitted run", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```javascript\\nconsole.log(1);\\n```"}}</tool_call>',
        "ok",
      ],
      calls,
    );
    const { context, executed } = makeContext(provider, TOOLS);
    await runHarness(context);
    expect(executed).toEqual([]);
    expect(String(calls[1].messages.at(-1)?.content ?? "")).toContain(
      "CODE_INTERPRETER_NOT_ADMITTED",
    );
  });

  it("asks for approval and denies on an unattended run", async () => {
    const calls: ProviderCall[] = [];
    const provider = scriptedProvider(
      [
        '<tool_call>{"name": "code_interpreter", "arguments": {"code": "```javascript\\nconsole.log(1);\\n```"}}</tool_call>',
        "ok",
      ],
      calls,
    );
    const { context } = makeContext(provider, TOOLS, {
      profileAdmitted: false,
      autoApprove: false,
    });
    (context.options as Record<string, unknown>).unattended = true;
    await runHarness(context);
    expect(String(calls[1].messages.at(-1)?.content ?? "")).toContain("USER_REJECTED");
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
