import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import {withRouteVersion} from '../benchmarks/route-client.mjs'
// Real HTTP gateway + controlled upstream + owned Redis. No development ports or data.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer,request as httpRequest} from 'node:http'
import {createServer as httpsServer} from 'node:https'
import {createServer as tcpServer} from 'node:net'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {randomUUID,createHash} from 'node:crypto'
import {join,resolve} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
const id=randomUUID(),name='zenith-proxy-'+id.slice(0,8),prefix='zg:proxy:'+id,token=randomUUID()
const out=resolve(process.env.PROXY_RESILIENCE_OUTPUT||'.dev/proxy-resilience/live-'+id.slice(0,8));await mkdir(out,{recursive:true})
const jar=process.env.PROXY_RESILIENCE_JAR||'backend/target/zg-1.0.0.jar'
const limiterHandoff=process.env.PROXY_RESILIENCE_LIMITER_HANDOFF==='true'
assert([undefined,'true','false'].includes(process.env.PROXY_RESILIENCE_LIMITER_HANDOFF),'Invalid PROXY_RESILIENCE_LIMITER_HANDOFF')
const report={startedAt:new Date().toISOString(),isolated:true,jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),checks:[],requests:[],cleanup:{},passed:false}
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const docker=args=>execFileSync('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const behaviors=new Map(),arrivals=[],connections=new Set();let redisPort,created=false,child,base,log
const serveUpstream=async(req,res)=>{
 const key=new URL(req.url,'http://local').pathname.slice(1),spec=behaviors.get(key)||{kind:'echo',status:200},row={key,method:req.method,url:req.url,receivedAt:new Date().toISOString(),bytes:0}
 arrivals.push(row);req.on('data',b=>row.bytes+=b.length);req.on('end',()=>{row.processedAt=new Date().toISOString();if(spec.kind==='lost-write'){row.effectApplied=true;req.socket.destroy()}})
 let timer;res.on('close',()=>{clearInterval(timer);row.closedAt=new Date().toISOString()})
 const finish=()=>{if(!res.destroyed){res.writeHead(spec.status||200,{'Content-Type':'text/plain','X-Upstream-Proof':'preserved'});res.end(spec.body||req.url)}}
 row.finish=finish
 if(spec.kind==='reset-before'){req.resume();req.once('end',()=>req.socket.resetAndDestroy());return}
 if(spec.kind==='reset-body'){
  row.reset=()=>req.socket.resetAndDestroy()
  res.writeHead(200,{'Content-Type':'text/plain','Content-Length':'4096'});res.flushHeaders();res.write('prefix-before-reset');return
 }
 if(spec.kind==='hold'||spec.kind==='lost-write')return
 if(spec.kind==='disconnect'){req.resume();req.once('end',()=>req.socket.destroy());return}
 if(spec.kind==='delayed'){timer=setTimeout(finish,spec.delayMs);return}
 if(spec.kind==='stall'||spec.kind==='trickle'){
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();res.write('data: prefix\n\n')
  if(spec.kind==='trickle')timer=setInterval(()=>res.write('data: pulse\n\n'),30)
  return
 }
 finish()
}
const upstream=createServer(serveUpstream)
// Private, short-lived TLS identity; the gateway trusts this certificate only in this test process.
const keytool=join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'keytool.exe':'keytool')
const pfx=join(out,'upstream.p12'),certificate=join(out,'upstream.pem'),password=randomUUID()
execFileSync(keytool,['-genkeypair','-alias','upstream','-keyalg','RSA','-keysize','2048','-storetype','PKCS12',
 '-keystore',pfx,'-storepass',password,'-keypass',password,'-dname','CN=localhost','-ext','SAN=IP:127.0.0.1,DNS:localhost','-validity','2'],{windowsHide:true,stdio:'pipe',timeout:15000})
