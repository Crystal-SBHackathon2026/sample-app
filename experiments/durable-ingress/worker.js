const {connect,consume}=require('./inbox');
(async()=>{const r=await connect(process.env.REDIS_URL);
while(true){try{await consume(r,{afterCommit:process.env.CRASH_AFTER_COMMIT?()=>process.exit(77):undefined});}catch(e){try{await r.set('last_error',e.message);if(['APP_HTTP_409','VERIFY_MISMATCH'].includes(e.message))await r.set('paused','true');}catch{}} await new Promise(x=>setTimeout(x,10));}})().catch(()=>process.exit(1));
