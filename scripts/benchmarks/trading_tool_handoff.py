"""Measure real wall-clock time until a completed write becomes readable.
No model calls: both revisions execute the same MCP workflow against the fixture.
The old cache uses its real production 60-second TTL, not a simulated clock.
"""
import asyncio,json,os,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
async def run(arm,repeat):
 env=dict(os.environ,TOOL_BENCH_ARM=arm,TOOL_BENCH_ROOT=str(ROOT if arm=='after' else '/tmp/lazy-tool-benchmark-before-c35fbd7'))
 p=await asyncio.create_subprocess_exec(os.environ['BENCH_NODE'],'--import','tsx','scripts/benchmarks/trading-tool-worker.mts',cwd=ROOT,env=env,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
 async def rpc(**kw):
  p.stdin.write((json.dumps(kw)+'\n').encode());await p.stdin.drain()
  while True:
   line=await p.stdout.readline()
   if not line:raise RuntimeError('worker closed')
   if line.startswith(b'BENCH_RPC '):return json.loads(line[10:])
 row=dict(arm=arm,repeat=repeat,poll_interval_s=1,success=False,polls=0)
 try:
  args={'ticker':'LULU','section':'market_context'}
  await rpc(op='call',name='whiteboard_read',args=args)
  await rpc(op='call',name='whiteboard_write',args={**args,'content':'verified note'})
  start=time.monotonic()
  while time.monotonic()-start < 70:
   row['polls']+=1
   result=await rpc(op='call',name='whiteboard_read',args=args)
   value=json.loads(result['result']['content'][0]['text'])
   if value.get('sections',{}).get('market_context')=='verified note':row['success']=True;break
   await asyncio.sleep(1)
  row['elapsed_s']=time.monotonic()-start
  row['state']=await rpc(op='state')
 finally:
  p.stdin.close()
  try:await asyncio.wait_for(p.wait(),5)
  except asyncio.TimeoutError:p.kill();await p.wait()
 print(json.dumps(row),flush=True)
 return row
async def main():
 rows=[]
 for repeat in range(3):
  for arm in (['before','after'] if repeat%2==0 else ['after','before']):
   rows.append(await run(arm,repeat))
   Path('/tmp/trading-tool-handoff-results.json').write_text(json.dumps(rows,indent=2))
asyncio.run(main())
