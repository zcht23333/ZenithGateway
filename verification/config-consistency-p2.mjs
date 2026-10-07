import {randomUUID} from 'node:crypto'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:net'
import {createWriteStream} from 'node:fs'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import {redisCommand} from '../benchmarks/redis.mjs'
import {runtimeValues} from './runtime-config-client.mjs'

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));process.chdir(root)
const id=randomBytes(5).toString('hex'),name='zenith-p2-browser-'+id,key='zg:p2:'+id+':runtime'
const out=resolve(process.env.CONFIG_P2_OUTPUT||'.dev/config-consistency-p2/browser-'+id)
const imageDir=resolve(process.env.CONFIG_P2_IMAGES||'docs/images')
const token=randomBytes(24).toString('hex')
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const report={startedAt:new Date().toISOString(),isolated:true,checks:[],evidence:{},pageErrors:[],cleanup:{},passed:false}
await mkdir(out,{recursive:true});await mkdir(imageDir,{recursive:true})
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
let java,previewServer,browser,context,redisPort,redisCreated=false,base,log
async function freePort(){
 const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port
 await new Promise(r=>s.close(r));return port
}
async function api(path='/settings/runtime',options={}){
 const r=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(10000)})
 assert.equal(r.status,200,await r.clone().text());return r.json()
}
const put=async(patch)=>{const c=await api();return api('/settings/runtime',{method:'PUT',body:JSON.stringify({...runtimeValues(c),...patch,expectedVersion:c.version,operationId:randomUUID()})})}
const stored=async()=>JSON.parse(await redisCommand(redisPort,['GET',key]))
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);redisCreated=true
 redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 for(let i=0;;i++){try{await redisCommand(redisPort,['PING']);break}catch(error){if(i===50)throw error;await delay(100)}}
 const port=await freePort(),uiPort=await freePort();base='http://127.0.0.1:'+port
 const ui='http://127.0.0.1:'+uiPort
 previewServer=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:uiPort,strictPort:true}})
 log=createWriteStream(join(out,'backend.log'))
 const executable=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java'
 java=spawn(executable,['-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.runtime.redis-key='+key,'--zenith.route.redis-key=zg:p2:'+id+':routes',
  '--zenith.audit.enabled=false','--management.endpoint.shutdown.access=unrestricted',
  '--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],
  {windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}})
 java.stdout.pipe(log,{end:false});java.stderr.pipe(log,{end:false})
 let ready=false
 for(let i=0;i<240;i++){
  assert.equal(java.exitCode,null,'gateway exited before readiness')
  try{const r=await fetch(base+'/actuator/health/readiness',{signal:AbortSignal.timeout(1000)});if(r.status===200){ready=true;break}}catch{}
  await delay(200)
 }
 assert.ok(ready,'gateway startup');const original=await api();report.evidence.initial=original
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 report.browser=browser.version()
 context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 const p=await context.newPage();p.setDefaultTimeout(10000);p.on('pageerror',e=>report.pageErrors.push(e.message))
 let readUnavailable=false,invalidAuth=false
 const requests=[]
 await p.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url()),path=url.pathname.slice(4)
  assert.ok(r.method()==='GET'||path==='/settings/runtime'&&r.method()==='PUT')
  if(readUnavailable&&path==='/settings/runtime'&&r.method()==='GET'){
   await route.fulfill({status:503,json:{code:'CONFIG_READ_UNAVAILABLE',message:'独立测试：读取暂时不可用'}});return
  }
  const headers={...r.headers()};if(invalidAuth)headers.authorization='Bearer isolated-expired-token'
  const response=await route.fetch({url:base+path+url.search,headers})
  if(r.method()==='PUT')requests.push({submitted:r.postDataJSON(),status:response.status(),response:await response.json()})
  await route.fulfill({response})
 })
 const field=k=>p.locator('#setting-'+k),save=p.locator('.settings-save')
 const diffs=()=>p.locator('.settings-remote-change').allTextContents()
 async function idle(){await p.waitForFunction(()=>document.querySelector('.settings-refresh')?.disabled===false)}
 async function reread(){
  await Promise.all([p.waitForResponse(r=>r.url().endsWith('/api/settings/runtime')&&r.request().method()==='GET'),p.locator('.settings-refresh').click()])
  await idle()
 }
 async function snapshot(file){
  await p.evaluate(()=>{
   let el=document.querySelector('#isolation-label')
   if(!el){el=document.createElement('div');el.id='isolation-label';document.body.append(el)}
   el.textContent='独立测试 · 实际后端与 Redis · 冲突重复读取补验'
   Object.assign(el.style,{position:'fixed',bottom:'8px',left:'8px',zIndex:'999',background:'#17221a',color:'#c9ef86',
    padding:'6px 10px',fontSize:'12px',border:'1px solid #738443',borderRadius:'5px',pointerEvents:'none'})
  })
  await p.screenshot({path:join(imageDir,file),fullPage:true})
 }
 await check('A real conflict retains draft rate 40 and displays window 10 to 30',async()=>{
  await p.goto(ui+'/settings');await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click();await idle()
  assert.equal(await field('monitorWindowSeconds').inputValue(),'10')
  await field('replenishRate').fill('40');const a=await put({monitorWindowSeconds:30})
  await save.click();await p.locator('.settings-version-conflict').waitFor();await idle()
  assert.equal(requests.length,1);assert.equal(requests[0].status,409)
  assert.deepEqual(await diffs(),['指标统计窗口10 → 30'])
  assert.equal(await field('replenishRate').inputValue(),'40');assert.equal(await field('monitorWindowSeconds').inputValue(),'30')
  assert.equal(await save.isDisabled(),true);report.evidence.firstConflict={latest:a,differences:await diffs()}
 })
 await check('Repeated same-version reads preserve 10 to 30 and never resend the draft',async()=>{
  for(let i=0;i<2;i++){await reread();assert.deepEqual(await diffs(),['指标统计窗口10 → 30'])}
  assert.equal(requests.length,1);assert.equal(await save.isDisabled(),true)
  assert.equal(await field('replenishRate').inputValue(),'40')
  await snapshot('config-consistency-p2-reread-1440.png')
  report.evidence.sameVersionReread={differences:await diffs(),puts:requests.length}
 })
 await check('A later update still compares from 10 while adopting the newest CAS version and untouched capacity',async()=>{
  const later=await put({monitorWindowSeconds:45,burstCapacity:60});await reread()
  assert.deepEqual(await diffs(),['令牌桶容量20 → 60','指标统计窗口10 → 45'])
  assert.equal(await field('replenishRate').inputValue(),'40');assert.equal(await field('burstCapacity').inputValue(),'60')
  assert.equal(await field('monitorWindowSeconds').inputValue(),'45');assert.equal(await save.isDisabled(),true)
  await p.locator('.settings-version-details summary').click()
  assert.equal(await p.getByRole('textbox',{name:'待核对基准版本',exact:true}).inputValue(),original.version)
  assert.equal(await p.getByRole('textbox',{name:'存储已确认版本',exact:true}).inputValue(),later.version)
  await p.locator('.settings-version-details summary').click();await p.evaluate(()=>scrollTo(0,0))
  await snapshot('config-consistency-p2-newer-read-1440.png')
  await p.setViewportSize({width:390,height:844})
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390)
  await snapshot('config-consistency-p2-newer-read-390.png')
  await p.setViewportSize({width:1440,height:900})
  report.evidence.laterRead={latest:later,differences:await diffs(),puts:requests.length}
 })
 await check('Unavailable reads and authentication recovery preserve comparison and draft without automatic writes',async()=>{
  readUnavailable=true;await reread();await p.locator('.settings-read-error').waitFor()
  assert.deepEqual(await diffs(),['令牌桶容量20 → 60','指标统计窗口10 → 45'])
  assert.equal(await save.isDisabled(),true)
  readUnavailable=false;await reread()
  p.once('dialog',dialog=>dialog.dismiss());await p.getByRole('link',{name:'路由调度',exact:true}).click()
  assert.ok(p.url().endsWith('/settings'));assert.equal(await field('replenishRate').inputValue(),'40')
  invalidAuth=true;await p.locator('.settings-refresh').click();await p.locator('#admin-token').waitFor()
  invalidAuth=false;await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click();await idle()
  assert.deepEqual(await diffs(),['令牌桶容量20 → 60','指标统计窗口10 → 45'])
  assert.equal(await field('replenishRate').inputValue(),'40');assert.equal(await save.isDisabled(),true);assert.equal(requests.length,1)
 })
 await check('Manual review and save submit the latest version once and preserve all other writers values',async()=>{
  const latest=await api()
  await p.locator('.settings-review-ack').click();await save.click()
  await p.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
  assert.equal(requests.length,2);assert.equal(requests[1].status,200)
  assert.equal(requests[1].submitted.expectedVersion,latest.version)
  assert.equal(requests[1].submitted.replenishRate,40);assert.equal(requests[1].submitted.monitorWindowSeconds,45)
  assert.equal(requests[1].submitted.burstCapacity,60)
  assert.equal(await p.locator('.settings-version-conflict').count(),0)
  report.evidence.confirmed=await stored();assert.equal(report.evidence.confirmed.replenishRate,40)
  assert.equal(report.evidence.confirmed.monitorWindowSeconds,45)
 })
 await check('A subsequent conflict and discarded draft start and clear the comparison at the correct boundaries',async()=>{
  await field('replenishRate').fill('50');await put({monitorWindowSeconds:60})
  await save.click();await p.locator('.settings-version-conflict').waitFor();await reread()
  assert.deepEqual(await diffs(),['指标统计窗口45 → 60'])
  await p.locator('.settings-restore').click()
  assert.equal(await p.locator('.settings-version-conflict').count(),0)
  assert.equal(await field('replenishRate').inputValue(),'40');assert.equal(await field('monitorWindowSeconds').inputValue(),'60')
  assert.equal(requests.length,3)
  report.evidence.requests=requests
 })
 assert.deepEqual(report.pageErrors,[]);report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{
 if(context)await context.close();if(browser)await browser.close()
 if(java?.exitCode===null){
  try{await api('/actuator/shutdown',{method:'POST',body:'{}'})}catch{}
  for(let i=0;i<200&&java.exitCode===null;i++)await delay(100)
  if(java.exitCode===null){const ended=new Promise(r=>java.once('exit',r));java.kill();await ended}
  report.cleanup.backendExitCode=java.exitCode
 }
 log?.end()
 if(previewServer)await new Promise(r=>previewServer.httpServer.close(r))
 if(redisCreated){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 report.cleanup.previewClosed=!!previewServer;report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log('Browser report: '+join(out,'report.json'))
 if(!report.passed)console.error(report.failure)
}
