import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer,request} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {routeProxy} from './route-publication-fault-proxy.mjs'
export async function until(label,probe,ms=7000){const end=performance.now()+ms;do{const v=await probe();if(v)return v;await delay(20)}while(performance.now()<end);throw new Error('Bounded wait: '+label)}
export async function reached(promise,label,ms=5000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(new Error('Missing boundary '+label)),ms))])}finally{clearTimeout(timer)}}
const port=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
export async function environment(){
 const id=randomUUID(),namespace='zg:route-publication:'+id,key=namespace+':routes',token=randomUUID(),name='zenith-route-'+id.slice(0,8)
 const out=resolve(process.env.ROUTE_PUBLICATION_OUTPUT||'.dev/route-publication/live-'+id.slice(0,8)),jar=process.env.ROUTE_PUBLICATION_JAR||'backend/target/zg-1.0.0.jar';await mkdir(out,{recursive:true})
 const docker=args=>execFileSync('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout:30000}).trim(),processes=[],arrivals=[],upstreams=[],holds=new Map()
 const report={startedAt:new Date().toISOString(),jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),checks:[],requests:[],evidence:{},cleanup:{},passed:false}
 let created=false,redisPort,proxyA,proxyB,sequence=0
 for(const version of ['V1','V2']){
  const server=createServer((req,res)=>{const entry={version,path:req.url,receivedAt:new Date().toISOString()};arrivals.push(entry);const finish=()=>{if(!res.destroyed){res.setHeader('Content-Type','text/plain');res.setHeader('X-Zenith-Route-Version','upstream-must-not-control-this');res.setHeader('X-Zenith-Instance','upstream-must-not-control-this');res.end(version+':'+req.url)}}
   const hold=holds.get(req.url);if(hold){hold.entered={...entry};hold.resolve(entry);hold.finish=finish}else finish()})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));upstreams.push(server)
 }
 const e={out,jar,key,namespace,token,report,processes,arrivals,upstreams,
  uri:which=>'http://127.0.0.1:'+upstreams[which-1].address().port,
  redis:args=>redisCommand(redisPort,args),
  async request(instance,path,options={}){const start=performance.now();const r=await fetch(instance.base+path,{...options,signal:options.signal??AbortSignal.timeout(12000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers}});const text=await r.text();const body=text?JSON.parse(text):null;return {status:r.status,body,headers:Object.fromEntries(r.headers),elapsedMs:performance.now()-start}},
  async api(instance,path,options={}){const r=await e.request(instance,path,options);assert.ok(r.status>=200&&r.status<300,JSON.stringify(r));return r.body},
  read:instance=>e.api(instance,'/settings/routes'),local:instance=>e.api(instance,'/settings/routes/adopted'),diag:instance=>e.api(instance,'/settings/routes/diagnostics'),
  publish:(instance,expectedVersion,route)=>e.request(instance,'/settings/routes',{method:'POST',body:JSON.stringify({expectedVersion,route})}),
  remove:(instance,expectedVersion,id)=>e.request(instance,'/settings/routes/'+encodeURIComponent(id),{method:'DELETE',body:JSON.stringify({expectedVersion})}),
  async hit(instance,path='/probe/proof'){
   const start=performance.now(),r=await fetch(instance.base+path,{signal:AbortSignal.timeout(7000)}),body=await r.text();const row={instance:instance.label,path,status:r.status,body,version:r.headers.get('x-zenith-route-version'),responseInstance:r.headers.get('x-zenith-instance'),elapsedMs:performance.now()-start,at:new Date().toISOString()};report.requests.push(row);return row
  },
  async adopted(instance,version,bodyPrefix,ms=3000){const start=performance.now();const proof=await until(instance.label+' actual forwarding '+version,async()=>{const d=await e.local(instance);const r=await e.hit(instance);return d.version===version&&r.version===version&&r.body.startsWith(bodyPrefix)?{local:d,response:r}:false},ms);return {...proof,observedAfterMs:performance.now()-start}},
  hold(path){let resolve;const entered=new Promise(r=>resolve=r),h={resolve};holds.set(path,h);return {entered,release(){h.finish?.();holds.delete(path)}}},
  async check(label,fn){await fn();report.checks.push(label);console.log('PASS '+label)},
  async start(label,{disableRewrite=false,routeKey=key,expectReady=true,redisEndpoint,artifact=jar}={}){
   const i={label:label+'-'+(++sequence),base:'http://127.0.0.1:'+await port(),routeKey};i.log=createWriteStream(join(out,i.label+'.log'))
   const proxy=label.startsWith('A')?proxyA:proxyB
   const args=['-Xms128m','-Xmx384m','-XX:ActiveProcessorCount=4','-jar',artifact,'--server.address=127.0.0.1','--server.port='+new URL(i.base).port,
    '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+(redisEndpoint??proxy.port),'--spring.data.redis.password=',
    '--zenith.runtime.redis-key='+namespace+':runtime','--zenith.route.redis-key='+routeKey,'--zenith.audit.redis-key='+namespace+':audit:'+i.label,'--zenith.limiter.namespace='+namespace+':limiter',
    '--zenith.cors.allowed-origins[0]='+(e.uiOrigin??'http://127.0.0.1:5173'),'--zenith.rate-limit.enabled=false','--zenith.audit.enabled=false','--zenith.proxy.resilience.total-timeout-ms=10000','--zenith.proxy.resilience.headers-timeout-ms=8000','--zenith.proxy.resilience.read-idle-timeout-ms=9000',
    '--zenith.route.publication.interval-ms=1000','--zenith.route.publication.timeout-ms=750','--zenith.route.publication.stale-after-ms=5000',
    '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,shutdown',
    ...(disableRewrite?['--spring.cloud.gateway.server.webflux.filter.rewrite-path.enabled=false']:[])]
   i.args=args;i.child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),args,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}});i.child.stdout.pipe(i.log,{end:false});i.child.stderr.pipe(i.log,{end:false});processes.push(i)
   let ready=false;await until(i.label+' startup',async()=>{if(i.child.exitCode!==null)return true;try{ready=(await e.request(i,'/actuator/health/readiness')).status===200;return ready}catch{return false}},60000)
   if(expectReady){assert.equal(i.child.exitCode,null,i.label+' failed startup');assert.equal(ready,true)}else{assert.equal(ready,false);assert.notEqual(i.child.exitCode,0);assert.notEqual(i.child.exitCode,null)}return i
  },
  async stop(i){if(i.child.exitCode===null){await e.request(i,'/actuator/shutdown',{method:'POST',body:'{}'}).catch(()=>{});await until(i.label+' shutdown',()=>i.child.exitCode!==null,20000).catch(()=>i.child.kill())}i.log.end();return i.child.exitCode},
  async finish(error){report.passed=!error;if(error){report.error=error.stack;process.exitCode=1;console.error(error)}
   proxyA?.recover();proxyB?.recover();proxyA?.release();proxyB?.release();
   for(const i of processes)report.cleanup[i.label+'ExitCode']=await e.stop(i)
   for(const [label,p] of [['A',proxyA],['B',proxyB]])if(p){await writeFile(join(out,label+'-redis-frames.json'),JSON.stringify(p.events,null,2));await p.close();report.cleanup[label+'ProxyClosed']=true}
   for(const s of upstreams){s.closeAllConnections();await new Promise(r=>s.close(r))}report.cleanup.upstreamsClosed=true
   if(created){docker(['rm','-fv',name]);report.cleanup.redisRemoved=true}
   report.processes=processes.map(i=>({label:i.label,base:i.base,args:i.args}));report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(out,'upstream.json'),JSON.stringify(arrivals,null,2));console.log('Route publication evidence: '+join(out,'report.json'))
  }
 }
 try{
  docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499','--save','','--appendonly','no']);created=true
  redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));proxyA=await routeProxy(redisPort,key);proxyB=await routeProxy(redisPort,key);e.proxyA=proxyA;e.proxyB=proxyB
  report.isolation={name,redisPort,key,namespace,proxyAPort:proxyA.port,proxyBPort:proxyB.port,upstreamPorts:upstreams.map(s=>s.address().port)};return e
 }catch(error){await e.finish(error);throw error}
}
