/** Opt-in, stateless model probe. No Prism calls, DB, dispatch or real tool writes.
 * Exercises the exact request transform with a fixed synthetic acknowledgement.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import { applyTradingToolProtocol } from "../../src/services/TradingToolProtocol.ts";

if (process.env.TOOL_PROTOCOL_PROBE !== "1") throw new Error("Set TOOL_PROTOCOL_PROBE=1 explicitly");
const output = process.env.TOOL_PROTOCOL_OUTPUT || "/tmp/trading-tool-protocol-probe.json";
if (fs.existsSync(output)) throw new Error("Output already exists; preserve every attempt");
const endpoint = process.env.TOOL_PROTOCOL_ENDPOINT || "http://10.0.0.141:8000";
const model = process.env.TOOL_PROTOCOL_MODEL || "GLM-5.3-Flash-EXL3";
const cases = [
  { id: "market_after_ack", name: "get_market_data", args: { ticker: "EVLT" },
    parameters: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"], additionalProperties: false },
    task: "Obtain the current synthetic EVLT quote using get_market_data. Return JSON with value (the quoted price), receipt (the tool's receipt), and data_gaps. If the tool never executes, use nulls and explain the missing data.",
    result: { price: 137.25, receipt: "synthetic-Q-4821", source: "frozen quote fixture" }, expected: 137.25 },
  { id: "calculator_after_ack", name: "evaluate_expression", args: { operation: "divide", a: "-19.1", b: "94.6" },
    parameters: { type: "object", properties: { operation: { type: "string", enum: ["divide"] }, a: { type: "string" }, b: { type: "string" } }, required: ["operation", "a", "b"], additionalProperties: false },
    task: "Use evaluate_expression to divide -19.1 by 94.6. Return JSON with value (the ratio, not percent), receipt (the tool's receipt), and data_gaps. If the tool never executes, use a null receipt and explain the missing execution.",
    result: { result: "-0.20190274841437632135", receipt: "synthetic-C-7039" }, expected: -19.1 / 94.6 },
];
const think = { type: "function", function: { name: "think", description: "Record an internal thought. Returns an acknowledgement only.", parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] } } };
const report: any = { version: 1, started_at: new Date().toISOString(), model, temperature: 0, max_tokens: 1536, max_turns: 4, timeout_seconds_per_turn: 120,
  repetitions: 2, cases, source_hash: crypto.createHash("sha256").update(fs.readFileSync(new URL("../../src/services/TradingToolProtocol.ts", import.meta.url))).digest("hex"), attempts: [],
  limitation: "Two synthetic recovery cases; direct provider loop with fixture tool results, not a production failure-rate or investment-quality estimate. No selective retries." };
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
save();
for (let repeat = 0; repeat < 2; repeat++) for (const [index, fixture] of cases.entries()) {
  for (const arm of (repeat + index) % 2 ? ["current", "baseline"] : ["baseline", "current"]) {
    const attempt: any = { case: fixture.id, repeat, arm, turns: [], real_calls: 0, think_calls: 0, tool_errors: 0, final: null, usage_complete: true, known_tokens: 0 };
    report.attempts.push(attempt); save();
    const messages: any[] = [{ role: "system", content: "You are a research analyst. Use the available tool results accurately. Return the requested JSON artifact." },
      { role: "user", content: fixture.task },
      { role: "assistant", content: null, tool_calls: [{ id: "prior-think", type: "function", function: { name: "think", arguments: JSON.stringify({ thought: `<tool_call>${JSON.stringify({ name: fixture.name, arguments: fixture.args })}</tool_call>` }) } }] },
      { role: "tool", tool_call_id: "prior-think", content: JSON.stringify({ status: "acknowledged" }) }];
    const tools = [think, { type: "function", function: { name: fixture.name, description: "Execute this operation and return its result and receipt.", parameters: fixture.parameters } }];
    for (let turn = 0; turn < 4; turn++) {
      let body: any = { model, messages, tools, temperature: 0, min_p: 0, max_tokens: 1536, chat_template_kwargs: { enable_thinking: false, thinking: false } };
      if (arm === "current") body = applyTradingToolProtocol(body).body;
      const started = Date.now();
      try {
        const response = await fetch(endpoint + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
        const result: any = await response.json();
        const choice = result.choices?.[0];
        const message = choice?.message;
        if (!message) throw new Error("Missing provider message");
        const usage = result.usage;
        attempt.usage_complete &&= typeof usage?.prompt_tokens === "number" && typeof usage?.completion_tokens === "number";
        attempt.known_tokens += (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
        // Keep public content and structured calls; omit provider hidden-reasoning fields.
        const safe = { role: "assistant", content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
        attempt.turns.push({ elapsed_ms: Date.now()-started, usage: usage || null, finish_reason: choice.finish_reason, message: safe,
          payload_hash: crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex"), tool_names: body.tools.map((t: any) => t.function.name) });
        messages.push(safe);
        if (!message.tool_calls?.length) { attempt.final = message.content; break; }
        for (const call of message.tool_calls) {
          let value: any = { error: "Unavailable tool" };
          if (call.function?.name === "think") { attempt.think_calls++; value = { status: "acknowledged" }; }
          else if (call.function?.name === fixture.name) {
            try {
              const args = JSON.parse(call.function.arguments);
              if (JSON.stringify(Object.keys(args).sort()) !== JSON.stringify(Object.keys(fixture.args).sort()) || Object.entries(fixture.args).some(([k,v]) => args[k] !== v)) throw new Error("Arguments must match the requested operation");
              attempt.real_calls++; value = fixture.result;
            } catch { attempt.tool_errors++; value = { error: "Invalid arguments for requested operation" }; }
          } else attempt.tool_errors++;
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(value) });
        }
        save();
      } catch (error) { attempt.error = String(error); attempt.usage_complete = false; break; }
    }
    try {
      const final = JSON.parse(String(attempt.final || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
      attempt.correct = attempt.real_calls > 0 && final.receipt === fixture.result.receipt && typeof final.value === "number" && Math.abs(final.value-fixture.expected) < 0.000001;
    } catch { attempt.correct = false; }
    save(); console.log(JSON.stringify({ case: fixture.id, repeat, arm, real_calls: attempt.real_calls, think_calls: attempt.think_calls, correct: attempt.correct, error: attempt.error }));
  }
}
report.finished_at = new Date().toISOString(); save();
