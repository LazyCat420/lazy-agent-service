import { prepareTradingRequest, filterTradingPayload } from "../src/services/learning/TradingLearningBoundary.ts";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const prepared = prepareTradingRequest(request);
const filtered = filterTradingPayload({messages:[{role:"system",content:prepared.systemPrompt},...prepared.messages]});
process.stdout.write(JSON.stringify(filtered.body.messages));
