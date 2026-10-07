import {runtimeValues,runtimeRequest} from './runtime-config-client.mjs'
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
const token=randomBytes(24).toString('hex'),name='zenith-settings-test-'+randomBytes(5).toString('hex')
const prefix='zg:settings-test:'+Date.now(),out='.dev/settings-stage-b'
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
 java=spawn(process.env.JAVA_HOME+'/bin/java.exe',['-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=','--spring.data.redis.database=0',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+prefix+':runtime','--zenith.audit.redis-key='+prefix+':audit',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}})
 java.stdout.pipe(log);java.stderr.pipe(log,{end:false})
 let ready=false;const deadline=Date.now()+60000
 while(Date.now()<deadline){try{if((await api('/actuator/health')).status==='UP'){ready=true;break}}catch{}await delay(300)}
 assert.ok(ready,'Isolated backend started')
 baseline=await api('/settings/runtime');report.baseline=baseline
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 const p=await ctx.newPage();p.setDefaultTimeout(7000);p.on('pageerror',e=>report.pageErrors.push(e.message))
 let puts=0,gets=0,failNextRead=false,loseNextWrite=false
 await p.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.slice(4)
  report.requests.push({method:request.method(),path})
  assert.ok(request.method()==='GET'||(path==='/settings/runtime'&&request.method()==='PUT'),'Unexpected management write')
  if(path==='/monitor/stream'){await route.continue({url:base+path+url.search});return}
  if(path==='/settings/runtime'&&request.method()==='GET'){
   gets++;if(failNextRead){failNextRead=false;await route.fulfill({status:503,json:{message:'isolated follow-up read failure'}});return}
  }
  if(path==='/settings/runtime'&&request.method()==='PUT')puts++
  const response=await route.fetch({url:base+path+url.search})
  if(path==='/settings/runtime'&&request.method()==='PUT'){
   await delay(400)
   if(loseNextWrite){loseNextWrite=false;assert.equal(response.status(),200);await route.abort('failed');return}
  }
  await route.fulfill({response})
 })
 const field=key=>p.locator('#setting-'+key)
 async function setValues(values){
  if((await p.getByRole('switch',{name:'全局限流'}).getAttribute('aria-checked')==='true')!==values.rateLimitEnabled)
   await p.getByRole('switch',{name:'全局限流'}).click()
  for(const key of ['replenishRate','burstCapacity','requestedTokens','monitorWindowSeconds','emitIntervalSeconds'])await field(key).fill(String(values[key]))
 }
 async function message(pattern){await p.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('.settings-write-message')?.textContent||''),pattern)}
 await check('Real authentication loads the six exact backend values with no demo controls',async()=>{
  await p.goto(ui+'/settings');await p.locator('#admin-token').waitFor()
  await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  assert.equal(await field('replenishRate').inputValue(),String(baseline.replenishRate))
  assert.equal(await p.locator('.settings-demo-bar').count(),0)
 })
 const changed={rateLimitEnabled:!baseline.rateLimitEnabled,replenishRate:37,burstCapacity:74,requestedTokens:2,monitorWindowSeconds:17,emitIntervalSeconds:2}
 await check('One UI save updates the live runtime and Redis; all six returned fields become the baseline',async()=>{
  await setValues(changed);const priorPuts=puts,priorGets=gets
  await p.locator('.settings-save').click();assert.equal(await field('replenishRate').isDisabled(),true)
  await p.locator('form').evaluate(el=>el.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true})))
  await message('保存已确认');assert.equal(puts,priorPuts+1);assert.equal(gets,priorGets)
  assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(changed));assert.deepEqual(runtimeValues(redisConfig()),runtimeValues(changed))
  assert.equal(await p.locator('.settings-difference').count(),0)
  await p.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0)})
  await p.screenshot({path:'docs/images/settings-stage-b-live-saved-1440.png'})
  report.confirmed=changed
 })
 await check('A subsequent failed read does not undo the real confirmed save; retry restores reading',async()=>{
  failNextRead=true;await p.getByRole('button',{name:'重新读取',exact:true}).click();await p.locator('.settings-read-error').waitFor()
  assert.match(await p.locator('.settings-read-error').textContent(),/保存已确认，重新读取失败/)
  assert.equal(await field('replenishRate').inputValue(),'37');assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(changed))
  await p.getByRole('button',{name:'重试读取配置',exact:true}).click();await p.locator('.settings-read-error').waitFor({state:'hidden'})
 })
 await check('An actually committed write with a dropped response reconciles via GET without duplicate PUT',async()=>{
  loseNextWrite=true;await field('replenishRate').fill('41');const prior=puts
  await p.locator('.settings-save').click();await message('未收到可靠')
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  assert.equal((await api('/settings/runtime')).replenishRate,41);assert.equal(redisConfig().replenishRate,41)
  await p.locator('.settings-query-operation').click();await message('此前存储写入已确认')
  assert.equal(puts,prior+1);assert.equal(await p.locator('.settings-difference').count(),0)
 })
 await check('Shared navigation reaches actual overview and routes after a save, including the changed metric window',async()=>{
  await p.getByRole('link',{name:'运行概览',exact:true}).click();await p.locator('.overview-chart canvas').waitFor()
  await p.waitForFunction(()=>document.querySelector('.overview-window-context')?.textContent.includes('17'))
  await p.getByRole('link',{name:'路由调度',exact:true}).click();await p.locator('.dispatch-view').waitFor()
  await p.setViewportSize({width:390,height:844})
  await p.getByRole('button',{name:'导航',exact:true}).click()
  await p.getByRole('link',{name:'系统配置',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  assert.equal(await field('replenishRate').inputValue(),'41');assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390)
  await p.setViewportSize({width:1440,height:900})
 })
 await check('Restoring the original six values through the UI is confirmed by runtime and Redis reads',async()=>{
  await setValues(baseline);await p.locator('.settings-save').click();await message('保存已确认')
  assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(baseline));assert.deepEqual(runtimeValues(redisConfig()),runtimeValues(baseline))
  report.cleanup.originalConfigurationRestored=true
  await p.getByRole('button',{name:'断开管理连接',exact:true}).click();await p.locator('#admin-token').waitFor()
 })
 report.runtimeGets=gets;report.runtimePuts=puts;assert.deepEqual(report.pageErrors,[]);report.passed=true
}catch(error){report.failure=error.stack;throw error}
finally{
 if(browser)await browser.close()
 if(baseline&&java?.exitCode===null){try{await api('/settings/runtime',{method:'PUT',body:JSON.stringify(runtimeRequest(baseline,(await api('/settings/runtime')).version))});assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(baseline));report.cleanup.originalConfigurationRestored=true}catch(error){report.cleanup.restoreError=error.message}}
 if(java&&java.exitCode===null){try{await api('/actuator/shutdown',{method:'POST',body:'{}'});const deadline=Date.now()+25000;while(java.exitCode===null&&Date.now()<deadline)await delay(200);if(java.exitCode===null)java.kill()}catch{java.kill()}if(java.exitCode===null)await once(java,'exit');report.cleanup.backendExitCode=java.exitCode}
 log.end();if(created){docker(['stop','--time','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString();await writeFile(out+'/live-validation.json',JSON.stringify(report,null,2)+'\n')
}
