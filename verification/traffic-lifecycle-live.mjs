import {scopedDockerArgs} from './acceptance-scope.mjs'
// Isolated cold-entry comparisons, guarded ramp and drain/exit evidence. No development instance is used.
import assert from 'node:assert/strict'
import http from 'node:http'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,readFile,writeFile,copyFile,unlink,rmdir} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {assessStage} from './traffic-lifecycle-gates.mjs'
const exec=promisify(execFile),root=resolve('.'),id=randomUUID().slice(0,8)
const arg=(n,d)=>process.argv.includes(n)?process.argv[process.argv.indexOf(n)+1]:d
const out=resolve(arg('--out','.dev/traffic-lifecycle-live-'+id)),mode=arg('--mode','all'),sourceJar=resolve(arg('--jar','backend/target/zg-1.0.0.jar'))
assert(['functional','cold','signal','all'].includes(mode))
await mkdir(out,{recursive:true});await writeFile(join(out,'run-marker'),new Date().toISOString(),{flag:'wx'})
const jar=join(out,'gateway.jar');await copyFile(sourceJar,jar)
const hash=b=>createHash('sha256').update(b).digest('hex')
const images={redis:'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',node:'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',java:'mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5'}
const plan={version:2,driverPlatform:"Linux container, 2 CPU / 256 MiB, two active jobs maximum",targetRate:1000,oldInstanceRate:200,ramp:[25,100,250,500,1000],windowSeconds:10,targetWindowSeconds:20,
 repetitions:3,comparisonOrder:['immediate','gradual','gradual','immediate','immediate','gradual'],maxWindowsPerStep:3,
 p95LimitMs:100,p99LimitMs:250,maxArrivalGapRatio:0.01,auditSettleMs:15000,readinessBudgetMs:60000,recoveryBudgetMs:15000,
 requestDrainMs:2000,cancellationSettleMs:1000,auditDrainMs:1000,auditCommandMs:250,springPhaseMs:10000,processExitMs:45000,
 generatorMaxInFlight:256,generatorRequestMs:8000,sampleEveryMs:500,decisionWorkers:8,decisionQueue:64,resultHandoff:false,
 gateway:{cpus:2,memory:'1g',pids:512,heapInitialMiB:256,heapMaxMiB:512,directMaxMiB:256},
 health:'All 200; zero quota rejects, fault forwards, protective rejects, unknown/cancel; per-instance deltas reconcile; resources in bounds; versions match; no sampling failure; no sustained >75% I/O queue in two samples.'}
