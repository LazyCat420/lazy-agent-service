"""Paired model replay; only model inference contacts the user's owned endpoint.
All tools execute via the revision's actual MCP handler against an offline worker.
"""
import asyncio, json, os, sys, time, hashlib
from pathlib import Path
import httpx
ROOT=Path(__file__).resolve().parents[2]
SUN=ROOT.parent
sys.path.insert(0,str(SUN/'trading-service/scripts/benchmarks'))
from memory_stream import complete_stream
ENDPOINT='http://10.0.0.16:5591/vllm-shim/gold-spark'
OUT=Path(os.environ.get('TOOL_MODEL_OUTPUT','/tmp/trading-tool-model'))
OUT.mkdir(exist_ok=True)
SCENARIOS=['healthy_note','stale_handoff','cross_cycle_note','transient_read_failure']
SCHEMA=json.loads((ROOT/'tool_schemas.json').read_text())
TOOLS=[{'type':'function','function':{k:t[k] for k in ('name','description','parameters')}} for t in SCHEMA if t['name'] in ['get_market_data','whiteboard_read','whiteboard_write']]
NOTE='LULU price 100.61; evidence verified'
RISK='Debt ratio verified at 0.37; observation RISK-20260903-17'
SYSTEM='Complete the specified trading workflow step using the provided tools. This is an offline historical replay, with no trade execution. Treat tool results as evidence. Keep the final answer to one JSON object with keys completed (boolean), ticker (string), price (number or null), observed_note (string or null), data_gaps (array of strings). Set completed=true only when all required steps succeed; otherwise preserve the actual data gap. Do not add prose.'
def prompt(s):
 if s=='stale_handoff':return "You are the Board completing a research handoff step. The Fundamental Analyst has now posted risk_flags on the current LULU whiteboard. Read that section and return its exact content as observed_note. Do not write to the board. An earlier read before the author finished may have been empty. Do not invent missing content."
 if s=='transient_read_failure':return "You are the Junior Analyst completing a market-data verification step for LULU. Fetch get_market_data. If a temporary provider error occurs, retry once. Report the supplied price, or an explicit data gap if both reads fail. No whiteboard write is needed."
 return f"You are the Junior Analyst completing the LULU cycle's required note handoff. Fetch get_market_data and verify its price is 100.61. Then write whiteboard section market_context, author v3_junior_analyst, with the exact content string '{NOTE}'. Finally read market_context to verify that this current cycle actually contains your note. A write acknowledgment alone is not verification. Do not mark completed unless the current board read matches. Report an explicit data gap if verification fails."
