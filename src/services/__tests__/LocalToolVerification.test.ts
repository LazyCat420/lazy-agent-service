import { afterEach, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { LocalToolContinuation } from '../LocalToolContinuation.ts';
import { RunStore } from '../RunStore.ts';
afterEach(()=>vi.restoreAllMocks());
it('verifies every receipt field and refuses expired or inactive effects',async()=>{
 const receipt={signature:crypto.randomBytes(32).toString('hex'),run_id:'run',tool_call_id:'call',arguments_json:'{}',expires_at:new Date(Date.now()+60000).toISOString(),effect:'write'};
 const run:any={status:'waiting_for_tool',pending_tools:{call:{event:{authorization_receipt:receipt}}}};
 vi.spyOn(RunStore,'getRun').mockResolvedValue(run);
 (LocalToolContinuation as any).waiters.set('run:call',{resolve:()=>{},reject:()=>{}});
 try {
   await expect(LocalToolContinuation.verify('run','call',{...receipt})).resolves.toBeUndefined();
   await expect(LocalToolContinuation.verify('run','call',{...receipt,arguments_json:'{"path":"changed"}'})).rejects.toThrow('scope or signature');
   await expect(LocalToolContinuation.verify('run','call',{...receipt,signature:crypto.randomBytes(32).toString('hex')})).rejects.toThrow('signature');
   run.status='completed'; await expect(LocalToolContinuation.verify('run','call',receipt)).rejects.toThrow('no longer active');
   run.pending_tools.call.result_digest='recorded'; await expect(LocalToolContinuation.verify('run','call',receipt)).resolves.toBeUndefined();
 } finally {(LocalToolContinuation as any).waiters.delete('run:call');}
});
