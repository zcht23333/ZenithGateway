import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {migrateLimiter} from './rate-limit-storage.mjs'
import {environment,until} from './rate-limit-harness.mjs'
const handoff=process.env.RATE_LIMIT_HANDOFF
assert(handoff===undefined||handoff==='true'||handoff==='false','Invalid RATE_LIMIT_HANDOFF')
const e=await environment({out:process.env.RATE_LIMIT_OUTPUT,extra:handoff===undefined?[]:['--zenith.limiter.result-handoff-enabled='+handoff]});let failure
const diag=i=>e.api(i,'/settings/rate-limit/diagnostics'),bucket=ip=>e.ns+':bucket:'+ip
const time=async()=>{const t=await e.redis(['TIME']);return Number(t[0])*1000+Math.floor(Number(t[1])/1000)}
const state=async ip=>JSON.parse(await e.redis(['GET',bucket(ip)]))
const released=i=>until(i.label+' physical resources released',async()=>{const d=await diag(i);assert.ok(d.commandsInFlight<=2&&d.queued<=4&&d.connectionSlots<=2);assert.ok(d.scheduledTasks<=d.admissionCapacity+1);assert.ok(d.activeDeliveries<=d.resultWorkers&&d.queuedDeliveries<=d.deliveryQueueCapacity&&d.retainedTasks<=d.admissionCapacity);return d.commandsInFlight===0&&d.queued===0&&d.activeWorkers===0&&d.closing===0&&d.queuedDeliveries===0&&d.activeDeliveries===0&&d.retainedTasks===0?d:false})
const recovered=i=>until(i.label+' transport recovery',async()=>{const d=await diag(i);return d.transportState==='healthy'?d:false})
const decisions=ip=>[...e.proxyA.events,...e.proxyB.events].filter(x=>x.limiter&&x.keys.includes(bucket(ip))&&x.reply).map(x=>({...JSON.parse(x.reply),connection:x.connection,at:x.at}))
const ledger=(ip,capacity,rate)=>{
 const rows=decisions(ip),normal=rows.filter(r=>['allowed','limited','unfulfillable'].includes(r.outcome));assert.equal(normal.length,rows.length)
 const spent=normal.filter(r=>r.outcome==='allowed').reduce((n,r)=>n+r.cost*1000,0)
 const first=Math.min(...normal.map(r=>r.billedTimeMs)),last=Math.max(...normal.map(r=>r.billedTimeMs)),bound=capacity*1000+(last-first)*rate
 assert.ok(spent<=bound,'Shared debit exceeds initial plus actual refill');return {rows,spentMilli:spent,initialMilli:capacity*1000,refillUpperBoundMilli:(last-first)*rate,boundMilli:bound}
}
try{
 const A=await e.start('A'),B=await e.start('B')
 await e.check('Two authenticated local diagnostics, isolated namespace and bounded ownership',async()=>{
  const [a,b]=await Promise.all([diag(A),diag(B)]);assert.notEqual(a.instanceId,b.instanceId);assert.equal(a.namespace,b.namespace);assert.equal(a.workers,2);assert.equal(a.queueCapacity,4);assert.equal(a.admissionCapacity,6)
  const anonymous=await fetch(A.base+'/settings/rate-limit/diagnostics');assert.equal(anonymous.status,401);assert.equal(anonymous.headers.get('cache-control'),'no-store');e.report.evidence.startup={a,b}
 })
 await e.check('Two instances debit the same IP atomically with actual refill included; separate clients remain independent',async()=>{
  const rows=[];for(let wave=0;wave<10;wave++)rows.push(...await Promise.all([e.hit(A),e.hit(B),e.hit(A),e.hit(B)]))
  assert.ok(rows.some(r=>r.status===429));assert.ok(rows.every(r=>[200,429].includes(r.status)));const proof=ledger('192.0.2.1',20,1)
  assert.equal(rows.filter(r=>r.status===200).length,proof.rows.filter(r=>r.outcome==='allowed').length)
  assert.equal((await e.hit(A,'192.0.2.2')).status,200);assert.equal((await e.hit(B,'192.0.2.3')).status,200)
  e.report.evidence.shared={...proof,stored:await state('192.0.2.1'),independent:[await state('192.0.2.2'),await state('192.0.2.3')]}
 })
 await e.check('Actual request cost and atomic deficit determine Retry-After; impossible cost has no promised recovery time',async()=>{
  let c=await e.save(A,{burstCapacity:10,replenishRate:1,requestedTokens:5});await e.adopted(B,c.version)
  assert.equal((await e.hit(A,'192.0.2.4')).status,200);assert.equal((await e.hit(B,'192.0.2.4')).status,200)
  const denied=await e.hit(A,'192.0.2.4'),decision=decisions('192.0.2.4').at(-1);assert.equal(denied.status,429)
  const expected=Math.max(1,Math.ceil((decision.billedTimeMs-decision.serverTimeMs+Math.ceil((decision.cost*1000-decision.tokensMilli)/decision.rate))/1000))
  assert.equal(Number(denied.headers['retry-after']),expected);assert.equal(expected,5)
  c=await e.save(A,{burstCapacity:1,requestedTokens:2});await e.adopted(B,c.version)
  const impossible=await e.hit(B,'192.0.2.5');assert.equal(impossible.status,429);assert.equal(impossible.headers['retry-after'],undefined);assert.equal(JSON.parse(impossible.body).retryAfterSeconds,null)
  e.report.evidence.retry={denied,decision,expected,impossible}
 })
 await e.check('Real Redis elapsed time replenishes capacity; rejected requests persist time and balances',async()=>{
  const c=await e.save(A,{burstCapacity:2,replenishRate:4,requestedTokens:2});await e.adopted(B,c.version)
  await e.hit(A,'192.0.2.6');const before=await state('192.0.2.6');assert.equal((await e.hit(B,'192.0.2.6')).status,429)
  await until('earned two tokens by Redis clock',async()=>await time()>=before.billedTimeMs+500)
  assert.equal((await e.hit(B,'192.0.2.6')).status,200);e.report.evidence.refill={...ledger('192.0.2.6',2,4),ttlMs:await e.redis(['PTTL',bucket('192.0.2.6')])}
 })
 const script=(await readFile('backend/src/main/resources/rate-limit.lua','utf8')).replaceAll('\r\n','\n')
 const fixture=script.replace("local time = redis.call('TIME')\nlocal now = tonumber(time[1])*1000+math.floor(tonumber(time[2])/1000)","local now = tonumber(ARGV[5])");assert.notEqual(fixture,script)
 const fixtureKey=e.ns+':controlled-time',epoch=randomUUID(),v=epoch+':1',keys=[fixtureKey+':policy',fixtureKey+':bucket']
 const evalAt=async(now,version=v,cap=2,rate=2,cost=2)=>JSON.parse(await e.redis(['EVAL',fixture,2,...keys,version,cap,rate,cost,now]))
 await e.check('Controlled Lua time fixture rejects duplicate refill after rollback without changing either host clock',async()=>{
  const start=await time()+5000,rows=[];for(const t of [start,start+1000,start,start+1000])rows.push(await evalAt(t))
  assert.deepEqual(rows.map(r=>r.outcome),['allowed','allowed','limited','limited']);assert.equal(rows[2].billedTimeMs,rows[1].billedTimeMs)
  assert.ok(rows[2].expiresAtMs>=rows[1].expiresAtMs);assert.equal(rows.filter(x=>x.outcome==='allowed').reduce((n,x)=>n+x.cost,0),4)
  e.report.evidence.clock={layer:'Production Lua with only Redis TIME source replaced by a controlled argument, running on real isolated Redis; no gateway or host clock altered',rows,
    actualProductionTimeArguments:'HTTP clients send no timestamp; limiter EVAL arguments are version, capacity, rate and cost only'}
 })
 await e.check('Gateway-clock skew cannot influence production Lua time or issue extra credit',async()=>{
  const key=e.ns+':caller-clock',begin=await time(),rows=[]
  // An extra legacy time hint is deliberately supplied directly to Lua; production gateways send only four arguments.
  for(const localTime of [begin-86400000,begin+86400000,begin-86400000]) {
   rows.push(JSON.parse(await e.redis(['EVAL',script,2,key+':policy',key+':bucket',v,2,1,1,localTime])))
  }
  const end=await time();assert.deepEqual(rows.map(x=>x.outcome),['allowed','allowed','limited'])
  assert.ok(rows.every(x=>x.serverTimeMs>=begin&&x.serverTimeMs<=end));assert.ok(end-begin<1000)
  e.report.evidence.callerClock={layer:'Unmodified production Lua on real Redis, with deliberately skewed unused legacy time hints; JVM and host clocks unchanged',begin,end,rows}
 })
 await e.check('Idle expiration is no earlier than universal quota recovery; policy survives collection and stale recreation',async()=>{
  await e.redis(['DEL',...keys]);const old=await evalAt(await time()-10003000,v,10000,1,100)
  assert.equal(await e.redis(['EXISTS',keys[1]]),0);assert.equal(await e.redis(['PTTL',keys[0]]),-1)
  const fresh=await evalAt(await time(),epoch+':3',3,1,3);assert.equal(fresh.tokensMilli,0)
  await e.redis(['DEL',keys[1]]);const stale=await evalAt(await time(),v,10000,1,1);assert.equal(stale.version,epoch+':3');assert.equal(stale.capacity,3);assert.equal(stale.cost,3)
  e.report.evidence.expiry={layer:'Real Redis PXAT expiry with a dedicated historical-time Lua fixture; explicit subsequent bucket deletion separately tests retained version fencing',old,fresh,stale}
 })
 await e.check('A newer policy settles old-rate credit then clamps; stale B cannot restore capacity, rate or cost',async()=>{
  let c=await e.save(A,{burstCapacity:100,replenishRate:1,requestedTokens:10});await e.adopted(B,c.version)
  await e.hit(B,'192.0.2.7');const old=await state('192.0.2.7');e.proxyB.blockSync=true
  await until('B background reply held',()=>e.proxyB.held.some(x=>x.sync))
  c=await e.save(A,{burstCapacity:5,replenishRate:3,requestedTokens:2});const oldAdopted=await e.api(B,'/settings/runtime/adopted');assert.notEqual(oldAdopted.version,c.version)
  await e.hit(A,'192.0.2.7');const afterA=await state('192.0.2.7');assert.equal(afterA.tokensMilli,3000)
  await e.hit(B,'192.0.2.7');const afterB=await state('192.0.2.7'),stale=decisions('192.0.2.7').at(-1);assert.equal(afterB.policy.version,c.version);assert.equal(stale.cost,2);assert.equal(stale.staleRequest,true)
  await until('observable old-rate interval before growth',async()=>await time()>=afterB.billedTimeMs+50)
  c=await e.save(A,{burstCapacity:100,replenishRate:8,requestedTokens:1});await e.hit(A,'192.0.2.7');const grown=await state('192.0.2.7')
  const oldCredit=Math.min(afterB.policy.capacity*1000,afterB.tokensMilli+(grown.billedTimeMs-afterB.billedTimeMs)*afterB.policy.rate)
  assert.equal(grown.tokensMilli,oldCredit-1000,'The previous interval must use the stored old rate, not the new incoming rate')
  assert.ok(grown.tokensMilli<10000,'Capacity increase must not mint a full bucket')
  e.report.evidence.policySwitch={old,oldAdopted,afterA,afterB,stale,grown}
  e.proxyB.release();await e.adopted(B,c.version)
 })
 await e.check('Disable and re-enable propagate asynchronously; bypass never resets retained credit',async()=>{
  e.proxyB.blockSync=true;await until('B stale switch boundary',()=>e.proxyB.held.some(x=>x.sync))
  const previous=(await diag(B)).adopted.version,before=await state('192.0.2.7');let c=await e.save(A,{rateLimitEnabled:false})
  const index=e.proxyA.events.length;assert.equal((await e.hit(A,'192.0.2.7')).status,200);assert.equal(e.proxyA.events.slice(index).filter(x=>x.limiter).length,0)
  await e.hit(B,'192.0.2.7');assert.equal((await diag(B)).adopted.version,previous)
  e.proxyB.release();await e.adopted(B,c.version);const j=e.proxyB.events.length;await e.hit(B,'192.0.2.7');assert.equal(e.proxyB.events.slice(j).filter(x=>x.limiter).length,0)
  e.proxyB.blockSync=true;await until('B remains disabled',()=>e.proxyB.held.some(x=>x.sync))
  c=await e.save(A,{rateLimitEnabled:true});await e.hit(A,'192.0.2.7');const after=await state('192.0.2.7');assert.ok(after.tokensMilli<100000)
  const k=e.proxyB.events.length;await e.hit(B,'192.0.2.7');assert.equal(e.proxyB.events.slice(k).filter(x=>x.limiter).length,0)
  e.report.evidence.switch={before,after,previous,enabledVersion:c.version};e.proxyB.release();await e.adopted(B,c.version)
 })
 await e.check('Foreign epoch and invalid bucket produce explicit degradation without repairing or overwriting state',async()=>{
  const before=await e.redis(['GET',keys[1]]);const foreign=await evalAt(await time(),randomUUID()+':999');assert.equal(foreign.reason,'epoch_mismatch');assert.equal(await e.redis(['GET',keys[1]]),before)
  const key=bucket('192.0.2.8');await e.redis(['SET',key,'corrupt']);const response=await e.hit(A,'192.0.2.8');assert.equal(response.status,200)
  const d=await diag(A);assert.equal(d.lastDecision.reason,'bucket_invalid');assert.equal(d.lastDecision.outcome,'redis_fail_open');assert.equal(await e.redis(['GET',key]),'corrupt')
  e.report.evidence.invalid={foreign,response,diagnostic:d};await e.redis(['DEL',key])
 })
 await e.check('Trusted IP walk and untrusted peers cannot spoof independent quotas',async()=>{
  let c=await e.save(A,{burstCapacity:1,replenishRate:1,requestedTokens:1});await e.adopted(B,c.version)
  const first=await e.hit(A,'198.51.100.9'),same=await e.hit(B,'203.0.113.88, 198.51.100.9'),other=await e.hit(B,'198.51.100.10')
  assert.equal(first.status,200);assert.equal(same.status,429);assert.equal(other.status,200)
  const C=await e.start('B-untrusted',{trusted:false});await e.redis(['DEL',bucket('127.0.0.1')])
  const c1=await e.hit(C,'198.51.100.11'),c2=await e.hit(C,'198.51.100.12');assert.equal(c1.status,200);assert.equal(c2.status,429)
  e.report.evidence.ip={trusted:[first,same,other],untrusted:[c1,c2],state:await state('127.0.0.1')}
  c=await e.save(A,{burstCapacity:100,replenishRate:1,requestedTokens:1});await e.adopted(B,c.version)
 })
 await e.check('Executed command with lost reply is not retried or refunded; fail-open remains separately visible',async()=>{
  e.proxyA.setMode('drop-reply');const job=e.hit(A,'192.0.2.20')
  await until('Redis executed and reply captured',()=>e.proxyA.held.some(x=>x.limiter&&x.keys.includes(bucket('192.0.2.20'))))
  const executed=await state('192.0.2.20');assert.equal(executed.tokensMilli,99000)
  const response=await job;assert.equal(response.status,200);assert.ok(response.elapsedMs>=350&&response.elapsedMs<1500)
  const beforeRecovery=await diag(A);assert.equal(beforeRecovery.lastDecision.outcome,'redis_fail_open');assert.equal(beforeRecovery.lastDecision.execution,'unknown')
  const releasedAt=e.proxyA.release();const recovery=await recovered(A);await released(A)
  const frames=e.proxyA.events.filter(x=>x.limiter&&x.keys.includes(bucket('192.0.2.20')));assert.equal(frames.length,1);assert.equal((await state('192.0.2.20')).tokensMilli,99000)
  e.report.evidence.lostReply={response,executed,beforeRecovery,recovery,frames,releasedAt,recoveryAfterReleaseMs:Date.parse(recovery.lastRecoveryAt)-Date.parse(releasedAt)}
 })
 await e.check('Sustained overload and withheld commands keep queue, physical I/O and wait bounded; closed commands never replay',async()=>{
  e.proxyA.setMode('hold-request');const initial=Array.from({length:6},()=>e.hit(A,'192.0.2.21'))
  const saturated=await until('two physical commands and four queued decisions',async()=>{const d=await diag(A);return d.commandsInFlight===2&&d.queued===4&&d.availableDecisionPermits===0&&d.scheduledTasks<=7?d:false})
  const overload=Array.from({length:24},()=>e.hit(A,'192.0.2.21'));const rows=await Promise.all([...initial,...overload]);assert.ok(rows.every(r=>r.status===200));assert.ok(rows.every(r=>r.elapsedMs<1500))
  const degraded=await released(A);assert.ok(degraded.peakCommandsInFlight<=2&&degraded.peakQueued<=4);assert.ok(degraded.outcomes.local_fail_open>0);assert.equal(await e.redis(['EXISTS',bucket('192.0.2.21')]),0)
  const further=[];for(let n=0;n<4;n++)further.push(...await Promise.all(Array.from({length:16},()=>e.hit(A,'192.0.2.21'))))
  assert.ok(further.every(r=>r.status===200&&r.elapsedMs<1500));const releasedAt=e.proxyA.release();const recovery=await recovered(A);await released(A)
  assert.equal(await e.redis(['EXISTS',bucket('192.0.2.21')]),0)
  const frames=e.proxyA.events.filter(x=>x.limiter&&x.keys.includes(bucket('192.0.2.21')));assert.ok(frames.every(x=>!x.forwarded&&x.discardedOnClose));assert.equal(frames.length,2)
  e.report.evidence.overload={rows,further,saturated,degraded,recovery,frames,maxObservedWaitMs:Math.max(...rows.map(r=>r.elapsedMs),...further.map(r=>r.elapsedMs)),releasedAt,recoveryAfterReleaseMs:Date.parse(recovery.lastRecoveryAt)-Date.parse(releasedAt)}
 })
 await e.check('Transport disconnection degrades only quota decisions and background probes recover automatically',async()=>{
  e.proxyB.setMode('disconnect');const rows=await Promise.all([e.hit(B,'192.0.2.22'),e.hit(B,'192.0.2.22')]);assert.ok(rows.every(r=>r.status===200))
  const degraded=await diag(B);assert.notEqual(degraded.transportState,'healthy');const releasedAt=e.proxyB.release();const restored=await recovered(B)
  assert.equal((await e.hit(B,'192.0.2.22')).status,200);assert.equal(decisions('192.0.2.22').filter(x=>x.outcome==='allowed').length,1)
  e.report.evidence.disconnect={rows,degraded,restored,releasedAt,recoveryAfterReleaseMs:Date.parse(restored.lastRecoveryAt)-Date.parse(releasedAt)}
 })
 await e.check('Client cancellation closes actual pending I/O without success accounting or automatic refund',async()=>{
  await released(A);e.proxyA.setMode('hold-request');const before=await diag(A),job=e.hit(A,'192.0.2.23')
  await until('cancel at captured command',()=>e.proxyA.held.some(x=>x.limiter&&x.keys.includes(bucket('192.0.2.23'))));job.abort();await job
  const after=await released(A);assert.equal(after.outcomes.cancelled,before.outcomes.cancelled+1);assert.equal(after.outcomes.allowed,before.outcomes.allowed)
  e.proxyA.release();assert.equal(await e.redis(['EXISTS',bucket('192.0.2.23')]),0);e.report.evidence.cancel={before,after,path:job.path}
 })
 await e.check('Cancelling after Redis executed preserves the debit and never repeats the operation',async()=>{
  e.proxyA.setMode('drop-reply',{one:true});const before=await diag(A),job=e.hit(A,'192.0.2.26')
  await until('cancel after executed debit',()=>e.proxyA.held.some(x=>x.limiter&&x.keys.includes(bucket('192.0.2.26'))))
  const committed=await state('192.0.2.26');job.abort();await job;const after=await released(A);e.proxyA.release()
  assert.equal(committed.tokensMilli,99000);assert.equal((await state('192.0.2.26')).tokensMilli,99000);assert.equal(after.outcomes.cancelled,before.outcomes.cancelled+1)
  assert.equal(e.proxyA.events.filter(x=>x.limiter&&x.keys.includes(bucket('192.0.2.26'))).length,1);e.report.evidence.cancelAfterCommit={committed,before,after,path:job.path}
 })
 await e.check('A real Redis write pause bounds waiting and probes; commands received before timeout remain explicitly uncertain',async()=>{
  await released(A);await e.redis(['CLIENT','PAUSE',10000,'WRITE']);let rows,paused,afterTimeout
  try{
   const start=e.proxyA.events.length,jobs=[e.hit(A,'192.0.2.27'),e.hit(A,'192.0.2.27')]
   await until('both EVALs forwarded to paused Redis',()=>e.proxyA.events.slice(start).filter(x=>x.limiter&&x.keys.includes(bucket('192.0.2.27'))&&x.forwarded).length===2)
   paused=await e.redis(['CLIENT','LIST']);rows=await Promise.all(jobs);assert.ok(rows.every(x=>x.status===200&&x.elapsedMs<1500));afterTimeout=await diag(A)
   assert.notEqual(afterTimeout.transportState,'healthy');assert.equal(await e.redis(['EXISTS',bucket('192.0.2.27')]),0)
  }finally{await e.redis(['CLIENT','UNPAUSE'])}
  const recovery=await recovered(A);await released(A);const final=await state('192.0.2.27'),commands=e.proxyA.events.filter(x=>x.limiter&&x.keys.includes(bucket('192.0.2.27')))
  assert.equal(commands.length,2);assert.ok(final===null||(final.tokensMilli>=98000&&final.tokensMilli<=100000))
  e.report.evidence.serverPause={rows,pausedClients:paused,afterTimeout,recovery,final,commands,
   guarantee:'No replay/refund. These two commands had reached Redis; local timeout or close does not prove whether they execute. Recorded final state describes this run only.'}
 })
 await e.check('Offline legacy migration and explicit epoch adoption preserve credit without changing runtime configuration',async()=>{
  const ns=e.ns+':maintenance',runtime=ns+':runtime',legacy=ns+':legacy:',runtimeSnapshot=await e.api(A,'/settings/runtime/adopted')
  await e.redis(['SET',runtime,JSON.stringify(runtimeSnapshot)]);await e.redis(['HSET',legacy+'192.0.2.40','tokens','2.75','ts','1'])
  const args={port:e.report.isolation.redisPort,namespace:ns,runtimeKey:runtime,backup:join(e.out,'legacy-backup.jsonl'),mode:'migrate-v1',legacyPrefix:legacy}
  await assert.rejects(()=>migrateLimiter(args),/maintenance/)
  const migrated=await migrateLimiter({...args,maintenance:true}),first=JSON.parse(await e.redis(['GET',ns+':bucket:192.0.2.40']));assert.equal(first.tokensMilli,2750);assert.equal(migrated.count,1)
  assert.equal(await e.redis(['HGET',legacy+'192.0.2.40','tokens']),'2.75')
  await assert.rejects(()=>migrateLimiter({...args,maintenance:true}),/EEXIST/)
  const next={...runtimeSnapshot,version:randomUUID()+':1',burstCapacity:2};await e.redis(['SET',runtime,JSON.stringify(next)])
  const adopted=await migrateLimiter({...args,mode:'adopt-epoch',maintenance:true,backup:join(e.out,'epoch-backup.jsonl')})
  const after=JSON.parse(await e.redis(['GET',ns+':bucket:192.0.2.40']));assert.equal(after.tokensMilli,2000);assert.equal(after.policy.version,next.version)
  assert.deepEqual(JSON.parse(await e.redis(['GET',runtime])),next)
  e.report.evidence.migration={migrated,first,adopted,after,layer:'Dedicated maintenance keys in real Redis; no application uses this namespace during migration'}
 })
 await e.check('EVAL is cache independent: SCRIPT FLUSH causes one decision and no retry',async()=>{
  await e.redis(['SCRIPT','FLUSH']);const before=e.proxyA.events.length;assert.equal((await e.hit(A,'192.0.2.24')).status,200)
  const commands=e.proxyA.events.slice(before).filter(x=>x.limiter);assert.equal(commands.length,1);assert.equal(commands[0].command,'EVAL');e.report.evidence.scriptCache=commands
 })
 await e.check('Proxy requests and local diagnostics add zero runtime configuration queries',async()=>{
  e.proxyB.blockSync=true;await until('sync isolated from request experiment',()=>e.proxyB.held.some(x=>x.sync));const start=e.proxyB.events.length
  for(let n=0;n<10;n++)assert.equal((await e.hit(B,'192.0.2.25')).status,200)
  for(let n=0;n<10;n++){await diag(B);await e.api(B,'/settings/runtime/adopted')}
  const events=e.proxyB.events.slice(start),config=events.filter(x=>x.key===e.key);assert.ok(events.filter(x=>x.limiter).every(x=>x.arguments.length===4),'Quota commands must carry version/capacity/rate/cost, never a gateway timestamp');assert.ok(config.every(x=>x.sync));assert.equal(config.filter(x=>!x.sync).length,0)
  e.report.evidence.hotPath={proxyRequests:10,localDiagnosticReads:20,extraRuntimeConfigurationQueries:0,backgroundReads:config.length,limiterCommands:events.filter(x=>x.limiter).length};e.proxyB.release()
 })
 await e.check('Every proxy entry reconciles to one final audit and an independent quota outcome',async()=>{
  const perInstance={}
  for(const instance of e.processes){
   await until(instance.label+' audit drained',async()=>(await e.api(instance,'/monitor/audit/status')).pending===0)
   const audit=(await e.redis(['LRANGE',e.ns+':audit:'+instance.label,0,-1])).map(x=>JSON.parse(x)),d=await released(instance)
   assert.equal(d.decisionsStarted,d.decisionsCompleted);assert.equal(Object.values(d.outcomes).reduce((a,b)=>a+b,0),d.decisionsCompleted)
   const tally={};for(const row of audit){tally[row.rateLimitOutcome]=(tally[row.rateLimitOutcome]||0)+1}
   for(const [outcome,count] of Object.entries(d.outcomes))assert.equal(tally[outcome]||0,count,'audit quota outcome '+outcome+' '+instance.label)
   for(const request of e.report.requests.filter(r=>r.instance===instance.label&&r.status!==404))assert.equal(audit.filter(x=>x.path===request.path).length,1,'exactly one final audit '+request.path)
   assert.ok(audit.filter(x=>x.statusCode===429).every(x=>x.reason==='gateway_limited'))
   perInstance[instance.label]={diagnostics:d,audit,tally}
  }
  e.report.evidence.accounting=perInstance
 })
 await e.check('Graceful shutdown closes held limiter I/O and its workers; no client or command survives the instance',async()=>{
  const C=e.processes.find(i=>i.label==='B-untrusted');e.proxyB.setMode('hold-request')
  const pending=e.hit(C,'192.0.2.28');await until('shutdown at captured command',()=>e.proxyB.held.some(x=>x.limiter&&x.keys.includes(bucket('127.0.0.1'))))
  const atShutdown=await diag(C);assert.equal(atShutdown.commandsInFlight,1)
  const response=await e.api(C,'/actuator/shutdown',{method:'POST',body:'{}'});await pending
  await until('shutdown process exit',()=>C.child.exitCode!==null,20000);assert.equal(C.child.exitCode,0)
  e.proxyB.release();const clients=await e.redis(['CLIENT','LIST']);assert.ok(!clients.includes('zenith-rate-limit:'+atShutdown.instanceId))
  const log=await readFile(join(e.out,C.label+'.log'),'utf8');assert.match(log,/Rate-limit workers stopped; active=0, queued=0, commands=0/);assert.match(log,/Rate-limit result dispatch stopped; active=0, queued=0, retained=0/)
  const audit=(await e.redis(['LRANGE',e.ns+':audit:'+C.label,0,-1])).map(x=>JSON.parse(x));assert.equal(audit.filter(x=>x.path===pending.path).length,1)
  e.report.evidence.shutdown={atShutdown,response,exitCode:C.child.exitCode,finalAudit:audit.find(x=>x.path===pending.path),noRemainingNamedLimiterClient:true,workersStopped:true}
 })
}catch(error){failure=error}finally{e.proxyA.release();e.proxyB.release();await e.finish(failure)}
