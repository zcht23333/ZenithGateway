import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,writeFile,mkdir,unlink,rmdir} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from './redis.mjs'
const exec=promisify(execFile),base=resolve('.'),id=randomUUID().slice(0,8)
const out=resolve(process.env.CAPACITY_CALIBRATION_OUTPUT||'.dev/capacity-calibration-'+id),phase='calibration'
const jar=resolve(process.env.CAPACITY_CALIBRATION_JAR||'backend/target/zg-1.0.0.jar')
function integer(name,fallback,min,max){const x=Number(process.env[name]??fallback);assert(Number.isInteger(x)&&x>=min&&x<=max,'Invalid '+name);return x}
const rate=integer('CAPACITY_CALIBRATION_RATE',4000,1,10000),workers=integer('CAPACITY_CALIBRATION_WORKERS',8,1,64)
const routeCount=integer('CAPACITY_CALIBRATION_ROUTES',32,1,256),seconds=integer('CAPACITY_CALIBRATION_SECONDS',120,30,180)
const applicationProfile=process.env.CAPACITY_CALIBRATION_PROFILE||'capacity'
assert(['','capacity'].includes(applicationProfile),'Invalid application profile')
const queueCapacity=integer('CAPACITY_CALIBRATION_QUEUE',applicationProfile==='capacity'?128:64,0,4096)
const warmSeconds=integer('CAPACITY_CALIBRATION_WARMUP',30,5,120),soakSeconds=integer('CAPACITY_CALIBRATION_SOAK_SECONDS',900,900,1800)
const repetitions=integer('CAPACITY_CALIBRATION_REPETITIONS',3,1,5)
const warmRate=integer('CAPACITY_CALIBRATION_WARMUP_RATE',Math.min(rate,1000),1,10000)
const modes=(process.env.CAPACITY_CALIBRATION_MODES||'none,light,native,native,light,none').split(',');assert(modes.every(m=>['none','light','native'].includes(m)))
const coldStrategy=process.env.CAPACITY_CALIBRATION_COLD_STRATEGY||'immediate'
assert(['immediate','gradual'].includes(coldStrategy))
const longSeconds=integer('CAPACITY_CALIBRATION_LONG_SECONDS',3600,3600,7200),idleSeconds=integer('CAPACITY_CALIBRATION_IDLE_SECONDS',600,300,1800)
const sampleInterval=2000
const probeEnabled=process.env.CAPACITY_CALIBRATION_PROBE!=='false'
const study='handoff'
const rates=(process.env.CAPACITY_CALIBRATION_RATES||'1000,2000,3000,3500,4000').split(',').map(Number);assert(rates.length<=6&&rates.every(r=>Number.isInteger(r)&&r>=500&&r<=4000))
const health={generatorMissFraction:0.01,p95Ms:50,p99Ms:100,scheduledP99Ms:150}

const redisHost=process.env.CAPACITY_CALIBRATION_REDIS_HOST||null;assert(redisHost===null||['redis','proxy'].includes(redisHost));assert(study!=='transport'||redisHost===null)
const images={redis:'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
 node:'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
 java:'mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5'}
const prefix='zg-calibration-'+id,network=prefix,namespace='zg:calibration:'+id,owned=[],gateways=[]
const token=randomUUID()+randomUUID(),secretDir=join(out,'secrets')
const paths=Array.from({length:routeCount},(_,n)=>n===0?'/bench':'/r'+String(n).padStart(3,'0'))
let stopped=false,networkCreated=false,outputCreated=false,secretCreated=false,secretDirCreated=false,redisPort,upstreamControl,proxyControl,stageSequence=0
const report={startedAt:new Date().toISOString(),phase,id,namespace,jar:{path:jar,sha256:createHash('sha256').update(await readFile(jar)).digest('hex')},
 config:{rates,health,rate,workers,queueCapacity,applicationProfile,routeCount,seconds,warmSeconds,warmRate,soakSeconds,repetitions,images,coldStrategy,longSeconds,idleSeconds,sampleInterval,modes,probeEnabled,study,redisHost,
  cpuSets:{redis:'0-1',upstream:'2-3',gatewayA:'4-7',driver:'8-11',faultProxy:'12',gatewayB:['transport','handoff'].includes(study)?'4-7':'13-15'},
  heap:'256m/512m',directMemoryLimit:'256m',gc:'G1',nativeMemoryTracking:'summary',gatewayMemoryLimit:'1g',
  note:'Dedicated logical CPU sets within the same Docker Desktop VM; not production sizing. All normal samples include limiter, monitoring and audit.'},
 stages:[],events:[],cleanup:{},passed:false}
