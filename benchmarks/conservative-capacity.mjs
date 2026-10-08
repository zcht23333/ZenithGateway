import assert from 'node:assert/strict'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {readFile,writeFile,mkdir,unlink,rmdir} from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from './redis.mjs'
import {capacityPlan as fullCapacityPlan,assessCapacity} from './conservative-capacity-gates.mjs'
import {recordCapacityShutdown} from './conservative-capacity-shutdown.mjs'
import {rssPlan,rssSafetyIssues} from './rss-observation.mjs'
import {collectRssCheckpoint} from './rss-checkpoint.mjs'
import {nativeDiagnosticPlan,controlledTrim} from './rss-native-diagnostic.mjs'
const counterShort=process.env.CAPACITY_BASELINE_MODE==='command-counter-short'
const nativeMode=process.env.CAPACITY_BASELINE_MODE==='rss-native-retention'
const rssMode=process.env.CAPACITY_BASELINE_MODE==='rss-investigation'||nativeMode
assert(process.env.CAPACITY_BASELINE_MODE===undefined||counterShort||rssMode,'Unknown CAPACITY_BASELINE_MODE')
// A separate, predeclared regression plan; never an abbreviated one-hour capacity claim.
const capacityPlan=counterShort?Object.freeze({...fullCapacityPlan,
 warmup:[{name:'warm-100',rate:100,seconds:10},{name:'warm-500',rate:500,seconds:10},{name:'warm-1000',rate:1000,seconds:40}],
 shortSeconds:60,longSeconds:0,confirmationSeconds:0,downshiftSeconds:15,idleSeconds:0,
 note:'Command counter short regression only; two 60s windows at 1000/s. No long-load or RSS stability validation.'}):nativeMode?nativeDiagnosticPlan:rssMode?rssPlan:fullCapacityPlan
const exec=promisify(execFile),base=resolve('.'),id=randomUUID().slice(0,8)
const out=resolve(process.env.CAPACITY_BASELINE_OUTPUT||'.dev/conservative-capacity-'+id)
if(!process.env.CAPACITY_BASELINE_JAR)throw new Error('CAPACITY_BASELINE_JAR must select the verified frozen release JAR')
const jar=resolve(process.env.CAPACITY_BASELINE_JAR),workers=capacityPlan.workers,queueCapacity=capacityPlan.queueCapacity,routeCount=32,applicationProfile='capacity',sampleInterval=capacityPlan.sampleMs
const images={redis:'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',node:'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',java:'mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5'}
const prefix='zg-conservative-'+id,network=prefix,namespace='zg:conservative:'+id,owned=[],gateways=[]
const token=randomUUID()+randomUUID(),secretDir=join(out,'secrets'),paths=Array.from({length:routeCount},(_,n)=>n===0?'/bench':'/r'+String(n).padStart(3,'0'))
let stopped=false,networkCreated=false,outputCreated=false,secretCreated=false,secretDirCreated=false,redisPort,upstreamControl,stageSequence=0
const report={schemaVersion:1,mode:counterShort?'command-counter-short':nativeMode?'rss-native-retention':rssMode?'rss-investigation':'capacity',startedAt:new Date().toISOString(),id,namespace,jar:{path:jar,sha256:createHash('sha256').update(await readFile(jar)).digest('hex')},
 config:{...capacityPlan,images,routeCount,applicationProfile,saturationSamplingEnabled:true,cpuSets:{redis:'0-1',upstream:'2-3',gateway:'4-7',driver:'8-11'},heap:'256m/512m',directMemoryLimit:'256m',nativeMemoryTracking:'summary',gatewayMemoryLimit:'1g',redisPersistence:false},
 containerLimits:[],stages:[],events:[],cleanup:{},passed:false,longValidated:null}
