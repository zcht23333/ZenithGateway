import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
import {withRouteVersion} from '../benchmarks/route-client.mjs'
// Real Redis + two real JVMs; every port, key and process belongs to this run.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {randomBytes,randomUUID,createHash} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {redisCommand} from '../benchmarks/redis.mjs'
import {runtimeValues,runtimeRequest} from './runtime-config-client.mjs'
import {syncProxy} from './runtime-config-sync-proxy.mjs'
import {faultProxy} from './runtime-config-fault-proxy.mjs'
const backendOnly=process.argv.includes('--backend-only')
let preview,chromium
if(!backendOnly){
 ({preview}=await import('../frontend/node_modules/vite/dist/node/index.js'));
 ({chromium}=await import('../.dev/browser/node_modules/playwright/index.mjs'))
}

const id=randomBytes(5).toString('hex'),name='zenith-rollback-'+id,key='zg:rollback-live:'+id
const out=resolve(process.env.CONFIG_ROLLBACK_OUTPUT||'.dev/config-rollback/live-'+id)
await mkdir(out,{recursive:true})
const token=randomBytes(24).toString('hex'),password=randomBytes(24).toString('hex')
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const script=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
const report={startedAt:new Date().toISOString(),isolated:true,checks:[],evidence:{},cleanup:{},passed:false,
 jarSha256:createHash('sha256').update(await readFile('backend/target/zg-1.0.0.jar')).digest('hex')}