execFileSync(keytool,['-exportcert','-rfc','-alias','upstream','-keystore',pfx,'-storepass',password,'-file',certificate],{windowsHide:true,stdio:'pipe',timeout:15000})
const secureUpstream=httpsServer({pfx:await readFile(pfx),passphrase:password},serveUpstream)
secureUpstream.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))})
await new Promise(r=>secureUpstream.listen(0,'127.0.0.1',r))
upstream.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const blackhole=tcpServer(socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.resume()})
await new Promise(r=>blackhole.listen(0,'127.0.0.1',r))
async function freePort(){const s=tcpServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function until(label,fn,timeout=6000){const end=performance.now()+timeout;do{const value=await fn();if(value)return value;await delay(25)}while(performance.now()<end);throw new Error('Bounded wait: '+label)}
async function api(path,options={}){const r=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(8000)});const text=await r.text();assert.ok(r.ok,path+' '+r.status+' '+text);return text?JSON.parse(text):null}
const diagnostic=()=>api('/settings/proxy/diagnostics')
const breaker=async name=>(await diagnostic()).breakers.find(b=>b.name===name)
const snapshot=()=>api('/dashboard/snapshot')
async function runtime(patch){const c=await api('/settings/runtime');return api('/settings/runtime',{method:'PUT',body:JSON.stringify({rateLimitEnabled:c.rateLimitEnabled,replenishRate:c.replenishRate,burstCapacity:c.burstCapacity,requestedTokens:c.requestedTokens,monitorWindowSeconds:c.monitorWindowSeconds,emitIntervalSeconds:c.emitIntervalSeconds,...patch,expectedVersion:c.version,operationId:randomUUID()})})}
async function route(id,enabled=true,breakerName,uri='http://127.0.0.1:'+upstream.address().port){
 const body={id,path:'/'+id+'/**',uri,rewriteEnabled:true,circuitBreakerEnabled:enabled,...(breakerName?{circuitBreakerName:breakerName}:{})}
 await api('/settings/routes',await withRouteVersion(()=>api('/settings/routes'),{method:'POST',body:JSON.stringify(body)}))
 // A normal request confirms the route cache, rather than guessing a refresh delay.
 if([upstream.address().port,secureUpstream.address().port].includes(Number(new URL(uri).port)))await until('route '+id,async()=>{const r=await fetch(base+'/'+id+'/ready-'+id);await r.text();return r.status===200})
 return id
}
function launch(route,spec={kind:'echo'},options={}){
 const key=(options.keyPrefix||'case-')+randomUUID(),path='/'+route+'/'+key;behaviors.set(key,spec)
 const started=performance.now();let req,res,settled=false,resolvePromise,timer,resolveChunk;const firstChunk=new Promise(r=>resolveChunk=r)
 const promise=new Promise(resolve=>resolvePromise=resolve),entry={key,path,method:options.method||'GET',startedAt:new Date().toISOString(),status:0,body:'',termination:null}
 function finish(termination){if(settled)return;settled=true;clearTimeout(timer);entry.termination=termination;entry.elapsedMs=performance.now()-started;resolvePromise(entry)}
 req=httpRequest(base+path,{method:entry.method,headers:options.headers||{}},response=>{
  res=response;entry.status=res.statusCode;entry.headers=res.headers
  res.on('data',b=>{entry.body+=b.toString();resolveChunk()});res.on('end',()=>finish('complete'));res.on('aborted',()=>finish('response-aborted'));res.on('error',e=>finish(e.code||e.name))
 });req.on('error',e=>finish(e.code||e.name));req.end(options.body||'')
 timer=setTimeout(()=>{req.destroy();finish('verification-deadline')},10000)
 return {key,path,promise,firstChunk:Promise.race([firstChunk,promise]),abort:(reset=false)=>{if(reset)req.socket?.resetAndDestroy();else req.destroy();res?.destroy();finish(reset?'client-reset':'client-abort')}}
}
async function audit(path){return until('one final audit '+path,async()=>{
 const all=await redisCommand(redisPort,['LRANGE',prefix+':audit',0,-1]);const rows=all.map(x=>JSON.parse(x)).filter(r=>r.path===path)
 assert.ok(rows.length<=1,'Duplicate final audit '+path);return rows[0]
 })}
async function evidence(job){const result=await job.promise;assert.notEqual(result.termination,'verification-deadline');const final=await audit(job.path)
 const received=arrivals.filter(a=>a.key===job.key).map(({finish,reset,...row})=>row),diag=await diagnostic()
 const item={...result,upstreamReceived:received.length,upstream:received,final,breakers:diag.breakers,resources:{active:diag.activeProxyRequests,pool:diag.pool}};report.requests.push(item);return item}
