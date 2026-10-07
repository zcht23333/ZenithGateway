// Real HAProxy entry, two gateway JVMs, dedicated Redis and harmless upstream. No production deployment.
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {mkdir,readFile,writeFile,copyFile,unlink,rmdir,readdir} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import os from 'node:os'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {fileHash} from './acceptance-core.mjs'
import {scopedDockerArgs} from './acceptance-scope.mjs'
import {rollingPlan as plan,candidateGate,assessRollingWindow,reconcileRollingLedger,reconcileAuditSettlement} from './rolling-replacement-core.mjs'
import {finishRecording} from './rolling-replacement-recording.mjs'
const exec=promisify(execFile),root=resolve('.'),id=randomUUID().slice(0,8)
const arg=(n,d)=>process.argv.includes(n)?process.argv[process.argv.indexOf(n)+1]:d
const out=resolve(arg('--out','.dev/rolling-live-'+id)),sourceJar=resolve(arg('--jar','backend/target/zg-1.0.0.jar'))
await mkdir(out,{recursive:true});await writeFile(join(out,'run-marker'),new Date().toISOString(),{flag:'wx'})
const images={redis:'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
 node:'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
 java:'mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5',
 haproxy:'haproxy@sha256:56b887da77428b7a6621e59e480cdbd330cc805c22d3cedb66ceea76ffdea2c6'}