const docker=args=>execFileSync('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const instances=[];let created=false,port,proxy,proxyB,A,B,browser,context,ui,current
const uiPort=await freePort(),managementRequests=[]
const upstream=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end('{"isolated":true}')})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const initial={rateLimitEnabled:false,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
const redis=args=>redisCommand(port,args)
const raw=()=>redis(['GET',key])
const stored=async()=>JSON.parse(await raw())
const rev=v=>Number(v.slice(37))
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function until(label,probe,timeout=8000){const end=performance.now()+timeout;do{const result=await probe();if(result)return result;await delay(40)}while(performance.now()<end);throw new Error('Bounded wait: '+label)}
async function reached(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fault boundary not reached')),6000)})])}finally{clearTimeout(timer)}}
async function request(instance,path='/settings/runtime',options={}){
 assert.ok(!(instance.label.startsWith('B') && path==='/settings/runtime' && (!options.method||options.method==='GET')),'B observation must be local')
 managementRequests.push({instance:instance.label,path,method:options.method||'GET',at:new Date().toISOString()})
 const response=await fetch(instance.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(8000)})
 return {status:response.status,body:await response.json(),cacheControl:response.headers.get('cache-control')}
}
async function api(instance,path,options){const r=await request(instance,path,options);assert.equal(r.status,200,JSON.stringify(r));return r.body}
const submit=(instance,body)=>request(instance,'/settings/runtime',{method:'PUT',body:JSON.stringify(body)})
const query=(instance,operationId)=>api(instance,'/settings/runtime/operations/'+operationId)
const history=(instance,cursor='',limit=20)=>api(instance,'/settings/runtime/history?limit='+limit+'&cursor='+encodeURIComponent(cursor))
async function update(patch={},instance=A){const c=current;const r=await submit(instance,{...runtimeRequest(c),...patch});assert.equal(r.status,200,JSON.stringify(r));current=r.body;return r.body}
async function check(label,fn){const started=performance.now();await fn();report.checks.push({label,elapsedMs:performance.now()-started});console.log('PASS '+label)}
async function start(label,redisPort){
 const instance={label,base:'http://127.0.0.1:'+await freePort(),log:createWriteStream(join(out,label+'.log'))}
 const java=process.env.JAVA_HOME?join(process.env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java'
 instance.child=spawn(java,['-Xms128m','-Xmx384m','-XX:ActiveProcessorCount=4','-jar','backend/target/zg-1.0.0.jar',
  '--server.address=127.0.0.1','--server.port='+new URL(instance.base).port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.username=operations-test',
  '--zenith.cors.allowed-origins[0]=http://127.0.0.1:'+uiPort,'--zenith.runtime.redis-key='+key,'--zenith.route.redis-key='+key+':routes','--zenith.audit.enabled=false',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],
  {windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token,REDIS_PASSWORD:password}})
 instance.child.stdout.pipe(instance.log,{end:false});instance.child.stderr.pipe(instance.log,{end:false});instances.push(instance)
 await until(label+' readiness',async()=>{assert.equal(instance.child.exitCode,null,label+' exited');try{return (await request(instance,'/actuator/health/readiness')).status===200}catch(e){return false}},60000)
 return instance
}
async function stop(instance){
 if(instance.child.exitCode!==null)return
 await request(instance,'/actuator/shutdown',{method:'POST',body:'{}'})
 await until(instance.label+' stopped',async()=>instance.child.exitCode!==null,20000)
 assert.equal(instance.child.exitCode,0);report.cleanup[instance.label+'ExitCode']=0
}
const lua=async(target,mode,expected='',value=initial,operationId=randomUUID(),instanceId=randomUUID(),options={})=>
 JSON.parse(await redisCommand(port,['EVAL',script,1,target,mode,expected,typeof value==='string'?value:JSON.stringify(runtimeValues(value)),operationId,instanceId],options))
const init=async target=>lua(target,'init',randomUUID()+':1')

const reference=r=>({version:r.after.version,operationId:r.operationId})
const previewSource=source=>api(A,'/settings/runtime/rollback-preview?sourceVersion='+encodeURIComponent(source.version)+'&sourceOperationId='+source.operationId)
const restore=(instance,body)=>request(instance,'/settings/runtime/rollback',{method:'PUT',body:JSON.stringify(body)})
const rollbackRequest=(source,expected=current.version)=>({operationId:randomUUID(),expectedVersion:expected,source})
async function adoptB(snapshot,confirmedAt=performance.now()) {
 const state=await until('B background adopts '+snapshot.version,async()=>{
  const s=await api(B,'/settings/runtime/sync');return s.adoptedVersion===snapshot.version && s.status==='ok'?s:false
 },8000)
 assert.deepEqual(runtimeValues(state.adopted),runtimeValues(snapshot))
 return {version:snapshot.version,confirmedAt:new Date(Date.now()-(performance.now()-confirmedAt)).toISOString(),observedAt:new Date().toISOString(),
  elapsedMs:performance.now()-confirmedAt,adoptedAt:state.lastAdoptedAt,diagnostic:state}
}
const pageErrors=[],browserWrites=[],queryIds=[]
let source,originalRecovery,originalBody
async function pageSession() {
 context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 const page=await context.newPage();page.setDefaultTimeout(8000)
 const control={loseNext:false,expire:false,holdPath:null,held:null,decision:'accept'}
 page.on('pageerror',e=>pageErrors.push(e.message))
 page.on('dialog',d=>d[control.decision]())
 await page.route('**/api/**',async route=>{
  try {
   const req=route.request(),u=new URL(req.url()),path=u.pathname.slice(4),headers={...req.headers()}
   if(path==='/monitor/stream')return route.fulfill({status:200,contentType:'text/event-stream',body:': verification stream not captured\n\n'})
   if(control.expire)headers.authorization='Bearer deliberately-expired-in-isolated-test'
   if(req.method()==='PUT')browserWrites.push({path,body:req.postDataJSON()})
   if(path.startsWith('/settings/runtime/operations/'))queryIds.push(path.split('/').at(-1))
   const response=await route.fetch({url:A.base+path+u.search,headers})
   if(control.holdPath && path===control.holdPath) {
    const held=control.held;control.holdPath=null;held.started.resolve({status:response.status(),body:await response.json()})
    await held.gate.promise
    await route.fulfill({response});held.delivered.resolve();return
   }
   if(control.loseNext && path==='/settings/runtime/rollback' && req.method()==='PUT') {
    control.loseNext=false;control.lostResponse={status:response.status(),body:await response.json()};return route.abort('failed')
   }
   await route.fulfill({response})
  } catch(error){if(!page.isClosed())pageErrors.push(error.message);await route.abort().catch(()=>{})}
 })
 await page.goto('http://127.0.0.1:'+uiPort+'/settings');await login(page)
 return {page,control}
}
async function login(page) {await page.locator('#admin-token').fill(token);await page.getByRole('button',{name:'连接',exact:true}).click();await ready(page)}
async function ready(page){await page.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)}
async function choose(page,entry=source) {
 if(!await page.locator('.settings-history').count())await page.getByRole('button',{name:'提交历史 / 安全恢复',exact:true}).click()
 await page.locator('.settings-history-row').filter({hasText:entry.operationId}).click()
 await page.waitForFunction(()=>document.querySelector('.settings-rollback-differences tbody')?.children.length===6)
}
async function confirm(page){await page.locator('.settings-rollback-ack input').check();await page.locator('.settings-rollback-submit').click()}
async function shot(page,file){
 await page.evaluate(()=>{const el=document.createElement('div');el.textContent='隔离验证 · 双实例 · 真实 Redis 7.4';el.dataset.verification='true';el.style.cssText='position:fixed;bottom:8px;right:8px;padding:6px 9px;background:#14211c;color:#dbecaf;border:1px solid #698345;z-index:9999;font:12px sans-serif';document.body.append(el)})
 await page.screenshot({path:join(out,file),fullPage:true,animations:'disabled'})
 await page.locator('[data-verification]').evaluate(e=>e.remove())
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);created=true
 port=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));await until('Redis',async()=>{try{return await redis(['PING'])}catch{return false}})
 await redis(['ACL','SETUSER','operations-test','on','>'+password,'~*','+@all'])
 proxy=await faultProxy(port,key,['write','rollback']);proxyB=await syncProxy(port,key)
 A=await start('A',proxy.port);B=await start('B',proxyB.port);current=await api(A)
 // Create a successful historical source, not an invented initialization record.
 source=(await update(initial)).receipt
 await check('Management authentication, authoritative preview and exact source-only rollback payload',async()=>{
  for(const path of ['/settings/runtime/rollback-preview?sourceVersion='+source.after.version+'&sourceOperationId='+source.operationId,'/settings/runtime/rollback']) {
   const r=await fetch(A.base+path,{method:path.endsWith('/rollback')?'PUT':'GET',headers:{'Content-Type':'application/json'},body:path.endsWith('/rollback')?'{}':undefined})
   assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store')
  }
  const p=await previewSource(reference(source));assert.deepEqual(p.target,source.after);assert.equal(p.noChanges,true)
  assert.equal((await restore(A,{...rollbackRequest(reference(source)),replenishRate:999})).status,400)
  report.evidence.preview=p
 })
 await check('Full rollback propagates automatically to B and restores real proxy limiting behavior; business requests add zero config reads',async()=>{
  const r=await request(B,'/settings/routes',await withRouteVersion(()=>request(B,'/settings/routes'),{method:'POST',body:JSON.stringify({id:'rollback-probe',path:'/rollback-probe/**',uri:'http://127.0.0.1:'+upstream.address().port,rewriteEnabled:false,circuitBreakerEnabled:false})}))
  assert.equal(r.status,201)
  await until('route published',async()=>{const r=await fetch(B.base+'/rollback-probe/hello');await r.text();return r.status===200})
  const blocked=await update({rateLimitEnabled:true,replenishRate:1,burstCapacity:1,requestedTokens:2,monitorWindowSeconds:30,emitIntervalSeconds:3})
  await adoptB(blocked)
  const denied=await fetch(B.base+'/rollback-probe/hello');await denied.text();assert.equal(denied.status,429)
  const preview=await previewSource(reference(source));originalBody=rollbackRequest(reference(source),preview.current.version)
  const result=await restore(A,originalBody);assert.equal(result.status,200);originalRecovery=result.body.receipt;current=result.body
  const confirmed=performance.now(),propagation=await adoptB(current,confirmed)
  assert.ok(propagation.elapsedMs<=3000,JSON.stringify(propagation))
  const allowed=await fetch(B.base+'/rollback-probe/hello');await allowed.text();assert.equal(allowed.status,200)
  assert.deepEqual(runtimeValues(current),runtimeValues(source.after));assert.equal(Number(current.version.slice(37)),Number(blocked.version.slice(37))+1)
  const held=proxyB.holdNextRead()
  let extra
  try {
   await reached(held.reached)
   const before=proxyB.events.filter(e=>e.key===key).length
   const responses=await Promise.all(Array.from({length:20},async()=>{const r=await fetch(B.base+'/rollback-probe/hello');await r.text();return r.status}))
   await Promise.all(Array.from({length:10},()=>api(B,'/settings/runtime/adopted')))
   extra=proxyB.events.filter(e=>e.key===key).length-before;assert.equal(extra,0);assert.ok(responses.every(s=>s===200))
  } finally{held.release()}
  report.evidence.business={before:blocked,preview,request:originalBody,receipt:originalRecovery,propagation,beforeHttp:429,afterHttp:200,
   proxyRequests:20,localObservations:10,additionalConfigCommands:extra}
 })
 await check('Two real instances retry the same recovery concurrently: one increment, one history fact and one original receipt',async()=>{
  const body=rollbackRequest(reference(source));let release;const gate=new Promise(r=>release=r)
  const pending=[A,B].map(i=>gate.then(()=>restore(i,body)));release();const replies=await Promise.all(pending)
  assert.ok(replies.every(r=>r.status===200),JSON.stringify(replies));assert.deepEqual(replies[0].body.receipt,replies[1].body.receipt)
  assert.equal(replies.filter(r=>!r.body.replayed).length,1);assert.equal((await history(A)).entries.filter(r=>r.operationId===body.operationId).length,1)
  current=replies[0].body
  report.evidence.concurrent={body,replies}
 })
 await check('A normal commit racing B rollback on the same reviewed version produces one success and one recorded conflict',async()=>{
  const body=rollbackRequest(reference(source)),normal={...runtimeRequest(current),replenishRate:52}
  let release;const gate=new Promise(r=>release=r),pending=[gate.then(()=>submit(A,normal)),gate.then(()=>restore(B,body))]
  release();const replies=await Promise.all(pending);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409])
  current=replies.find(r=>r.status===200).body
  const rejected=replies.find(r=>r.status===409);assert.equal((await query(A,rejected.body.operationId)).status,'rejected')
  report.evidence.conflict={normal,rollback:body,replies}
 })
 await check('Same ID with changed source, type or expectedVersion fails while the original recovery remains unchanged',async()=>{
  const identicalSource=(await update(runtimeValues(source.after))).receipt,before=await raw()
  for(const body of [{...originalBody,source:reference(identicalSource)},{...originalBody,expectedVersion:current.version}]) {
   const r=await restore(B,body);assert.equal(r.status,409);assert.equal(r.body.code,'CONFIG_OPERATION_MISMATCH');assert.equal(await raw(),before)
  }
  const wrongType=await submit(B,{...runtimeValues(source.after),operationId:originalBody.operationId,expectedVersion:originalBody.expectedVersion})
  assert.equal(wrongType.body.code,'CONFIG_OPERATION_MISMATCH');assert.equal(await raw(),before)
  assert.deepEqual((await query(B,originalBody.operationId)).receipt,originalRecovery)
 })
 await check('Redis execution blocked before SET: query stays unknown; a deliberate identical retry uses the original identity',async()=>{
  const body=rollbackRequest(reference(source)),before=await raw(),boundary=proxy.arm('before'),pending=restore(A,body)
  await reached(boundary);const during=await query(B,body.operationId);assert.equal(during.status,'unknown')
  const lost=await pending;assert.equal(lost.body.outcome,'unknown');assert.equal(await raw(),before);proxy.recover()
  const retry=await restore(B,body);assert.equal(retry.status,200);current=retry.body
  report.evidence.beforeExecution={body,during,lost,retry}
 })
 await check('Redis executed rollback but acknowledgement was lost: another instance confirms the original source and success',async()=>{
  await until('A Redis reconnect',async()=>{const r=await request(A);return r.status===200},20000)
  const body=rollbackRequest(reference(source)),boundary=proxy.arm('after'),pending=restore(A,body)
  const captured=await reached(boundary),lost=await pending
  assert.equal(JSON.parse(captured.redisReply).status,'ok');assert.equal(lost.body.outcome,'unknown')
  const confirmed=await query(B,body.operationId);assert.equal(confirmed.status,'committed');current=confirmed.receipt.after
  await update({replenishRate:61},B);const before=await raw()
  const replay=await restore(B,body);assert.deepEqual(replay.body.receipt,confirmed.receipt);assert.equal(await raw(),before)
  proxy.recover();await until('A ready for browser',async()=>{const r=await request(A);return r.status===200},20000)
  report.evidence.redisReplyLoss={body,captured,lost,confirmed,replay,laterVersion:current.version}
 })
 if(!backendOnly){
 ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:uiPort,strictPort:true}})
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 await check('Actual browser: history selection, complete differences, real version conflict, explicit new operation and successful recovery',async()=>{
  const {page}=await pageSession();await page.locator('#setting-replenishRate').fill('43')
  await page.getByRole('button',{name:'提交历史 / 安全恢复',exact:true}).click();await page.locator('.settings-history-row').first().waitFor()
  await shot(page,'history-selection-1440.png');await choose(page)
  assert.equal(await page.locator('#setting-replenishRate').inputValue(),'43');await shot(page,'rollback-differences-1440.png')
  await update({replenishRate:64,monitorWindowSeconds:40});await confirm(page)
  await page.locator('.settings-rollback-error').waitFor();assert.equal(await page.locator('#setting-replenishRate').inputValue(),'43')
  const failed=browserWrites.at(-1);assert.equal(failed.path,'/settings/runtime/rollback')
  await shot(page,'rollback-conflict-1440.png')
  const beforeWrites=browserWrites.length
  await page.getByRole('button',{name:'重新读取恢复预览',exact:true}).click();await page.locator('.settings-rollback-error').waitFor({state:'hidden'})
  assert.equal(await page.locator('.settings-rollback-ack input').isChecked(),false);assert.equal(browserWrites.length,beforeWrites)
  await confirm(page);await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('历史恢复已确认'))
  assert.notEqual(browserWrites.at(-1).body.operationId,failed.body.operationId)
  current=await api(A);assert.deepEqual(runtimeValues(current),runtimeValues(source.after))
  await shot(page,'rollback-success-1440.png');await choose(page)
  assert.match(await page.locator('.settings-rollback-no-changes').textContent(),/完全一致/)
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await shot(page,'rollback-differences-390.png')
  report.evidence.browserConfirmed={failed,successful:browserWrites.at(-1),currentVersion:current.version,draftPreservedOnConflict:true}
  await context.close();context=null
 })
 await check('Real HTTP rollback response lost: auth recovery retains identity; querying historical success cannot regress current baseline or auto-submit',async()=>{
  await update({replenishRate:71,monitorWindowSeconds:45})
  const {page,control}=await pageSession();await choose(page);control.loseNext=true;await confirm(page)
  await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('未收到可靠'))
  const submitted=browserWrites.at(-1).body,receipt=(await query(B,submitted.operationId)).receipt
  assert.equal(control.lostResponse.status,200);assert.deepEqual(control.lostResponse.body.receipt,receipt)
  await page.locator('#setting-replenishRate').fill('43');control.expire=true
  await page.locator('.settings-query-operation').click();await page.locator('#admin-token').waitFor()
  control.expire=false;await login(page)
  assert.equal(await page.getByLabel('操作 ID',{exact:true}).inputValue(),submitted.operationId);assert.equal(await page.locator('#setting-replenishRate').inputValue(),'43')
  current=receipt.after;await update({replenishRate:88,monitorWindowSeconds:55})
  await page.locator('.settings-refresh').click();await ready(page)
  const beforeWrites=browserWrites.length;await page.locator('.settings-query-operation').click()
  await page.waitForFunction(()=>document.querySelector('.settings-operation')?.textContent.includes('原提交已成功'));await ready(page)
  assert.equal(browserWrites.length,beforeWrites);assert.equal(await page.getByLabel('存储已确认版本',{exact:true}).inputValue(),current.version)
  assert.equal(await page.locator('#setting-replenishRate').inputValue(),'43')
  const before=await raw(),retry=await restore(B,submitted);assert.deepEqual(retry.body.receipt,receipt);assert.equal(await raw(),before)
  report.evidence.httpReplyLoss={submitted,receipt,latestVersion:current.version,retry,queryIds:[...queryIds],automaticWrites:0}
  await shot(page,'rollback-old-receipt-current-1440.png');await context.close();context=null
 })
 await check('Actual in-flight history and preview responses become inert after explicit discard; cancel leave and new drafts remain protected',async()=>{
  const observations=[]
  for(const path of ['/settings/runtime/history','/settings/runtime/rollback-preview']) {
   const {page,control}=await pageSession();await page.locator('#setting-replenishRate').fill('43')
   if(path.endsWith('rollback-preview')) {await page.getByRole('button',{name:'提交历史 / 安全恢复',exact:true}).click();await page.locator('.settings-history-row').first().waitFor()}
   control.holdPath=path;control.held={started:deferred(),gate:deferred(),delivered:deferred()}
   if(path.endsWith('history'))await page.getByRole('button',{name:'提交历史 / 安全恢复',exact:true}).click()
   else await page.locator('.settings-history-row').filter({hasText:source.operationId}).click()
   await reached(control.held.started.promise);const writes=browserWrites.length
   control.decision='dismiss';await page.getByRole('link',{name:'运行概览',exact:true}).click();assert.match(page.url(),/\/settings$/)
   assert.equal(await page.locator('#setting-replenishRate').inputValue(),'43')
   control.decision='accept';await page.getByRole('link',{name:'运行概览',exact:true}).click();await page.waitForURL('http://127.0.0.1:'+uiPort+'/')
   await page.getByRole('link',{name:'系统配置',exact:true}).click();await ready(page);await page.locator('#setting-replenishRate').fill('45')
   control.held.gate.resolve();await reached(control.held.delivered.promise)
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
   assert.equal(await page.locator('#setting-replenishRate').inputValue(),'45');assert.equal(await page.getByLabel('操作 ID',{exact:true}).count(),0)
   assert.equal(await page.locator('.settings-history').count(),0);assert.equal(browserWrites.length,writes)
   observations.push({path,newDraft:'45',oldOperationAbsent:true,lateHistoryDidNotReopen:true,automaticWrites:0})
   await context.close();context=null
  }
  report.evidence.lifecycle=observations
 })
 }
 await check('Previewed source cropped before confirmation is rejected, but prior successful recovery remains confirmed',async()=>{
  await previewSource(reference(source));const before=await stored(),cropped=structuredClone(before)
  cropped.history=cropped.history.filter(r=>r.operationId!==source.operationId);await redis(['SET',key,JSON.stringify(cropped)])
  const rejected=await restore(A,rollbackRequest(reference(source)));assert.equal(rejected.status,410);assert.equal(rejected.body.outcome,'not-written')
  const immutable=await raw(),queried=await query(B,originalBody.operationId),retry=await restore(B,originalBody)
  assert.deepEqual(queried.receipt,originalRecovery);assert.deepEqual(retry.body.receipt,originalRecovery);assert.equal(await raw(),immutable)
  report.evidence.cropped={rejected,queried,retry}
 })
 await check('Restart restores the latest snapshot and keeps historical rollback receipts queryable across instances',async()=>{
  await stop(B);B=await start('B-restarted',proxyB.port)
  const adopted=await adoptB(current),queried=await query(B,originalBody.operationId)
  assert.deepEqual(queried.receipt,originalRecovery);assert.equal(adopted.version,current.version)
  report.evidence.restart={adopted,queried}
 })
 assert.deepEqual(pageErrors,[])
 if(!backendOnly) report.evidence.browser={writes:browserWrites,queryIds,pageErrors}
 report.notExecuted=backendOnly?['browser: rollback selection/conflict, HTTP reply loss, auth recovery and discard lifecycle']:[]
 report.evidence.observation={forbiddenRedisBackedReadsOnB:managementRequests.filter(r=>r.instance.startsWith('B')&&r.path==='/settings/runtime'&&r.method==='GET').length}
 report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1;console.error(error.stack)}
finally{
 if(context)await context.close();if(browser)await browser.close()
 report.cleanup.browserClosed=!browser||!browser.isConnected()
 if(ui){await new Promise(r=>ui.httpServer.close(r));report.cleanup.previewClosed=!ui.httpServer.listening}
 proxy?.recover();proxyB?.recover()
 for(const instance of instances){
  try{await stop(instance)}catch(error){report.cleanup[instance.label+'Error']=error.message;report.passed=false;process.exitCode=1
   if(instance.child.exitCode===null){const ended=new Promise(r=>instance.child.once('exit',r));instance.child.kill();await ended}}
  instance.log.end()
 }
 if(proxy){await proxy.close();report.cleanup.proxyClosed=true}
 if(proxyB){await writeFile(join(out,'B-redis-frames.json'),JSON.stringify(proxyB.events,null,2)+'\n');await proxyB.close();report.cleanup.proxyBClosed=true}
 upstream.closeAllConnections();await new Promise(r=>upstream.close(r));report.cleanup.upstreamClosed=true
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString()
 await writeFile(join(out,'management-requests.json'),JSON.stringify(managementRequests,null,2)+'\n')
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('Rollback verification: '+join(out,'report.json'))
}
