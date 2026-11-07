const fs=require('node:fs/promises'); const os=require('node:os');const path=require('node:path');
const {openLedger}=require('./ledger');
(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ledger-bench-'));let ledger;
try{const entries=Array.from({length:20000},(_,i)=>({request:{request_id:String(i),run_id:'bench',request_no:String(i),payload:'x'.repeat(150),phase:'test',created_at:'2026-11-07T00:00:00.000Z'},state:'committed',attempts:1,enqueuedAt:1,nextAttemptAt:0,observations:[]}));
await fs.writeFile(path.join(dir,'ledger.json'),JSON.stringify({version:1,entries}));ledger=await openLedger({dir,maxRecords:30000,maxLedgerBytes:64*1024*1024});let start=performance.now();
for(let i=0;i<10;i++){await ledger.add({...entries[0].request,request_id:'new-'+i});await ledger.update('new-'+i,{attempts:1});await ledger.update('new-'+i,{state:'committed'});}
console.log(JSON.stringify({history:20000,requests:10,durable_mutations:30,elapsed_ms:performance.now()-start,summary:ledger.summary()}));
}finally{if(ledger)await ledger.close();await fs.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