const prefix='zg-roll-'+id,network=prefix,ns='zg:rolling:'+id,token=randomUUID()+randomUUID()
const jar=join(out,'gateway.jar'),secrets=join(out,'credentials'),secret=join(secrets,'zenith.admin.token')
await copyFile(sourceJar,jar)
const report={startedAt:new Date().toISOString(),plan,images,jarSha256:await fileHash(jar),entrySha256:await fileHash(new URL(import.meta.url)),
 host:{platform:os.platform(),release:os.release(),arch:os.arch(),cpus:os.cpus().length,cpuModel:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
 checks:[],windows:[],processes:[],containers:[],requests:[],timeline:[],control:[],cleanup:{},passed:false}
const owned=[],volumes=new Set(),instances=[],agents=new Set();let createdNetwork=false,redisPort,worker,driver,entry,adminPort,A,B,versions,weights={a:100,b:0},browser,context,page,demoServer
const docker=async(args,timeout=30000)=>(await exec('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout,maxBuffer:8*1024*1024})).stdout.trim()
const save=(name,value)=>writeFile(join(out,name),JSON.stringify(value,null,2)+'\n')
async function until(label,probe,budget=20000){const end=performance.now()+budget;let last;do{try{const value=await probe(Math.max(1,end-performance.now()));if(value)return value}catch(e){last=e.message}await delay(50)}while(performance.now()<end);throw new Error(label+' exceeded '+budget+' ms: '+(last||''))}
async function event(title,data={}){const e={at:new Date().toISOString(),title,weights:{...weights},...data};report.timeline.push(e);console.log(title,JSON.stringify(data));await save('timeline.json',report.timeline)}
async function api(base,path,options={}){const r=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(3000)});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}if(!r.ok)throw new Error(path+' '+r.status+' '+text.slice(0,200));return body}
const ctrl=(path='/status',body)=>api(worker,path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)})
async function run(name,args){
 await docker(['run','-d','--pull=never','--name',name,'--label','zenith.verification='+prefix,'--network',network,...args]);owned.push(name)
 const i=JSON.parse(await docker(['inspect',name]))[0];for(const m of i.Mounts)if(m.Type==='volume')volumes.add(m.Name)
 report.containers.push({name,id:i.Id,image:i.Image,requestedImage:i.Config.Image,nanoCpus:i.HostConfig.NanoCpus,memoryBytes:i.HostConfig.Memory,pidsLimit:i.HostConfig.PidsLimit,network,ports:i.NetworkSettings.Ports})
 assert(i.HostConfig.NanoCpus>0&&i.HostConfig.Memory>0&&i.HostConfig.PidsLimit>0,'Every test container requires explicit resource limits')
 await save('containers.json',report.containers);return i
}
async function port(name,p){return Number((await docker(['port',name,p+'/tcp'])).split(':').at(-1))}
async function command(text){
 assert(!text.includes('\n'));let value=''
 try{
 await new Promise((resolve,reject)=>{const socket=net.connect({host:'127.0.0.1',port:adminPort},()=>socket.end(text+'\n'));socket.setTimeout(3000,()=>socket.destroy(new Error('HAProxy runtime deadline')));socket.on('data',b=>{value+=b;if(value.length>2*1024*1024)socket.destroy(new Error('HAProxy output bound'))});socket.once('error',reject);socket.once('end',resolve)})
 }catch(e){report.control.push({at:new Date().toISOString(),command:text,error:e.message});throw e}
 report.control.push({at:new Date().toISOString(),command:text,response:value});return value
}
function stats(csv){const lines=csv.trim().split('\n'),keys=lines.shift().replace(/^#\s*/,'').split(',');return lines.filter(Boolean).map(l=>Object.fromEntries(l.split(',').map((v,n)=>[keys[n],v])))}
async function weight(a,b){assert(a>=0&&b>=0&&a+b===100);await command('set server gateway/a weight '+a);await command('set server gateway/b weight '+b)
 const rows=stats(await command('show stat'));for(const [slot,value] of Object.entries({a,b})){const actual=rows.find(r=>r.pxname==='gateway'&&r.svname===slot);assert.equal(Number(actual?.weight),value,'HAProxy did not apply '+slot+' weight')}
 weights={a,b};await event('HAProxy 分配 A '+a+'% / B '+b+'%')}
async function readyServer(i,slot){await command('set server gateway/'+slot+' addr '+i.ip+' port 8080');await command('set server gateway/'+slot+' state ready');await until('HAProxy '+slot+' health UP',async()=>{
 const csv=await command('show stat'),row=csv.split('\n').find(l=>l.startsWith('gateway,'+slot+','));return ['UP','DRAIN'].includes(row?.split(',')[17])
 })}
async function startup(label,{proxy=false,invalid=false,auditProxy=false}={}){
 const name=prefix+'-'+label.toLowerCase(),auditKey=ns+':audit:'+label
 const args=['-XX:+UseG1GC','-XX:ActiveProcessorCount=2','-Xms256m','-Xmx512m','-XX:MaxDirectMemorySize=256m','-jar','/app/gateway.jar',
 '--server.port=8080','--spring.data.redis.host='+(proxy?'upstream':'redis'),'--spring.data.redis.port='+(proxy?6381:6379),'--spring.data.redis.password=',
 '--zenith.runtime.redis-key='+ns+':runtime','--zenith.route.redis-key='+ns+':routes','--zenith.audit.redis-key='+auditKey,'--zenith.limiter.namespace='+ns+':limiter',
 '--zenith.rate-limit.replenish-rate=10000','--zenith.rate-limit.burst-capacity=10000','--zenith.rate-limit.requested-tokens=1',
 '--zenith.limiter.workers=8','--zenith.limiter.queue-capacity=64','--zenith.limiter.result-handoff-enabled=false',
 '--zenith.lifecycle.request-drain-timeout-ms=2000','--zenith.lifecycle.cancellation-settle-timeout-ms=1000','--spring.lifecycle.timeout-per-shutdown-phase=10s',
 '--zenith.audit.shutdown-drain-timeout-ms=1000','--zenith.audit.command-timeout-ms=250','--zenith.audit.redis-max-entries=50000',
 '--zenith.proxy.resilience.headers-timeout-ms=15000','--zenith.proxy.resilience.read-idle-timeout-ms=15000','--zenith.proxy.resilience.total-timeout-ms=20000',
 ...(auditProxy?['--zenith.audit.host=upstream','--zenith.audit.port=6382','--zenith.audit.batch-size=10']:[]),...(invalid?['--zenith.proxy.resilience.connect-timeout-ms=0']:[])]
 const i={label,name,auditKey,args,startedAt:new Date().toISOString(),invalid},created=await run(name,['--cpus=2','--memory=1g','--pids-limit=512','-p','127.0.0.1::8080',
 '-e','SPRING_CONFIG_IMPORT=configtree:/run/secrets/','-v',secrets.replaceAll('\\','/')+':/run/secrets:ro','-v',jar.replaceAll('\\','/')+':/app/gateway.jar:ro',images.java,'java',...args])
 i.base='http://127.0.0.1:'+await port(name,8080);i.ip=created.NetworkSettings.Networks[network].IPAddress;instances.push(i);report.processes.push(i)
 if(invalid){i.exit=await until(label+' rejected startup',async()=>{const s=JSON.parse(await docker(['inspect',name]))[0].State;return s.Running?false:s},plan.readinessMs);assert.notEqual(i.exit.ExitCode,0);i.stopped=true;return i}
 await until(label+' readiness',()=>api(i.base,'/actuator/health/readiness').then(x=>x.status==='UP'),plan.readinessMs)
 i.readyAt=new Date().toISOString();i.identity=await api(i.base,'/settings/lifecycle');return i
}
async function snapshot(i){
 const [life,limit,proxy,runtimeSync,routeSync]=await Promise.all(['/settings/lifecycle','/settings/rate-limit/diagnostics','/settings/proxy/diagnostics','/settings/runtime/sync','/settings/routes/diagnostics'].map(p=>api(i.base,p)))
 const r=await fetch(i.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(3000)});assert(r.ok);const prom=await r.text()
 const poolFull=prom.split('\n').filter(l=>l.startsWith('zenith_gateway_proxy_outcomes_total{')&&l.includes('reason="proxy_pool_full"')).reduce((n,l)=>n+Number(l.split(' ').at(-1)),0)
 return {at:new Date().toISOString(),ready:life.phase==='ready',life,limit,proxy,runtimeSync,routeSync,poolFull}
}
async function settle(i){return until(i.label+' idle and audit settled',async()=>{const s=await snapshot(i);return s.life.activeBusinessRequests===0&&s.life.audit.pending===0&&s.limit.retainedTasks===0&&s.proxy.activeProxyRequests===0?s:false},plan.auditSettleMs)}
async function waitCandidate(i,name,initialTraffic=false){
 const observations=[],startedAt=new Date().toISOString(),start=performance.now();let last
 try{return await until(name,async()=>{last=await snapshot(i);const gate=candidateGate(last,versions,{initialTraffic});observations.push({at:last.at,gate,config:last.life.adoptedRuntimeVersion,route:last.life.adoptedRouteVersion,runtimeSync:last.runtimeSync.status,routeSync:last.routeSync.status,limiter:last.limit.transportState});if(!gate.allowed)await delay(250);return gate.allowed},plan.recoveryMs)}
 finally{await save(name+'.json',{startedAt,elapsedMs:performance.now()-start,initialTraffic,versions,observations,last})}
}
async function measure(name,{rate=plan.rate,seconds=plan.windowSeconds,members=[A,B].filter(Boolean),fault=false}={}){
 const collect=async()=>Object.fromEntries(await Promise.all(members.map(async i=>[i.label,await snapshot(i)])))
 const before=await collect(),samples=[],sampleErrors=[];let sampling=true
 const collector=(async()=>{while(sampling){try{samples.push(await collect())}catch(e){sampleErrors.push(e.message)}await delay(plan.sampleEveryMs)}})()
 let job
 try{await api(driver,'/start',{method:'POST',body:JSON.stringify({id:name,rate,seconds})});job=await until(name+' ingress complete',async()=>{const j=await api(driver,'/'+name);return j.state!=='running'?j:false},seconds*1000+12000);assert.equal(job.state,'complete',job.error)}finally{sampling=false;await collector}
 if(!fault)for(const i of members)await settle(i)
 const after=await collect(),upstream=(await ctrl('/status?phase='+name)).rows,result=job.result
 assert.equal(new Set(result.urls.map(u=>new URL(u).origin)).size,1);assert(result.urls.every(u=>u.startsWith('http://balancer:8080/')))
 const assessment=assessRollingWindow({before,after,samples,sampleErrors,result,upstreamCount:upstream.length},plan,versions)
 const row={name,fault,rate,seconds,weights:{...weights},before,after,samples,sampleErrors,result,upstream,assessment};report.windows.push(row);await save(name+'.json',row)
 await event((assessment.healthy?'窗口通过：':'暂停提升：')+name,{healthy:assessment.healthy,reasons:assessment.reasons,finished:result.finished,upstream:upstream.length,audit:assessment.audit,p99:result.latencyMs.p99})
 return row
}
async function healthy(name,options={}){
 for(let n=1;n<=plan.maxWindows;n++){const row=await measure(name+'-'+n,options);if(row.assessment.healthy)return row
  for(const i of options.members||[A,B].filter(Boolean))await until(i.label+' promotion recovery',async()=>candidateGate(await snapshot(i),versions).allowed,plan.recoveryMs)
 }
 throw new Error(name+' did not pass fixed windows; no further weight increase allowed')
}
async function hit(path,{agent,method='GET'}={}){
 let req,finish,ended=false,status=0,body='',selected,localPort,reused=false
 const start=performance.now(),done=new Promise(r=>finish=r)
 const end=termination=>{if(ended)return;ended=true;clearTimeout(timer);const row={path,method,status,body,instance:selected,localPort,reused,termination,at:new Date().toISOString(),elapsedMs:performance.now()-start};report.requests.push(row);finish(row)}
 const timer=setTimeout(()=>{req.destroy();end('client_deadline')},25000)
 req=http.request(entry+path,{method,agent},res=>{status=res.statusCode;selected=res.headers['x-verification-instance'];localPort=req.socket.localPort;reused=req.reusedSocket
  res.on('data',b=>{body+=b.toString();if(body.length>65536)req.destroy()});res.once('end',()=>end('complete'));res.once('aborted',()=>end('aborted'));res.once('error',()=>end('response_error'))
 });req.once('error',e=>end(e.code||'request_error'));req.end()
 return {done,cancel(mode='fin'){end('client_cancelled');if(mode==='reset'){assert(req.socket,'reset requires an established socket');req.socket.resetAndDestroy()}else req.destroy()},get body(){return body},get status(){return status}}
}
async function arrival(id){return until('upstream arrival '+id,async()=>{const state=await ctrl();return state.rows.find(x=>x.id===id)})}
async function linuxCancellationProbe(id,kind='hold'){
 await api(driver,'/probe-start',{method:'POST',body:JSON.stringify({id,kind})})
 const done=until('Linux probe '+id,async()=>{const job=await api(driver,'/probe/'+id);return job.state==='complete'?job.result:false},28000).then(row=>{report.requests.push(row);return row})
 return {done,cancel:mode=>api(driver,'/probe-cancel',{method:'POST',body:JSON.stringify({id,mode})})}
}
async function auditDump(i){
 const total=Number(await redisCommand(redisPort,['LLEN',i.auditKey]));assert(total<50000)
 const rows=[];for(let n=0;n<total;n+=500)for(const text of await redisCommand(redisPort,['LRANGE',i.auditKey,n,Math.min(n+499,total-1)]))rows.push({...JSON.parse(text),instance:i.slot})
 assert.equal(new Set(rows.map(x=>x.eventId)).size,rows.length);await save(i.label+'-audit.json',rows);return rows
}
async function stop(i){if(i.stopped)return;const start=performance.now();await docker(['kill','--signal=TERM',i.name],3000)
 try{i.exit=await until(i.label+' exited',async left=>{const s=JSON.parse(await docker(['inspect',i.name],Math.min(1500,Math.ceil(left))))[0].State;return s.Running?false:s},plan.exitMs);assert([0,143].includes(i.exit.ExitCode));assert(!i.exit.OOMKilled);i.stopped=true}
 finally{i.stopElapsedMs=performance.now()-start}
}
async function drain(i){const start=performance.now(),first=await api(i.base,'/settings/lifecycle/drain',{method:'POST',body:'{}'});const repeat=await api(i.base,'/settings/lifecycle/drain',{method:'POST',body:'{}'});assert.equal(first.drainStartedAt,repeat.drainStartedAt)
 const final=await until(i.label+' drained',async()=>{const s=await api(i.base,'/settings/lifecycle');return s.phase==='drained'?s:false},plan.drainObserveMs)
 i.drain={elapsedMs:performance.now()-start,first,final};return final
}
async function startRecording(){if(!process.argv.includes('--record'))return
 const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE||'.dev/browser/node_modules/playwright/index.mjs')))
 const html=await readFile(new URL('./rolling-replacement-demo.html',import.meta.url),'utf8')
 demoServer=http.createServer((req,res)=>{res.setHeader('Cache-Control','no-store');if(req.url==='/state'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(report.timeline))}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)}})
 await new Promise(r=>demoServer.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,timeout:10000,...(process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{})});report.recording={browserVersion:browser.version(),channel:process.env.PLAYWRIGHT_CHANNEL||'bundled chromium'};context=await browser.newContext({viewport:{width:1280,height:900},recordVideo:{dir:join(out,'video'),size:{width:1280,height:900}}});page=await context.newPage();await page.goto('http://127.0.0.1:'+demoServer.address().port)
}
async function endRecording(){
 if(!page&&!context&&!browser&&!demoServer)return
 const owned={page,context,browser,server:demoServer};page=null;context=null;browser=null;demoServer=null
 await finishRecording(owned,{title:report.timeline.at(-1)?.title,screenshotPath:join(out,'rolling-demo.png'),videoPath:join(out,'rolling-demo.webm')})
}
try{
 await save('plan.json',plan);await mkdir(secrets);await writeFile(secret,token)
 report.host.docker=JSON.parse(await docker(['info','--format','{"cpus":{{.NCPU}},"memoryBytes":{{.MemTotal}},"kernel":{{json .KernelVersion}},"version":{{json .ServerVersion}}}']))
 if(process.argv.includes('--prepare'))for(const image of Object.values(images))await docker(['pull',image],180000)
 await docker(['network','create',network]);createdNetwork=true
 const redisName=prefix+'-redis';await run(redisName,['--network-alias','redis','--cpus=1','--memory=512m','--pids-limit=128','--tmpfs','/data:rw,size=16m','-p','127.0.0.1::6379',images.redis,'--save','','--appendonly','no']);redisPort=await port(redisName,6379)
 const workerName=prefix+'-upstream';await run(workerName,['--network-alias','upstream','--cpus=1','--memory=256m','--pids-limit=128','-p','127.0.0.1::8090','-v',root.replaceAll('\\','/')+':/workspace:ro','-v',out.replaceAll('\\','/')+':/evidence','-v',secrets.replaceAll('\\','/')+':/secrets:ro',images.node,'node','/workspace/verification/rolling-replacement-worker.mjs']);worker='http://127.0.0.1:'+await port(workerName,8090);await until('upstream ready',()=>ctrl())
 A=await startup('A',{auditProxy:true});A.slot='a'
 const base=await api(A.base,'/settings/routes'),route={id:'probe',path:'/probe/**',uri:'http://upstream:8080',rewriteEnabled:true,circuitBreakerEnabled:true}
 const published=await api(A.base,'/settings/routes',{method:'POST',body:JSON.stringify({expectedVersion:base.version,route})})
 const runtime=await api(A.base,'/settings/runtime/adopted');versions={runtime:runtime.version,route:published.version}
 const cfg=`global\n  log stdout format raw local0\n  maxconn 512\n  stats socket ipv4@0.0.0.0:9999 level admin\n  nbthread 1\ndefaults\n  mode http\n  log global\n  option httplog\n  retries 0\n  retry-on none\n  no option redispatch\n  timeout connect 1s\n  timeout client 30s\n  timeout server 30s\n  timeout http-keep-alive 120s\n  timeout check 500ms\nfrontend public\n  bind :8080\n  default_backend gateway\nbackend gateway\n  balance roundrobin\n  http-reuse safe\n  option httpchk\n  http-check send meth GET uri /actuator/health/readiness\n  http-check expect status 200\n  http-send-name-header X-Verification-Instance\n  http-response set-header X-Verification-Instance %[srv_name]\n  server a ${A.ip}:8080 check inter 200ms rise 1 fall 1 weight 100\n  server b 127.0.0.1:1 check inter 200ms rise 1 fall 1 weight 0 disabled\n`
 await writeFile(join(out,'haproxy.cfg'),cfg)
 const lb=prefix+'-lb';await run(lb,['--network-alias','balancer','--cpus=1','--memory=256m','--pids-limit=128','-p','127.0.0.1::8080','-p','127.0.0.1::9999','-v',join(out,'haproxy.cfg').replaceAll('\\','/')+':/usr/local/etc/haproxy/haproxy.cfg:ro',images.haproxy]);entry='http://127.0.0.1:'+await port(lb,8080);adminPort=await port(lb,9999)
 await until('HAProxy runtime listener ready',async()=>/Name: HAProxy/.test(await command('show info')),10000);await readyServer(A,'a')
 await writeFile(join(out,'haproxy-version.txt'),await docker(['exec',lb,'haproxy','-vv']))
 const load=prefix+'-load';await run(load,['--cpus=1','--memory=256m','--pids-limit=128','-p','127.0.0.1::8091','-v',root.replaceAll('\\','/')+':/workspace:ro','-v',out.replaceAll('\\','/')+':/evidence','-v',secrets.replaceAll('\\','/')+':/secrets:ro',images.node,'node','/workspace/verification/rolling-replacement-load.mjs']);driver='http://127.0.0.1:'+await port(load,8091);await until('driver ready',()=>api(driver,'/status'))
 report.isolation={network,namespace:ns,entry,adminPort,redisPort,driver,worker};await event('A 服务，B 保持零权重',{versions})
 await healthy('a-preparation',{members:[A],rate:plan.warmRate,seconds:plan.warmSeconds})
 const duringBad=measure('a-during-b-start-failure',{members:[A]});const bad=await startup('BINVALID',{invalid:true});assert((await duringBad).assessment.healthy);report.checks.push({name:'new JVM invalid startup is rejected; A keeps serving',exit:bad.exit})
 B=await startup('B',{proxy:true});B.slot='b';await readyServer(B,'b');assert.equal(weights.b,0)
 await ctrl('/redis',{partitionB:true})
 const config=await api(A.base,'/settings/runtime/adopted');const updated=await api(A.base,'/settings/runtime',{method:'PUT',body:JSON.stringify({...config,expectedVersion:config.version,operationId:randomUUID(),monitorWindowSeconds:30})});assert.equal(updated.monitorWindowSeconds,30)
 const routes=await api(A.base,'/settings/routes');const changed=await api(A.base,'/settings/routes',{method:'POST',body:JSON.stringify({expectedVersion:routes.version,route})});versions={runtime:updated.version,route:changed.version}
 const lag=candidateGate(await snapshot(B),versions);assert(!lag.allowed&&lag.reasons.includes('runtime_version_not_adopted')&&lag.reasons.includes('route_version_not_adopted'))
 const isolated=await measure('a-during-b-lag',{members:[A]});assert(isolated.assessment.healthy);assert(isolated.upstream.every(x=>x.instance==='a'));report.checks.push({name:'stale local versions prevent B promotion without foreground adoption reads',gate:lag,weights:{...weights}})
 await ctrl('/redis',{partitionB:false});await waitCandidate(B,'b-background-versions-recovered',true)
 await weight(90,10);await healthy('b-small-warm')
 await ctrl('/redis',{partitionB:true});const fault=await measure('b-entry-fault',{fault:true});assert(!fault.assessment.healthy&&fault.assessment.reasons.includes('fault_forward'))
 await weight(100,0);const paused=await measure('a-after-b-withdrawn',{members:[A]});assert(paused.assessment.healthy);assert(paused.upstream.every(x=>x.instance==='a'))
 report.checks.push({name:'B Redis fault stops promotion despite fail-open HTTP 200; A remains available',faultWindow:fault.name,withdrawalWindow:paused.name})
 await ctrl('/redis',{partitionB:false});await waitCandidate(B,'b-recovery-before-reevaluation');await settle(B)
 await startRecording();await event('开始正常滚动替换：B 已恢复并追平两个版本',{versions})
 const agent=new http.Agent({keepAlive:true,maxSockets:1});agents.add(agent)
 const keep=await hit('/probe/quick/keep-before',{agent});const keepBefore=await keep.done;assert.equal(keepBefore.instance,'a')
 for(const percent of plan.rampWeights){assert(candidateGate(await snapshot(B),versions).allowed);await weight(100-percent,percent);await healthy('b-weight-'+percent)}
 // Let HAProxy choose; if a preparatory hold lands on B, release it and retain its ledger row.
 let held,heldId
 for(let n=0;n<8;n++){const key='normal-hold-'+n,h=await hit('/probe/hold/'+key),arrivalRow=await arrival(key);if(arrivalRow.instance==='a'){held=h;heldId=key;break}await ctrl('/release',{id:key});await h.done}
 assert(held,'HAProxy must select old A for the controlled in-flight request')
 await command('set server gateway/a state maint');await weight(0,100);await event('已从 HAProxy 摘除 A；既有在途请求继续')
 const drainPending=drain(A);await until('A admission boundary',()=>api(A.base,'/settings/lifecycle').then(x=>x.draining),2000)
 const keepAfter=await (await hit('/probe/quick/keep-after',{agent})).done;assert.equal(keepAfter.instance,'b');assert(keepAfter.reused);assert.equal(keepAfter.localPort,keepBefore.localPort)
 await ctrl('/release',{id:heldId});assert.equal((await held.done).status,200);const finalA=await drainPending
 const continuing=measure('b-during-a-exit',{members:[B]});await stop(A);assert((await continuing).assessment.healthy)
 report.checks.push({name:'healthy rolling replacement and same client keep-alive connection reselects B',keepBefore,keepAfter,drain:A.drain,exit:A.exit});await event('正常替换完成：B 继续服务，A 排空并退出',{drainMs:A.drain.elapsedMs,exitMs:A.stopElapsedMs});await endRecording()
 // Independent exit-fault exercise, still at most two live gateway JVMs. Restart A as the old instance.
 A=await startup('AEXIT',{auditProxy:true});A.slot='a';await readyServer(A,'a');await weight(100,0);await healthy('aexit-preparation',{members:[A]})
 const exitBaseline=await settle(A)
 const slow=await hit('/probe/hold/exit-over',{method:'POST'}),stream=await hit('/probe/stream/exit-partial'),cancel=await linuxCancellationProbe('exit-cancel','stream'),halfClose=await linuxCancellationProbe('exit-fin')
 for(const key of ['exit-over','exit-partial','exit-cancel','exit-fin'])await arrival(key);await until('partial response really sent',()=>stream.body.includes('part-0'))
 await until('cancel probe received its first response chunk',()=>api(driver,'/probe/exit-cancel').then(p=>p.status===200&&p.body.includes('part-0')))
 await ctrl('/redis',{partitionB:false,auditMode:'drop-reply'})
 const auditRequests=await Promise.all(Array.from({length:12},(_,n)=>hit('/probe/quick/audit-pending-'+n).then(h=>h.done)));assert(auditRequests.every(r=>r.status===200))
 await until('audit events pending and Redis replies suppressed',async()=>{const life=await api(A.base,'/settings/lifecycle'),c=await ctrl();return life.audit.pending>0&&c.suppressed>0})
 await command('set server gateway/a state maint');await weight(0,100)
 const faultDrain=drain(A);await until('AEXIT draining',()=>api(A.base,'/settings/lifecycle').then(x=>x.draining),2000);await Promise.all([halfClose.cancel('fin'),cancel.cancel('reset')])
 await ctrl('/pulse',{id:'exit-cancel'})
 const cancelObserved=await until('stream cancellation propagated before drain deadline',async()=>{const life=await api(A.base,'/settings/lifecycle'),state=await ctrl();return life.clientCancelled===exitBaseline.life.clientCancelled+1&&life.deadlineTerminated===exitBaseline.life.deadlineTerminated&&!state.holds.includes('exit-cancel')?{at:new Date().toISOString(),life,upstream:state.rows.find(r=>r.id==='exit-cancel')}:false},1500)
 const [slowResult,streamResult,cancelResult,halfCloseResult]=await Promise.all([slow.done,stream.done,cancel.done,halfClose.done]);const finalFault=await faultDrain
 await save('exit-fault-results.json',{exitBaseline,slowResult,streamResult,cancelResult,halfCloseResult,cancelObserved,finalFault})
 assert.equal(slowResult.status,503);assert.equal(streamResult.status,200);assert.notEqual(streamResult.termination,'complete');assert(!streamResult.body.includes('shutdown_deadline'));assert.equal(cancelResult.termination,'client_cancelled')
 assert.equal(cancelResult.status,200);assert.equal(cancelResult.body,'part-0\n')
 assert.equal(finalFault.admitted-exitBaseline.life.admitted,16);assert.equal(finalFault.completed-exitBaseline.life.completed,16)
 assert.equal(finalFault.deadlineTerminated-exitBaseline.life.deadlineTerminated,3);assert.equal(finalFault.clientCancelled-exitBaseline.life.clientCancelled,1)
 const auditState=finalFault.audit;assert.equal(auditState.received,auditState.persisted+auditState.pending+auditState.uncertain+auditState.dropped);assert(auditState.uncertain+auditState.dropped>0);assert.equal(auditState.pending,0)
 const healthyB=measure('b-during-a-fault-exit',{members:[B]});await stop(A);assert((await healthyB).assessment.healthy);await ctrl('/redis',{partitionB:false,auditMode:'normal'})
 report.checks.push({name:'bounded old-instance exit with write in-flight, partial response, active-stream cancellation, pre-header FIN and audit reply loss',slowResult,streamResult,cancelResult,halfCloseResult,cancelObserved,drain:A.drain,exit:A.exit,auditState})
 await settle(B);await drain(B);await stop(B)
 const upstream=(await ctrl()).rows,audits=[]
 report.auditSettlement=[]
 for(const i of instances.filter(x=>!x.invalid)){const rows=await auditDump(i),settlement=reconcileAuditSettlement(i.drain.final.audit,rows.length);assert(settlement.passed,JSON.stringify(settlement));report.auditSettlement.push({instance:i.label,...settlement});audits.push(...rows)}
 const ingress=[...report.requests]
 for(const f of await readdir(out))if(f.endsWith('-ingress.jsonl'))for(const line of (await readFile(join(out,f),'utf8')).trim().split('\n').filter(Boolean))ingress.push(JSON.parse(line))
 const isFault=path=>/\/(exit-|audit-pending-|b-entry-fault-)/.test(path)
 const normalIngress=ingress.filter(r=>!isFault(r.path)),normalIds=new Set(normalIngress.map(r=>r.path.split('/').at(-1)))
 const reconciliation=reconcileRollingLedger(normalIngress,upstream.filter(r=>normalIds.has(r.id)),audits.filter(r=>normalIds.has(r.path.split('/').at(-1))))
 assert(reconciliation.passed,JSON.stringify(reconciliation.errors));assert.equal(new Set(upstream.map(r=>r.id)).size,upstream.length,'Upstream duplicate execution')
 assert.equal(new Set(ingress.map(r=>r.path)).size,ingress.length,'Duplicate ingress IDs')
 const faultAudit=audits.filter(r=>isFault(r.path)),faultUpstream=upstream.filter(r=>isFault(r.path)),allIds=new Set(ingress.map(r=>r.path.split('/').at(-1)))
 assert(audits.every(r=>allIds.has(r.path.split('/').at(-1))),'Unissued audit event')
 assert.equal(new Set(audits.map(r=>r.path.split('/').at(-1))).size,audits.length,'Duplicate audit per ingress')
 assert.equal(instances.filter(i=>!i.invalid).reduce((n,i)=>n+i.drain.final.completed,0),ingress.length,'Exactly one instance terminal per ingress')
 assert.equal(report.auditSettlement.reduce((n,s)=>n+s.received,0),ingress.length,'Exactly one audit admission per ingress')
 report.accounting={normal:reconciliation,allIngress:ingress.length,allUpstream:upstream.length,allStoredAudits:audits.length,faultAudit,faultUpstream,
  note:'Fault audit uncertain may be stored; dropped are not promised persisted. Do not equate unknown with absent.'}
 assert.equal(ingress.length,upstream.length);await save('ingress-all.json',ingress);await save('upstream-all.json',upstream);await save('audits-all.json',audits)
 report.checks.push({name:'single-entry request IDs reconcile across instance, upstream and audit; no duplicate upstream execution',reconciliation})
 const csv=await command('show stat'),lbRows=stats(csv),frontend=lbRows.find(r=>r.pxname==='public'&&r.svname==='FRONTEND'),backend=lbRows.find(r=>r.pxname==='gateway'&&r.svname==='BACKEND')
 assert.equal(Number(frontend.req_tot),ingress.length,'HAProxy HTTP requests must match the client ledger, including keep-alive reuse');assert.equal(Number(backend.wretr),0);assert.equal(Number(backend.wredis),0)
 report.accounting.haproxy={requests:Number(frontend.req_tot),retries:Number(backend.wretr),redispatches:Number(backend.wredis)}
 await save('haproxy-final-stat.json',{csv,rows:lbRows,state:await command('show servers state')});report.passed=true
}catch(e){
 report.error=e.stack;process.exitCode=1;console.error(e)
 report.failureSnapshots=Object.fromEntries(await Promise.all(instances.filter(i=>!i.invalid&&!i.stopped).map(async i=>[i.label,await snapshot(i).catch(error=>({error:error.message}))])))
}
finally{
 await endRecording().catch(e=>report.recordingError=e.message);for(const a of agents)a.destroy()
 if(worker)await ctrl('/redis',{partitionB:false,auditMode:'normal'}).catch(()=>{})
 for(const i of instances)if(!i.stopped)try{await stop(i)}catch(e){report.cleanup[i.label+'StopError']=e.message;await docker(['kill',i.name],3000).catch(()=>{})}
 if(!report.passed&&redisPort){report.failureCleanupAudits={};for(const i of instances.filter(x=>!x.invalid)){try{const rows=await auditDump(i);report.failureCleanupAudits[i.label]={records:rows.length,note:'Read after failure cleanup restored the test wire and stopped this JVM; not an earlier healthy-window confirmation.'}}catch(e){report.failureCleanupAudits[i.label]={error:e.message}}}}
 if(redisPort){const clients=await redisCommand(redisPort,['CLIENT','LIST']).catch(e=>'UNAVAILABLE:'+e.message);await writeFile(join(out,'clients-final.txt'),clients);report.cleanup.namedGatewayClientsAbsent=!clients.startsWith('UNAVAILABLE')&&instances.every(i=>!i.identity||!clients.includes(i.identity.instanceId))}
 for(const name of owned){await writeFile(join(out,name+'.log'),await docker(['logs',name]).catch(e=>e.message));await docker(['rm','-fv',name]).catch(e=>report.cleanup[name]=e.message)}
 if(createdNetwork)await docker(['network','rm',network]).catch(e=>report.cleanup.networkError=e.message)
 await unlink(secret).catch(()=>{});await rmdir(secrets).catch(()=>{})
 const names=(await docker(['ps','-a','--format','{{.Names}}']).catch(()=>'?')).split('\n'),remainingVolumes=(await docker(['volume','ls','-q']).catch(()=>'?')).split('\n')
 report.cleanup.ownedContainersAbsent=names[0]!=='?'&&!owned.some(n=>names.includes(n));report.cleanup.ownedVolumesAbsent=remainingVolumes[0]!=='?'&&![...volumes].some(v=>remainingVolumes.includes(v))
 report.cleanup.networkAbsent=!(await docker(['network','ls','--format','{{.Name}}']).catch(()=>network)).split('\n').includes(network)
 report.cleanup.credentialsRemoved=await readFile(secret).then(()=>false,()=>true)
 report.passed&&=Object.values(report.cleanup).every(x=>x===true);report.completedAt=new Date().toISOString();if(!report.passed)process.exitCode=1
 await save('report.json',report);console.log('Rolling evidence: '+out)
}
