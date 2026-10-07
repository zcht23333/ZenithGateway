import {withRouteVersion} from '../benchmarks/route-client.mjs'
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createWriteStream} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
import assert from 'node:assert/strict';
const token=randomBytes(24).toString('hex'),name='zenith-overview-test-'+randomBytes(5).toString('hex');
const prefix='zg:overview-test:'+Date.now(),ui=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15174';
const report={startedAt:new Date().toISOString(),isolated:true,cleanup:{},passed:false};
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim();
const upstream=createServer((req,res)=>{res.statusCode=req.url.includes('failure')?500:200;res.end('overview integration');});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const port=reservation.address().port;await new Promise(r=>reservation.close(r));
const base='http://127.0.0.1:'+port,log=createWriteStream('.dev/overview-stage-a/isolated-backend.log');
let java,created=false;
async function api(path,options={}){const response=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000)});assert.ok(response.ok);return response.status===204?null:response.json();}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);created=true;
 const redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));
 const javaFile=process.env.JAVA_HOME+'/bin/java.exe';
 java=spawn(javaFile,['-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=','--spring.data.redis.database=0',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.rate-limit.enabled=false',
  '--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+prefix+':runtime','--zenith.audit.redis-key='+prefix+':audit',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],
 {windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}});
 java.stdout.pipe(log);java.stderr.pipe(log,{end:false});
 const deadline=Date.now()+60000;let ready=false;
 while(Date.now()<deadline){try{if((await api('/actuator/health')).status==='UP'){ready=true;break;}}catch{}await delay(300);}
 assert.ok(ready,'Isolated backend started');
 await api('/settings/routes',await withRouteVersion(()=>api('/settings/routes'),{method:'POST',body:JSON.stringify({id:'overview-live-smoke',path:'/overview-smoke/**',
  uri:'http://127.0.0.1:'+upstream.address().port,rewriteEnabled:false,rewriteRegex:null,rewriteReplacement:null,circuitBreakerEnabled:false,circuitBreakerName:'overview-live',fallbackPath:'/fallback/default'})}));
 await delay(500);
 for(const suffix of ['first','second','failure']){const r=await fetch(base+'/overview-smoke/'+suffix);assert.equal(r.status,suffix==='failure'?500:200);}
 await delay(700);
 const child=spawn(process.execPath,['verification/overview-live-readonly.mjs'],{windowsHide:true,stdio:'inherit',
  env:{...process.env,ROUTE_CONSOLE_URL:ui,OVERVIEW_API_TARGET:base,ZENITH_ADMIN_TOKEN:token}});
 const [code]=await once(child,'exit');assert.equal(code,0);
 report.passed=true;report.realProxyRequests=3;
}catch(error){report.failure=error.stack;throw error;}
finally{
 if(java&&java.exitCode===null){try{await api('/actuator/shutdown',{method:'POST',body:'{}'});const deadline=Date.now()+25000;while(java.exitCode===null&&Date.now()<deadline)await delay(200);if(java.exitCode===null)java.kill();}catch{java.kill();}if(java.exitCode===null)await once(java,'exit');report.cleanup.backendExitCode=java.exitCode;}
 log.end();await new Promise(r=>upstream.close(r));if(created){docker(['stop','--time','5',name]);report.cleanup.redisRemoved=true;}
 report.completedAt=new Date().toISOString();await writeFile('.dev/overview-stage-a/isolated-live.json',JSON.stringify(report,null,2)+'\n');
}