const save=async()=>{if(outputCreated)await writeFile(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n')}
async function docker(args,options={}){const {stdout}=await exec('docker',args,{cwd:base,windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,...options});return stdout.trim()}
async function until(label,fn,ms=60000){const end=Date.now()+ms;do{if(stopped)throw new Error('Interrupted');try{const v=await fn();if(v)return v}catch(e){if(Date.now()+200>=end)throw e}await delay(100)}while(Date.now()<end);throw new Error('Timeout: '+label)}
async function api(g,path,options={}){
 const r=await fetch(g.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(5000)})
 const text=await r.text();if(!r.ok)throw new Error(path+' HTTP '+r.status+': '+text.slice(0,300));return text?JSON.parse(text):null
}
async function control(origin,body){const r=await fetch(origin,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json()}
const common=['--pull=never','--label','zenith.capacity-calibration.owner='+id,'--network',network]
const sourceMount=['--mount','type=bind,source='+join(out,'tools')+',target=/workspace/benchmarks,readonly']
const secretMount=['--mount','type=bind,source='+secretDir+',target=/run/secrets,readonly']
async function port(name,inside){return Number((await docker(['port',name,String(inside)+'/tcp'])).split(':').at(-1))}
async function runContainer(name,args){await docker(['run','-d','--name',name,...common,...args]);owned.push(name);await save();return name}
async function setup(){
 await mkdir(out,{recursive:false});outputCreated=true;
 report.harnessIdentity=Object.fromEntries(await Promise.all(['capacity-calibration.mjs','stability-worker.mjs','stability-load.mjs','redis.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(base,'benchmarks',name))).digest('hex')])));
 await mkdir(join(out,'tools'));for(const name of Object.keys(report.harnessIdentity))await writeFile(join(out,'tools',name),await readFile(join(base,'benchmarks',name)));
 await mkdir(secretDir);secretDirCreated=true;await writeFile(join(secretDir,'zenith.admin.token'),token,{flag:'wx'});secretCreated=true
 const info=JSON.parse(await docker(['info','--format','{{json .}}']))
 report.environment={cpus:info.NCPU,memoryBytes:info.MemTotal,kernel:info.KernelVersion,os:info.OperatingSystem,startedHost:process.platform}
 assert(info.NCPU>=16,'Capacity CPU layout requires sixteen Docker logical CPUs')
 for(const image of Object.values(images))await docker(['image','inspect',image,'--format','{{.Id}}'])
 await docker(['network','create','--label','zenith.capacity-calibration.owner='+id,network]);networkCreated=true
 const redis=await runContainer(prefix+'-redis',['--network-alias','redis','--cpuset-cpus','0-1','--memory','256m','--pids-limit','128','-p','127.0.0.1::6379',images.redis,'redis-server','--save','','--appendonly','no'])
 redisPort=await port(redis,6379);await until('redis',()=>redisCommand(redisPort,['PING']).then(v=>v==='PONG'))
 for(const [role,cpus] of [['upstream','2-3'],['proxy','12']]){
  const name=await runContainer(prefix+'-'+role,['--network-alias',role,'--cpuset-cpus',cpus,'--memory','256m','--pids-limit','128','-p','127.0.0.1::8090',
   ...sourceMount,'--mount','type=bind,source='+join(secretDir,'zenith.admin.token')+',target=/run/admin-token,readonly',images.node,'node','/workspace/benchmarks/stability-worker.mjs',role])
  const origin='http://127.0.0.1:'+await port(name,8090)
  await until(role,()=>control(origin))
  if(role==='upstream')upstreamControl=origin;else proxyControl=origin
 }
 report.isolation={network,redisPort,upstreamControl,proxyControl,containers:owned}
 await save()
}
async function startGateway(label='A',redisHost=null){
 const name=prefix+'-gateway-'+label.toLowerCase(),alias='gateway-'+label.toLowerCase()
 const args=[...(redisHost?['-Dzenith.limiter.probe.redisHost='+redisHost]:[]),'-Dzenith.limiter.probe.enabled='+probeEnabled,'-Xlog:gc,safepoint:file=/diagnosis/gc-'+label+'.log:time,uptime,level,tags:filecount=3,filesize=20M','-Xms256m','-Xmx512m','-XX:MaxDirectMemorySize=256m','-XX:ActiveProcessorCount=4','-XX:+UseG1GC','-XX:NativeMemoryTracking=summary','-jar','/app/gateway.jar',
  '--server.port=8080','--spring.data.redis.host='+(study==='handoff'?'redis':'proxy'),'--spring.data.redis.port=6379','--spring.data.redis.password=',
  '--zenith.runtime.redis-key='+namespace+':runtime','--zenith.route.redis-key='+namespace+':routes','--zenith.audit.redis-key='+namespace+':audit:'+label,
  '--zenith.limiter.namespace='+namespace+':limiter','--zenith.limiter.workers='+workers,'--zenith.limiter.saturation-sampling-enabled=true',
  ...(study==='handoff'?['--zenith.limiter.result-handoff-enabled='+(label==='B'),'--zenith.limiter.result-workers=2']:[]),
  ...(applicationProfile?['--spring.profiles.active='+applicationProfile]:['--zenith.limiter.queue-capacity='+queueCapacity]),
  '--zenith.rate-limit.replenish-rate=10000','--zenith.rate-limit.burst-capacity=10000',
  '--zenith.monitor.enabled=true','--zenith.audit.enabled=true',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,metrics,prometheus,shutdown']
 await runContainer(name,['--network-alias',alias,'--cpuset-cpus',label==='A'||['transport','handoff'].includes(study)?'4-7':'13-15','--memory','1g','--pids-limit','512','-p','127.0.0.1::8080',
  '--env','SPRING_CONFIG_IMPORT=configtree:/run/secrets/',...secretMount,
  '--mount','type=bind,source='+jar+',target=/app/gateway.jar,readonly','--mount','type=bind,source='+out+',target=/diagnosis',images.java,'java',...args])
 const g={name,label,alias,base:'http://127.0.0.1:'+await port(name,8080),args};gateways.push(g)
 await until('gateway '+label,()=>api(g,'/actuator/health/readiness').then(x=>x.status==='UP'))
 g.readyConfirmedAt=new Date().toISOString();
 const anonymous=await fetch(g.base+'/settings/rate-limit/saturation');assert.equal(anonymous.status,401);
 const eventResponse=await fetch(g.base+'/settings/rate-limit/saturation',{headers:{Authorization:'Bearer '+token}});assert.equal(eventResponse.status,200);assert.equal(eventResponse.headers.get('cache-control'),'no-store');
 const negative=await fetch(g.base+'/settings/rate-limit/saturation?afterSequence=-1',{headers:{Authorization:'Bearer '+token}});assert.equal(negative.status,400);

 if(study==='handoff')assert.equal((await api(g,'/settings/rate-limit/diagnostics')).resultHandoffEnabled,label==='B');
 g.effectiveLimiter=await api(g,'/settings/rate-limit/diagnostics');assert.equal(g.effectiveLimiter.saturationEvents.enabled,true);assert.equal(g.effectiveLimiter.workers,workers);assert.equal(g.effectiveLimiter.queueCapacity,queueCapacity,'Actual profile queue capacity');
 g.vmFlags=await docker(['exec',name,'jcmd','1','VM.flags']);assert(g.vmFlags.includes('+UseG1GC'))
 g.java=await docker(['exec',name,'java','--version'])
 report.gateways=gateways;await save();return g
}
function route(n,target=1){return {id:'capacity-'+String(n).padStart(3,'0'),path:paths[n]+'/**',uri:'http://upstream:'+(target===1?8080:8081),rewriteEnabled:false,circuitBreakerEnabled:true,circuitBreakerName:'capacity-'+n}}
async function publish(g,n,target){
 const current=await api(g,'/settings/routes')
 return api(g,'/settings/routes',{method:'POST',body:JSON.stringify({expectedVersion:current.version,route:route(n,target)})})
}
async function seed(g){for(let n=0;n<routeCount;n++)await publish(g,n,1);await until('real forwarding',async()=>{const r=await fetch(g.base+paths[0]+'/ready');return r.status===200&&(await r.text()).startsWith('V1:')})}
function parseProm(text){
 const values=text.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const m=l.match(/^([^ {]+)(\{.*\})?\s+([-+\w.eE]+)(?:\s.*)?$/);return m?{name:m[1],tags:m[2]||'',value:Number(m[3])}:null}).filter(Boolean)
 const sum=(name,tag)=>{const rows=values.filter(v=>v.name===name&&(!tag||v.tags.includes(tag)));return rows.length?rows.reduce((a,x)=>a+x.value,0):null}
 return {heapBytes:sum('jvm_memory_used_bytes','area="heap"'),heapCommitted:sum('jvm_memory_committed_bytes','area="heap"'),
  directBytes:sum('jvm_buffer_memory_used_bytes','id="direct"'),nonHeapBytes:sum('jvm_memory_used_bytes','area="nonheap"'),
  threads:sum('jvm_threads_live_threads'),cpuFraction:sum('process_cpu_usage'),openFiles:sum('process_files_open_files'),
  gcPauseSeconds:sum('jvm_gc_pause_seconds_sum'),gcCount:sum('jvm_gc_pause_seconds_count'),
  proxyOutcomes:Object.fromEntries(values.filter(v=>v.name==='zenith_gateway_proxy_outcomes_total').map(v=>[v.tags.match(/reason="([^"]+)"/)?.[1]||v.tags,v.value]))}
}
async function snapshot(g){
 const routes=['/monitor/audit/status','/settings/rate-limit/diagnostics','/settings/proxy/diagnostics','/settings/routes/diagnostics','/settings/runtime/sync']
 const values=await Promise.all(routes.map(p=>api(g,p)))
 const response=await fetch(g.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200)
 const proxy=values[2];proxy.breakerStates=proxy.breakers.reduce((m,b)=>{m[b.state]=(m[b.state]||0)+1;return m},{});delete proxy.breakers
 return {label:g.label,at:new Date().toISOString(),audit:values[0],limiter:values[1],proxy,route:values[3],runtime:values[4],jvm:parseProm(await response.text())}
}
async function settled(){
 await until('drained requests and audit',async()=>{const rows=await Promise.all(gateways.map(async g=>({a:await api(g,'/monitor/audit/status'),p:await api(g,'/settings/proxy/diagnostics'),l:await api(g,'/settings/rate-limit/diagnostics')})));return rows.every(x=>x.a.pending===0&&x.p.activeProxyRequests===0&&x.l.commandsInFlight===0&&x.l.queued===0&&x.l.retainedTasks===0&&x.l.activeDeliveries===0&&x.l.activeWorkers===0)},45000)
 await delay(100)
 return Promise.all(gateways.map(async g=>({...await snapshot(g),monitor:await api(g,'/dashboard/snapshot')})))
}
async function sampleAll(stage){
 const observed=stage.activeLabel?gateways.filter(g=>g.label===stage.activeLabel):gateways;
 const results=await Promise.allSettled(observed.map(snapshot))
 for(let i=0;i<results.length;i++){const r=results[i];if(r.status==='fulfilled'){
 const v=r.value,p=v.limiter.experimentProbe
  await collectEvents(stage,observed[i],v.limiter.saturationEvents.lastSequence)
 if(p){for(const key of ['saturationSamples','slowSamples','roundtripSamples']){
  stage[key]??=[];const retained=new Set(stage[key].map(x=>JSON.stringify(x)))
  for(const entry of p[key]||[]){const k=JSON.stringify(entry);if(!retained.has(k)&&Date.parse(entry.at)>=Date.parse(stage.driverStartedAt||stage.startedAt)){stage[key].push(entry);retained.add(k)}}
  if(stage[key].length>4096)stage[key].splice(0,stage[key].length-4096)
  delete p[key]
 }}
 stage.samples.push(v)
}else stage.samplingErrors.push({label:observed[i].label,at:new Date().toISOString(),error:r.reason.message})}
}
async function collectEvents(stage,g,latest){
 stage.eventCursors??={};const after=stage.eventCursors[g.label]||0;if(latest!==undefined&&latest<=after)return;
 const data=await api(g,'/settings/rate-limit/saturation?afterSequence='+after);
 stage.eventCursorGaps??=[];if(data.cursorTooOld)stage.eventCursorGaps.push({label:g.label,after,oldest:data.oldestRetainedSequence});
 stage.saturationSamples??=[];
 for(const sample of data.samples){stage.saturationSamples.push({label:g.label,...sample});stage.eventCursors[g.label]=Math.max(stage.eventCursors[g.label]||0,sample.sequence)}
 stage.collectorTrimmed??=0;if(stage.saturationSamples.length>1024){stage.collectorTrimmed+=stage.saturationSamples.length-1024;stage.saturationSamples.splice(0,stage.saturationSamples.length-1024)}
}
async function probe(stage,g,expected){
 const at=performance.now(),r=await fetch(g.base+paths[0]+'/proof',{signal:AbortSignal.timeout(7000)}),body=await r.text()
 const row={label:g.label,status:r.status,body:body.slice(0,100),version:r.headers.get('x-zenith-route-version'),elapsedMs:performance.now()-at,at:new Date().toISOString()}
 stage.probes.push(row);return row.status===200&&row.body.startsWith('V'+expected+':')?row:null
}
function assessment(stage){
 const r=stage.result,issues=[]
 if(r.transportErrors)issues.push('transport_errors')
 if(Object.entries(r.statuses).some(([s,n])=>s!=='200'&&n))issues.push('non_200')
 if((r.schedulerMisses+r.capacityMisses)/r.offered>.01)issues.push('generator_misses_over_1_percent')
 if(stage.samplingErrors.length)issues.push('sampling_errors')
 if((r.statusLatencyMs['200']?.p95??Infinity)>health.p95Ms)issues.push('p95_exceeded')
 if((r.statusLatencyMs['200']?.p99??Infinity)>health.p99Ms)issues.push('p99_exceeded')
 if((r.scheduledLatencyMs?.p99??Infinity)>health.scheduledP99Ms)issues.push('scheduled_p99_exceeded')
 let failOpen=0
 for(const row of stage.accounting){
  assert.equal(row.reconciliationGap,0,'audit reconciliation')
  assert.equal(row.monitorGap,0,'monitor/request reconciliation')
  assert.equal(row.auditGap,0,'audit/request reconciliation')
  if(row.dropped||row.uncertain)issues.push('audit_not_confirmed')
  failOpen+=Object.entries(row.limiterOutcomes).filter(([k])=>k.includes('fail_open')).reduce((n,[,v])=>n+v,0)
 }
 if(failOpen)issues.push('limiter_fail_open')
 const breaches=[]
 for(const s of stage.samples){
  if(s.limiter.resultHandoffEnabled&&(s.limiter.activeDeliveries>s.limiter.resultWorkers||s.limiter.queuedDeliveries>s.limiter.deliveryQueueCapacity||s.limiter.retainedTasks>s.limiter.admissionCapacity))breaches.push('delivery_budget')
  if(s.audit.pending>20000||s.audit.reservedBytes>16777216)breaches.push('audit_budget')
  if(s.limiter.commandsInFlight>workers||s.limiter.openConnections>workers||s.limiter.queued>s.limiter.queueCapacity||s.limiter.scheduledTasks>workers+s.limiter.queueCapacity+2)breaches.push('limiter_budget')
 }
 stage.assessment={healthy:issues.length===0,issues:[...new Set(issues)],limiterFailOpen:failOpen,resourceBreaches:[...new Set(breaches)],
  criteria:'100% HTTP 200; no transport error, limiter fail-open, audit drop/unknown, accounting gap or sampling error; <=1% generator missed slots; P95<=50ms/P99<=100ms; scheduled P99<=150ms'}
 assert.equal(breaches.length,0,'Resource upper bound breached')
}

let activeDriver
async function measure(name,arrivalRate,durationSeconds,{actions=[],urls,jfr=false,arrivalPlan=null,diagnostics='light',kind='measurement'}={}){
 const stage={name,kind,arrivalRate,durationSeconds,diagnostics,startedAt:new Date().toISOString(),samples:[],samplingErrors:[],probes:[],events:[]}
 const stageDir=join(out,String(++stageSequence).padStart(2,'0')+'-'+name);await mkdir(stageDir)
 const before=await settled();stage.before=before;stage.eventCursors=Object.fromEntries(before.map(x=>[x.label,x.limiter.saturationEvents.lastSequence]));stage.redisBefore=await redisCommand(redisPort,['INFO','commandstats']);stage.controlsBefore={upstream:await control(upstreamControl),proxy:await control(proxyControl)};stage.output=stageDir;report.stages.push(stage);await save()
 const targetUrls=urls||gateways.flatMap(g=>paths.map(p=>'http://'+g.alias+':8080'+p+'/work'))
 const active=gateways.filter(g=>targetUrls.some(u=>u.startsWith('http://'+g.alias+':8080/')));assert.equal(active.length,1);stage.activeLabel=active[0].label;const observedGateway=active[0]
 await writeFile(join(stageDir,'load-config.json'),JSON.stringify({urls:targetUrls,durationSeconds,arrivalRate,connections:256,timeoutMs:8000,arrivalPlan}))
 if(jfr)await docker(['exec',observedGateway.name,'jcmd','1','JFR.start','name=capacity','settings=profile','maxsize=64m','maxage=180s','filename=/tmp/capacity.jfr','dumponexit=true'])
 const driver=prefix+'-driver-'+stageSequence;owned.push(driver);activeDriver=driver
 const args=['run','--rm','--name',driver,...common,'--cpuset-cpus','8-11','--memory','512m','--pids-limit','128',
  ...sourceMount,'--mount','type=bind,source='+stageDir+',target=/evidence',images.node,'node','/workspace/benchmarks/stability-worker.mjs','load']
 const log=createWriteStream(join(stageDir,'driver.log')),child=spawn('docker',args,{cwd:base,windowsHide:true})
 let text='',began=false,exitCode=null,childError
 child.stdout.on('data',chunk=>{log.write(chunk);text+=chunk;let index;while((index=text.indexOf('\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);try{const m=JSON.parse(line);if(m.kind==='started'){began=true;stage.driverStartedAt=m.startedAt}}catch{}}})
 child.stderr.on('data',x=>log.write(x))
 const finished=new Promise(resolve=>{child.once('error',e=>{childError=e;exitCode=-1;resolve()});child.once('exit',code=>{exitCode=code;resolve()})})
 await until('load driver startup',()=>{if(childError)throw childError;if(exitCode!==null)throw new Error('Load driver exited '+exitCode);return began},30000)
 console.log('START '+name+' rate='+arrivalRate+' duration='+durationSeconds+'s workers='+workers)
 let sampling=true,ticks=0,lastSaved=performance.now(),lastRss=performance.now()
 const sampler=(async()=>{while(sampling){
  if(diagnostics!=='none')await sampleAll(stage)
  ticks++;if(diagnostics!=='none'&&performance.now()-lastRss>=10000)for(const g of active)try{
   lastRss=performance.now()
   const raw=await docker(['exec',g.name,'cat','/proc/1/status','/sys/fs/cgroup/memory.current'])
   const latest=stage.samples.findLast(s=>s.label===g.label)
   if(latest)latest.processMemory={rssBytes:Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024,cgroupBytes:Number(raw.trim().split('\n').at(-1))}
  }catch(e){stage.samplingErrors.push({at:new Date().toISOString(),error:e.message})}
  if(performance.now()-lastSaved>=30000){lastSaved=performance.now();const x=stage.samples.at(-1);
   console.log('PROGRESS '+name+' '+JSON.stringify({seconds:Math.round((Date.now()-Date.parse(stage.driverStartedAt))/1000),failedOpen:x?x.limiter.outcomes.redis_fail_open+x.limiter.outcomes.local_fail_open-(before.find(b=>b.label===x.label).limiter.outcomes.redis_fail_open+before.find(b=>b.label===x.label).limiter.outcomes.local_fail_open):null}));await writeFile(join(out,'progress.json'),JSON.stringify({stage:name,active:stage.activeLabel,startedAt:stage.driverStartedAt,updatedAt:new Date().toISOString(),last:x},null,2))}
  if(sampling)await delay(sampleInterval)

 }})()
 const planned=actions.map(async action=>{const due=Date.now()+action.seconds*1000;while(Date.now()<due&&exitCode===null&&!stopped)await delay(Math.min(1000,due-Date.now()));if(exitCode!==null||stopped)return;const event={name:action.name,plannedSeconds:action.seconds,startedAt:new Date().toISOString()};stage.events.push(event);try{event.result=await action.run(stage);event.completedAt=new Date().toISOString()}catch(e){event.error=e.message;throw e}})
 const actionResults=Promise.allSettled(planned)
 try{await finished;assert.equal(exitCode,0,'Load driver exit; inspect '+stageDir);if(childError)throw childError}
 finally{sampling=false;await sampler;log.end();activeDriver=null}
 const events=await actionResults
 for(const e of events)if(e.status==='rejected')throw e.reason
 if(jfr){
  await docker(['exec',observedGateway.name,'jcmd','1','JFR.stop','name=capacity','filename=/tmp/capacity.jfr'])
  await docker(['cp',observedGateway.name+':/tmp/capacity.jfr',join(stageDir,'capacity.jfr')])
  stage.jfr={path:join(stageDir,'capacity.jfr'),sha256:createHash('sha256').update(await readFile(join(stageDir,'capacity.jfr'))).digest('hex')}
 }
 stage.result=JSON.parse(await readFile(join(stageDir,'load-result.json'),'utf8'))
 stage.controlsAfter={upstream:await control(upstreamControl),proxy:await control(proxyControl)}
 assert.equal(stage.result.offered,stage.result.issued+stage.result.schedulerMisses+stage.result.capacityMisses)
 assert.equal(stage.result.issued,stage.result.finished)
 for(const segment of Object.values(stage.result.segmentStats)){assert.equal(segment.offered,segment.issued+segment.schedulerMisses+segment.capacityMisses);assert.equal(segment.issued,segment.finished)}
 const after=await settled();stage.after=after;for(const g of active)await collectEvents(stage,g,after.find(x=>x.label===g.label).limiter.saturationEvents.lastSequence);stage.redisAfter=await redisCommand(redisPort,['INFO','commandstats']);stage.redisSlowlog=await redisCommand(redisPort,['SLOWLOG','GET','128']);
 stage.accounting=gateways.map(g=>{
  const b=before.find(x=>x.label===g.label),a=after.find(x=>x.label===g.label)
  const requests=(stage.result.byTarget['http://'+g.alias+':8080']?.finished||0)+stage.probes.filter(p=>p.label===g.label).length
  const counters=Object.fromEntries(['received','persisted','dropped','uncertain','retries'].map(k=>[k,a.audit[k]-b.audit[k]]))
  return {label:g.label,requests,...counters,pending:a.audit.pending,monitorCompleted:a.monitor.completedTotal-b.monitor.completedTotal,
   reconciliationGap:counters.received-counters.persisted-counters.dropped-counters.uncertain-(a.audit.pending-b.audit.pending),
   monitorGap:a.monitor.completedTotal-b.monitor.completedTotal-requests,auditGap:counters.received-requests,
   proxyReasons:Object.fromEntries(Object.keys(a.jvm.proxyOutcomes).map(k=>[k,a.jvm.proxyOutcomes[k]-(b.jvm.proxyOutcomes[k]||0)])),
    limiterOutcomes:Object.fromEntries(Object.keys(a.limiter.outcomes).map(k=>[k,a.limiter.outcomes[k]-(b.limiter.outcomes[k]||0)])),
   limiterReasons:a.limiter.observations?Object.fromEntries(Object.keys(a.limiter.observations.reasons).map(k=>[k,a.limiter.observations.reasons[k]-(b.limiter.observations.reasons[k]||0)])):null,
   limiterRejections:a.limiter.observations?Object.fromEntries(Object.keys(a.limiter.observations.rejections).map(k=>[k,a.limiter.observations.rejections[k]-(b.limiter.observations.rejections[k]||0)])):null}
 })
 for(const g of gateways){
  const records=await redisCommand(redisPort,['LRANGE',namespace+':audit:'+g.label,0,-1])
  const parsed=records.map(x=>JSON.parse(x)),ids=parsed.map(x=>x.eventId);assert.equal(ids.length,new Set(ids).size,'Duplicate retained audit IDs')
  stage.retainedAudit??={};stage.retainedAudit[g.label]={rows:parsed.length,rateLimitReasons:parsed.reduce((m,x)=>{const k=(x.rateLimitOutcome||'unknown')+'/'+(x.rateLimitReason||'unknown');m[k]=(m[k]||0)+1;return m},{})}
 }
 stage.upstreamReceived=stage.controlsAfter.upstream.stats.requests-stage.controlsBefore.upstream.stats.requests;
 assessment(stage);stage.completedAt=new Date().toISOString();await save()
 console.log('RESULT '+name+' '+JSON.stringify({rps:stage.result.successfulRequestsPerSecond,p95:stage.result.statusLatencyMs['200']?.p95,p99:stage.result.statusLatencyMs['200']?.p99,statuses:stage.result.statuses,misses:stage.result.schedulerMisses+stage.result.capacityMisses,assessment:stage.assessment}))
 return stage
}
async function nativeMemory(label){
 for(const g of gateways){await writeFile(join(out,label+'-'+g.label+'-native.txt'),await docker(['exec',g.name,'jcmd','1','VM.native_memory','summary','scale=KB']))}
}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{stopped=true;if(activeDriver)void docker(['rm','-f',activeDriver]).catch(()=>{})})

async function memoryCheckpoint(label,{baseline=false}={}){
 const dir=join(out,'memory-'+label);await mkdir(dir);const item={label,startedAt:new Date().toISOString(),output:dir,commands:[]}
 report.memoryCheckpoints??=[];report.memoryCheckpoints.push(item)
 for(const g of gateways){
  for(const command of [['VM.native_memory','summary','scale=KB'],['GC.heap_info'],['Compiler.codecache'],['System.native_heap_info']]){
   const started=performance.now(),name=g.label+'-'+command[0].replaceAll('.','-')+'.txt'
   const value=await docker(['exec',g.name,'jcmd','1',...command])
   assert(!/Unknown diagnostic command|Native memory tracking is not enabled/.test(value),value)
   await writeFile(join(dir,name),value)
   item.commands.push({label:g.label,command:command.join(' '),elapsedMs:performance.now()-started,file:name})
  }
  for(const [name,path] of [['smaps','/proc/1/smaps'],['smaps-rollup','/proc/1/smaps_rollup'],['status','/proc/1/status'],['cgroup-memory','/sys/fs/cgroup/memory.stat']])
   await writeFile(join(dir,g.label+'-'+name+'.txt'),await docker(['exec',g.name,'cat',path]))
  if(baseline)await docker(['exec',g.name,'jcmd','1','VM.native_memory','baseline'])
  else await writeFile(join(dir,g.label+'-native-diff.txt'),await docker(['exec',g.name,'jcmd','1','VM.native_memory','summary.diff','scale=KB']))
 }
 item.completedAt=new Date().toISOString();await save();return item
}
async function idle(label,seconds){
 const stage={name:label,durationSeconds:seconds,startedAt:new Date().toISOString(),samples:[],samplingErrors:[],events:[],kind:'idle'}
 report.stages.push(stage);const untilAt=Date.now()+seconds*1000;let nextLog=Date.now()+30000
 while(Date.now()<untilAt){
  if(stopped)throw new Error('Interrupted')
  await sampleAll(stage)
  const g=gateways[0],latest=stage.samples.at(-1)
  const raw=await docker(['exec',g.name,'cat','/proc/1/status','/sys/fs/cgroup/memory.current'])
  latest.processMemory={rssBytes:Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024,cgroupBytes:Number(raw.trim().split('\n').at(-1))}
  if(Date.now()>=nextLog){nextLog=Date.now()+30000;console.log('IDLE '+label+' '+JSON.stringify({remainingSeconds:Math.round((untilAt-Date.now())/1000),rssMiB:Math.round(latest.processMemory.rssBytes/1048576),heapMiB:Math.round(latest.jvm.heapBytes/1048576),pool:latest.proxy.pool,pending:latest.audit.pending}));await save()}
  await delay(Math.min(5000,Math.max(1,untilAt-Date.now())))
 }
 stage.completedAt=new Date().toISOString();await save()
}
const urlsFor=g=>paths.map(p=>'http://'+g.alias+':8080'+p+'/work');
async function idleUntilPoolEmpty(g,label){
 const entry={name:label,label:g.label,startedAt:new Date().toISOString(),samples:[]};report.idleChecks??=[];report.idleChecks.push(entry);
 const started=performance.now();
 await until('idle pool removal '+g.label,async()=>{
  const p=await api(g,'/settings/proxy/diagnostics');if(entry.samples.length<900)entry.samples.push({at:new Date().toISOString(),pool:p.pool,active:p.activeProxyRequests});
  return p.pool['total.connections']===0&&p.activeProxyRequests===0;
 },90000);
 entry.elapsedMs=performance.now()-started;entry.completedAt=new Date().toISOString();await save();return entry;
}
async function prepareWarm(g){
 await measure('cold-'+g.label+'-1000',1000,30,{urls:urlsFor(g),kind:'cold'});
 await idleUntilPoolEmpty(g,'cold-to-idle-'+g.label);
 await measure('idle-restart-'+g.label+'-1000',1000,30,{urls:urlsFor(g),kind:'idle-recovery'});
 await measure('warmup-'+g.label,2000,120,{urls:urlsFor(g),kind:'warmup',arrivalPlan:[{name:'warm-500',rate:500,seconds:30},{name:'warm-1000',rate:1000,seconds:30},{name:'warm-2000',rate:2000,seconds:60}]});
}
async function measured(g,name,r,kind='capacity',options={}){
 await measure('prepare-'+name,500,15,{urls:urlsFor(g),kind:'warmup'});
 return measure(name,r,seconds,{urls:urlsFor(g),kind,...options});
}
try{
 await setup();await redisCommand(redisPort,['CONFIG','SET','slowlog-log-slower-than','1000']);
 // Same-binary bootstrap writes routes; measured JVMs have not forwarded any business request before cold load.
 const seeder=await startGateway('S');await seed(seeder);await settled();
 report.seeder={...seeder};await api(seeder,'/actuator/shutdown',{method:'POST',body:'{}'});await docker(['wait',seeder.name],{timeout:45000});report.cleanup.SGraceful=true;
 await writeFile(join(out,'S-gateway.log'),await docker(['logs',seeder.name]));gateways.splice(gateways.indexOf(seeder),1);
 const A=await startGateway('A');await prepareWarm(A);
 const B=await startGateway('B');await prepareWarm(B);
 report.comparison={artifact:'same frozen jar',A:'inline default',B:'bounded handoff',cpuSet:'4-7, one load at a time',resourcesUnchanged:true};
 let round=0;
 for(const [g,levels] of [[A,rates],[B,rates],[B,[...rates].reverse()],[A,[...rates].reverse()]]){
  round++;for(const r of levels)await measured(g,'r'+round+'-'+g.label+'-'+r,r);
 }
 report.eligible=[];
 for(const g of [A,B])for(const r of rates){
  const matches=report.stages.filter(s=>s.kind==='capacity'&&s.activeLabel===g.label&&s.arrivalRate===r);
  if(matches.length===2&&matches.every(s=>s.assessment.healthy))report.eligible.push({label:g.label,rate:r,stages:matches.map(s=>s.name)});
 }
 report.eligible.sort((a,b)=>b.rate-a.rate||a.label.localeCompare(b.label));report.selected=report.eligible[0]||null;await save();
 // One paired diagnostic round. JFR recording overhead is excluded from capacity selection.
 for(const g of [A,B])await measured(g,'targeted-'+g.label+'-4000',4000,'diagnostic',{jfr:true});
 if(report.selected){
  const chosen=gateways.find(g=>g.label===report.selected.label);
  const confirmation=await measured(chosen,'pre-soak-confirm-'+chosen.label,report.selected.rate,'soak-confirmation');
  if(confirmation.assessment.healthy){
   await memoryCheckpoint('before-soak',{baseline:true});
   const soak=await measure('one-hour-'+chosen.label+'-'+report.selected.rate,report.selected.rate,3600,{urls:urlsFor(chosen),kind:'soak'});
   report.longValidated=soak.assessment.healthy?{label:chosen.label,rate:report.selected.rate,seconds:3600}:null;
   await memoryCheckpoint('after-soak');
   await measure('downshift-'+chosen.label+'-500',500,120,{urls:urlsFor(chosen),kind:'recovery'});
   await idleUntilPoolEmpty(chosen,'final-idle-'+chosen.label);await memoryCheckpoint('after-idle');
  }else report.soakSkipped='Selected rate failed the additional pre-soak confirmation; all results retained.';
 }else report.soakSkipped='No mode/rate passed both predeclared short repetitions; no one-hour capacity claim.';
 report.finalSnapshots=await Promise.all(gateways.map(snapshot))
 report.finalControls={upstream:await control(upstreamControl),proxy:await control(proxyControl)}
 if(study==='transport'||study==='handoff'){
  const rows=(await redisCommand(redisPort,['CLIENT','LIST'])).split('\n').filter(Boolean).map(line=>Object.fromEntries(line.split(' ').filter(Boolean).map(v=>{const i=v.indexOf('=');return [v.slice(0,i),v.slice(i+1)]})))
  report.transportProof=[]
  const proxyIp=JSON.parse(await docker(['inspect','--format','{{json .NetworkSettings.Networks}}',prefix+'-proxy']))[network].IPAddress
  for(const g of gateways){
   const gatewayIp=JSON.parse(await docker(['inspect','--format','{{json .NetworkSettings.Networks}}',g.name]))[network].IPAddress
   const connections=rows.filter(r=>r.name==='zenith-rate-limit:'+g.effectiveLimiter.instanceId)
   const expectedIp=study==='handoff'||g.label==='B'?gatewayIp:proxyIp
   assert.equal(connections.length,workers);assert(connections.every(r=>r.addr.startsWith(expectedIp+':')))
   report.transportProof.push({label:g.label,gatewayIp,expectedRedisPeerIp:expectedIp,connections:connections.map(r=>({id:r.id,addr:r.addr,name:r.name}))})
  }
 }
 assert.equal(createHash('sha256').update(await readFile(jar)).digest('hex'),report.jar.sha256,'Frozen jar changed');
  report.completedAt=new Date().toISOString();report.passed=true

}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack)}
finally{
 if(proxyControl)await control(proxyControl,{delayMs:0,disconnected:false}).catch(()=>{})
 if(upstreamControl)await control(upstreamControl,{delayMs:0,disconnected:false}).catch(()=>{})
 for(const g of gateways){
  await writeFile(join(out,g.label+'-gateway.log'),await docker(['logs',g.name]).catch(e=>e.message)).catch(()=>{})
  try{await api(g,'/actuator/shutdown',{method:'POST',body:'{}'});await docker(['wait',g.name],{timeout:45000});report.cleanup[g.label+'Graceful']=true}catch(e){report.cleanup[g.label+'ShutdownError']=e.message}
 }
 for(const name of [...owned].reverse()){
  try{const owner=await docker(['inspect','--format','{{index .Config.Labels "zenith.capacity-calibration.owner"}}',name]);assert.equal(owner,id);await docker(['rm','-f',name]);report.cleanup[name]='removed'}
  catch(e){if(/No such (object|container)/i.test(e.message))report.cleanup[name]='already_removed';else{report.cleanup[name]=e.message;report.passed=false;process.exitCode=1}}
 }
 if(networkCreated)try{const owner=await docker(['network','inspect','--format','{{index .Labels "zenith.capacity-calibration.owner"}}',network]);assert.equal(owner,id);await docker(['network','rm',network]);report.cleanup.networkRemoved=true}catch(e){report.cleanup.networkError=e.message;report.passed=false;process.exitCode=1}
 // Only this run's explicitly created credential is deleted, after its consumers have stopped.
 try{if(secretCreated){await unlink(join(secretDir,'zenith.admin.token'));report.cleanup.credentialRemoved=true}if(secretDirCreated)await rmdir(secretDir)}catch(e){if(e.code!=='ENOENT'){report.cleanup.credentialError=e.message;process.exitCode=1;report.passed=false}}
 report.finishedAt=new Date().toISOString();await save().catch(()=>{})
 console.log('Capacity calibration evidence: '+out)
}
