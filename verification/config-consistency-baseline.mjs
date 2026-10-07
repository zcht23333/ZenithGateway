import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const ui=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15174'
const token=randomBytes(24).toString('hex'),name='zenith-consistency-before-'+randomBytes(5).toString('hex')
const prefix='zg:consistency-before:'+Date.now(),out='.dev/config-consistency'
await mkdir(out,{recursive:true})
const report={startedAt:new Date().toISOString(),isolated:true,checks:[],pageErrors:[],requests:[],cleanup:{},passed:false}
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r))
const port=reserve.address().port;await new Promise(r=>reserve.close(r))
const base='http://127.0.0.1:'+port,log=createWriteStream(out+'/isolated-backend.log')
let java,created=false,browser,baseline
async function api(path,options={}) {
 const response=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000)})
 assert.ok(response.ok,'Isolated API status '+response.status)
 return response.status===204?null:response.json()
}
const redisConfig=()=>JSON.parse(docker(['exec',name,'redis-cli','GET',prefix+':runtime']))
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);created=true
 const redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 java=spawn(process.env.JAVA_HOME+'/bin/java.exe',['-jar','.dev/config-consistency/before.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=','--spring.data.redis.database=0',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+prefix+':runtime','--zenith.audit.redis-key='+prefix+':audit',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}})
 java.stdout.pipe(log);java.stderr.pipe(log,{end:false})
 let ready=false;const deadline=Date.now()+60000
 while(Date.now()<deadline){try{if((await api('/actuator/health')).status==='UP'){ready=true;break}}catch{}await delay(300)}
 assert.ok(ready,'Isolated backend started')
 baseline=await api('/settings/runtime');report.baseline=baseline
 await check('Legacy actual gateway accepts stale B and overwrites A window 30 back to 10',async()=>{
  const a=await api('/settings/runtime'),b=await api('/settings/runtime')
  const confirmedA=await api('/settings/runtime',{method:'PUT',body:JSON.stringify({...a,monitorWindowSeconds:30})})
  assert.equal(confirmedA.monitorWindowSeconds,30)
  const confirmedB=await api('/settings/runtime',{method:'PUT',body:JSON.stringify({...b,replenishRate:40})})
  assert.equal(confirmedB.monitorWindowSeconds,10);assert.equal(redisConfig().monitorWindowSeconds,10)
  report.evidence={aRead:a,bRead:b,confirmedA,confirmedB,stored:redisConfig()}
 })
 report.passed=true
}catch(error){report.failure=error.stack;throw error}
finally{
 if(browser)await browser.close()
 if(baseline&&java?.exitCode===null){try{await api('/settings/runtime',{method:'PUT',body:JSON.stringify(baseline)});assert.deepEqual(await api('/settings/runtime'),baseline);report.cleanup.originalConfigurationRestored=true}catch(error){report.cleanup.restoreError=error.message}}
 if(java&&java.exitCode===null){try{await api('/actuator/shutdown',{method:'POST',body:'{}'});const deadline=Date.now()+25000;while(java.exitCode===null&&Date.now()<deadline)await delay(200);if(java.exitCode===null)java.kill()}catch{java.kill()}if(java.exitCode===null)await once(java,'exit');report.cleanup.backendExitCode=java.exitCode}
 log.end();if(created){docker(['stop','--time','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString();await writeFile(out+'/baseline-real-redis.json',JSON.stringify(report,null,2)+'\n')
}
