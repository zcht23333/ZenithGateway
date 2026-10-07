import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createServer,request as httpRequest} from 'node:http'
import {readFile,writeFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {environment,until,reached} from './route-publication-harness.mjs'
const e=await environment();let failure,A,B,current
const rule=(which=1,extra={})=>({id:'probe',path:'/probe/**',uri:e.uri(which),rewriteEnabled:false,circuitBreakerEnabled:false,...extra})
const publish=async(route,instance=A,version=current.version)=>{const r=await e.publish(instance,version,route);assert.equal(r.status,201,JSON.stringify(r));current=r.body;return r}
const proof=async(instance,version,which=1)=>e.adopted(instance,version,'V'+which+':')
const failures=code=>until('B diagnostic '+code,async()=>{const d=await e.diag(B);return d.reasonCode===code?d:false})
async function tool(mode,key,extra=[]){
 const args=['verification/route-storage.mjs',mode,'--port',String(e.report.isolation.redisPort),'--key',key,...extra]
 const child=spawn(process.execPath,args,{windowsHide:true,env:process.env});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b)
 const exitCode=await reached(new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)}),'maintenance '+mode,15000)
 const result={args,exitCode,stdout,stderr};return result
}
try{
 await e.check('Two simultaneous cold starts initialize one independent legal empty route snapshot',async()=>{
  ;[A,B]=await Promise.all([e.start('A'),e.start('B')]);const [a,b]=await Promise.all([e.local(A),e.local(B)])
  assert.equal(a.version,b.version);assert.deepEqual(a.routes,[]);assert.deepEqual(b.routes,[])
  const runtime=await e.api(A,'/settings/runtime/adopted');assert.notEqual(a.version.split(':')[0],runtime.version.split(':')[0])
  assert.equal((await e.hit(A)).status,404);current=await e.read(A);e.report.evidence.coldStart={a,b,runtimeVersion:runtime.version}
 })
 await e.check('Real requests at A and B prove V1 then V2 adoption within the healthy 3-second target',async()=>{
  const first=await publish(rule(1));const v1=await Promise.all([proof(A,current.version),proof(B,current.version)])
  const committedAt=new Date().toISOString(),start=performance.now();const second=await publish(rule(2));const v2=await Promise.all([proof(A,current.version,2),proof(B,current.version,2)])
  const propagatedMs=performance.now()-start;assert.ok(propagatedMs<3000);e.report.evidence.propagation={first,second,committedAt,propagatedMs,v1,v2}
 })
 await e.check('Missing expectedVersion is rejected and diagnostics are authenticated, local and no-store',async()=>{
  const missing=await e.request(A,'/settings/routes',{method:'POST',body:JSON.stringify(rule())});assert.equal(missing.status,428)
  const denied=await fetch(A.base+'/settings/routes/diagnostics');assert.equal(denied.status,401);assert.equal(denied.headers.get('cache-control'),'no-store')
  const local=await e.request(A,'/settings/routes/diagnostics');assert.equal(local.headers['cache-control'],'no-store');e.report.evidence.protocol={missing,diagnostic:local.body}
 })
 await e.check('Same-version concurrent modifications have exactly one winner and one explicit conflict',async()=>{
  const expected=current.version;const results=await Promise.all([e.publish(A,expected,rule(1)),e.publish(B,expected,rule(2))]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);current=results.find(r=>r.status===201).body
  const which=current.routes.find(r=>r.id==='probe').uri===e.uri(1)?1:2;const actual=await Promise.all([proof(A,current.version,which),proof(B,current.version,which)]);e.report.evidence.concurrent={expected,results,actual}
 })
 await e.check('Edit versus delete and deletion followed by same-ID recreation reject stale requests',async()=>{
  const expected=current.version;const results=await Promise.all([e.publish(A,expected,rule(2)),e.remove(B,expected,'probe')]);assert.equal(results.filter(r=>r.status<300).length,1);assert.equal(results.filter(r=>r.status===409).length,1)
  current=results.find(r=>r.status<300).body
  if(current.routes.length){const deleted=await e.remove(A,current.version,'probe');assert.equal(deleted.status,200);current=deleted.body}
  await until('deleted on both real matchers',async()=>{const [a,b]=await Promise.all([e.hit(A),e.hit(B)]);return a.status===404&&b.status===404})
  const recreated=await publish(rule(1));const lateEdit=await e.publish(B,expected,rule(2)),lateDelete=await e.remove(A,expected,'probe');assert.equal(lateEdit.status,409);assert.equal(lateDelete.status,409)
  const actual=await Promise.all([proof(A,current.version),proof(B,current.version)]);e.report.evidence.recreate={expected,results,recreated,lateEdit,lateDelete,actual}
 })
 await e.check('An already matched in-flight request finishes on its original route after deletion',async()=>{
  const oldVersion=current.version,path='/probe/in-flight-'+randomUUID(),hold=e.hold(path),pending=e.hit(B,path)
  await reached(hold.entered,'upstream has already received the old route');const deletion=await e.remove(A,current.version,'probe');assert.equal(deletion.status,200);current=deletion.body
  await until('new B requests no longer match',async()=>(await e.hit(B)).status===404);hold.release();const completed=await pending
  assert.equal(completed.status,200);assert.equal(completed.version,oldVersion);assert.ok(completed.body.startsWith('V1:'));e.report.evidence.inFlight={oldVersion,deletion,completed};await publish(rule(1));await proof(B,current.version)
 })
 await e.check('A held old sync reply cannot overwrite a newer route already used by B',async()=>{
  await publish(rule(2));const oldVersion=current.version,gate=e.proxyB.holdNextSync();const captured=await reached(gate.reached,'old sync response')
  const oldReply=JSON.parse(captured.reply);assert.equal(JSON.parse(oldReply.snapshot).version,oldVersion)
  const newer=await publish(rule(1),B,oldVersion);const beforeRelease=await proof(B,current.version),beforeChecks=(await e.diag(B)).checks;gate.release()
  await until('old response processed',async()=>(await e.diag(B)).checks>beforeChecks);assert.ok(captured.releasedAt);assert.notEqual(captured.closedBeforeRelease,true)
  const afterRelease=await proof(B,current.version);assert.equal((await e.local(B)).version,current.version);e.report.evidence.oldReply={captured,newer,beforeRelease,afterRelease}
 })
 await e.check('Continuous full publications remain monotonic and match actual upstream responses',async()=>{
  const ledger=new Map([[current.version,current.routes[0].uri]]),observations=[],last={A:0,B:0}
  for(let n=0;n<8;n++){
   await publish(rule(n%2+1));ledger.set(current.version,current.routes[0].uri)
   for(const [label,instance] of [['A',A],['B',B]]){const r=await e.hit(instance);assert.equal(r.status,200);const revision=Number(r.version.split(':')[1]);assert.ok(revision>=last[label]);last[label]=revision;assert.ok(ledger.has(r.version));assert.equal(r.body.split(':')[0],ledger.get(r.version)===e.uri(1)?'V1':'V2');observations.push(r)}
  }
  await proof(B,current.version,2);e.report.evidence.continuous={ledger:Object.fromEntries(ledger),observations}
 })
 await e.check('Only B loses Redis: retained forwarding survives, A continues publishing, recovery catches latest',async()=>{
  const retained=await e.hit(B);e.proxyB.cut();const failed=await until('B sync fails',async()=>{const d=await e.diag(B);return d.lastCheckOutcome==='failed'?d:false})
  for(const which of [1,2,1])await publish(rule(which))
  const whileOffline=await e.hit(B);assert.equal(whileOffline.version,retained.version);assert.equal(whileOffline.body,retained.body)
  const stale=await until('B confirmation becomes stale',async()=>{const d=await e.diag(B);return d.stale?d:false},7000)
  const recoveryAt=new Date().toISOString(),start=performance.now();e.proxyB.recover();const recovered=await proof(B,current.version);const recoveredMs=performance.now()-start;assert.ok(recoveredMs<3000)
  e.report.evidence.partition={retained,failed,whileOffline,stale,recoveryAt,recovered,recoveredMs}
 })
 await e.check('Invalid authoritative data is not an empty publication and keeps the last forwarding snapshot',async()=>{
  const original=await e.redis(['GET',e.key]),retained=await e.hit(B);await e.redis(['SET',e.key,'false']);const failure=await failures('ROUTE_STORAGE_INVALID')
  const actual=await e.hit(B),read=await e.request(A,'/settings/routes');assert.equal(actual.version,retained.version);assert.equal(read.status,503);assert.equal(await e.redis(['GET',e.key]),'false')
  await e.redis(['SET',e.key,original]);const recovered=await until('B recovered after invalid data',async()=>{const d=await e.diag(B);return d.status==='ok'?d:false});e.report.evidence.invalid={failure,actual,read,recovered}
 })
 await e.check('Epoch changes retain the old route; a normal recovery restores synchronization',async()=>{
  const raw=await e.redis(['GET',e.key]),guard=await e.redis(['GET',e.key+':guard']),foreign={...JSON.parse(raw),version:randomUUID()+':1'}
  await e.redis(['MSET',e.key,JSON.stringify(foreign),e.key+':guard',foreign.version.slice(0,36)]);const issue=await failures('ROUTE_GENERATION_CHANGED');const actual=await e.hit(B);assert.equal(actual.version,current.version)
  await e.redis(['MSET',e.key,raw,e.key+':guard',guard]);await until('epoch recovery',async()=>(await e.diag(B)).status==='ok');e.report.evidence.generation={foreignVersion:foreign.version,issue,actual}
 })
 await e.check('Authority loss does not recreate empty routes, including a failed restart; restoration resumes latest',async()=>{
  const raw=await e.redis(['GET',e.key]);await e.redis(['DEL',e.key]);const issue=await failures('ROUTE_STORAGE_MISSING');const actual=await e.hit(B);assert.equal(actual.version,current.version)
  assert.equal(await e.stop(B),0);const failedRestart=await e.start('B-missing',{expectReady:false});assert.equal(await e.redis(['EXISTS',e.key]),0)
  await e.redis(['SET',e.key,raw]);B=await e.start('B-recovered');const recovered=await proof(B,current.version);e.report.evidence.missing={issue,actual,failedRestart:{base:failedRestart.base,exitCode:failedRestart.child.exitCode},recovered}
 })
 await e.check('A real missing RewritePath factory causes whole-build failure and retains the prior plain route',async()=>{
  assert.equal(await e.stop(B),0);B=await e.start('B-no-rewrite',{disableRewrite:true});const retained=await proof(B,current.version)
  const committed=await publish(rule(2,{rewriteEnabled:true}));const failure=await failures('ROUTE_BUILD_FAILED');const actual=await e.hit(B);assert.equal(actual.version,retained.response.version);assert.ok(actual.body.startsWith('V1:'))
  const stored=await e.read(B);assert.equal(stored.adoption,'pending');assert.equal(stored.version,current.version);assert.equal((await e.hit(B)).version,retained.response.version,'management GET does not trigger adoption')
  const rejected=await e.publish(B,current.version,rule(1,{rewriteEnabled:true}));assert.equal(rejected.status,422);assert.equal(rejected.body.outcome,'not-written')
  await publish(rule(2));const recovered=await proof(B,current.version,2);e.report.evidence.buildFailure={committed,failure,actual,stored,rejected,recovered}
 })
 await e.check('Redis executed publication but acknowledgement was lost: unknown response, one write and eventual adoption',async()=>{
  const start=e.proxyA.events.length;e.proxyA.dropNextWriteReply();const result=await e.publish(A,current.version,rule(1));assert.equal(result.status,503);assert.equal(result.body.outcome,'unknown')
  const frames=e.proxyA.events.slice(start).filter(x=>x.route&&x.mode==='write');assert.equal(frames.length,1);assert.equal(JSON.parse(frames[0].reply).status,'ok')
  e.proxyA.release();current=await e.read(A);const actual=await Promise.all([proof(A,current.version),proof(B,current.version)]);e.report.evidence.redisLostReply={result,frames,readNow:current,actual,note:'Only the controlled Redis frame proves execution of the original test request; current GET does not offer operation attribution.'}
 })
 await e.check('An HTTP response lost after commit is not retried automatically',async()=>{
  let captured;const proxy=createServer((req,res)=>{const target=httpRequest(A.base+req.url,{method:req.method,headers:req.headers},r=>{let body='';r.on('data',b=>body+=b);r.on('end',()=>{captured={status:r.statusCode,body:JSON.parse(body)};res.destroy()})});req.pipe(target);target.on('error',()=>res.destroy())})
  await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const start=e.proxyA.events.length
  try{await assert.rejects(()=>fetch('http://127.0.0.1:'+proxy.address().port+'/settings/routes',{method:'POST',headers:{Authorization:'Bearer '+e.token,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:current.version,route:rule(2)}),signal:AbortSignal.timeout(5000)}))}
  finally{proxy.closeAllConnections();await new Promise(r=>proxy.close(r))}
  assert.equal(captured.status,201);assert.equal(e.proxyA.events.slice(start).filter(x=>x.route&&x.mode==='write').length,1);current=await e.read(A);const actual=await proof(B,current.version,2);e.report.evidence.httpLostReply={captured,actual}
 })
 await e.check('Proxy traffic and local diagnostics add zero per-request route configuration reads',async()=>{
  const gate=e.proxyB.holdNextSync();await reached(gate.reached,'separate known background read');const index=e.proxyB.events.length
  for(let n=0;n<12;n++){const r=await e.hit(B);assert.equal(r.status,200);await e.local(B);await e.diag(B)}
  const events=e.proxyB.events.slice(index).filter(x=>x.route);assert.equal(events.filter(x=>!x.sync).length,0);gate.release();e.report.evidence.hotPath={proxyRequests:12,localDiagnosticReads:24,additionalRouteConfigQueries:0,backgroundReads:events.length,events}
 })
 await e.check('Slow Redis does not stack sync tasks; physical I/O and management admission remain bounded',async()=>{
  e.proxyB.holdReads=true;await until('held sync read',()=>e.proxyB.held.some(x=>x.sync))
  const controllers=Array.from({length:24},()=>new AbortController()),jobs=controllers.map(c=>e.request(B,'/settings/routes',{signal:c.signal}).catch(error=>({aborted:error.name})))
  const saturated=await until('bounded management queue',async()=>{const d=await e.diag(B);return d.managementQueueSize===16?d:false})
  assert.ok(saturated.resources.sync.commandsInFlight<=1&&saturated.resources.management.commandsInFlight<=1);assert.ok(e.proxyB.peakRouteConnections<=2)
  const at=performance.now();const responsive=await e.diag(B);assert.ok(performance.now()-at<500,'Local diagnostic must not wait for Redis lock')
  for(const c of controllers)c.abort();const rows=await Promise.all(jobs);await until('cancelled queue removed',async()=>(await e.diag(B)).managementQueueSize===0)
  await until('held sync connection closed at deadline',()=>e.proxyB.events.some(x=>x.sync&&x.closedBeforeRelease));e.proxyB.release();await until('sync healthy after slow Redis',async()=>(await e.diag(B)).status==='ok')
  e.report.evidence.bounds={saturated,responsive,rows,peakRouteConnections:e.proxyB.peakRouteConnections}
 })
 await e.check('Legacy migration validates every entry, backs up, converts atomically, verifies and supports offline format rollback',async()=>{
  const key=e.namespace+':legacy',valid={...rule(1),rewriteRegex:null,rewriteReplacement:null,circuitBreakerName:'cb-probe',fallbackPath:'/fallback/default'}
  await e.redis(['HSET',key,'probe',JSON.stringify(valid),'bad','false']);const invalid=await tool('check',key);assert.notEqual(invalid.exitCode,0);assert.equal(await e.redis(['HGET',key,'bad']),'false');await e.redis(['HDEL',key,'bad'])
  const checked=await tool('check',key);assert.equal(checked.exitCode,0,checked.stderr)
  const migrated=await tool('migrate',key,['--maintenance','--backup',join(e.out,'legacy-before.json')]);assert.equal(migrated.exitCode,0,migrated.stderr);const verified=await tool('verify',key);assert.equal(verified.exitCode,0,verified.stderr)
  const M=await e.start('M-migrated',{routeKey:key});const first=await e.hit(M);assert.ok(first.body.startsWith('V1:'));assert.equal(await e.stop(M),0)
  const rollback=await tool('rollback',key,['--maintenance','--backup',join(e.out,'versioned-before.json')]);assert.equal(rollback.exitCode,0,rollback.stderr);assert.equal(await e.redis(['TYPE',key]),'hash')
  let legacyProof=null;if(process.env.ROUTE_BASELINE_JAR){const old=await e.start('M-legacy',{routeKey:key,artifact:process.env.ROUTE_BASELINE_JAR});legacyProof=await e.hit(old);assert.ok(legacyProof.body.startsWith('V1:'));assert.equal(await e.stop(old),0)}
  const restored=await tool('migrate',key,['--maintenance','--backup',join(e.out,'legacy-again.json')]);assert.equal(restored.exitCode,0,restored.stderr)
  e.report.evidence.migration={invalid,checked,migrated,verified,first,rollback,legacyProof,restored}
 })
 await e.check('Graceful shutdown releases route sync workers, connections and queued work',async()=>{
  e.proxyB.holdReads=true;await until('sync request captured before close',()=>e.proxyB.held.some(x=>x.sync));const diagnostic=await e.diag(B),exitCode=await e.stop(B);assert.equal(exitCode,0)
  const clients=await e.redis(['CLIENT','LIST']);assert.ok(!clients.includes('zenith-route-sync:'+diagnostic.instanceId));assert.ok(!clients.includes('zenith-route-management:'+diagnostic.instanceId))
  const log=await readFile(join(e.out,B.label+'.log'),'utf8');assert.match(log,/Route publication stopped; syncTerminated=true, managementTerminated=true, queued=0/);e.proxyB.release();e.report.evidence.shutdown={diagnostic,exitCode,noNamedClients:true}
 })
}catch(error){failure=error}finally{await e.finish(failure)}
