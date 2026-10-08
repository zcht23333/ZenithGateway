import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {resolve,join} from 'node:path'
import {environment,until} from './rate-limit-harness.mjs'
import {fullyIdle,faultRequestsRetired} from './limiter-policy-gates.mjs'

const out=resolve(process.env.RATE_LIMIT_POLICY_OUTPUT||'.dev/limiter-failure-policy/live-'+randomUUID().slice(0,8))
await mkdir(out,{recursive:true})
const jar=join(out,'gateway-final.jar'),fixtureJar=join(out,'limiter-policy-fixture.jar')
await copyFile(process.env.RATE_LIMIT_POLICY_JAR||'backend/target/zg-1.0.0.jar',jar)
const jarTool=join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'jar.exe':'jar')
const productionEntries=execFileSync(jarTool,['tf',jar],{encoding:'utf8',windowsHide:true})
assert(!productionEntries.includes('LimiterPolicyGate'),'Test fixture must not ship in production jar')
const fixtureClasses=join(out,'fixture-classes'),fixturePackage=join(fixtureClasses,'com/zch/verification')
await mkdir(fixturePackage,{recursive:true})
for(const name of ['LimiterPolicyGate.class','LimiterPolicyGate$Gate.class'])
 await copyFile(join('backend/target/test-classes/com/zch/verification',name),join(fixturePackage,name))
// Include package directory entries so Spring's classpath resource scan can find the test-only component.
execFileSync(jarTool,['--create','--file',fixtureJar,'-C',fixtureClasses,'.'],{windowsHide:true})
const e=await environment({out,jar,fixtureJar,extra:['--zenith.limiter.workers=1','--zenith.limiter.queue-capacity=1',
 '--zenith.limiter.decision-timeout-ms=1500','--zenith.limiter.saturation-sampling-enabled=true']})
e.report.fixture={sha256:createHash('sha256').update(await readFile(fixtureJar)).digest('hex'),productionJarContainsFixture:false,
 layer:'A separately loaded test-only GlobalFilter holds one synchronous result consumer with one bounded latch (5s). Real gateway, production limiter, Redis, upstream and HTTP are unchanged. Not a performance experiment.'}
