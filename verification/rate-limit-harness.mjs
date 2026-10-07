import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import {withRouteVersion} from '../benchmarks/route-client.mjs'
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer,request} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {limiterProxy} from './rate-limit-fault-proxy.mjs'
import {runtimeValues} from './runtime-config-client.mjs'
export async function until(label,probe,timeout=7000){const end=performance.now()+timeout;do{const v=await probe();if(v)return v;await delay(20)}while(performance.now()<end);throw new Error('Bounded wait: '+label)}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
export async function environment({out,jar='backend/target/zg-1.0.0.jar',legacy=false,extra=[],fixtureJar=null}={}){
 const id=randomUUID(),name='zenith-limiter-'+id.slice(0,8),ns='zg:rl:test:'+id,key=ns+':runtime',token=randomUUID(),processes=[],arrivals=[]
 out=resolve(out||'.dev/rate-limit-reliability/live-'+id.slice(0,8));await mkdir(out,{recursive:true})
 const report={startedAt:new Date().toISOString(),isolated:true,jarSha256:createHash('sha256').update(await readFile(jar)).digest('hex'),checks:[],requests:[],evidence:{},cleanup:{},passed:false}
 const docker=a=>execFileSync('docker',scopedDockerArgs(a),{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
 const upstream=createServer((req,res)=>{arrivals.push({path:req.url,at:new Date().toISOString(),method:req.method});res.writeHead(200,{'Content-Type':'text/plain'});res.end('upstream:'+req.url)})
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
 let redisPort,proxyA,proxyB,created=false
 const env={report,out,ns,key,arrivals,processes,
  redis:a=>redisCommand(redisPort,a),
  async api(instance,path,options={}){const r=await fetch(instance.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(7000)});const body=await r.json();assert.ok(r.ok,path+' '+r.status+' '+JSON.stringify(body));return body},
  async check(label,fn){await fn();report.checks.push(label);console.log('PASS '+label)},
  async start(label,{trusted=true,flags=[]}={}){
   const instance={label,base:'http://127.0.0.1:'+await port(),log:createWriteStream(join(out,label+'.log'))},proxy=label.startsWith('A')?proxyA:proxyB
   const args=['-Xms128m','-Xmx384m','-XX:ActiveProcessorCount=4',...(fixtureJar?['-Dloader.path='+resolve(fixtureJar),'-cp',jar,'org.springframework.boot.loader.launch.PropertiesLauncher']:['-jar',jar]),'--server.address=127.0.0.1','--server.port='+new URL(instance.base).port,
    '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+proxy.port,'--spring.data.redis.password=',
    '--zenith.runtime.redis-key='+key,'--zenith.route.redis-key='+ns+':routes:'+label,'--zenith.audit.redis-key='+ns+':audit:'+label,
    '--zenith.rate-limit.enabled=true','--zenith.rate-limit.burst-capacity=20','--zenith.rate-limit.replenish-rate=1','--zenith.rate-limit.requested-tokens=1',
    '--zenith.limiter.namespace='+ns,'--zenith.limiter.workers=2','--zenith.limiter.queue-capacity=4','--zenith.limiter.decision-timeout-ms=400','--zenith.limiter.probe-interval-ms=300',
    '--zenith.runtime.sync.interval-ms=200','--zenith.runtime.sync.timeout-ms=200','--zenith.runtime.sync.stale-after-ms=1000',
    '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,metrics,prometheus,shutdown',
    ...(trusted?['--zenith.proxy.trusted-proxies[0]=127.0.0.1/32']:[]),...(fixtureJar?['--zenith.verification.limiter-gate=true']:[]),...extra,...flags]
   // Spring concatenates duplicate command-line values rather than taking the last one.
   const last=new Map();args.forEach((a,n)=>{if(a.startsWith('--'))last.set(a.split('=')[0],n)})
   const effective=args.filter((a,n)=>!a.startsWith('--')||last.get(a.split('=')[0])===n)
   instance.child=spawn(join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'),effective,{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}});instance.child.stdout.pipe(instance.log,{end:false});instance.child.stderr.pipe(instance.log,{end:false});processes.push(instance)
   await until(label+' readiness',async()=>{assert.equal(instance.child.exitCode,null,label+' exited');try{return (await fetch(instance.base+'/actuator/health/readiness')).ok}catch{return false}},60000)
   if(fixtureJar)await env.api(instance,'/settings/verification/limiter-gate')
   await env.api(instance,'/settings/routes',await withRouteVersion(()=>env.api(instance,'/settings/routes'),{method:'POST',body:JSON.stringify({id:'probe',path:'/probe/**',uri:'http://127.0.0.1:'+upstream.address().port,rewriteEnabled:true,circuitBreakerEnabled:true})}))
   await until(label+' route',async()=>{const r=await env.hit(instance,'192.0.2.250',{warmup:true});return r.status===200})
   return instance
  },
  hit(instance,ip='192.0.2.1',options={}){
   let req,done,body='',status=0,headers={},ended=false;const start=performance.now(),path='/probe/'+randomUUID(),promise=new Promise(r=>done=r)
   const finish=termination=>{if(ended)return;ended=true;clearTimeout(timer);const row={instance:instance.label,path,ip,status,body,headers,termination,elapsedMs:performance.now()-start,warmup:!!options.warmup};report.requests.push(row);done(row)}
   req=request(instance.base+path,{headers:{'X-Forwarded-For':ip,...options.headers},method:options.method||'GET'},r=>{status=r.statusCode;headers=r.headers;r.on('data',b=>body+=b);r.on('end',()=>finish('complete'));r.on('error',()=>finish('aborted'))});req.on('error',e=>finish(e.code));req.end()
   const timer=setTimeout(()=>{req.destroy();finish('test-deadline')},5000)
   return Object.assign(promise,{path,abort(){req.destroy();finish('client-cancelled')}})
  },
  async save(A,patch){const c=await env.api(A,'/settings/runtime');return env.api(A,'/settings/runtime',{method:'PUT',body:JSON.stringify({...runtimeValues(c),...patch,expectedVersion:c.version,operationId:randomUUID()})})},
  async adopted(instance,version){return until(instance.label+' adoption '+version,async()=>{const s=await env.api(instance,'/settings/runtime/adopted');return s.version===version?s:false})},
  async finish(error){report.passed=!error;if(error){report.error=error.stack;process.exitCode=1;console.error(error)}
   for(const i of processes){if(i.child.exitCode===null){await env.api(i,'/actuator/shutdown',{method:'POST',body:'{}'}).catch(()=>{});await until(i.label+' exit',()=>i.child.exitCode!==null,20000).catch(()=>i.child.kill())}report.cleanup[i.label+'ExitCode']=i.child.exitCode;i.log.end()}
   for(const [name,p] of [['proxyA',proxyA],['proxyB',proxyB]])if(p){await writeFile(join(out,name+'-frames.json'),JSON.stringify(p.events,null,2));await p.close();report.cleanup[name+'Closed']=true}
   upstream.closeAllConnections();await new Promise(r=>upstream.close(r));report.cleanup.upstreamClosed=true
   if(created){docker(['rm','-fv',name]);report.cleanup.redisRemoved=true}report.completedAt=new Date().toISOString();await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await writeFile(join(out,'upstream.json'),JSON.stringify(arrivals,null,2));console.log('Rate limit evidence: '+join(out,'report.json'))
  }
 }
 try{docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499','--save','','--appendonly','no']);created=true
  redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));proxyA=await limiterProxy(redisPort,ns,key);proxyB=await limiterProxy(redisPort,ns,key)
  env.proxyA=proxyA;env.proxyB=proxyB;report.isolation={name,redisPort,namespace:ns,upstreamPort:upstream.address().port,proxyAPort:proxyA.port,proxyBPort:proxyB.port};return env
 }catch(e){await env.finish(e);throw e}
}
