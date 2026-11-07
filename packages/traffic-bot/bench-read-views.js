const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {createTrafficBot}=require('./index');
(async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ghost-bench-'));
 const entries=Array.from({length:18400},(_,i)=>({request:{request_id:randomUUID(),run_id:'history',phase:'baseline',request_no:String(i),payload:'synthetic-'+i,created_at:new Date().toISOString()},state:'committed',attempts:1,enqueuedAt:1,nextAttemptAt:0,observations:[]}));
 await fs.writeFile(path.join(dir,'ledger.json'),JSON.stringify({version:1,entries}));
 const bot=await createTrafficBot({ledgerDir:dir,runId:'new-run',maxRecords:30000,maxLedgerBytes:32*1024*1024,adapter:{write:async()=>{throw Error('unexpected')},read:async()=>{throw Error('unexpected')}}});
 try {for(const [name,fn,n] of [['snapshot',()=>bot.snapshot(),100],['empty_delivery',()=>bot.processPending(),100]]){const start=performance.now();for(let i=0;i<n;i++)await fn();console.log(JSON.stringify({name,entries:entries.length,iterations:n,total_ms:+(performance.now()-start).toFixed(2)}));}}finally{await bot.stop();await fs.rm(dir,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