let failure,ipSequence=30
const ip=()=> '192.0.2.'+(ipSequence++),bucket=ip=>e.ns+':bucket:'+ip
const diag=i=>e.api(i,'/settings/rate-limit/diagnostics')
const proxy=i=>i.label.startsWith('A')?e.proxyA:e.proxyB
const allAudit=async i=>(await e.redis(['LRANGE',e.ns+':audit:'+i.label,0,-1])).map(x=>JSON.parse(x))
const audit=async(i,path)=>until('one audit '+path,async()=>{const rows=(await allAudit(i)).filter(x=>x.path===path);assert(rows.length<=1);return rows[0]})
const arrivals=row=>e.arrivals.filter(x=>x.path===row.path.replace(/^\/probe/,''))
const idle=i=>until(i.label+' bounded resources released',async()=>{
 const d=await diag(i)
 return fullyIdle(d)?d:false
})
const retiredDuringFault=(i,p,keyIp)=>{
 const trace=[];e.report.evidence[i.label+'-retirement-'+keyIp]=trace
 return until(i.label+' business commands physically retired during recovery probes',async()=>{
  const d=await diag(i),frames=p.events.filter(x=>x.limiter&&x.keys.includes(bucket(keyIp)))
  const released=faultRequestsRetired(d,frames)
  trace.push({at:new Date().toISOString(),released,commandsInFlight:d.commandsInFlight,activeWorkers:d.activeWorkers,queued:d.queued,closing:d.closing,retainedTasks:d.retainedTasks,availableDecisionPermits:d.availableDecisionPermits,transportState:d.transportState,businessCommands:frames.length,physicallyClosed:frames.filter(f=>f.discardedOnClose).length})
  if(trace.length>64)trace.shift()
  return released?{diagnostic:d,businessCommands:frames,meaning:'Business commands closed; one bounded recovery probe may remain. Full idle is required again after fault release.'}:false
 })
}
const healthy=i=>until(i.label+' recovered',async()=>{const d=await diag(i);return d.transportState==='healthy'?d:false})
const gate=(i,action)=>e.api(i,'/settings/verification/limiter-gate',{method:'POST',body:JSON.stringify({action})})
const entered=i=>until(i.label+' synchronous consumer held',async()=>{const g=await e.api(i,'/settings/verification/limiter-gate');assert.equal(g.timedOut,false);return g.entered?g:false})
const queued=i=>until(i.label+' IO queue occupied',async()=>{const d=await diag(i);return d.queued===1?d:false})
async function verify(i,row,{event,execution,source,status}={}){
 const a=await audit(i,row.path),expected=a.rateLimitAction==='reject'?(a.rateLimitEvent==='local_unavailable'||a.rateLimitEvent==='redis_unconfirmed'?503:429):a.rateLimitAction==='cancel'?0:200
 assert.equal(row.status,status??expected);assert.equal(arrivals(row).length,expected===200?1:0)
 if(event)assert.equal(a.rateLimitEvent,event)
 if(execution)assert.equal(a.rateLimitExecution,execution)
 if(source)assert.equal(a.rateLimitRejectionSource,source)
 if(expected===503){const body=JSON.parse(row.body);assert.equal(body.limitExecution,a.rateLimitExecution);assert.equal(body.limitAction,'reject');assert.equal(body.limitEvent,a.rateLimitEvent);assert.equal(body.limitReason,a.rateLimitReason);assert.equal(body.limitRejectionSource,a.rateLimitRejectionSource??null);assert.equal(row.headers['cache-control'],'no-store');assert.equal(row.headers['retry-after'],undefined)}
 return {request:row,audit:a,upstreamReceived:arrivals(row).length}
}
const save=async(instances,patch)=>{const c=await e.save(instances[0],patch);await Promise.all(instances.map(i=>e.adopted(i,c.version)));return c}
try{
 const O=await e.start('A-default'),S=await e.start('B-strict',{flags:['--zenith.limiter.local-failure-policy=reject','--zenith.limiter.redis-failure-policy=reject']})
 const L=await e.start('A-local-strict',{flags:['--zenith.limiter.local-failure-policy=reject']})
 const R=await e.start('B-redis-strict',{flags:['--zenith.limiter.redis-failure-policy=reject']})
 const instances=[O,S,L,R]
 await save(instances,{burstCapacity:100,replenishRate:1,requestedTokens:1})
 await e.check('All four independent policy combinations bind; authenticated no-store local diagnostics disclose policy',async()=>{
  const states=await Promise.all(instances.map(diag));assert.deepEqual(states.map(d=>[d.localFailurePolicy,d.redisFailurePolicy]),[['allow','allow'],['reject','reject'],['reject','allow'],['allow','reject']])
  for(const i of instances){const r=await fetch(i.base+'/settings/rate-limit/diagnostics');assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store')}
  e.report.evidence.startup=states
 })
 for(const i of instances){
  await e.check(i.label+' admission saturation chooses only local policy and recovery uses Redis policy',async()=>{
   await idle(i);const p=proxy(i),keyIp=ip(),before=await diag(i);p.setMode('hold-request')
   const one=e.hit(i,keyIp);await until('first command held',()=>p.held.some(x=>x.limiter&&x.keys.includes(bucket(keyIp))))
   const two=e.hit(i,keyIp);const boundary=await queued(i);assert.equal(boundary.availableDecisionPermits,0)
   const extras=await Promise.all(Array.from({length:4},()=>e.hit(i,keyIp))),rows=[]
   for(const row of extras){const proof=await verify(i,row,{event:'local_unavailable',execution:'not_sent',source:'admission_full'});assert.equal(row.status,before.localFailurePolicy==='reject'?503:200);rows.push(proof)}
   const pending=await Promise.all([one,two]);for(const row of pending)rows.push(await verify(i,row))
   const shortCircuit=await e.hit(i,keyIp);rows.push(await verify(i,shortCircuit,{event:'redis_unconfirmed',execution:'not_sent'}));assert.equal(shortCircuit.status,before.redisFailurePolicy==='reject'?503:200)
   const released=await retiredDuringFault(i,p,keyIp);assert.equal(await e.redis(['EXISTS',bucket(keyIp)]),0)
   const restoredAt=p.release();const restored=await healthy(i);await idle(i)
   assert.equal(await e.redis(['EXISTS',bucket(keyIp)]),0)
   e.report.evidence[i.label+'-admission']={before,boundary,released,restoredAt,recoveryMs:Date.parse(restored.lastRecoveryAt)-Date.parse(restoredAt),rows,commands:p.events.filter(x=>x.limiter&&x.keys.includes(bucket(keyIp)))}
  })
  await e.check(i.label+' executed debit with lost reply preserves unknown, never retries or refunds, and obeys Redis policy',async()=>{
   const p=proxy(i),keyIp=ip(),before=await diag(i);p.setMode('drop-reply')
   const job=e.hit(i,keyIp,{method:'POST'});await until('committed reply captured',()=>p.held.some(x=>x.limiter&&x.keys.includes(bucket(keyIp))&&x.reply))
   const committed=JSON.parse(await e.redis(['GET',bucket(keyIp)]));assert.equal(committed.tokensMilli,99000)
   const row=await job,proof=await verify(i,row,{event:'redis_unconfirmed',execution:'unknown'});assert.equal(row.status,before.redisFailurePolicy==='reject'?503:200)
   const released=await retiredDuringFault(i,p,keyIp);const releaseAt=p.release(),restored=await healthy(i);await idle(i)
   const frames=p.events.filter(x=>x.limiter&&x.keys.includes(bucket(keyIp)));assert.equal(frames.length,1)
   assert.equal(JSON.parse(await e.redis(['GET',bucket(keyIp)])).tokensMilli,99000)
   e.report.evidence[i.label+'-lost-reply']={proof,committed,frames,released,releaseAt,recoveryMs:Date.parse(restored.lastRecoveryAt)-Date.parse(releaseAt)}
  })
 }
 for(const i of [O,S]){
  await e.check(i.label+' actual executor rejection and queued deadline retain local reason, with no Redis dispatch',async()=>{
   await idle(i);await gate(i,'arm');const before=await diag(i),one=e.hit(i,ip(),{headers:{'X-Verification-Limiter-Gate':'hold'}})
   let two,third,held,queuedAt
   try{
    held=await entered(i);assert.match(held.thread,/^rate-limit-io-/)
    two=e.hit(i,ip());queuedAt=await queued(i)
    third=await e.hit(i,ip());const executor=await verify(i,third,{event:'local_unavailable',execution:'not_sent',source:'executor_rejected'})
    assert.equal(third.status,before.localFailurePolicy==='reject'?503:200)
    const timeout=await verify(i,await two,{event:'local_unavailable',execution:'not_sent'});assert.equal(timeout.audit.rateLimitReason,'queue_timeout')
    assert.equal(timeout.request.status,before.localFailurePolicy==='reject'?503:200)
    e.report.evidence[i.label+'-executor']={held,queuedAt,executor,timeout}
   }finally{await gate(i,'release');await one;if(two)await two}
   await idle(i)
   const last=await diag(i);assert.equal(last.transportState,'healthy')
  })
  await e.check(i.label+' Redis connection loss follows Redis policy, records unknown and restores automatically',async()=>{
   const p=proxy(i),keyIp=ip(),before=await diag(i);p.setMode('disconnect')
   const proof=await verify(i,await e.hit(i,keyIp),{event:'redis_unconfirmed',execution:'unknown'})
   assert.equal(proof.request.status,before.redisFailurePolicy==='reject'?503:200);assert.equal(await e.redis(['EXISTS',bucket(keyIp)]),0)
   const at=p.release(),restored=await healthy(i);await idle(i)
   const recovered=await verify(i,await e.hit(i,keyIp),{event:'allowed',execution:'confirmed'})
   e.report.evidence[i.label+'-disconnect']={proof,recovered,at,recoveryMs:Date.parse(restored.lastRecoveryAt)-Date.parse(at)}
  })
  await e.check(i.label+' cancelling queued work records not_sent, without a policy rejection or upstream request',async()=>{
   await idle(i);await gate(i,'arm');const one=e.hit(i,ip(),{headers:{'X-Verification-Limiter-Gate':'hold'}});let job
   try{await entered(i);job=e.hit(i,ip());await queued(i);job.abort();e.report.evidence[i.label+'-cancel-queued']=await verify(i,await job,{event:'cancelled',execution:'not_sent'})}
   finally{await gate(i,'release');await one;if(job)await job}
   await idle(i)
  })
  await e.check(i.label+' cancellation after a committed debit closes resources without refund or success accounting',async()=>{
   await idle(i);const p=proxy(i),keyIp=ip();p.setMode('hold-reply')
   const job=e.hit(i,keyIp);await until('commit before cancellation',()=>p.held.some(x=>x.limiter&&x.keys.includes(bucket(keyIp))&&x.reply))
   assert.equal(JSON.parse(await e.redis(['GET',bucket(keyIp)])).tokensMilli,99000);job.abort()
   const proof=await verify(i,await job,{event:'cancelled',execution:'unknown'});assert.equal(proof.audit.outcome,'cancelled')
   const resources=await idle(i);p.release();assert.equal(JSON.parse(await e.redis(['GET',bucket(keyIp)])).tokensMilli,99000)
   assert.equal(p.events.filter(x=>x.limiter&&x.keys.includes(bucket(keyIp))).length,1)
   e.report.evidence[i.label+'-cancel-after-commit']={proof,resources}
  })
  await e.check(i.label+' damaged bucket has a definite not_written fact while quota remains unconfirmed',async()=>{
   const keyIp=ip();await e.redis(['SET',bucket(keyIp),'false'])
   const proof=await verify(i,await e.hit(i,keyIp),{event:'redis_unconfirmed',execution:'not_written'})
   assert.equal(proof.audit.rateLimitReason,'bucket_invalid');assert.equal(proof.request.status,i===S?503:200);assert.equal(await e.redis(['GET',bucket(keyIp)]),'false')
   e.report.evidence[i.label+'-invalid-bucket']=proof
  })
 }
 await e.check('Quota exhaustion is 429 in both modes; impossible cost never advertises retry time',async()=>{
  await save(instances,{burstCapacity:10,requestedTokens:10,replenishRate:1});const rows=[]
  for(const i of [O,S]){const keyIp=ip();assert.equal((await e.hit(i,keyIp)).status,200);const proof=await verify(i,await e.hit(i,keyIp),{event:'limited',execution:'confirmed',status:429});assert(Number(proof.request.headers['retry-after'])>0);rows.push(proof)}
  await save(instances,{burstCapacity:1,requestedTokens:2})
  for(const i of [O,S]){const proof=await verify(i,await e.hit(i,ip()),{event:'unfulfillable',execution:'confirmed',status:429});assert.equal(proof.request.headers['retry-after'],undefined);rows.push(proof)}
  e.report.evidence.quota=rows;await save(instances,{burstCapacity:100,requestedTokens:1})
 })
 await e.check('Explicit runtime disable remains a bypass even in strict mode; policies do not change six-field protocol',async()=>{
  await save(instances,{rateLimitEnabled:false});const p=proxy(S),start=p.events.length
  const proof=await verify(S,await e.hit(S,ip()),{event:'disabled',execution:'not_sent',status:200});assert.equal(p.events.slice(start).filter(x=>x.limiter).length,0)
  e.report.evidence.disabled=proof;await save(instances,{rateLimitEnabled:true})
 })
 const H=await e.start('B-strict-handoff',{flags:['--zenith.limiter.local-failure-policy=reject','--zenith.limiter.redis-failure-policy=reject','--zenith.limiter.result-handoff-enabled=true','--zenith.limiter.result-workers=1']});instances.push(H)
 await e.check('Strict handoff mode bounds occupied result stages and rejects admission before Redis',async()=>{
  await idle(H);await gate(H,'arm');const one=e.hit(H,ip(),{headers:{'X-Verification-Limiter-Gate':'hold'}});let two
  try{
   const held=await entered(H);assert.match(held.thread,/^rate-limit-result-/);two=e.hit(H,ip())
   const d=await until('one active, one queued delivery',async()=>{const d=await diag(H);return d.activeDeliveries===1&&d.queuedDeliveries===1&&d.commandsInFlight===0?d:false})
   const proof=await verify(H,await e.hit(H,ip()),{event:'local_unavailable',source:'admission_full',execution:'not_sent',status:503})
   e.report.evidence.handoff={held,boundary:d,proof}
  }finally{await gate(H,'release');await one;if(two)await two}
  await idle(H)
 })
 await e.check('Real recovery forwards only with a new confirmed decision; local diagnostics add zero runtime configuration reads',async()=>{
  e.proxyB.blockSync=true;await until('background read held',()=>e.proxyB.held.some(x=>x.sync));const start=e.proxyB.events.length,rows=[]
  for(let n=0;n<5;n++){rows.push(await verify(S,await e.hit(S,ip()),{event:'allowed',execution:'confirmed'}));await diag(S)}
  const events=e.proxyB.events.slice(start),extra=events.filter(x=>x.key===e.key&&!x.sync)
  assert.equal(extra.length,0);e.report.evidence.hotPath={rows,extraRuntimeQueries:extra.length,backgroundReads:events.filter(x=>x.sync).length};e.proxyB.release()
 })
 await e.check('HTTP, upstream, terminal facts/actions/executions, Prometheus counters and final audit reconcile exactly once',async()=>{
  const accounting={}
  for(const i of instances){
   const d=await idle(i);await until(i.label+' audit drain',async()=>{const a=await e.api(i,'/monitor/audit/status');return a.pending===0&&a.received===a.persisted?a:false})
   const audits=await allAudit(i);assert.equal(d.decisionsStarted,d.decisionsCompleted);assert.equal(audits.length,d.decisionsCompleted)
   const sum=m=>Object.values(m).reduce((a,b)=>a+b,0)
   for(const m of [d.outcomes,d.observations.events,d.observations.actions,d.observations.executions])assert.equal(sum(m),d.decisionsCompleted)
   for(const [field,counters] of [['rateLimitOutcome',d.outcomes],['rateLimitEvent',d.observations.events],['rateLimitAction',d.observations.actions],['rateLimitExecution',d.observations.executions]]){
    for(const [value,count] of Object.entries(counters))assert.equal(audits.filter(a=>a[field]===value).length,count,i.label+' '+field+'='+value)
   }
   for(const row of e.report.requests.filter(x=>x.instance===i.label&&x.status!==404))assert.equal(audits.filter(a=>a.path===row.path).length,1)
   assert(audits.filter(a=>a.rateLimitAction==='reject'||a.outcome==='cancelled').every(a=>arrivals(a).length===0))
   const meter=await e.api(i,'/actuator/metrics/zenith.ratelimit.decisions');assert.equal(meter.measurements.find(m=>m.statistic==='COUNT').value,d.decisionsCompleted)
   assert(!meter.availableTags.some(t=>/ip|path|route|request/i.test(t.tag)))
   accounting[i.label]={diagnostics:d,audits,meter,auditStatus:await e.api(i,'/monitor/audit/status'),upstreamReceived:audits.filter(a=>arrivals(a).length===1).length}
  }
  e.report.evidence.accounting=accounting
 })
 await e.check('Invalid local and Redis policies fail real startup without silently allowing',async()=>{
  const results=[]
  for(const property of ['local-failure-policy','redis-failure-policy']){
   const args=['-Xmx256m','-XX:ActiveProcessorCount=2','-jar',jar,'--server.port=0','--server.address=127.0.0.1','--spring.data.redis.port='+e.report.isolation.redisPort,'--zenith.runtime.redis-key='+e.ns+':invalid:'+property,'--zenith.route.redis-key='+e.ns+':invalid-routes:'+property,'--zenith.limiter.'+property+'=rejcet']
   const child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),args,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:randomUUID()}});let output=''
   child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
   try{await until('invalid policy startup exit',()=>child.exitCode!==null,60000);assert.notEqual(child.exitCode,0);assert.match(output,/FailurePolicy|failed to convert|Failed to bind/)}
   finally{if(child.exitCode===null)child.kill();await writeFile(join(out,'invalid-'+property+'.log'),output)}
   results.push({property,exitCode:child.exitCode,log:'invalid-'+property+'.log'})
  }
  e.report.evidence.invalidStartup=results
 })
}catch(error){failure=error}
finally{
 for(const i of e.processes)if(i.child.exitCode===null)await gate(i,'release').catch(()=>{})
 e.proxyA.release();e.proxyB.release();await e.finish(failure)
}
