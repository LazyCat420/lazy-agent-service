/** Offline input builder: prove that only upstream memory differs between arms. */
import { prepareTradingRequest, filterTradingPayload } from '../src/services/learning/TradingLearningBoundary.ts';
let input=''; for await (const chunk of process.stdin) input+=chunk;
const cases=JSON.parse(input).map((request:any)=>{
 const prepared=prepareTradingRequest(request);
 const payload={messages:[{role:'system',content:prepared.systemPrompt},...prepared.messages]};
 const after=filterTradingPayload(payload);
 const before=payload.messages.map((m:any)=>m.role==='system'?{...m,content:m.content.replace(/<TRADING_LEARNING_BOUNDARY_V2>[A-Za-z0-9_-]+<\/TRADING_LEARNING_BOUNDARY_V2>/g,'')}:m);
 const expected=before.map((m:any)=>m.role==='system'?{...m,content:m.content.replace(/<(agent-memory|past-workflows|project-skills)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi,'')}:m);
 if(JSON.stringify(expected)!==JSON.stringify(after.body.messages))throw new Error('Confounded benchmark: extra prompt difference');
 return {id:request.benchmark_id,before,after:after.body.messages,receipt:after.receipt};
});
process.stdout.write(JSON.stringify(cases));