async def run(client,model,scenario,arm,repeat):
 env=dict(os.environ,TOOL_BENCH_ARM=arm,TOOL_BENCH_ROOT=str(ROOT if arm=='after' else Path('/tmp/lazy-tool-benchmark-before-c35fbd7')))
 proc=await asyncio.create_subprocess_exec(os.environ['BENCH_NODE'],'--import','tsx','scripts/benchmarks/trading-tool-worker.mts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
 async def rpc(**kw):
  proc.stdin.write((json.dumps(kw)+'\n').encode());await proc.stdin.drain()
  while True:
   line=await proc.stdout.readline()
   if not line:raise RuntimeError('Fixture worker exited')
   if line.startswith(b'BENCH_RPC '):
    result=json.loads(line[10:])
    if 'error' in result:raise RuntimeError(result['error'])
    return result
 row=dict(arm=arm,scenario=scenario,repeat=repeat,model=model,started_at=time.time(),turns=[],usage_complete=True,prompt_tokens=0,completion_tokens=0,tool_calls=0,success=False,stop='unknown')
 messages=[{'role':'system','content':SYSTEM},{'role':'user','content':prompt(scenario)}]
 row['input_hash']=hashlib.sha256(json.dumps([messages,TOOLS],sort_keys=True).encode()).hexdigest()
 start=time.monotonic();seeded=False;current='cycle-v3-bench-current'
 try:
  if scenario=='stale_handoff':
   await rpc(op='call',name='whiteboard_read',args={'ticker':'LULU','section':'risk_flags'})
   await rpc(op='state',section='risk_flags',content=RISK)
  if scenario=='transient_read_failure':await rpc(op='state',failNext=True)
  row['setup_state']=await rpc(op='state')
  for turn in range(6):
   payload=dict(model=model,messages=messages,tools=TOOLS,temperature=0,min_p=0,max_tokens=1024,chat_template_kwargs={'enable_thinking':False,'thinking':False})
   def first_output(first,headers):print(json.dumps(dict(event='first_delta',arm=arm,scenario=scenario,repeat=repeat,turn=turn+1,first_delta_s=first)),flush=True)
   ts=time.monotonic()
   result=await asyncio.wait_for(complete_stream(client,ENDPOINT+'/v1/chat/completions',payload,first_output),timeout=max(1,300-(time.monotonic()-start)))
   message=result['message'];usage=result.get('usage') or {}
   event=dict(message=message,usage=usage,elapsed_s=time.monotonic()-ts,first_delta_s=result['first_delta_s'],finish_reason=result.get('finish_reason'),tool_results=[])
   row['turns'].append(event)
   if not usage:row['usage_complete']=False
   row['prompt_tokens']+=usage.get('prompt_tokens',0);row['completion_tokens']+=usage.get('completion_tokens',0)
   messages.append(message)
   calls=message.get('tool_calls') or []
   print(json.dumps(dict(event='turn',arm=arm,scenario=scenario,repeat=repeat,turn=turn+1,elapsed_s=event['elapsed_s'],usage=usage,tools=[c['function']['name'] for c in calls])),flush=True)
   if not calls:row['final_text']=message.get('content') or '';row['stop']=result.get('finish_reason');break
   for c in calls:
    row['tool_calls']+=1;name=c['function']['name'];args=json.loads(c['function']['arguments'])
    if scenario=='cross_cycle_note' and name=='whiteboard_write' and not seeded:
     seeded=True
     await rpc(op='call',name=name,args=args,cycle=current+'-prior')
     row['cross_cycle_setup']=await rpc(op='state',cycle=current)
    actual=await rpc(op='call',name=name,args=args,cycle=current)
    envelope=actual['result'];text='\n'.join(c.get('text','') for c in envelope['content'])
    content=json.dumps({'error':text}) if envelope.get('isError') else text
    messages.append(dict(role='tool',tool_call_id=c['id'],content=content))
    event['tool_results'].append(dict(name=name,arguments=args,content=content,is_error=bool(envelope.get('isError')),backend_delta=actual['backend_delta']))
   if turn==5:row['stop']='max_turns'
  state=await rpc(op='state',cycle=current);row['final_state']=state
  try:artifact=json.loads(row.get('final_text',''))
  except Exception:artifact=None
  row['artifact']=artifact
  fields=['completed','ticker','price','observed_note','data_gaps']
  row['schema_valid']=isinstance(artifact,dict) and all(k in artifact for k in fields) and isinstance(artifact['completed'],bool) and isinstance(artifact['ticker'],str) and (artifact['price'] is None or type(artifact['price']) in (int,float)) and (artifact['observed_note'] is None or isinstance(artifact['observed_note'],str)) and isinstance(artifact['data_gaps'],list) and all(isinstance(g,str) for g in artifact['data_gaps'])
  if row['schema_valid']:
   actual_calls=[e for t in row['turns'] for e in t['tool_results']]
   observed=[]
   for c in actual_calls:
    try:value=json.loads(c['content'])
    except Exception:continue
    if isinstance(value,dict) and not c['is_error']:observed.append((c['name'],value))
   price_seen=any(n=='get_market_data' and v.get('price')==100.61 and v.get('ticker')=='LULU' for n,v in observed)
   def note_seen(section,content):return any(n=='whiteboard_read' and v.get('cycle_id')==current and v.get('sections',{}).get(section)==content for n,v in observed)
   if scenario=='stale_handoff':work=note_seen('risk_flags',RISK) and artifact['observed_note']==RISK
   elif scenario=='transient_read_failure':work=price_seen and artifact['price']==100.61
   else:work=state['board'].get('market_context')==NOTE and any(c['name']=='whiteboard_write' for c in actual_calls) and note_seen('market_context',NOTE) and price_seen and artifact['price']==100.61 and artifact['observed_note']==NOTE
   row['required_work_pass']=work
   row['success']=work and artifact['completed'] is True and artifact['ticker']=='LULU'
 except Exception as e:row.update(error=f'{type(e).__name__}: {e}',usage_complete=False,stop='error')
 finally:
  row['elapsed_s']=time.monotonic()-start
  if proc.stdin:proc.stdin.close()
  try:await asyncio.wait_for(proc.wait(),timeout=5)
  except asyncio.TimeoutError:proc.kill();await proc.wait()
  (OUT/f'{scenario}-{repeat}-{arm}.json').write_text(json.dumps(row,indent=2))
  print(json.dumps({k:v for k,v in row.items() if k not in ['turns','final_text','artifact','setup_state','final_state','cross_cycle_setup']}),flush=True)
 return row
async def main():
 async with httpx.AsyncClient(timeout=300) as client:
  model=(await client.get(ENDPOINT+'/v1/models')).json()['data'][0]['id']
  if os.environ.get('TOOL_MODEL_PREFLIGHT'):
   await run(client,model,'healthy_note','after',-1);return
  for repeat in range(2):
   for i,scenario in enumerate(SCENARIOS):
    for arm in (['before','after'] if (repeat+i)%2==0 else ['after','before']):await run(client,model,scenario,arm,repeat)
if __name__=='__main__':asyncio.run(main())
