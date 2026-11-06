// Experimental single-consumer ingress. Not a production HA service.
const express = require('express');
const {createClient} = require('redis');
const {normalizeRequest, normalizeId} = require('../../packages/request-store/request');
async function connect(url) {
  const r = createClient({url, disableOfflineQueue: true,
    socket: {connectTimeout: 1000, reconnectStrategy: () => 100}});
  r.on('error', () => {}); await r.connect(); return r;
}
const enqueue = `
local old=redis.call('HGET',KEYS[1],'body')
if old then
 if old~=ARGV[1] then return 'conflict' end
 return redis.call('HGET',KEYS[1],'status')
end
redis.call('HSET',KEYS[1],'body',ARGV[1],'status','accepted')
local queued=redis.pcall('XADD',KEYS[2],'*','id',ARGV[2])
if type(queued)=='table' and queued.err then
 redis.call('DEL',KEYS[1])
 return redis.error_reply('ENQUEUE_FAILED')
end
return 'accepted'`;
function gateway(r) {
  const a=express(); a.use(express.json({limit:'128kb'}));
  a.post('/api/requests',async(req,res)=>{
    try {
      const b=normalizeRequest(req.body);
      const state=await r.eval(enqueue,{keys:['req:'+b.request_id,'inbox'],arguments:[JSON.stringify(b),b.request_id]});
      if(state==='conflict') return res.status(409).json({error:'ID_CONFLICT'});
      res.status(state==='committed'?200:202).json({request_id:b.request_id,status:state});
    } catch(e) {res.status(e.statusCode||503).json({error:e.statusCode===400?'INVALID_REQUEST':'INBOX_UNAVAILABLE'});}
  });
  a.get('/api/requests/:id',async(req,res)=>{
    try {const s=await r.hGet('req:'+normalizeId(req.params.id),'status');res.status(s?200:404).json({status:s});}
    catch(e){res.status(e.statusCode||503).json({error:'INBOX_UNAVAILABLE'});}
  });
  return a;
}
async function consume(r,{afterCommit}={}) {
  if(await r.get('paused')!=='false') return false;
  // Single consumer identity: recover its pending work before reading new messages.
  let rows=await r.sendCommand(['XREADGROUP','GROUP','delivery','single','COUNT','1','STREAMS','inbox','0']);
  if(!rows?.[0]?.[1]?.length) rows=await r.sendCommand(['XREADGROUP','GROUP','delivery','single','COUNT','1','STREAMS','inbox','>']);
  if(!rows) return false;
  const [entry,fields]=rows[0][1][0], id=fields[1];
  const body=await r.hGet('req:'+id,'body');
  const target=await r.get('target');
  const response=await fetch(target+'/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(2000)});
  if(!response.ok) throw new Error('APP_HTTP_'+response.status);
  const posted=await response.json();
  if(posted.status!=='committed') throw new Error('APP_NOT_COMMITTED');
  if(afterCommit) await afterCommit();
  const got=await fetch(target+'/api/requests/'+id,{signal:AbortSignal.timeout(2000)});
  if(!got.ok) throw new Error('VERIFY_HTTP_'+got.status);
  const data=await got.json();
  if(data.status!=='committed'||JSON.stringify(normalizeRequest(data.request))!==body) throw new Error('VERIFY_MISMATCH');
  await r.multi().hSet('req:'+id,'status','committed').xAck('inbox','delivery',entry).exec();
  return true;
}
module.exports={connect,gateway,consume};
