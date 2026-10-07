import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import {withRouteVersion} from '../benchmarks/route-client.mjs'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {runtimeValues} from './runtime-config-client.mjs'
import {syncProxy} from './runtime-config-sync-proxy.mjs'

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));process.chdir(root)
const id=randomBytes(5).toString('hex'),name='zenith-config-sync-'+id,key='zg:sync:'+id+':runtime'
const out=resolve(process.env.CONFIG_SYNC_OUTPUT||'.dev/config-sync/live-'+id)
const token=randomBytes(24).toString('hex')
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const report={startedAt:new Date().toISOString(),isolated:true,checks:[],evidence:{},observations:[],cleanup:{},passed:false}
await mkdir(out,{recursive:true})
report.jarSha256=createHash('sha256').update(await readFile('backend/target/zg-1.0.0.jar')).digest('hex')
const docker=args=>execFileSync('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const processes=[],ledger=new Map(),lastRevision=new Map(),requests=[]
let redisCreated=false,redisPort,proxy,A,B,current,observationCount=0,signature
const upstream=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"isolatedUpstream":true}')})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
async function until(label,probe,timeout=6000){
 const deadline=performance.now()+timeout;let last
 do{last=await probe();if(last)return last;await delay(40)}while(performance.now()<deadline)
 throw new Error('Bounded wait expired: '+label)
}
async function reached(promise,label,timeout=6000){
 let timer
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Missing boundary: '+label)),timeout)})])}
 finally{clearTimeout(timer)}
}
async function request(instance,path,options={}){
 assert.ok(!(instance.label.startsWith('B')&&path==='/settings/runtime'&&(!options.method||options.method==='GET')),
  'B may only be observed via local endpoints')
 const r=await fetch(instance.base+path,{...options,signal:AbortSignal.timeout(6000),
  headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}})
 const body=await r.json();requests.push({instance:instance.label,path,method:options.method||'GET',status:r.status})
 return {status:r.status,body,cacheControl:r.headers.get('cache-control')}
}
async function api(instance,path,options={}){
 const r=await request(instance,path,options);assert.equal(r.status,200,JSON.stringify(r));return r.body
}
async function start(label,port){
 const instance={label,base:'http://127.0.0.1:'+await freePort(),log:createWriteStream(join(out,label+'.log'))}
 const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java'
 instance.child=spawn(java,['-Xms128m','-Xmx384m','-XX:ActiveProcessorCount=4','-jar','backend/target/zg-1.0.0.jar',
  '--server.address=127.0.0.1','--server.port='+new URL(instance.base).port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+port,'--spring.data.redis.password=',
  '--zenith.runtime.redis-key='+key,'--zenith.route.redis-key=zg:sync:'+id+':routes:'+label[0],
  '--zenith.rate-limit.enabled=false','--zenith.audit.enabled=false',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],
  {windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}})
 instance.child.stdout.pipe(instance.log,{end:false});instance.child.stderr.pipe(instance.log,{end:false});processes.push(instance)
 let spawnError;instance.child.once('error',e=>spawnError=e)
 await until(label+' readiness',async()=>{
  if(spawnError)throw spawnError
  assert.equal(instance.child.exitCode,null,label+' exited before readiness')
  try{return (await request(instance,'/actuator/health/readiness')).status===200}catch(e){if(e.name==='AssertionError')throw e;return false}
 },60000)
 return instance
}
async function stop(instance){
 if(!instance||instance.child.exitCode!==null)return
 await api(instance,'/actuator/shutdown',{method:'POST',body:'{}'})
 await until(instance.label+' graceful exit',async()=>instance.child.exitCode!==null,20000)
 assert.equal(instance.child.exitCode,0);instance.log.end()
 report.cleanup[instance.label+'ExitCode']=instance.child.exitCode
}
function remember(value){ledger.set(value.version,runtimeValues(value));return value}
async function save(patch,instance=A){
 const expected=current.version,startedAt=new Date().toISOString(),started=performance.now()
 current=remember(await api(instance,'/settings/runtime',{method:'PUT',body:JSON.stringify({...runtimeValues(current),...patch,expectedVersion:expected,operationId:randomUUID()})}))
 return {version:current.version,submittedAt:startedAt,confirmedAt:new Date().toISOString(),
  commitRoundTripMs:performance.now()-started,confirmedMonotonic:performance.now(),values:runtimeValues(current)}
}
function validateSnapshot(value,instanceId){
 assert.deepEqual(runtimeValues(value),ledger.get(value.version),'published fields must match one real committed snapshot')
 const revision=Number(value.version.slice(37)),before=lastRevision.get(instanceId)||0
 assert.ok(revision>=before,'adopted version moved backwards');lastRevision.set(instanceId,revision)
}
async function status(instance=B){
 const s=await api(instance,'/settings/runtime/sync');observationCount++
 validateSnapshot(s.adopted,s.instanceId)
 const next=JSON.stringify([s.instanceId,s.status,s.adoptedVersion,s.lastConfirmedVersion,s.reasonCode])
 if(next!==signature){report.observations.push({observedAt:new Date().toISOString(),instance:instance.label,...s});signature=next}
 return s
}
async function converged(commit,instance=B){
 const s=await until(instance.label+' adopts '+commit.version,async()=>{
  const s=await status(instance);return s.adoptedVersion===commit.version&&s.status==='ok'?s:false
 })
 const elapsedMs=performance.now()-commit.confirmedMonotonic
 assert.ok(elapsedMs<=3000,'Healthy convergence target 3000ms exceeded: '+elapsedMs)
 return {...commit,observedAt:new Date().toISOString(),adoptedAt:s.lastAdoptedAt,elapsedMs,status:s}
}
async function check(label,fn){await fn();report.checks.push(label);console.log('PASS '+label)}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);redisCreated=true
 redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 const redis=args=>redisCommand(redisPort,args)
 await until('Redis ready',async()=>{try{return await redis(['PING'])}catch{return false}})
 proxy=await syncProxy(redisPort,key)
 assert.equal(await redis(['EXISTS',key]),0)
 A=await start('A',redisPort);current=remember(await api(A,'/settings/runtime'))
 B=await start('B',proxy.port);let initialB
 await check('Two independent processes restore one snapshot and expose authenticated local sync diagnostics',async()=>{
  initialB=await until('initial B check',async()=>{const s=await status();return s.status==='ok'?s:false})
  const a=await status(A);assert.notEqual(a.instanceId,initialB.instanceId)
  assert.equal(initialB.adoptedVersion,current.version);assert.equal(initialB.intervalMs,2000)
  assert.equal(initialB.timeoutMs,1000);assert.equal(initialB.staleAfterMs,10000)
  const anonymous=await fetch(B.base+'/settings/runtime/sync');assert.equal(anonymous.status,401)
  assert.equal((await request(B,'/settings/runtime/sync')).cacheControl,'no-store')
  report.evidence.startup={a,b:initialB}
 })
 await check('A committed update automatically changes B real proxy behavior from 200 to 429',async()=>{
  const route=await request(B,'/settings/routes',await withRouteVersion(()=>request(B,'/settings/routes'),{method:'POST',body:JSON.stringify({
   id:'sync-behavior',path:'/sync-probe/**',uri:'http://127.0.0.1:'+upstream.address().port,
   rewriteEnabled:false,circuitBreakerEnabled:false})}));assert.equal(route.status,201)
  await until('B route published',async()=>{const r=await fetch(B.base+'/sync-probe/hello');await r.text();return r.status===200})
  const commit=await save({rateLimitEnabled:true,replenishRate:1,burstCapacity:1,requestedTokens:2,monitorWindowSeconds:30})
  report.evidence.firstConvergence=await converged(commit)
  const response=await fetch(B.base+'/sync-probe/hello');assert.equal(response.status,429);await response.text()
  const adopted=await api(B,'/settings/runtime/adopted');assert.equal(adopted.version,commit.version)
  report.evidence.business={beforeHttpStatus:200,afterHttpStatus:429,observedOnlyThroughLocalEndpoints:true}
  await converged(await save({rateLimitEnabled:false,replenishRate:20,burstCapacity:40,requestedTokens:1}))
 })
 await check('Repeated confirmation refreshes check time without changing the actual adoption timestamp',async()=>{
  const first=await status()
  const again=await until('next same-version check',async()=>{const s=await status();return s.checksCompleted>first.checksCompleted?s:false})
  assert.equal(again.adoptedVersion,first.adoptedVersion);assert.equal(again.lastAdoptedAt,first.lastAdoptedAt)
  assert.notEqual(again.lastConfirmedAt,first.lastConfirmedAt)
  report.evidence.repeated={first,again}
 })
 await check('Proxy requests and diagnostic reads add zero runtime Redis commands while one periodic read is held',async()=>{
  const held=proxy.holdNextRead()
  try{
   await reached(held.reached,'background read frame')
   const start=proxy.events.length
   await Promise.all(Array.from({length:20},async()=>{const r=await fetch(B.base+'/sync-probe/hello');assert.equal(r.status,200);await r.text()}))
   for(let i=0;i<5;i++){await status();await api(B,'/settings/runtime/adopted')}
   const events=proxy.events.slice(start).filter(e=>e.key===key)
   assert.equal(events.length,0);report.evidence.hotPath={proxiedRequests:20,localDiagnosticRequests:10,configurationCommands:events.length}
  }finally{held.release()}
 })
 await check('Only B is disconnected; it retains its snapshot, exposes failure then expiry, and automatically recovers',async()=>{
  const boundary=proxy.holdNextRead();await reached(boundary.reached,'disconnect at a captured periodic read')
  const before=await status();proxy.cut();boundary.release();const cutAt=new Date().toISOString()
  const commits=[]
  for(const window of [35,40,45])commits.push(await save({monitorWindowSeconds:window,replenishRate:window}))
  const failed=await until('B failure',async()=>{const s=await status();return s.status==='failed'?s:false})
  assert.equal(failed.adoptedVersion,before.adoptedVersion);assert.equal(failed.lastConfirmedAt,before.lastConfirmedAt)
  const stale=await until('B confirmation expiry',async()=>{const s=await status();return s.status==='stale'?s:false},14000)
  assert.equal(stale.adoptedVersion,before.adoptedVersion);assert.equal(stale.lastConfirmedVersion,before.lastConfirmedVersion)
  assert.equal((await request(B,'/actuator/health/readiness')).status,200)
  const recoveredMonotonic=performance.now(),recoveredAt=new Date().toISOString();proxy.recover()
  const recovery=await converged({...commits.at(-1),confirmedMonotonic:recoveredMonotonic})
  await until('independent application Redis connection reconnects',async()=>proxy.applicationConnected,45000)
  report.evidence.partition={cutAt,before,commits,failed,stale,recoveredAt,recovery,applicationConnectionReadyAt:new Date().toISOString(),applicationReconnectObservedMs:performance.now()-recoveredMonotonic}
 })
 await check('A captured old read arriving after a newer B commit cannot roll back B or its adoption time',async()=>{
  const held=proxy.holdNextRead()
  try{
   const frame=await reached(held.reached,'old Redis read reply'),old=JSON.parse(frame.value).snapshot
   assert.equal(old.version,current.version)
   await save({monitorWindowSeconds:50})
   const newer=await save({monitorWindowSeconds:55,replenishRate:55},B)
   const afterWrite=await status();assert.equal(afterWrite.adoptedVersion,newer.version)
   held.release()
   const late=await until('old observation recorded',async()=>{const s=await status();return s.reasonCode==='CONFIG_SYNC_OBSERVATION_BEHIND'?s:false})
   assert.equal(late.lastConfirmedVersion,old.version);assert.equal(late.adoptedVersion,newer.version)
   assert.equal(late.lastAdoptedAt,afterWrite.lastAdoptedAt)
   const recovered=await until('new check converges',async()=>{const s=await status();return s.status==='ok'?s:false})
   report.evidence.lateReply={capturedAt:frame.at,oldVersion:old.version,newer,afterWrite,late,recovered}
  }finally{held.release()}
 })
 await check('Consecutive update waves only publish complete ledger snapshots and never move the local revision backwards',async()=>{
  const commits=[]
  for(let wave=0;wave<4;wave++){
   let commit
   for(let i=0;i<3;i++){const n=wave*3+i;commit=await save({
    rateLimitEnabled:false,replenishRate:70+n,burstCapacity:140+n,requestedTokens:1+n%3,
    monitorWindowSeconds:60+n,emitIntervalSeconds:1+n%5})}
   commits.push(await converged(commit))
  }
  report.evidence.waves={commits,ledgerSize:ledger.size,distinctLocalInstances:lastRevision.size}
 })
 await check('Missing, corrupt, foreign-generation and same-version conflicting data are exposed without repair or publication',async()=>{
  const raw=await redis(['GET',key]),original=JSON.parse(raw),before=await status(),cases=[]
  for(const [kind,code,value] of [
   ['missing','CONFIG_STORAGE_MISSING',null],
   ['invalid','CONFIG_STORAGE_INVALID','{"monitorWindowSeconds":10}'],
   ['foreign-generation','CONFIG_SYNC_GENERATION_CHANGED',JSON.stringify({...original,version:randomUUID()+':1'})],
   ['same-version-different-values','CONFIG_SYNC_VERSION_CONTENT_MISMATCH',JSON.stringify({...original,replenishRate:999})]
  ]){
   try{
    if(value===null)await redis(['DEL',key]);else await redis(['SET',key,value])
    const failed=await until(kind,async()=>{const s=await status();return s.reasonCode===code?s:false})
    assert.equal(failed.adoptedVersion,before.adoptedVersion);assert.deepEqual(failed.adopted,before.adopted)
    assert.equal(await redis(['GET',key]),value)
    cases.push({kind,diagnostic:failed,unchangedStorage:true})
   }finally{await redis(['SET',key,raw])}
   await until('recovery after removing '+kind+' injection',async()=>{const s=await status();return s.status==='ok'?s:false})
  }
  report.evidence.invalidStorage=cases
 })
 await check('Restart restores the newest stored snapshot with a new instance identity and resumes automatic polling',async()=>{
  const before=await status();await stop(B)
  const commit=await save({monitorWindowSeconds:80,replenishRate:90})
  B=await start('B-restarted',proxy.port)
  const restored=await until('restarted sync ready',async()=>{const s=await status();return s.status==='ok'?s:false})
  assert.notEqual(restored.instanceId,before.instanceId);assert.equal(restored.adoptedVersion,commit.version)
  const subsequent=await converged(await save({monitorWindowSeconds:85}))
  report.evidence.restart={before,restored,subsequent}
 })
 await check('Shutdown cancels an active sync read and releases all B proxy and named Redis connections',async()=>{
  const last=await status(),held=proxy.holdNextRead()
  try{
   await reached(held.reached,'shutdown read boundary');await stop(B)
   await until('B connections closed',async()=>proxy.activeConnections===0)
   const clients=await redis(['CLIENT','LIST'])
   assert.ok(!clients.includes('zenith-runtime-sync:'+last.instanceId))
   report.evidence.shutdown={instanceId:last.instanceId,exitCode:B.child.exitCode,remainingProxyConnections:proxy.activeConnections,namedSyncConnectionRemoved:true}
  }finally{held.release()}
 })
 assert.equal(requests.filter(r=>r.instance.startsWith('B')&&r.method==='GET'&&r.path==='/settings/runtime').length,0)
 assert.ok(proxy.events.filter(e=>e.clientName?.startsWith('zenith-runtime-sync:')&&e.key===key).every(e=>e.mode==='read'))
 report.evidence.observation={requests:observationCount,forbiddenRedisBackedReadsOnB:0,
  allPublishedSnapshotsMatchedLedger:true,proxyPeakConnections:proxy.peakConnections}
 report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{
 proxy?.recover()
 for(const instance of processes){
  try{await stop(instance)}catch(error){
   report.cleanup[instance.label+'Error']=error.message
   if(instance.child.exitCode===null){const ended=new Promise(r=>instance.child.once('exit',r));instance.child.kill();await ended}
   report.passed=false;process.exitCode=1
  }
  instance.log.end()
 }
 if(proxy){await writeFile(join(out,'redis-frames.json'),JSON.stringify(proxy.events,null,2)+'\n');await proxy.close();report.cleanup.proxyClosed=true}
 upstream.closeAllConnections();await new Promise(r=>upstream.close(r));report.cleanup.upstreamClosed=true
 if(redisCreated){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
 await writeFile(join(out,'management-requests.json'),JSON.stringify(requests,null,2)+'\n')
 console.log('Sync verification report: '+join(out,'report.json'))
 if(!report.passed)console.error(report.failure)
}