async function one(route,spec,options){return evidence(launch(route,spec,options))}
async function check(label,run){const before=(await snapshot()).completedTotal,start=performance.now(),offset=report.requests.length
 await run();const releaseStarted=performance.now();const released=await until('all active work released',async()=>{const d=await diagnostic();return d.activeProxyRequests===0 && d.pool['active.connections']===0 && d.pool['pending.connections']===0 ? d : null})
 const after=(await snapshot()).completedTotal;report.checks.push({label,elapsedMs:performance.now()-start,completedBefore:before,completedAfter:after,recordedRequests:report.requests.length-offset,releaseObservedAfterMs:performance.now()-releaseStarted,finalDiagnostics:released})
 assert.equal(after-before,report.requests.length-offset,'one final completion per entry: '+label);console.log('PASS '+label)
}
async function open(route,name='cb-'+route){
 const results=[];for(let n=0;n<6;n++){if((await breaker(name))?.state==='OPEN')break;results.push(await one(route,{kind:'echo',status:500,body:'business-failed'}))}
 assert.equal((await breaker(name)).state,'OPEN');assert.ok(results.every(r=>r.status===500&&r.body==='business-failed'));return results
}
async function eligible(name){await until('OPEN wait elapsed '+name,async()=>{const b=await breaker(name);return b.state==='OPEN'&&b.probeEligibleInMs===0})}
async function active(job){return until('controlled upstream arrival '+job.key,()=>arrivals.find(a=>a.key===job.key))}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);created=true
 redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));const port=await freePort();base='http://127.0.0.1:'+port;report.origin=base;report.isolation={redisContainer:name,redisPort,redisPrefix:prefix,upstreamPort:upstream.address().port,httpsUpstreamPort:secureUpstream.address().port,tlsBlackholePort:blackhole.address().port}
 const args=['-Xms128m','-Xmx384m','-XX:ActiveProcessorCount=4','-jar',jar,'--server.address=127.0.0.1','--server.port='+port,'--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,
 '--zenith.runtime.redis-key='+prefix+':runtime','--zenith.route.redis-key='+prefix+':routes','--zenith.audit.redis-key='+prefix+':audit','--zenith.rate-limit.enabled='+limiterHandoff,'--zenith.monitor.window-seconds=120',
 ...(limiterHandoff?['--zenith.rate-limit.replenish-rate=10000','--zenith.rate-limit.burst-capacity=10000','--zenith.limiter.namespace='+prefix+':limiter','--zenith.limiter.result-handoff-enabled=true']:[]),
 '--spring.cloud.gateway.server.webflux.httpclient.ssl.trusted-x509-certificates[0]='+certificate,
 '--zenith.proxy.resilience.connect-timeout-ms=150','--zenith.proxy.resilience.headers-timeout-ms=500','--zenith.proxy.resilience.read-idle-timeout-ms=700','--zenith.proxy.resilience.total-timeout-ms=1600',
 '--zenith.proxy.resilience.acquire-timeout-ms=250','--zenith.proxy.resilience.max-connections=4','--zenith.proxy.resilience.max-pending-acquires=2',
 '--zenith.proxy.resilience.sliding-window-size=4','--zenith.proxy.resilience.minimum-calls=4','--zenith.proxy.resilience.open-wait-ms=1000','--zenith.proxy.resilience.half-open-calls=2',
 '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,metrics,prometheus,shutdown']
 log=createWriteStream(join(out,'gateway.log'));child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),args,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token,REDIS_PASSWORD:''}});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 await until('gateway ready',async()=>{assert.equal(child.exitCode,null,'gateway exited');try{return (await fetch(base+'/actuator/health/readiness')).ok}catch{return false}},60000)
 report.policy=(await diagnostic()).policy
 report.initialLimiter=await api('/settings/rate-limit/diagnostics')
 if(limiterHandoff){assert.equal(report.initialLimiter.resultHandoffEnabled,true);assert.equal(report.initialLimiter.adopted.rateLimitEnabled,true)}
 for(const r of ['healthy','fault','isolated','probes','inflight','cancel','business','rst-before','rst-body','rst-opening'])await route(r)
 await route('plain',false);await route('shared-a',true,'explicit-shared');await route('shared-b',true,'explicit-shared')
 const refused=await freePort();await route('refused',false,undefined,'http://127.0.0.1:'+refused)
 await route('tls-hold',false,undefined,'https://127.0.0.1:'+blackhole.address().port)
 const schemeRoutes=[]
 for(const [i,scheme] of ['http','HTTP','HtTp','https','HTTPS','HtTpS'].entries()){
  const uri=scheme+'://127.0.0.1:'+(scheme.toLowerCase()==='https'?secureUpstream:upstream).address().port+'/MiXeD/Target'
  const plain=await route('scheme-plain-'+i,false,undefined,uri),protectedRoute=await route('scheme-breaker-'+i,true,undefined,uri)
  const persisted=JSON.parse(await redisCommand(redisPort,['GET',prefix+':routes'])).routes.find(r=>r.id===plain);assert.equal(persisted.uri,uri)
  schemeRoutes.push({scheme,uri,plain,protectedRoute})
 }
 report.schemeRoutes=schemeRoutes
 await until('audit warmup drained',async()=>(await api('/monitor/audit/status')).pending===0)
 await check('Normal forwarding, rewrite, business errors and redirects preserve the upstream response',async()=>{
  for(const status of [200,400,500,302]){const r=await one('business',{kind:'echo',status,body:'original-'+status});assert.equal(r.status,status);assert.equal(r.body,'original-'+status);assert.equal(r.headers['x-upstream-proof'],'preserved');assert.equal(r.upstreamReceived,1);assert.equal(r.upstream[0].url,'/'+r.key)}
  for(const status of [204,304]){const r=await one('plain',{kind:'echo',status});assert.equal(r.status,status);assert.equal(r.body,'');assert.equal(r.final.outcome,'completed');assert.equal(r.final.reason,'none')}
  const head=await one('plain',{kind:'echo'},{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.body,'');assert.equal(head.final.outcome,'completed')
  assert.equal((await breaker('cb-business')).state,'CLOSED')
 })
 await check('Connection refusal and pre-header disconnect are bounded 502 with a single final result',async()=>{
  const refused=await one('refused');assert.equal(refused.status,502);assert.equal(refused.final.reason,'upstream_connect_error');assert.equal(refused.upstreamReceived,0)
  const closed=await one('plain',{kind:'disconnect'});assert.equal(closed.status,502);assert.equal(closed.final.reason,'upstream_disconnect');assert.equal(closed.upstreamReceived,1)
 })
 await check('Real upstream TCP RST before headers is a single 502 and a breaker failure',async()=>{
  const before=await breaker('cb-rst-before'),r=await one('rst-before',{kind:'reset-before'},{method:'POST',body:'side-effect-may-have-run'})
  assert.equal(r.status,502);assert.equal(r.final.reason,'upstream_disconnect');assert.equal(r.upstreamReceived,1);assert.ok(r.elapsedMs<1600)
  assert.equal((await breaker('cb-rst-before')).failedCalls,before.failedCalls+1)
 })
 await check('TCP RST after observed bytes aborts the body without replacing 200 or appending JSON',async()=>{
  const before=await breaker('cb-rst-body'),job=launch('rst-body',{kind:'reset-body'}),row=await active(job)
  await job.firstChunk;row.reset();const r=await evidence(job)
  assert.equal(r.status,200);assert.equal(r.termination,'response-aborted');assert.equal(r.body,'prefix-before-reset');assert.equal(r.final.reason,'upstream_disconnect');assert.equal(r.final.outcome,'error');assert.equal(r.upstreamReceived,1)
  assert.equal((await breaker('cb-rst-body')).failedCalls,before.failedCalls+1)
 })
 await check('Repeated real TCP resets open the breaker and subsequent admission never reaches upstream',async()=>{
  for(let n=0;n<3;n++){const r=await one('rst-opening',{kind:'reset-before'},{method:'POST',body:'one-write'});assert.equal(r.status,502);assert.equal(r.final.reason,'upstream_disconnect');assert.equal(r.upstreamReceived,1)}
  const state=await breaker('cb-rst-opening');assert.equal(state.state,'OPEN');assert.equal(state.failedCalls,3);assert.equal(state.bufferedCalls,4)
  const r=await one('rst-opening');assert.equal(r.status,503);assert.equal(r.final.reason,'circuit_open');assert.equal(r.upstreamReceived,0)
 })
 for(const {scheme,plain,protectedRoute} of schemeRoutes)await check('Scheme '+scheme+' preserves path case, total deadline, cancellation and circuit admission',async()=>{
  const job=launch(plain,{kind:'trickle'},{keyPrefix:'CaseSensitive-'});await job.firstChunk
  assert.equal((await diagnostic()).activeProxyRequests,1)
  const timed=await evidence(job);assert.equal(timed.status,200);assert.equal(timed.termination,'response-aborted');assert.equal(timed.final.reason,'proxy_total_timeout');assert.equal(timed.final.outcome,'error');assert.ok(timed.elapsedMs>=1400&&timed.elapsedMs<2400);assert.equal(timed.upstream[0].url,'/'+timed.key)
  const name='cb-'+protectedRoute,before=await breaker(name),cancel=launch(protectedRoute,{kind:'stall'}),row=await active(cancel)
  await cancel.firstChunk;cancel.abort();const cancelled=await evidence(cancel)
  assert.equal(cancelled.final.outcome,'cancelled');assert.equal(cancelled.final.reason,'client_cancelled');await until('scheme cancelled upstream',()=>row.closedAt);assert.equal((await breaker(name)).bufferedCalls,before.bufferedCalls)
  for(let n=0;n<3;n++){const r=await one(protectedRoute,{kind:'echo',status:500,body:'business-error'});assert.equal(r.status,500);assert.equal(r.body,'business-error');assert.equal(r.final.reason,'upstream_5xx')}
  assert.equal((await breaker(name)).state,'OPEN');assert.equal((await breaker(name)).failedCalls,3)
  const blocked=await one(protectedRoute);assert.equal(blocked.status,503);assert.equal(blocked.upstreamReceived,0)
 })
 await check('Response-header deadline applies with and without breakers; TLS setup is also bounded',async()=>{
  const delayed=await one('plain',{kind:'delayed',delayMs:100});assert.equal(delayed.status,200)
  for(const route of ['plain','fault','tls-hold']){const r=await one(route,{kind:'hold'});assert.equal(r.status,504);assert.equal(r.final.reason,route==='tls-hold'?'upstream_tls_timeout':'upstream_headers_timeout');assert.ok(r.elapsedMs>=(route==='tls-hold'?120:400)&&r.elapsedMs<1300);if(route!=='tls-hold')assert.equal(r.upstreamReceived,1)}
 })
 await check('Partial body stall aborts the original response; no replacement status or appended JSON',async()=>{
  for(const route of ['plain','fault']){const r=await one(route,{kind:'stall'});assert.equal(r.status,200);assert.notEqual(r.termination,'complete');assert.equal(r.body,'data: prefix\n\n');assert.equal(r.final.reason,'upstream_read_idle');assert.equal(r.final.outcome,'error');assert.ok(r.elapsedMs>=600&&r.elapsedMs<1400)}
 })
 await check('Continuous body progress cannot bypass total processing budget',async()=>{
  for(const route of ['plain','fault']){const r=await one(route,{kind:'trickle'});assert.equal(r.status,200);assert.notEqual(r.termination,'complete');assert.match(r.body,/pulse/);assert.ok(!r.body.includes('Proxy request'));assert.equal(r.final.reason,'proxy_total_timeout');assert.ok(r.elapsedMs>=1400&&r.elapsedMs<2400)}
 })
 await check('Persistent failures open only their breaker; open admission never contacts upstream',async()=>{
  await open('isolated')
  const [blocked,normal]=await Promise.all([one('isolated',{kind:'echo'}),one('healthy',{kind:'echo'})]);assert.equal(blocked.status,503);assert.equal(blocked.final.reason,'circuit_open');assert.equal(blocked.upstreamReceived,0);assert.equal(normal.status,200);assert.equal((await breaker('cb-healthy')).state,'CLOSED')
 })
 await check('Half-open probes have two permits; successful probes close, failed probes reopen',async()=>{
  await open('probes');await eligible('cb-probes')
  let a=launch('probes',{kind:'hold'}),b=launch('probes',{kind:'hold'});let [ra,rb]=await Promise.all([active(a),active(b)])
  const halfOpen=await diagnostic();assert.equal((await breaker('cb-probes')).state,'HALF_OPEN');report.halfOpenAdmission=halfOpen;const blocked=await one('probes');assert.equal(blocked.status,503);assert.equal(blocked.upstreamReceived,0)
  ra.finish();rb.finish();await Promise.all([evidence(a),evidence(b)]);assert.equal((await breaker('cb-probes')).state,'CLOSED')
  await open('probes');await eligible('cb-probes')
  a=launch('probes',{kind:'hold',status:500});b=launch('probes',{kind:'hold'});[ra,rb]=await Promise.all([active(a),active(b)]);assert.equal((await breaker('cb-probes')).state,'HALF_OPEN')
  ra.finish();rb.finish();await Promise.all([evidence(a),evidence(b)]);assert.equal((await breaker('cb-probes')).state,'OPEN')
 })
 await check('Already admitted requests finish independently after the breaker opens',async()=>{
  const job=launch('inflight',{kind:'hold'}),row=await active(job);await open('inflight');assert.equal((await breaker('cb-inflight')).state,'OPEN');row.finish();const done=await evidence(job);assert.equal(done.status,200);assert.equal(done.final.outcome,'completed');assert.equal((await breaker('cb-inflight')).state,'OPEN')
 })
 await check('Explicit same breaker names share local state',async()=>{await open('shared-a','explicit-shared');const b=await one('shared-b');assert.equal(b.status,503);assert.equal(b.upstreamReceived,0)})
 await check('Write processed but response lost is sent once, without automatic retry',async()=>{
  const r=await one('plain',{kind:'lost-write'},{method:'POST',body:'{"amount":7}',headers:{'Content-Type':'application/json'}});assert.equal(r.status,502);assert.equal(r.upstreamReceived,1);assert.equal(r.upstream[0].effectApplied,true);assert.ok(r.upstream[0].bytes>0)
 })
 await check('Client cancellation propagates, releases work, and is neither success nor breaker failure',async()=>{
  for(const reset of [false,true]){
  const before=await breaker('cb-cancel');const job=launch('cancel',{kind:'hold'}),row=await active(job);job.abort(reset);const r=await evidence(job);assert.equal(r.final.outcome,'cancelled');assert.equal(r.final.reason,'client_cancelled');assert.equal(r.final.statusCode,0)
  await until('upstream cancellation close',()=>row.closedAt);const after=await breaker('cb-cancel');assert.equal(after.bufferedCalls,before.bufferedCalls)
  }
 })
 await check('Cancellation after response headers preserves the committed status and cancels the body',async()=>{
  for(const reset of [false,true]){
  const before=await breaker('cb-cancel'),job=launch('cancel',{kind:'stall'}),row=await active(job)
  await until('body read phase',async()=>{const d=await diagnostic();return d.pool['active.connections']===1})
  // Observe the client receiving bytes, not a guessed delay.
  await job.firstChunk;job.abort(reset);const r=await evidence(job)
  assert.equal(r.status,200);assert.equal(r.body,'data: prefix\n\n');assert.equal(r.final.statusCode,200)
  assert.equal(r.final.outcome,'cancelled');assert.equal(r.final.reason,'client_cancelled');await until('body cancellation close',()=>row.closedAt)
  assert.equal((await breaker('cb-cancel')).bufferedCalls,before.bufferedCalls)
  }
 })
 await check('Pool queue is bounded and cancelled waiters/requests release connections',async()=>{
  const before=await breaker('cb-healthy')
  const held=Array.from({length:4},()=>launch('plain',{kind:'hold'}));await Promise.all(held.map(active))
  const waiting=[launch('healthy',{kind:'hold'}),launch('healthy',{kind:'hold'})]
  await until('two queued acquisitions',async()=>(await diagnostic()).pool['pending.connections']===2)
  const overflow=await one('healthy',{kind:'hold'});assert.equal(overflow.status,503);assert.equal(overflow.final.reason,'proxy_pool_full');assert.equal(overflow.upstreamReceived,0)
  waiting[0].abort();const cancelled=await evidence(waiting[0]);assert.equal(cancelled.final.outcome,'cancelled')
  const timed=await evidence(waiting[1]);assert.equal(timed.status,503);assert.equal(timed.final.reason,'proxy_pool_timeout');assert.equal(timed.upstreamReceived,0)
  held.forEach(j=>j.abort());await Promise.all(held.map(evidence))
  const after=await breaker('cb-healthy');assert.equal(after.bufferedCalls,before.bufferedCalls);assert.equal(after.failedCalls,before.failedCalls);assert.equal(after.successfulCalls,before.successfulCalls)
 })
 await check('Gateway limiting and management authentication never increment upstream breaker failures',async()=>{
  const before=await breaker('cb-healthy');await runtime({rateLimitEnabled:true,burstCapacity:1,requestedTokens:2})
  const limited=await one('healthy');assert.equal(limited.status,429);assert.equal(limited.final.reason,'gateway_limited');assert.equal(limited.upstreamReceived,0);assert.equal((await breaker('cb-healthy')).bufferedCalls,before.bufferedCalls)
  await runtime({rateLimitEnabled:false});const auth=await fetch(base+'/settings/proxy/diagnostics');assert.equal(auth.status,401);assert.equal(auth.headers.get('cache-control'),'no-store')
 })
 // Management SSE is intentionally outside the proxy timeout/CB scope.
 const before=(await snapshot()).completedTotal;const controller=new AbortController();const stream=await fetch(base+'/monitor/stream',{headers:{Authorization:'Bearer '+token},signal:controller.signal});assert.equal(stream.status,200)
 const reader=stream.body.getReader(),start=performance.now();let frames=0
 while(performance.now()-start<2000){const event=await Promise.race([reader.read(),delay(4000).then(()=>{throw new Error('SSE stalled')})]);assert.equal(event.done,false);frames++}
 controller.abort();await reader.cancel().catch(()=>{});assert.equal((await snapshot()).completedTotal,before);report.sse={frames,elapsedMs:performance.now()-start,proxyBudgetMs:1600,proxyCompletions:0}
 const c=await api('/settings/runtime'),saved=await runtime({replenishRate:37}),result=await api('/settings/runtime/operations/'+saved.receipt.operationId);assert.equal(result.status,'committed');assert.notEqual(c.version,saved.version);assert.ok((await api('/settings/runtime/history')).entries.length)
 report.regression={runtimeVersion:saved.version,receipt:saved.receipt.operationId,routeCount:(await api('/settings/routes')).routes.length}
 report.finalDiagnostics=await diagnostic()
 report.finalLimiterBeforeRestart=await api('/settings/rate-limit/diagnostics')
 if(limiterHandoff)assert(report.finalLimiterBeforeRestart.observations.timings.handoff_queue.count>50,'Fault requests must actually traverse the result handoff')
 // Recheck counts after every terminal event, so a delayed retry or duplicate final audit cannot hide.
 const finalAudit=(await redisCommand(redisPort,['LRANGE',prefix+':audit',0,-1])).map(x=>JSON.parse(x))
 for(const r of report.requests){assert.equal(finalAudit.filter(a=>a.path===r.path).length,1);assert.equal(arrivals.filter(a=>a.key===r.key).length,r.upstreamReceived)}
 report.startupRejections=[]
 for(const test of [
  {name:'invalid total budget',flags:['--zenith.proxy.resilience.total-timeout-ms=100'],expected:'Invalid zenith.proxy.resilience policy'},
  {name:'Retry filter is prohibited',flags:['--spring.cloud.gateway.server.webflux.default-filters[0]=Retry=1'],expected:'Proxy Retry filters are disabled in this release'}
 ]){
  const flags=['--server.port='+await freePort(),...test.flags],keys=flags.map(s=>s.slice(0,s.indexOf('=')+1))
  const rejectArgs=args.filter(s=>!keys.some(k=>s.startsWith(k))).concat(flags)
  const rejected=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),rejectArgs,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token,REDIS_PASSWORD:''}})
  let text='';rejected.stdout.on('data',b=>text+=b);rejected.stderr.on('data',b=>text+=b)
  try {await until('fail closed: '+test.name,()=>rejected.exitCode!==null,40000);assert.notEqual(rejected.exitCode,0);assert.ok(text.includes(test.expected),text)}
  finally {if(rejected.exitCode===null){rejected.kill();await until('rejected process exit',()=>rejected.exitCode!==null,5000)}await writeFile(join(out,'startup-'+report.startupRejections.length+'.log'),text)}
  report.startupRejections.push({name:test.name,exitCode:rejected.exitCode,expected:test.expected})
 }
 // Reload the existing mixed-case URIs from Redis in a fresh gateway; no route write/refresh.
 await api('/actuator/shutdown',{method:'POST',body:'{}'});await until('first gateway exit for persisted route test',()=>child.exitCode!==null,15000)
 report.restart={firstExitCode:child.exitCode,routeWritesAfterRestart:0};assert.equal(child.exitCode,0)
 await new Promise(r=>log.end(r));log=createWriteStream(join(out,'gateway-restarted.log'))
 child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),args,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token,REDIS_PASSWORD:''}});child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 await until('restarted gateway ready',async()=>{assert.equal(child.exitCode,null);try{return (await fetch(base+'/actuator/health/readiness')).ok}catch{return false}},60000)
 for(const {scheme,plain,uri} of schemeRoutes){
  await until('reloaded '+scheme,async()=>{const r=await fetch(base+'/'+plain+'/restart-ready-'+plain);await r.text();return r.status===200})
  assert.equal((await api('/settings/routes')).routes.find(r=>r.id===plain).uri,uri)
 }
 await until('restart warmup drained',async()=>(await api('/monitor/audit/status')).pending===0)
 await check('Restart loads all six persisted scheme variants without rewriting URIs or bypassing total deadlines',async()=>{
  for(const {plain} of schemeRoutes){
   const job=launch(plain,{kind:'trickle'},{keyPrefix:'ReLoaded-'});await job.firstChunk;assert.equal((await diagnostic()).activeProxyRequests,1)
   const r=await evidence(job);assert.equal(r.status,200);assert.equal(r.final.reason,'proxy_total_timeout');assert.equal(r.final.outcome,'error');assert.equal(r.upstream[0].url,'/'+r.key);assert.ok(r.elapsedMs>=1400&&r.elapsedMs<2400)
  }
 })
 const auditsAfterRestart=(await redisCommand(redisPort,['LRANGE',prefix+':audit',0,-1])).map(x=>JSON.parse(x))
 for(const r of report.requests){assert.equal(auditsAfterRestart.filter(a=>a.path===r.path).length,1);assert.equal(arrivals.filter(a=>a.key===r.key).length,r.upstreamReceived)}
 report.finalDiagnosticsAfterRestart=await diagnostic();report.passed=true
}catch(error){report.error=error.stack;process.exitCode=1;console.error(error)}finally{
 if(child&&child.exitCode===null){await api('/actuator/shutdown',{method:'POST',body:'{}'}).catch(()=>{});await until('gateway shutdown',()=>child.exitCode!==null,15000).catch(()=>child.kill());report.cleanup.gatewayExitCode=child.exitCode}
 for(const c of connections)c.destroy();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));await new Promise(r=>blackhole.close(r));await new Promise(r=>secureUpstream.close(r));report.cleanup.upstreamClosed=true;report.cleanup.httpsUpstreamClosed=true
 if(created){docker(['rm','-fv',name]);report.cleanup.redisRemoved=true}await rm(pfx,{force:true});report.cleanup.privateTlsKeyRemoved=true;log?.end();report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(out,'upstream.json'),JSON.stringify(arrivals.map(({finish,reset,...r})=>r),null,2)+'\n');console.log('Proxy resilience report: '+join(out,'report.json'))
}