await writeFile(join(out,'plan.json'),JSON.stringify(plan,null,2))
const report={startedAt:new Date().toISOString(),mode,plan,images,jarSha256:hash(await readFile(jar)),entrySha256:hash(await readFile(new URL(import.meta.url))),checks:[],stages:[],cold:[],processes:[],requests:[],cleanup:{},passed:false}
const prefix='zg-entry-'+id,network=prefix,redisName=prefix+'-redis',workerName=prefix+'-upstream',loadName=prefix+'-load',ns='zg:entry:'+id,token=randomUUID()+randomUUID(),owned=[],ownedVolumes=new Set(),processes=[],streams=[]
const secretDir=join(out,'credentials'),secretFile=join(secretDir,'zenith.admin.token')
let networkCreated=false,paused=false,redisPort,control,loadControl,A,B,versions,stoppingA=false,aLoad
const docker=async(args,timeout=30000)=>(await exec('docker',scopedDockerArgs(args),{timeout,maxBuffer:8*1024*1024,windowsHide:true,encoding:'utf8'})).stdout.trim()
async function save(name,obj){await writeFile(join(out,name),JSON.stringify(obj,null,2)+'\n')}
async function until(label,probe,budget=15000){const end=performance.now()+budget;let last;do{try{const v=await probe(Math.max(1,end-performance.now()));if(v)return v}catch(e){last=e.message}await delay(50)}while(performance.now()<end);throw new Error(label+' exceeded '+budget+' ms; '+(last||''))}
async function run(name,args){await docker(['run','-d','--pull=never','--name',name,'--label','zenith.verification='+prefix,'--network',network,...args]);owned.push(name);const created=JSON.parse(await docker(['inspect',name]))[0];await save(name+'-created.json',created);for(const m of created.Mounts)if(m.Type==='volume')ownedVolumes.add(m.Name)}
async function mapped(name,p){return Number((await docker(['port',name,p+'/tcp'])).split(':').at(-1))}
async function api(i,path,options={}){const r=await fetch(i.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(3000)});const text=await r.text();let data;try{data=text?JSON.parse(text):null}catch{data=text}if(!r.ok)throw new Error(path+' HTTP '+r.status+' '+text.slice(0,300));return data}
async function ctrl(path=''){return api({base:control},path||'/status',path.startsWith('/audit-mode')||path.startsWith('/release')?{method:'POST'}:{})}
async function startup(label,{strict=false,auditProxy=false,longProxy=false}={}){
 const name=prefix+'-'+label.toLowerCase(),auditKey=ns+':audit:'+label
 const args=['-XX:+UseG1GC','-XX:ActiveProcessorCount=2','-Xms256m','-Xmx512m','-XX:MaxDirectMemorySize=256m','-jar','/app/gateway.jar',
 '--server.port=8080','--spring.data.redis.host=redis','--spring.data.redis.port=6379','--spring.data.redis.password=',
 '--zenith.runtime.redis-key='+ns+':runtime','--zenith.route.redis-key='+ns+':routes','--zenith.audit.redis-key='+auditKey,'--zenith.limiter.namespace='+ns+':limiter',
 '--zenith.rate-limit.replenish-rate=10000','--zenith.rate-limit.burst-capacity=10000','--zenith.rate-limit.requested-tokens=1',
 '--zenith.limiter.workers=8','--zenith.limiter.queue-capacity=64','--zenith.limiter.result-handoff-enabled=false',
 '--zenith.lifecycle.request-drain-timeout-ms=2000','--zenith.lifecycle.cancellation-settle-timeout-ms=1000',
 '--spring.lifecycle.timeout-per-shutdown-phase=10s','--zenith.audit.shutdown-drain-timeout-ms=1000','--zenith.audit.command-timeout-ms=250',
 '--zenith.audit.redis-max-entries=200000','--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,metrics,prometheus,shutdown',
 ...(auditProxy?['--zenith.audit.host=upstream','--zenith.audit.port=6380','--zenith.audit.batch-size=10']:[]),
 ...(strict?['--zenith.limiter.local-failure-policy=reject','--zenith.limiter.redis-failure-policy=reject']:[]),
 ...(longProxy?['--zenith.proxy.resilience.headers-timeout-ms=10000','--zenith.proxy.resilience.total-timeout-ms=15000','--zenith.proxy.resilience.read-idle-timeout-ms=11000']:[])]
 const i={label,name,auditKey,args,startedAt:new Date().toISOString()}
 await run(name,['--network-alias',label.toLowerCase(),'--cpus=2','--memory=1g','--pids-limit=512','-p','127.0.0.1::8080','-e','SPRING_CONFIG_IMPORT=configtree:/run/secrets/',
 '-v',secretDir.replaceAll('\\','/')+':/run/secrets:ro','-v',jar.replaceAll('\\','/')+':/app/gateway.jar:ro',images.java,'java',...args])
 i.base='http://127.0.0.1:'+await mapped(name,8080);processes.push(i);report.processes.push(i);await followLogs(i)
 await until(label+' ready',()=>api(i,'/actuator/health/readiness').then(x=>x.status==='UP'),plan.readinessBudgetMs)
 i.readyAt=new Date().toISOString()
 i.identity=await api(i,'/settings/lifecycle')
 if(versions){assert.equal(i.identity.adoptedRuntimeVersion,versions.runtime);assert.equal(i.identity.adoptedRouteVersion,versions.route)}
 return i
}
async function snapshot(i){
 const [life,limit,proxy,runtimeSync,routeSync]=await Promise.all(['/settings/lifecycle','/settings/rate-limit/diagnostics','/settings/proxy/diagnostics','/settings/runtime/sync','/settings/routes/diagnostics'].map(p=>api(i,p)))
 return {at:new Date().toISOString(),life,limit,proxy,runtimeSync,routeSync}
}
async function metrics(i,name){
 const r=await fetch(i.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(4000)});assert(r.ok)
 const raw=await r.text();await writeFile(join(out,name+'.prom'),raw)
 const sum=metric=>raw.split('\n').filter(l=>l.startsWith(metric+'{')).reduce((n,l)=>n+Number(l.split(' ').at(-1)),0)
 return {requests:sum('zenith_gateway_requests_seconds_count'),monitor:sum('zenith_monitor_completed_total'),
 poolFull:raw.split('\n').filter(l=>l.startsWith('zenith_gateway_proxy_outcomes_total{')&&l.includes('reason="proxy_pool_full"')).reduce((n,l)=>n+Number(l.split(' ').at(-1)),0)}
}
async function settle(i,budget=plan.auditSettleMs){
 return until(i.label+' final callbacks/audit',async()=>{const s=await snapshot(i);return s.life.activeBusinessRequests===0&&s.proxy.activeProxyRequests===0&&s.limit.retainedTasks===0&&s.limit.commandsInFlight===0&&s.life.audit.pending===0?s:false},budget)
}
async function load(i,id,rate,seconds){
 const args={id,urls:['http://'+i.label.toLowerCase()+':8080/probe/quick/'+id],arrivalRate:rate,durationSeconds:seconds,connections:plan.generatorMaxInFlight,timeoutMs:plan.generatorRequestMs}
 await api({base:loadControl},'/start',{method:'POST',body:JSON.stringify(args)})
 const job=await until('load '+id,async()=>{const j=await api({base:loadControl},'/'+id);return j.state!=='running'?j:false},seconds*1000+plan.generatorRequestMs+15000)
 assert.equal(job.state,'complete',job.error);return job.result
}
async function measure(i,name,rate,seconds,{fault=false}={}){
 const before=await snapshot(i),m0=await metrics(i,name+'-before'),up0=(await ctrl()).counts[name]||0
  const samples=[],sampleErrors=[];let collecting=true
 const collector=(async()=>{while(collecting){try{samples.push(await snapshot(i))}catch(e){sampleErrors.push({at:new Date().toISOString(),error:e.message})}await delay(plan.sampleEveryMs)}})()
 let result
 try{result=await load(i,name,rate,seconds)}finally{collecting=false;await collector}
 let after
 try{after=fault?await until(i.label+" fault terminal callbacks",async()=>{const s=await snapshot(i);return s.life.activeBusinessRequests===0&&s.proxy.activeProxyRequests===0&&s.limit.retainedTasks===0?s:false},plan.auditSettleMs):await settle(i)}catch(e){sampleErrors.push({error:e.message});after=await snapshot(i)}
 const m1=await metrics(i,name+'-after'),up1=(await ctrl()).counts[name]||0
 const assessment=assessStage({result,before,after,samples,sampleErrors,upstreamBefore:up0,upstreamAfter:up1,metricsBefore:m0,metricsAfter:m1,declaredFault:fault},plan,versions)
 const failures=assessment.reasons
 const record={name,instance:i.label,rate,seconds,declaredFault:fault,startedAfterReadyMs:Date.parse(result.startedAt)-Date.parse(i.readyAt),before,after,result,samples,sampleErrors,metricsBefore:m0,metricsAfter:m1,upstreamBefore:up0,upstreamAfter:up1,healthy:failures.length===0,failures,assessment}
 report.stages.push(record);await save(name+'.json',record);console.log((record.healthy?'HEALTHY ':'PAUSE ')+name+' '+JSON.stringify(failures))
 return record
}
async function ramp(i,prefix,{rates=plan.ramp}={}){
 const run={instance:i.label,mode:'gradual',requestedRates:rates,windows:[],completedRequestedSteps:false,reachedTarget:false}
 for(const rate of rates){
  let passed=false
  for(let n=1;n<=plan.maxWindowsPerStep;n++){
   const s=await measure(i,prefix+'-'+rate+'-'+n,rate,rate===plan.targetRate?plan.targetWindowSeconds:plan.windowSeconds)
   run.windows.push(s.name)
   if(s.healthy){passed=true;break}
   // Remain withdrawn at the same step; observe actual recovery before another complete window.
   try{await until('reassess '+i.label,async()=>{const d=await snapshot(i);return d.limit.transportState==='healthy'&&d.life.audit.pending===0&&d.limit.retainedTasks===0&&d.runtimeSync.status==='ok'&&d.routeSync.status==='ok'},plan.recoveryBudgetMs)}
   catch(e){run.failure=e.message;break}
  }
  if(!passed){run.failure??='Step '+rate+' did not pass; no increase issued';return run}
 }
 run.completedRequestedSteps=true;run.reachedTarget=rates.at(-1)===plan.targetRate;return run
}
async function auditDump(i){
 const total=Number(await redisCommand(redisPort,['LLEN',i.auditKey])),ids=new Set(),paths={},file=createWriteStream(join(out,i.label+'-audit.jsonl'));streams.push(file)
 assert(total<200000,'Audit retention must cover the whole experiment')
 for(let offset=0;offset<total;offset+=500){
  const rows=await redisCommand(redisPort,['LRANGE',i.auditKey,offset,Math.min(total-1,offset+499)])
  for(const text of rows){const x=JSON.parse(text);assert(!ids.has(x.eventId),'Duplicate audit event');ids.add(x.eventId);paths[x.path]=(paths[x.path]||0)+1;file.write(text+'\n')}
 }
 await new Promise(r=>file.end(r));return {total,unique:ids.size,paths}
}
async function stop(i,{signal=true}={}){
 if(i.stopped)return
 const start=performance.now()
 const initial=JSON.parse(await docker(['inspect',i.name]))[0].State
 if(initial.Running){
  if(signal)await docker(['kill','--signal=TERM',i.name],3000)
  else await api(i,'/actuator/shutdown',{method:'POST',body:'{}'})
 }
 let state
 try{state=await until(i.label+' exit',async left=>{const s=JSON.parse(await docker(['inspect',i.name],Math.max(1,Math.min(1000,Math.ceil(left)))))[0].State;return !s.Running?s:false},Math.max(1,plan.processExitMs-(performance.now()-start)))}
 catch(e){i.forced=true;i.stopError=e.message;await docker(['kill',i.name],3000);throw e}
 finally{i.stopElapsedMs=performance.now()-start;i.stopped=true}
 i.exitCode=state.ExitCode;i.finishedAt=state.FinishedAt;i.oomKilled=state.OOMKilled;i.signal=signal?'SIGTERM':'actuator'
 const logs=await docker(['logs',i.name]);await writeFile(join(out,i.label+'-stop.log'),logs)
 await save(i.label+'-inspect.json',JSON.parse(await docker(['inspect',i.name]))[0])
 assert.equal(i.exitCode,signal?143:0,i.label+' expected shutdown exit status');assert.equal(i.oomKilled,false)
 for(const pattern of [/Traffic drain finished:.*phase=drained/,/Audit writer stopped:.*pending=0/,/Graceful shutdown complete/,/Rate-limit workers stopped; active=0, queued=0, commands=0/,/Rate-limit result dispatch stopped; active=0, queued=0, retained=0/,/Runtime config sync stopped:/,/Route publication stopped; syncTerminated=true, managementTerminated=true, queued=0/])assert.match(logs,pattern)
 assert(logs.indexOf('Audit writer stopped:')<logs.indexOf('Commencing graceful shutdown'))
 assert(logs.indexOf('Graceful shutdown complete')<logs.indexOf('Rate-limit workers stopped;'))
 i.orderVerified=true
 if(!paused){const clients=await redisCommand(redisPort,['CLIENT','LIST']);await writeFile(join(out,i.label+'-clients-after.txt'),clients);assert(!clients.includes(i.identity.instanceId));i.namedClientsRemoved=true}
}
async function followLogs(i){
 if(i.logProcess)return
 const file=createWriteStream(join(out,i.label+'.log'));streams.push(file)
 const {spawn}=await import('node:child_process');Object.defineProperty(i,'logProcess',{value:spawn('docker',['logs','--follow',i.name],{windowsHide:true}),enumerable:false})
 i.logProcess.stdout.pipe(file,{end:false});i.logProcess.stderr.pipe(file,{end:false})
 i.logProcess.on('exit',()=>file.end())
}
async function hit(i,path,{agent,headers={}}={}){
 let req,finish,body='',status=0,reused=false,localPort,ended=false
 const began=performance.now(),p=new Promise(r=>finish=r)
 const timer=setTimeout(()=>{req.destroy();done('test_deadline')},20000)
 const done=termination=>{if(ended)return;ended=true;clearTimeout(timer);const row={instance:i.label,path,status,body,termination,reused,localPort,elapsedMs:performance.now()-began};report.requests.push(row);finish(row)}
 req=http.get(i.base+path,{agent,headers},res=>{status=res.statusCode;reused=req.reusedSocket;localPort=req.socket?.localPort;res.on('data',b=>{body+=b.toString();if(body.length>16384)req.destroy()});res.on('end',()=>done('complete'));res.on('aborted',()=>done('aborted'));res.on('error',()=>done('response_error'))})
 req.on('error',e=>done(e.code||'error'))
 return {done:p,cancel(){req.destroy();done('client_cancelled')},get status(){return status},get body(){return body}}
}
async function requireArrival(key){return until('upstream '+key,async()=>{const c=await ctrl();return c.counts[key]?c:false})}
async function drainCheck(i){
 const base=await snapshot(i),agent=new http.Agent({keepAlive:true,maxSockets:1})
 const warm=await hit(i,'/probe/quick/keep-'+i.label,{agent});assert.equal((await warm.done).status,200)
 const normal=await hit(i,'/probe/hold/normal-'+i.label),slow=await hit(i,'/probe/hold/over-'+i.label),
 stream=await hit(i,'/probe/stream/stream-'+i.label),cancel=await hit(i,'/probe/hold/cancel-'+i.label)
 for(const key of ['normal-','over-','stream-','cancel-'])await requireArrival(key+i.label)
 await until('stream committed',()=>stream.status===200&&stream.body.includes('part-0'))
 const sse=await hit(i,'/monitor/stream',{headers:{Authorization:'Bearer '+token}});await until('monitor SSE first data',()=>sse.status===200&&sse.body.length>0);const sseBefore=sse.body.length
 assert.equal((await fetch(i.base+'/settings/lifecycle/drain',{method:'POST',signal:AbortSignal.timeout(3000)})).status,401)
 assert.equal((await api(i,'/settings/lifecycle')).draining,false)
 const started=performance.now(),one=await api(i,'/settings/lifecycle/drain',{method:'POST',body:'{}'})
 const repeated=await Promise.all(Array.from({length:3},()=>api(i,'/settings/lifecycle/drain',{method:'POST',body:'{}'})))
 assert(repeated.every(x=>x.drainStartedAt===one.drainStartedAt))
 const denied=await hit(i,'/probe/quick/rejected-'+i.label,{agent});const rejected=await denied.done;assert.equal(rejected.status,503);assert(rejected.reused);assert.equal(rejected.localPort,(await warm.done).localPort)
 cancel.cancel();await ctrl('/release?key=normal-'+i.label)
 assert.equal((await normal.done).status,200)
 assert.equal((await slow.done).status,503);const streamResult=await stream.done;assert.equal(streamResult.status,200);assert.notEqual(streamResult.termination,'complete');assert(!streamResult.body.includes('shutdown_deadline'))
 const final=await until('drained with diagnostics',async()=>{const s=await api(i,'/settings/lifecycle');return s.phase==='drained'?s:false},12000)
 assert.equal(final.admitted-base.life.admitted,5);assert.equal(final.completed-base.life.completed,5)
 assert((await api(i,"/settings/proxy/diagnostics")).breakers.every(b=>b.failedCalls===0),"Local shutdown must not mark the upstream breaker failed");assert.equal(final.deadlineTerminated-base.life.deadlineTerminated,2);assert.equal(final.clientCancelled-base.life.clientCancelled,1);assert.equal(final.rejectedBeforeAdmission-base.life.rejectedBeforeAdmission,1)
 await until('existing monitor SSE still produces data',()=>sse.body.length>sseBefore);sse.cancel()
 assert.equal(final.audit.received-base.life.audit.received,5);assert.equal(final.audit.persisted-base.life.audit.persisted,5)
 assert.equal((await fetch(i.base+'/actuator/health/readiness')).status,503);assert.equal((await fetch(i.base+'/actuator/health/liveness')).status,200)
 assert.equal((await fetch(i.base+'/settings/lifecycle')).status,401)
 const upstream=await ctrl();assert(!upstream.counts['rejected-'+i.label]);await until('upstream resources released',async()=>!(await ctrl()).holds.some(k=>k.endsWith(i.label)))
 const audits=await auditDump(i);report.checks.push({name:'Keep-alive new request rejected; slow success, deadline, partial stream, client cancel, auth and exact audit',instance:i.label,before:base,final,elapsedMs:performance.now()-started,upstream,audits,rejected,monitorSse:{beforeBytes:sseBefore,afterBytes:sse.body.length,termination:(await sse.done).termination}})
 agent.destroy();await stop(i)
}
async function functional(){
 B=await startup('DRAIN',{longProxy:true});await followLogs(B)
 await measure(B,'functional-warm',25,10)
 await drainCheck(B)
 const F=await startup('FAULT',{auditProxy:true,strict:true});await followLogs(F)
 await measure(F,'fault-warm',25,10)
 await docker(['pause',redisName]);paused=true
 const degraded=await measure(F,'redis-down',25,3,{fault:true})
 const offlineHealth=Object.fromEntries(await Promise.all(['readiness','liveness'].map(async probe=>[probe,(await fetch(F.base+'/actuator/health/'+probe,{signal:AbortSignal.timeout(3000)})).status])))
 assert.deepEqual(offlineHealth,{readiness:200,liveness:200},'Redis outage is handled by failure policy, not a liveness restart loop')
 degraded.offlineHealth=offlineHealth
 assert(!degraded.healthy&&degraded.failures.includes('protective_rejection'));assert.equal(degraded.upstreamAfter-degraded.upstreamBefore,0)
 assert.equal((await fetch(F.base+'/actuator/health/liveness')).status,200)
 report.checks.push({name:'Increase paused for Redis failure; no next higher rate issued',window:degraded.name,reasons:degraded.failures,offlineHealth})
 await docker(['unpause',redisName]);paused=false
 await until('fault recovery',async()=>{const s=await snapshot(F);return s.limit.transportState==='healthy'&&s.life.audit.pending===0&&s.runtimeSync.status==='ok'},plan.recoveryBudgetMs)
 const recovery=await ramp(F,'recovery',{rates:[25,100]});assert(recovery.completedRequestedSteps)
 await ctrl('/audit-mode?mode=drop-reply')
 const start=await snapshot(F),batch=[]
 for(let n=0;n<35;n++){const r=await hit(F,'/probe/quick/pending-'+n);batch.push(await r.done)}
 await until('Redis executed audit without reply',async()=>Number(await redisCommand(redisPort,['LLEN',F.auditKey]))>start.life.audit.persisted)
 const queued=await until('audit has backlog',async()=>{const s=await snapshot(F);return s.life.audit.pending>10?s:false})
 await docker(['pause',redisName]);paused=true
 const d0=performance.now();await api(F,'/settings/lifecycle/drain',{method:'POST',body:'{}'})
 const final=await until('offline bounded audit drain',async()=>{const s=await api(F,'/settings/lifecycle');return s.phase==='drained'?s:false},12000)
 assert.equal(final.audit.received,final.audit.persisted+final.audit.uncertain+final.audit.dropped);assert(final.audit.uncertain>0);assert(final.audit.droppedByReason.shutdown>0);assert.equal(final.audit.pending,0)
 const drainedHealth=Object.fromEntries(await Promise.all(['readiness','liveness'].map(async probe=>[probe,(await fetch(F.base+'/actuator/health/'+probe,{signal:AbortSignal.timeout(3000)})).status])))
 assert.deepEqual(drainedHealth,{readiness:503,liveness:200})
 assert.equal((await fetch(F.base+'/settings/lifecycle',{signal:AbortSignal.timeout(3000)})).status,401)
 report.checks.push({name:'Offline drain conserves confirmed + unknown + deliberately discarded unsent; HTTP diagnostics stay available',before:queued,final,elapsedMs:performance.now()-d0,batch,drainedHealth,anonymousDiagnosticStatus:401})
 await stop(F);await docker(['unpause',redisName]);paused=false;await ctrl('/audit-mode?mode=normal')
 const records=await auditDump(F);report.checks.at(-1).stored=records
 assert(records.total>final.audit.persisted,'Some unknown records really executed; never equate unknown with lost')
 // Default fail-open semantics still halt promotion even when every HTTP response is 200.
 const G=await startup('ALLOW');await followLogs(G);await measure(G,'allow-warm',25,10)
 await docker(['pause',redisName]);paused=true;const open=await measure(G,'redis-down-allow',25,3,{fault:true});assert(!open.healthy&&open.failures.includes('fault_forward'))
 await docker(['unpause',redisName]);paused=false;await until('allow recovery',async()=>(await snapshot(G)).limit.transportState==='healthy')
 await api(G,'/settings/lifecycle/drain',{method:'POST',body:'{}'});await until('allow drained',async()=>(await api(G,'/settings/lifecycle')).phase==='drained');await stop(G)
 report.checks.push({name:'Default fault forward is unhealthy even with HTTP 200',window:open.name,reasons:open.failures})
}
async function signalDrain(){
 const i=await startup('SIGNAL',{longProxy:true});await followLogs(i)
 const slow=await hit(i,'/probe/hold/signal-over'),stream=await hit(i,'/probe/stream/signal-stream')
 await requireArrival('signal-over');await requireArrival('signal-stream');await until('signal stream committed',()=>stream.body.length>0)
 const at=performance.now(),stopping=stop(i),observations=[]
 await until('SIGTERM closes admission while local diagnostics still answer',async()=>{
  try{const life=await api(i,'/settings/lifecycle');observations.push(life);return life.draining}catch{return false}
 },1800)
 const reject=await hit(i,'/probe/quick/after-signal');assert.equal((await reject.done).status,503)
 const responses=await Promise.all([slow.done,stream.done]);await stopping
 assert.equal(responses[0].status,503);assert.equal(responses[1].status,200);assert.notEqual(responses[1].termination,'complete')
 assert(!responses[1].body.includes('shutdown_deadline'));assert(!(await ctrl()).counts['after-signal'])
 const audit=await auditDump(i);assert.equal(audit.total,2)
 report.checks.push({name:'SIGTERM without pre-drain uses the same bounded gate before Netty and audit stop',observations,responses,elapsedMs:performance.now()-at,audit})
}
async function cold(){
 const preparation=await ramp(A,'old-preparation',{rates:[25,100,200]});assert(preparation.completedRequestedSteps,'Old instance must pass its preparation windows')
 const aBefore=await settle(A),aM0=await metrics(A,'old-before');let aCount=0,aFailures=[]
 aLoad=(async()=>{while(!stoppingA){const label='old-continuous-'+aCount;const x=await load(A,label,200,5);if(x.statuses['200']!==x.finished||x.transportErrors)aFailures.push({label,...x});aCount+=x.finished;await save(label+'.json',x)}})()
 for(let n=0;n<plan.comparisonOrder.length;n++){
  const style=plan.comparisonOrder[n],i=await startup('B'+(n+1));B=i;await followLogs(i)
  let result
  if(style==='immediate'){const s=await measure(i,'cold-'+(n+1)+'-immediate',plan.targetRate,plan.targetWindowSeconds);result={mode:style,instance:i.label,windows:[s.name],reachedTarget:s.healthy}}
  else result=await ramp(i,'cold-'+(n+1)+'-gradual')
  result.readyAt=i.readyAt;report.cold.push(result);await save('cold-results.json',report.cold)
  if(n<plan.comparisonOrder.length-1){await api(i,'/settings/lifecycle/drain',{method:'POST',body:'{}'});await until('cold drained',async()=>(await api(i,'/settings/lifecycle')).phase==='drained');result.audit=await auditDump(i);await stop(i)}
 }
 assert(report.cold.filter(x=>x.mode==='gradual').every(x=>x.reachedTarget),'Keep failed samples: at least one gradual replacement could not be promoted')
 // Both are proven at this run's windows; the test generator now stops assigning requests to old A.
 stoppingA=true;await aLoad
 const aAfter=await settle(A),aM1=await metrics(A,'old-after')
 report.oldService={before:aBefore,after:aAfter,metricsBefore:aM0,metricsAfter:aM1,completed:aCount,failures:aFailures}
 assert.equal(aFailures.length,0);assert.equal(aAfter.life.audit.persisted-aBefore.life.audit.persisted,aCount);assert.equal(aM1.requests-aM0.requests,aCount)
 const keepServing=measure(B,'replacement-during-old-exit',1000,20)
 await api(A,'/settings/lifecycle/drain',{method:'POST',body:'{}'});await until('old drained',async()=>(await api(A,'/settings/lifecycle')).phase==='drained')
 report.oldService.audit=await auditDump(A);await stop(A);assert((await keepServing).healthy)
 report.checks.push({name:'Generator transfers assignment; replacement serves while old process exits',old:A.label,replacement:B.label})
 await api(B,'/settings/lifecycle/drain',{method:'POST',body:'{}'});await until('replacement drained',async()=>(await api(B,'/settings/lifecycle')).phase==='drained');report.cold.at(-1).audit=await auditDump(B);await stop(B)
}
try{
 await save('host-before.json',{networks:await docker(['network','ls','--format','{{.ID}} {{.Name}}']),containers:await docker(['ps','-a','--format','{{.ID}} {{.Names}} {{.State}}'])})
 await mkdir(secretDir);await writeFile(secretFile,token)
 await docker(['network','create',network]);networkCreated=true
 await run(redisName,['--network-alias','redis','--cpus=1','--memory=512m','-p','127.0.0.1::6379',images.redis,'--save','','--appendonly','no','--maxmemory','384mb','--maxmemory-policy','noeviction']);redisPort=await mapped(redisName,6379)
 await run(workerName,['--network-alias','upstream','--cpus=1','--memory=256m','--pids-limit=128','-p','127.0.0.1::8090','-v',root.replaceAll('\\','/')+':/workspace:ro','-v',out.replaceAll('\\','/')+':/evidence','-v',secretDir.replaceAll('\\','/')+':/secrets:ro',images.node,'node','/workspace/verification/traffic-lifecycle-worker.mjs']);control='http://127.0.0.1:'+await mapped(workerName,8090);await until('upstream control',()=>ctrl())
 await run(loadName,['--cpus=2','--memory=256m','--pids-limit=128','-p','127.0.0.1::8091','-v',root.replaceAll('\\','/')+':/workspace:ro','-v',out.replaceAll('\\','/')+':/evidence','-v',secretDir.replaceAll('\\','/')+':/secrets:ro',images.node,'node','/workspace/verification/traffic-lifecycle-load.mjs']);loadControl='http://127.0.0.1:'+await mapped(loadName,8091);await until('Linux load control',()=>api({base:loadControl},'/status'))
 report.isolation={network,redisName,redisPort,workerName,loadName,namespace:ns,control,loadControl}
 A=await startup('A');await followLogs(A)
 const routeBase=await api(A,'/settings/routes')
 const published=await api(A,'/settings/routes',{method:'POST',body:JSON.stringify({expectedVersion:routeBase.version,route:{id:'probe',path:'/probe/**',uri:'http://upstream:8080',rewriteEnabled:true,circuitBreakerEnabled:true}})})
 const runtime=await api(A,'/settings/runtime/adopted')
 versions={route:published.version,runtime:runtime.version};report.versions=versions;report.effectiveRuntime=runtime
 if(mode==='functional'||mode==='all')await functional()
 if(mode==='signal'||mode==='all')await signalDrain()
 if(mode==='cold'||mode==='all')await cold()
 report.passed=true
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error)}
finally{
 stoppingA=true;if(aLoad)await aLoad.catch(()=>{})
 if(paused){await docker(['unpause',redisName]).catch(()=>{});paused=false}
 for(const i of processes){if(!i.stopped){try{await stop(i)}catch(e){report.cleanup[i.label+'Error']=e.message;await docker(['kill',i.name]).catch(()=>{})}}}
 if(redisPort){const clients=await redisCommand(redisPort,['CLIENT','LIST']).catch(e=>'UNAVAILABLE: '+e.message);await writeFile(join(out,'clients-final.txt'),clients);report.cleanup.namedGatewayClientsAbsent=processes.every(i=>!i.identity||!clients.includes(i.identity.instanceId))&&!clients.startsWith('UNAVAILABLE')}
 for(const name of owned.reverse())await docker(['rm','-fv',name]).catch(()=>{})
 if(networkCreated)await docker(['network','rm',network]).catch(e=>report.cleanup.networkError=e.message)
 await unlink(secretFile).catch(()=>{});await rmdir(secretDir).catch(()=>{})
 report.cleanup.ownedContainersAbsent=!(await docker(['ps','-a','--format','{{.Names}}'])).split('\n').some(n=>owned.includes(n))
 report.cleanup.ownedVolumes=[...ownedVolumes];report.cleanup.ownedVolumesAbsent=!(await docker(['volume','ls','-q'])).split('\n').some(n=>ownedVolumes.has(n))
 report.cleanup.networkAbsent=!(await docker(['network','ls','--format','{{.Name}}'])).split('\n').includes(network)
 report.cleanup.credentialsRemoved=await readFile(secretFile).then(()=>false,()=>true)
 report.completedAt=new Date().toISOString();report.passed=report.passed&&report.cleanup.ownedContainersAbsent&&report.cleanup.networkAbsent&&report.cleanup.credentialsRemoved&&report.cleanup.namedGatewayClientsAbsent&&report.cleanup.ownedVolumesAbsent; if(!report.passed)process.exitCode=1; await save('report.json',report)
 await save('host-after.json',{networks:await docker(['network','ls','--format','{{.ID}} {{.Name}}']),containers:await docker(['ps','-a','--format','{{.ID}} {{.Names}} {{.State}}'])})
 console.log('Traffic lifecycle evidence: '+out)
}