const save=async()=>{if(outputCreated)await writeFile(join(out,'summary.json'),JSON.stringify(report,null,2)+'\n')}
async function docker(args,options={}){const {stdout}=await exec('docker',args,{cwd:base,windowsHide:true,timeout:60000,maxBuffer:16*1024*1024,...options});return stdout.trim()}
async function until(label,fn,ms=60000){const end=Date.now()+ms;do{if(stopped)throw new Error('Interrupted');try{const v=await fn();if(v)return v}catch(e){if(Date.now()+200>=end)throw e}await delay(100)}while(Date.now()<end);throw new Error('Timeout: '+label)}
async function api(g,path,options={}){
 const r=await fetch(g.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(5000)})
 const text=await r.text();if(!r.ok)throw new Error(path+' HTTP '+r.status+': '+text.slice(0,300));return text?JSON.parse(text):null
}
async function control(origin,body){const r=await fetch(origin,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json()}
const common=['--pull=never','--label','zenith.capacity-baseline.owner='+id,'--network',network]
const sourceMount=['--mount','type=bind,source='+join(out,'tools')+',target=/workspace/benchmarks,readonly']
const secretMount=['--mount','type=bind,source='+secretDir+',target=/run/secrets,readonly']
async function port(name,inside){return Number((await docker(['port',name,String(inside)+'/tcp'])).split(':').at(-1))}
async function runContainer(name,args){
 owned.push(name);await docker(['run','-d','--name',name,...common,...args]);
 const c=JSON.parse(await docker(['inspect',name]))[0];report.containerLimits.push({name,id:c.Id,image:c.Image,cpuset:c.HostConfig.CpusetCpus,nanoCpus:c.HostConfig.NanoCpus,memory:c.HostConfig.Memory,pids:c.HostConfig.PidsLimit,ports:c.NetworkSettings.Ports,mounts:c.Mounts.map(m=>({type:m.Type,name:m.Name,destination:m.Destination}))});
 await save();return name
}
async function setup(){
 await mkdir(out,{recursive:false});outputCreated=true;await writeFile(join(out,'plan.json'),JSON.stringify(capacityPlan,null,2)+'\n');
 report.harnessIdentity=Object.fromEntries(await Promise.all(['conservative-capacity.mjs','conservative-capacity-gates.mjs','conservative-capacity-shutdown.mjs','rss-observation.mjs','rss-checkpoint.mjs','rss-native-diagnostic.mjs','stability-worker.mjs','stability-load.mjs','redis.mjs'].map(async name=>[name,createHash('sha256').update(await readFile(join(base,'benchmarks',name))).digest('hex')])));
 await mkdir(join(out,'tools'));for(const name of Object.keys(report.harnessIdentity))await writeFile(join(out,'tools',name),await readFile(join(base,'benchmarks',name)));
 await mkdir(secretDir);secretDirCreated=true;await writeFile(join(secretDir,'zenith.admin.token'),token,{flag:'wx'});secretCreated=true
 const info=JSON.parse(await docker(['info','--format','{{json .}}']))
 report.environment={cpus:info.NCPU,memoryBytes:info.MemTotal,kernel:info.KernelVersion,os:info.OperatingSystem,startedHost:process.platform}
 assert(info.NCPU>=16,'Capacity CPU layout requires sixteen Docker logical CPUs')
 report.imageIds={};for(const image of Object.values(images))report.imageIds[image]=await docker(['image','inspect',image,'--format','{{.Id}}'])
 await docker(['network','create','--label','zenith.capacity-baseline.owner='+id,network]);networkCreated=true
 const redis=await runContainer(prefix+'-redis',['--network-alias','redis','--cpuset-cpus','0-1','--memory','256m','--pids-limit','128','-p','127.0.0.1::6379',images.redis,'redis-server','--save','','--appendonly','no'])
 redisPort=await port(redis,6379);await until('redis',()=>redisCommand(redisPort,['PING']).then(v=>v==='PONG'))
 for(const [role,cpus] of [['upstream','2-3']]){
  const name=await runContainer(prefix+'-'+role,['--network-alias',role,'--cpuset-cpus',cpus,'--memory','256m','--pids-limit','128','-p','127.0.0.1::8090',
   ...sourceMount,'--mount','type=bind,source='+join(secretDir,'zenith.admin.token')+',target=/run/admin-token,readonly',images.node,'node','/workspace/benchmarks/stability-worker.mjs',role])
  const origin='http://127.0.0.1:'+await port(name,8090)
  await until(role,()=>control(origin))
  upstreamControl=origin
 }
 report.isolation={network,redisPort,upstreamControl,containers:owned}
 await save()
}
async function startGateway(label='A'){
 const name=prefix+'-gateway-'+label.toLowerCase(),alias='gateway-'+label.toLowerCase()
 const args=['-Xlog:gc,safepoint:file=/diagnosis/gc-'+label+'.log:time,uptime,level,tags:filecount=3,filesize=20M','-Xms256m','-Xmx512m','-XX:MaxDirectMemorySize=256m','-XX:ActiveProcessorCount=4','-XX:+UseG1GC','-XX:NativeMemoryTracking=summary','-jar','/app/gateway.jar',
  '--server.port=8080','--spring.data.redis.host=redis','--spring.data.redis.port=6379','--spring.data.redis.password=',
  '--zenith.runtime.redis-key='+namespace+':runtime','--zenith.route.redis-key='+namespace+':routes','--zenith.audit.redis-key='+namespace+':audit:'+label,
  '--zenith.limiter.namespace='+namespace+':limiter','--zenith.limiter.workers='+workers,'--zenith.limiter.saturation-sampling-enabled=true',
  '--zenith.limiter.result-handoff-enabled=false',
  ...(applicationProfile?['--spring.profiles.active='+applicationProfile]:['--zenith.limiter.queue-capacity='+queueCapacity]),
  '--zenith.rate-limit.replenish-rate=10000','--zenith.rate-limit.burst-capacity=10000',
  '--zenith.monitor.enabled=true','--zenith.audit.enabled=true','--zenith.limiter.local-failure-policy=allow','--zenith.limiter.redis-failure-policy=allow','--zenith.limiter.decision-timeout-ms=500',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,metrics,prometheus,shutdown']
 await runContainer(name,['--network-alias',alias,'--cpuset-cpus','4-7','--memory','1g','--pids-limit','512','-p','127.0.0.1::8080',
  '--env','SPRING_CONFIG_IMPORT=configtree:/run/secrets/',...secretMount,
  '--mount','type=bind,source='+jar+',target=/app/gateway.jar,readonly','--mount','type=bind,source='+out+',target=/diagnosis',images.java,'java',...args])
 const g={name,label,alias,base:'http://127.0.0.1:'+await port(name,8080),args};gateways.push(g)
 await until('gateway '+label,()=>api(g,'/actuator/health/readiness').then(x=>x.status==='UP'))
 g.readyConfirmedAt=new Date().toISOString();
 const anonymous=await fetch(g.base+'/settings/rate-limit/saturation');assert.equal(anonymous.status,401);
 const eventResponse=await fetch(g.base+'/settings/rate-limit/saturation',{headers:{Authorization:'Bearer '+token}});assert.equal(eventResponse.status,200);assert.equal(eventResponse.headers.get('cache-control'),'no-store');
 const negative=await fetch(g.base+'/settings/rate-limit/saturation?afterSequence=-1',{headers:{Authorization:'Bearer '+token}});assert.equal(negative.status,400);

 assert.equal((await api(g,'/settings/rate-limit/diagnostics')).resultHandoffEnabled,false);
 g.effectiveLimiter=await api(g,'/settings/rate-limit/diagnostics');assert.equal(g.effectiveLimiter.decisionTimeoutMs,500);assert.equal(g.effectiveLimiter.localFailurePolicy,'allow');assert.equal(g.effectiveLimiter.redisFailurePolicy,'allow');assert.equal(g.effectiveLimiter.saturationEvents.enabled,true);assert.equal(g.effectiveLimiter.workers,workers);assert.equal(g.effectiveLimiter.queueCapacity,queueCapacity,'Actual profile queue capacity');
 g.vmFlags=await docker(['exec',name,'jcmd','1','VM.flags']);assert(g.vmFlags.includes('+UseG1GC'))
 g.java=await docker(['exec',name,'java','--version'])
 if(nativeMode){g.nativeTrimHelp=await docker(['exec',name,'timeout','--kill-after=1s','5s','jcmd','1','help','System.trim_native_heap'],{timeout:8000});assert(g.nativeTrimHelp.includes('System.trim_native_heap')&&!/No such command|Unknown diagnostic/.test(g.nativeTrimHelp),'Native trim unavailable')}
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
  ...(rssMode?{memoryPools:values.filter(v=>['jvm_memory_used_bytes','jvm_memory_committed_bytes','jvm_buffer_count_buffers','jvm_classes_loaded_classes'].includes(v.name))}:{}),
  proxyOutcomes:Object.fromEntries(values.filter(v=>v.name==='zenith_gateway_proxy_outcomes_total').map(v=>[v.tags.match(/reason="([^"]+)"/)?.[1]||v.tags,v.value]))}
}
async function snapshot(g){
 const routes=['/monitor/audit/status','/settings/rate-limit/diagnostics','/settings/proxy/diagnostics','/settings/routes/diagnostics','/settings/runtime/sync','/settings/lifecycle']
 const values=await Promise.all(routes.map(p=>api(g,p)))
 const response=await fetch(g.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});assert.equal(response.status,200)
 const proxy=values[2];proxy.breakerStates=proxy.breakers.reduce((m,b)=>{m[b.state]=(m[b.state]||0)+1;return m},{});delete proxy.breakers
 return {label:g.label,at:new Date().toISOString(),audit:values[0],limiter:values[1],proxy,route:values[3],runtime:values[4],life:values[5],jvm:parseProm(await response.text())}
}
async function settled(){
 await until('drained requests and audit',async()=>{const rows=await Promise.all(gateways.map(async g=>({a:await api(g,'/monitor/audit/status'),p:await api(g,'/settings/proxy/diagnostics'),l:await api(g,'/settings/rate-limit/diagnostics')})));return rows.every(x=>x.a.pending===0&&x.p.activeProxyRequests===0&&x.l.commandsInFlight===0&&x.l.queued===0&&x.l.retainedTasks===0&&x.l.activeDeliveries===0&&x.l.activeWorkers===0)},45000)
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
function assessment(stage){stage.assessment=assessCapacity(stage);if(rssMode){stage.rssSafetyIssues=[...new Set([...stage.before,...stage.samples,...stage.after].flatMap(rssSafetyIssues))];if(stage.rssSafetyIssues.length){stage.assessment.healthy=false;stage.assessment.issues.push(...stage.rssSafetyIssues)}}}

let activeDriver
async function measure(name,arrivalRate,durationSeconds,{actions=[],urls,jfr=false,arrivalPlan=null,diagnostics='light',kind='measurement'}={}){
 const stage={name,kind,arrivalRate,durationSeconds,diagnostics,startedAt:new Date().toISOString(),samples:[],samplingErrors:[],probes:[],events:[]}
 const stageDir=join(out,String(++stageSequence).padStart(2,'0')+'-'+name);await mkdir(stageDir)
 const before=await settled();stage.before=before;stage.eventCursors=Object.fromEntries(before.map(x=>[x.label,x.limiter.saturationEvents.lastSequence]));stage.redisBefore=await redisCommand(redisPort,['INFO','commandstats']);stage.controlsBefore={upstream:await control(upstreamControl)};stage.output=stageDir;report.stages.push(stage);await save()
 const targetUrls=urls||gateways.flatMap(g=>paths.map(p=>'http://'+g.alias+':8080'+p+'/work'))
 const active=gateways.filter(g=>targetUrls.some(u=>u.startsWith('http://'+g.alias+':8080/')));assert.equal(active.length,1);stage.activeLabel=active[0].label;stage.origins=Object.fromEntries(active.map(g=>[g.label,'http://'+g.alias+':8080']));const observedGateway=active[0]
 await writeFile(join(stageDir,'load-config.json'),JSON.stringify({urls:targetUrls,durationSeconds,arrivalRate,connections:capacityPlan.generatorConnections,timeoutMs:capacityPlan.generatorTimeoutMs,arrivalPlan}))
 if(jfr)await docker(['exec',observedGateway.name,'jcmd','1','JFR.start','name=capacity','settings=profile','maxsize=64m','maxage=180s','filename=/tmp/capacity.jfr','dumponexit=true'])
 const driver=prefix+'-driver-'+stageSequence;owned.push(driver);activeDriver=driver
 const args=['run','--rm','--name',driver,...common,'--cpuset-cpus','8-11','--memory','512m','--pids-limit','128',
  ...sourceMount,'--mount','type=bind,source='+stageDir+',target=/evidence',images.node,'node','/workspace/benchmarks/stability-worker.mjs','load']
 const log=createWriteStream(join(stageDir,'driver.log')),child=spawn('docker',args,{cwd:base,windowsHide:true})
 let text='',began=false,exitCode=null,childError;const absoluteDeadline=setTimeout(()=>{stage.driverDeadlineExceeded=true;void docker(['rm','-f',driver]).catch(()=>{});child.kill()},(durationSeconds+45)*1000)
 child.stdout.on('data',chunk=>{log.write(chunk);text+=chunk;let index;while((index=text.indexOf('\n'))>=0){const line=text.slice(0,index);text=text.slice(index+1);try{const m=JSON.parse(line);if(m.kind==='started'){began=true;stage.driverStartedAt=m.startedAt}}catch{}}})
 child.stderr.on('data',x=>log.write(x))
 const finished=new Promise(resolve=>{child.once('error',e=>{clearTimeout(absoluteDeadline);childError=e;exitCode=-1;resolve()});child.once('exit',code=>{clearTimeout(absoluteDeadline);exitCode=code;resolve()})})
 await until('load driver startup',()=>{if(childError)throw childError;if(exitCode!==null)throw new Error('Load driver exited '+exitCode);return began},30000)
 console.log('START '+name+' rate='+arrivalRate+' duration='+durationSeconds+'s workers='+workers)
 let sampling=true,ticks=0,lastSaved=performance.now(),lastRss=0,nextMemory=Date.now()+rssPlan.memoryCheckpointMs,memorySequence=0
 const sampler=(async()=>{while(sampling){
  if(diagnostics!=='none')await sampleAll(stage)
  ticks++;if(diagnostics!=='none'&&performance.now()-lastRss>=capacityPlan.rssSampleMs)for(const g of active)try{
   lastRss=performance.now()
   const raw=await docker(['exec',g.name,'cat','/proc/1/status','/sys/fs/cgroup/memory.current'])
   const latest=stage.samples.findLast(s=>s.label===g.label)
   if(latest)latest.processMemory={rssBytes:Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024,cgroupBytes:Number(raw.trim().split('\n').at(-1))}
  }catch(e){stage.samplingErrors.push({at:new Date().toISOString(),error:e.message})}
  if(rssMode){
   try{
    const issues=rssSafetyIssues(stage.samples.at(-1));if(issues.length)throw Error(issues.join('; '))
    if(kind==='soak'&&Date.now()>=nextMemory){nextMemory=Date.now()+rssPlan.memoryCheckpointMs;await memoryCheckpoint(name+'-'+String(++memorySequence).padStart(2,'0'))}
   }catch(e){stage.resourceStop={at:new Date().toISOString(),error:e.message};sampling=false;await save();await docker(['rm','-f',driver]).catch(()=>{});break}
  }
  if(performance.now()-lastSaved>=30000){lastSaved=performance.now();const x=stage.samples.at(-1);
   console.log('PROGRESS '+name+' '+JSON.stringify({seconds:Math.round((Date.now()-Date.parse(stage.driverStartedAt))/1000),failedOpen:x?x.limiter.outcomes.redis_fail_open+x.limiter.outcomes.local_fail_open-(before.find(b=>b.label===x.label).limiter.outcomes.redis_fail_open+before.find(b=>b.label===x.label).limiter.outcomes.local_fail_open):null,protective:x?x.limiter.outcomes.redis_rejected+x.limiter.outcomes.local_rejected:null,debitUnknown:x?.limiter.observations.executions.unknown}));await writeFile(join(out,'progress.json'),JSON.stringify({stage:name,active:stage.activeLabel,startedAt:stage.driverStartedAt,updatedAt:new Date().toISOString(),last:x,lastRssSample:stage.samples.findLast(s=>s.processMemory)},null,2))}
  if(sampling)await delay(sampleInterval)

 }})()
 const planned=actions.map(async action=>{const due=Date.now()+action.seconds*1000;while(Date.now()<due&&exitCode===null&&!stopped)await delay(Math.min(1000,due-Date.now()));if(exitCode!==null||stopped)return;const event={name:action.name,plannedSeconds:action.seconds,startedAt:new Date().toISOString()};stage.events.push(event);try{event.result=await action.run(stage);event.completedAt=new Date().toISOString()}catch(e){event.error=e.message;throw e}})
 const actionResults=Promise.allSettled(planned)
 try{await finished;assert.equal(exitCode,0,'Load driver exit; inspect '+stageDir);if(childError)throw childError}
 finally{clearTimeout(absoluteDeadline);sampling=false;await sampler;log.end();activeDriver=null}
 const events=await actionResults
 for(const e of events)if(e.status==='rejected')throw e.reason
 if(jfr){
  await docker(['exec',observedGateway.name,'jcmd','1','JFR.stop','name=capacity','filename=/tmp/capacity.jfr'])
  await docker(['cp',observedGateway.name+':/tmp/capacity.jfr',join(stageDir,'capacity.jfr')])
  stage.jfr={path:join(stageDir,'capacity.jfr'),sha256:createHash('sha256').update(await readFile(join(stageDir,'capacity.jfr'))).digest('hex')}
 }
 stage.result=JSON.parse(await readFile(join(stageDir,'load-result.json'),'utf8'))
 stage.controlsAfter={upstream:await control(upstreamControl)}
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
 if(rssMode){
  report.memoryCheckpoints??=[];assert(report.memoryCheckpoints.length<rssPlan.maximumCheckpoints,'RSS checkpoint count limit')
  const item=await collectRssCheckpoint({label,out,gateways,docker,baseline});report.memoryCheckpoints.push(item);await save()
  if(item.error)throw Error(item.error);return item
 }
 const dir=join(out,'memory-'+label);await mkdir(dir);const item={label,startedAt:new Date().toISOString(),output:dir,commands:[]}
 report.memoryCheckpoints??=[];report.memoryCheckpoints.push(item)
 for(const g of gateways){
  for(const command of [['VM.native_memory','summary','scale=KB'],['GC.heap_info'],['Compiler.codecache']]){
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
async function idle(label,seconds,{kind='idle'}={}){
 const stage={name:label,durationSeconds:seconds,startedAt:new Date().toISOString(),samples:[],samplingErrors:[],events:[],kind}
 report.stages.push(stage);const untilAt=Date.now()+seconds*1000;let nextLog=Date.now()+30000,nextMemory=Date.now()+rssPlan.memoryCheckpointMs,memorySequence=0
 while(Date.now()<untilAt){
  if(stopped)throw new Error('Interrupted')
  await sampleAll(stage)
  const g=gateways[0],latest=stage.samples.at(-1)
  const raw=await docker(['exec',g.name,'cat','/proc/1/status','/sys/fs/cgroup/memory.current'])
  latest.processMemory={rssBytes:Number(raw.match(/^VmRSS:\s+(\d+)/m)?.[1])*1024,cgroupBytes:Number(raw.trim().split('\n').at(-1))}
  if(rssMode){const issues=rssSafetyIssues(latest);assert.equal(issues.length,0,issues.join('; '));if(Date.now()>=nextMemory){nextMemory=Date.now()+rssPlan.memoryCheckpointMs;await memoryCheckpoint(label+'-'+String(++memorySequence).padStart(2,'0'))}}
  if(Date.now()>=nextLog){nextLog=Date.now()+30000;console.log('IDLE '+label+' '+JSON.stringify({remainingSeconds:Math.round((untilAt-Date.now())/1000),rssMiB:Math.round(latest.processMemory.rssBytes/1048576),heapMiB:Math.round(latest.jvm.heapBytes/1048576),pool:latest.proxy.pool,pending:latest.audit.pending}));await save()}
  await delay(Math.min(5000,Math.max(1,untilAt-Date.now())))
 }
 stage.completedAt=new Date().toISOString();await save()
}
async function nativeHeapInfo(g,label){
 const entry={label,startedAt:new Date().toISOString(),file:label+'-native-heap-info.txt'},start=performance.now();report.nativeHeapInfo??=[];report.nativeHeapInfo.push(entry)
 try{const raw=await docker(['exec',g.name,'timeout','--kill-after=1s','5s','jcmd','1','System.native_heap_info'],{timeout:8000});await writeFile(join(out,entry.file),raw);assert(raw.includes('<malloc')&&raw.includes('</malloc>'),'malloc_info unavailable')}
 catch(e){entry.error=e.message;throw e}
 finally{entry.elapsedMs=performance.now()-start;entry.completedAt=new Date().toISOString();await save()}
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
try{
 await setup();await redisCommand(redisPort,['CONFIG','SET','slowlog-log-slower-than','1000']);
 const A=await startGateway('A');await seed(A);await settled();
 report.initialRuntime=await api(A,'/settings/runtime');report.initialRoutes=await api(A,'/settings/routes');
 assert.equal(report.initialRuntime.replenishRate,10000);assert.equal(report.initialRuntime.burstCapacity,10000);assert.equal(report.initialRuntime.requestedTokens,1);assert.equal(report.initialRuntime.rateLimitEnabled,true);
 if(!counterShort)await memoryCheckpoint('startup',{baseline:true});
 const warm=await measure('warmup',1000,capacityPlan.warmup.reduce((n,p)=>n+p.seconds,0),{urls:urlsFor(A),kind:'warmup',arrivalPlan:capacityPlan.warmup});
 if(!counterShort)await memoryCheckpoint('after-warmup',{baseline:true});
 const shorts=[];let mayIncrease=!rssMode||warm.assessment.healthy;
 for(let i=1;i<=capacityPlan.shortRepetitions&&mayIncrease;i++){const s=await measure('short-'+i,capacityPlan.rate,capacityPlan.shortSeconds,{urls:urlsFor(A),kind:'short'});shorts.push(s);if(rssMode&&!s.assessment.healthy)mayIncrease=false}
 if(counterShort)report.soakSkipped='Explicit command-counter short regression; no one-hour or RSS claim.';
 else if(mayIncrease&&shorts.length===capacityPlan.shortRepetitions&&shorts.every(s=>s.assessment.healthy)){
  await memoryCheckpoint('before-soak',{baseline:true});
  const confirm=await measure('pre-soak-confirmation',capacityPlan.rate,capacityPlan.confirmationSeconds,{urls:urlsFor(A),kind:'confirmation'});
  if(confirm.assessment.healthy){
   const soak=await measure(nativeMode?'native-conditioning-1000':'one-hour-1000',capacityPlan.rate,capacityPlan.longSeconds,{urls:urlsFor(A),kind:'soak'});
   const validated=soak.assessment.healthy?{rate:capacityPlan.rate,seconds:capacityPlan.longSeconds,stage:soak.name}:null;
   if(nativeMode){report.diagnosticLoadValidated=validated;report.longValidated=null}else report.longValidated=validated;
   await memoryCheckpoint('after-soak');
  }else report.soakSkipped='The pre-soak confirmation failed; no long-load result is claimed.';
 }else report.soakSkipped='At least one fixed short window failed; no automatic rate change or long-load claim.';
 await measure('downshift-100',capacityPlan.downshiftRate,capacityPlan.downshiftSeconds,{urls:urlsFor(A),kind:'recovery'});
 if(!counterShort){await memoryCheckpoint('after-downshift');await idle('idle-'+capacityPlan.idleSeconds,capacityPlan.idleSeconds)}
 await idleUntilPoolEmpty(A,'idle-pool-released');if(!counterShort)await memoryCheckpoint('after-idle');
 if(nativeMode){
  if(report.diagnosticLoadValidated&&report.stages.every(s=>!s.assessment||s.assessment.healthy)){
   await nativeHeapInfo(A,'before-trim');
   await controlledTrim({gateway:A,ownerId:id,drained:await settled(),activeDriver,docker,report,save});
   await memoryCheckpoint('after-native-trim');await nativeHeapInfo(A,'after-trim');
   await idle('post-trim-idle-'+capacityPlan.postTrimIdleSeconds,capacityPlan.postTrimIdleSeconds,{kind:'diagnostic-idle'});
   await memoryCheckpoint('after-trim-observation');
  }else report.nativeTrimSkipped='Conditioning health gates failed; no intervention.'
 }
 report.finalSnapshots=await settled();report.finalControls={upstream:await control(upstreamControl)};
 for(const s of report.finalSnapshots){assert.equal(s.limiter.availableDecisionPermits,s.limiter.admissionCapacity);assert.equal(s.limiter.retainedTasks,0);assert.equal(s.audit.pending,0)}
 assert.equal(createHash('sha256').update(await readFile(jar)).digest('hex'),report.jar.sha256,'Frozen release JAR changed');
 report.completedAt=new Date().toISOString();report.passed=true
}catch(e){report.error=e.stack;process.exitCode=1;console.error(e.stack)}
finally{
 if(activeDriver)await docker(['rm','-f',activeDriver]).catch(()=>{});
 for(const g of gateways){
  const exit=await recordCapacityShutdown(g,{requestShutdown:()=>api(g,'/actuator/shutdown',{method:'POST',body:'{}'}),docker,report})
  if(!exit.graceful)process.exitCode=1
  await save().catch(e=>{report.cleanup[g.label+'ShutdownSaveError']=e.message;report.passed=false;process.exitCode=1})
  await writeFile(join(out,g.label+'-gateway.log'),await docker(['logs',g.name]).catch(e=>e.message)).catch(()=>{})
 }
 if(redisPort){try{const clients=await redisCommand(redisPort,['CLIENT','LIST']);await writeFile(join(out,'clients-final.txt'),clients);report.cleanup.namedGatewayClientsAbsent=gateways.every(g=>!clients.includes(g.effectiveLimiter.instanceId));if(!report.cleanup.namedGatewayClientsAbsent)throw Error('Gateway connections remain')}catch(e){report.cleanup.clientCheckError=e.message;report.passed=false;process.exitCode=1}}
 for(const name of [...owned].reverse()){
  try{const owner=await docker(['inspect','--format','{{index .Config.Labels "zenith.capacity-baseline.owner"}}',name]);assert.equal(owner,id);await docker(['rm','-fv',name]);report.cleanup[name]='removed'}
  catch(e){if(/No such (object|container)/i.test(e.message))report.cleanup[name]='already_removed';else{report.cleanup[name]=e.message;report.passed=false;process.exitCode=1}}
 }
 if(networkCreated)try{const owner=await docker(['network','inspect','--format','{{index .Labels "zenith.capacity-baseline.owner"}}',network]);assert.equal(owner,id);await docker(['network','rm',network]);report.cleanup.networkRemoved=true}catch(e){report.cleanup.networkError=e.message;report.passed=false;process.exitCode=1}
 try{if(secretCreated){await unlink(join(secretDir,'zenith.admin.token'));report.cleanup.credentialRemoved=true}if(secretDirCreated)await rmdir(secretDir)}catch(e){if(e.code!=='ENOENT'){report.cleanup.credentialError=e.message;process.exitCode=1;report.passed=false}}
 report.finishedAt=new Date().toISOString();await save().catch(()=>{});console.log('Conservative capacity evidence: '+out)
}
