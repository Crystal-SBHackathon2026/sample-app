const {spawn,execFileSync}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {readFileSync,writeFileSync,mkdtempSync}=require('node:fs');
const {tmpdir}=require('node:os');const path=require('node:path');
const assert=require('node:assert/strict');const {Pool}=require('pg');
const express=require('express');
const {createPostgresRequestStore}=require('../../packages/request-store');
const {createRequestRouter}=require('../../packages/request-store/express');
const {connect,gateway}=require('./inbox');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const prefix='ghost-inbox-'+process.pid, redis=prefix+'-redis', pg=prefix+'-pg';
const password=randomUUID();const children=[],servers=[],stores=[],pools=[];let r;
const evidence={scope:'isolated real Redis + PostgreSQL + existing sample-app API; no AWS CDC or live cutover',tests:[]};
setInterval(()=>{writeFileSync(path.join(__dirname,(process.env.RESULTS_FILE||'results.json')+'.progress'),JSON.stringify(evidence,null,2));},1000).unref();
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,POSTGRES_PASSWORD:password}}).trim();
async function listen(a){const s=a.listen(0,'127.0.0.1');servers.push(s);await new Promise(ok=>s.once('listening',ok));return 'http://127.0.0.1:'+s.address().port;}
function worker(url,crash=false){const c=spawn(process.execPath,[path.join(__dirname,'worker.js')],{env:{...process.env,REDIS_URL:url,...(crash?{CRASH_AFTER_COMMIT:'1'}:{})},stdio:'ignore'});children.push(c);return c;}
async function stop(c){if(c.exitCode!==null||c.signalCode)return;c.kill('SIGKILL');await new Promise(ok=>c.once('exit',ok));}
async function waitFor(fn,seconds=90){const until=Date.now()+seconds*1000;while(Date.now()<until){if(await fn())return;await sleep(100);}throw Error('condition timeout');}
async function main(){
 docker('run','-d','--name',pg,'-e','POSTGRES_PASSWORD','-p','127.0.0.1::5432','postgres:16-alpine');
 const port=docker('port',pg,'5432/tcp').split(':').pop();
 const opts={host:'127.0.0.1',port:Number(port),user:'postgres',password,database:'postgres',ssl:false};
 const admin=new Pool(opts);pools.push(admin);await waitFor(async()=>{try{await admin.query('select 1');return true;}catch{return false;}});
 for(const name of ['source_db','target_db'])await admin.query('CREATE DATABASE '+name);
 const apps={},dbs={};
 for(const name of ['source_db','target_db']){
  const options={...opts,database:name};const pool=new Pool(options);pools.push(pool);dbs[name]=pool;
  await pool.query(readFileSync(path.join(__dirname,'../../packages/request-store/schema.sql'),'utf8'));
  const store=createPostgresRequestStore(options);stores.push(store);
  const a=express();a.use('/api/requests',createRequestRouter({store,getContext:()=>({environment:name})}));
  apps[name]={store,url:await listen(a)};
 }
 const probe=require('node:net').createServer().listen(0,'127.0.0.1');await new Promise(ok=>probe.once('listening',ok));const redisPort=probe.address().port;await new Promise(ok=>probe.close(ok));
 const data=mkdtempSync(path.join(tmpdir(),'ghost-inbox-aof-'));
 docker('run','-d','--name',redis,'-p','127.0.0.1:'+redisPort+':6379','-v',data+':/data','redis:7.4-alpine','redis-server','--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction');
 const redisUrl='redis://127.0.0.1:'+docker('port',redis,'6379/tcp').split(':').pop();
 r=await connect(redisUrl);await r.sendCommand(['XGROUP','CREATE','inbox','delivery','0','MKSTREAM']);
 await r.set('paused','true');await r.set('target',apps.source_db.url);
 const url=await listen(gateway(r));let seq=0;const records=[];
 const make=()=>({request_id:randomUUID(),run_id:prefix,phase:'test',request_no:String(++seq),payload:'payload-'+seq,created_at:new Date().toISOString()});
 async function post(b){const start=performance.now();try{const q=await fetch(url+'/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(2000)});return {status:q.status,ms:performance.now()-start};}catch{return {status:0,ms:performance.now()-start};}}
 async function accepted(b){const x=await post(b);assert.equal(x.status,202);records.push(b);return x;}
 await apps.source_db.store.pauseWrites();
 let b=make();let baseline=await fetch(apps.source_db.url+'/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});assert.equal(baseline.status,503);
 evidence.tests.push({test:'existing_app_during_pause',http:baseline.status,layer:'app rejects; no server-side acceptance'});
 let c=worker(redisUrl);const latencies=[];const hold=Number(process.env.HOLD_SECONDS||310);const started=Date.now();
 console.log('START paused ingress hold',hold,'seconds, 10 requests/s');
 // Generation follows wall clock independently from consumption, with concurrent HTTP requests.
 let pending=[];let next=Date.now();while(Date.now()-started<hold*1000){if(Date.now()>=next){next+=100;const body=make();pending.push(accepted(body).then(x=>latencies.push(x.ms)));}await sleep(5);}
 await Promise.all(pending);assert.equal(await r.hGet('req:'+records[0].request_id,'status'),'accepted');
 await stop(c);c=worker(redisUrl);await sleep(500);assert.equal(await r.hGet('req:'+records[0].request_id,'status'),'accepted');
 evidence.tests.push({test:'paused_consumer_restart',passed:true});
 await r.set('target',apps.target_db.url);const drain=Date.now();await r.set('paused','false');
 await waitFor(async()=>await r.hGet('req:'+records.at(-1).request_id,'status')==='committed',180);
 const rows=(await dbs.target_db.query('select request_id,run_id,phase,request_no::text,payload,created_at from migration_demo')).rows;
 const byId=new Map(rows.map(x=>[x.request_id,x]));
 for(const x of records){const y=byId.get(x.request_id);assert(y);assert.equal(y.payload,x.payload);assert.equal(y.request_no,x.request_no);assert.equal(y.created_at.toISOString(),x.created_at);assert.equal(y.phase,x.phase);assert.equal(y.run_id,x.run_id);assert.equal(await r.hGet('req:'+x.request_id,'status'),'committed');}
 assert.equal(rows.length,records.length);assert.equal((await dbs.source_db.query('select count(*) from migration_demo')).rows[0].count,'0');
 latencies.sort((a,b)=>a-b);
 evidence.tests.push({test:'pause_exceeding_legacy_expiry',hold_seconds:hold,accepted:records.length,first_http_failures:0,lost:0,duplicates:0,payload_mismatch:0,drain_seconds:(Date.now()-drain)/1000,acceptance_p95_ms:latencies[Math.floor(latencies.length*.95)],acceptance_max_ms:latencies.at(-1),total_seconds:(Date.now()-started)/1000});
 // Stop immediately after app commit, before marking committed/ACK in Redis.
 await r.set('paused','true');await stop(c);b=make();await accepted(b);c=worker(redisUrl,true);await r.set('paused','false');await new Promise(ok=>c.once('exit',ok));assert.equal(c.exitCode,77);
 assert.equal(await r.hGet('req:'+b.request_id,'status'),'accepted');c=worker(redisUrl);await waitFor(async()=>await r.hGet('req:'+b.request_id,'status')==='committed');
 assert.equal((await dbs.target_db.query('select count(*) from migration_demo where request_id=$1',[b.request_id])).rows[0].count,'1');
 evidence.tests.push({test:'consumer_killed_after_db_commit_before_ack',lost:0,duplicate_rows:0,passed:true});
 // Durable ACK survives abrupt Redis restart; ingress outage is a separate availability boundary.
 await r.set('paused','true');await stop(c);b=make();await accepted(b);docker('kill',redis);
 const outage=await post(make());assert.equal(outage.status,503);docker('start',redis);await waitFor(async()=>{try{return await r.ping()==='PONG';}catch{return false;}});
 assert.equal(await r.hGet('req:'+b.request_id,'status'),'accepted');assert.equal(await r.get('paused'),'true');
 c=worker(redisUrl);await r.set('paused','false');await waitFor(async()=>await r.hGet('req:'+b.request_id,'status')==='committed');
 evidence.tests.push({test:'redis_crash_after_202',accepted_loss:0,outage_http:outage.status,layer:'single Redis unavailable: ingress rejects new request, does not falsely accept',passed:true});
 const conflict=await post({...b,payload:'different'});assert.equal(conflict.status,409);
 evidence.tests.push({test:'same_id_different_payload',http:409});
 // Five-minute rehearsal budget: twenty-second pause and replay while new arrivals continue.
 await r.set('paused','true');const demoStart=Date.now();const demo=[];
 for(let i=0;i<200;i++){const item=make();demo.push(item);await accepted(item);await sleep(100);}
 const resume=Date.now();await r.set('paused','false');
 for(let i=0;i<50;i++){const item=make();demo.push(item);await accepted(item);await sleep(100);}
 await waitFor(async()=>await r.hGet('req:'+demo.at(-1).request_id,'status')==='committed');
 const duration=(Date.now()-demoStart)/1000;assert(duration<300);
 const count=Number((await dbs.target_db.query('select count(*) from migration_demo')).rows[0].count);assert.equal(count,records.length);
 evidence.tests.push({test:'five_minute_local_rehearsal',requests:demo.length,pause_seconds:(resume-demoStart)/1000,total_seconds:duration,accepted_total:records.length,db_rows:count,lost:0});
 const finalRows=(await dbs.target_db.query('select request_id,run_id,phase,request_no::text,payload,created_at from migration_demo')).rows;
 const finalMap=new Map(finalRows.map(x=>[x.request_id,x]));
 assert.equal(finalMap.size,records.length);
 for(const item of records){const row=finalMap.get(item.request_id);assert(row);for(const key of ['run_id','phase','request_no','payload'])assert.equal(row[key],item[key]);assert.equal(row.created_at.toISOString(),item.created_at);assert.equal(await r.hGet('req:'+item.request_id,'status'),'committed');}
 const pendingCount=await r.sendCommand(['XPENDING','inbox','delivery']);assert.equal(pendingCount[0],0);
 evidence.final_verification={accepted_ids:records.length,db_ids:finalMap.size,pending:pendingCount[0],all_fields_match:true};
 evidence.result='PASS_WITH_AVAILABILITY_LIMIT';
}
main().catch(e=>{evidence.result='FAIL';evidence.error=e.message;console.error('FAIL',e.message);process.exitCode=1;}).finally(async()=>{
 for(const c of children)await stop(c);for(const s of servers)s.closeAllConnections?.();for(const s of servers)s.close();
 if(r)r.destroy();for(const s of stores)await s.close();for(const p of pools)await p.end();
 for(const n of [redis,pg])try{docker('rm','-f',n);}catch{}
 writeFileSync(path.join(__dirname,process.env.RESULTS_FILE||'results.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
});
