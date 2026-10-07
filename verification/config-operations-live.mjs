import {ownedSpawn as spawn,scopedDockerArgs} from './acceptance-scope.mjs'
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
import {faultProxy} from './runtime-config-fault-proxy.mjs'
const backendOnly=process.argv.includes('--backend-only')
let preview,chromium
if(!backendOnly){
 ({preview}=await import('../frontend/node_modules/vite/dist/node/index.js'));
 ({chromium}=await import('../.dev/browser/node_modules/playwright/index.mjs'))
}

const id=randomBytes(5).toString('hex'),name='zenith-operations-'+id,key='zg:operations:'+id
const out=resolve(process.env.CONFIG_OPERATIONS_OUTPUT||'.dev/config-operations/live-'+id)
await mkdir(out,{recursive:true})
const token=randomBytes(24).toString('hex'),password=randomBytes(24).toString('hex')
const image='redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499'
const script=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
const report={startedAt:new Date().toISOString(),isolated:true,checks:[],evidence:{},cleanup:{},passed:false,
 jarSha256:createHash('sha256').update(await readFile('backend/target/zg-1.0.0.jar')).digest('hex')}
const docker=args=>execFileSync('docker',scopedDockerArgs(args),{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const instances=[];let created=false,port,proxy,A,B,browser,context,ui,current
const uiPort=await freePort()
const initial={rateLimitEnabled:false,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
const redis=args=>redisCommand(port,args)
const raw=()=>redis(['GET',key])
const stored=async()=>JSON.parse(await raw())
const rev=v=>Number(v.slice(37))
async function freePort(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function until(label,probe,timeout=8000){const end=performance.now()+timeout;do{const result=await probe();if(result)return result;await delay(40)}while(performance.now()<end);throw new Error('Bounded wait: '+label)}
async function reached(promise){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fault boundary not reached')),6000)})])}finally{clearTimeout(timer)}}
async function request(instance,path='/settings/runtime',options={}){
 const response=await fetch(instance.base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(8000)})
 return {status:response.status,body:await response.json(),cacheControl:response.headers.get('cache-control')}
}
async function api(instance,path,options){const r=await request(instance,path,options);assert.equal(r.status,200,JSON.stringify(r));return r.body}
const submit=(instance,body)=>request(instance,'/settings/runtime',{method:'PUT',body:JSON.stringify(body)})
const query=(instance,operationId)=>api(instance,'/settings/runtime/operations/'+operationId)
const history=(instance,cursor='',limit=20)=>api(instance,'/settings/runtime/history?limit='+limit+'&cursor='+encodeURIComponent(cursor))
async function update(patch={},instance=B){const c=await api(instance);const r=await submit(instance,{...runtimeRequest(c),...patch});assert.equal(r.status,200,JSON.stringify(r));current=r.body;return r.body}
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
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379',image,'--save','','--appendonly','no']);created=true
 port=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 await until('Redis',async()=>{try{return await redis(['PING'])}catch{return false}})
 await redis(['ACL','SETUSER','operations-test','on','>'+password,'~*','+@all'])
 const legacy={...initial,schemaVersion:1,version:randomUUID()+':7'}
 await redis(['SET',key,JSON.stringify(legacy)]);proxy=await faultProxy(port,key)
 A=await start('A',proxy.port);B=await start('B',port);current=await api(B)

 await check('Schema-1 migration preserves six fields and version; old HTTP writers fail closed',async()=>{
  assert.equal(current.version,legacy.version);assert.deepEqual(runtimeValues(current),initial)
  assert.equal((await stored()).schemaVersion,3)
  const noId=await submit(A,{...initial,expectedVersion:current.version});assert.equal(noId.status,428);assert.equal(noId.body.code,'CONFIG_OPERATION_REQUIRED')
  for(const path of ['/settings/runtime/history','/settings/runtime/operations/'+randomUUID()]){
   assert.equal((await fetch(A.base+path)).status,401);assert.equal((await request(A,path)).cacheControl,'no-store')
  }
  assert.equal((await request(A,'/settings/runtime/history?limit=invalid')).cacheControl,'no-store')
  report.evidence.migration={before:legacy,after:await stored(),oldCaller:noId}
 })
 await check('In-flight or absent operation is UNKNOWN, never not-executed; bounded transport failure preserves that fact',async()=>{
  const body={...runtimeRequest(current),replenishRate:31}
  const boundary=proxy.arm('before'),pending=submit(A,body);await reached(boundary)
  const during=await query(B,body.operationId);assert.equal(during.status,'unknown')
  const result=await pending;assert.equal(result.body.outcome,'unknown')
  assert.equal((await stored()).version,current.version);proxy.recover()
  const retry=await submit(B,body);assert.equal(retry.status,200);current=retry.body
  assert.equal((await query(B,body.operationId)).receipt.after.version,current.version)
  report.evidence.beforeExecution={body,during,result,retry}
 })
 let original,originalRequest
 await check('Two real instances submit the same ID and request concurrently: one increment, one receipt, identical original outcome',async()=>{
  originalRequest={...runtimeRequest(current),replenishRate:32}
  // Warm reconnection with a read; this read is not counted as sync evidence.
  await until('A management connection',async()=>{const r=await request(A);return r.status===200},20000)
  let release;const barrier=new Promise(r=>release=r)
  const sends=[A,B].map((instance,index)=>(async()=>{await barrier;
   if(!index)return submit(instance,originalRequest)
   const reordered=JSON.stringify(Object.fromEntries(Object.entries(originalRequest).reverse())).replace('"replenishRate":32','"replenishRate":32.0')
   return request(instance,'/settings/runtime',{method:'PUT',body:reordered})
  })())
  const startedAt=new Date().toISOString();release();const responses=await Promise.all(sends)
  assert.ok(responses.every(r=>r.status===200),JSON.stringify(responses))
  assert.deepEqual(responses[0].body.receipt,responses[1].body.receipt)
  original=responses[0].body.receipt
  assert.equal(rev(original.after.version),rev(current.version)+1)
  assert.equal((await history(B)).entries.filter(r=>r.operationId===originalRequest.operationId).length,1)
  current=responses[0].body
  report.evidence.concurrent={startedAt,confirmedAt:new Date().toISOString(),request:originalRequest,responses}
 })
 await check('Same ID with changed values OR expectedVersion is rejected without changing configuration or original receipt',async()=>{
  const before=await raw()
  for(const patch of [{replenishRate:33},{expectedVersion:current.version}]){
   const r=await submit(B,{...originalRequest,...patch});assert.equal(r.status,409);assert.equal(r.body.code,'CONFIG_OPERATION_MISMATCH')
   assert.equal(await raw(),before);assert.deepEqual((await query(A,originalRequest.operationId)).receipt,original)
  }
 })
 await check('Later commits remain intact when another instance queries and retries an earlier successful operation',async()=>{
  const later=await update({monitorWindowSeconds:30}),before=await raw()
  const queried=await query(B,originalRequest.operationId),retry=await submit(A,originalRequest)
  assert.deepEqual(queried.receipt,original);assert.deepEqual(retry.body.receipt,original);assert.equal(retry.body.replayed,true)
  assert.equal(await raw(),before)
  await until('A automatic adoption',async()=>{const s=await api(A,'/settings/runtime/sync');return s.adoptedVersion===later.version},6000)
  const adopted=await api(A,'/settings/runtime/adopted');assert.equal(adopted.version,later.version)
  report.evidence.oldOperation={queried,retry,adopted,currentVersion:later.version}
 })
 await check('A recorded version conflict is a definite rejection and its replay cannot turn into a new write',async()=>{
  const body={...runtimeRequest(initial,legacy.version),replenishRate:77},before=await raw()
  const rejected=await submit(B,body);assert.equal(rejected.status,409)
  assert.equal((await stored()).version,current.version)
  const q=await query(A,body.operationId);assert.equal(q.status,'rejected');assert.equal(q.receipt.code,'CONFIG_VERSION_CONFLICT')
  await update({emitIntervalSeconds:2})
  const replay=await submit(A,body);assert.equal(replay.status,409);assert.deepEqual(replay.body.receipt,q.receipt)
  assert.equal((await stored()).version,current.version)
  report.evidence.definiteRejection={request:body,rejected,query:q,replay,receiptAddedWithoutVersionChange:before!==await raw()}
 })
 await check('Redis executed SET but its reply is lost: cross-instance receipt proves the original success even after another commit',async()=>{
  const body={...runtimeRequest(current),replenishRate:34},boundary=proxy.arm('after'),pending=submit(A,body)
  const fault=await reached(boundary),unconfirmed=await pending
  assert.equal(unconfirmed.body.outcome,'unknown');assert.equal(JSON.parse(fault.redisReply).status,'ok')
  const q=await query(B,body.operationId);assert.equal(q.status,'committed');assert.equal(q.receipt.after.replenishRate,34)
  await update({replenishRate:35});const latest=await raw()
  const retry=await submit(B,body);assert.equal(retry.status,200);assert.deepEqual(retry.body.receipt,q.receipt);assert.equal(await raw(),latest)
  proxy.recover()
  report.evidence.redisReplyLoss={body,fault,unconfirmed,query:q,retry,laterVersion:current.version}
 })
 await check('Gateway restart keeps cross-instance receipts and duplicate submission returns the original receiving instance',async()=>{
  await stop(A);A=await start('A-restarted',proxy.port)
  const q=await query(A,originalRequest.operationId);assert.deepEqual(q.receipt,original)
  const before=await raw(),retry=await submit(A,originalRequest)
  assert.equal(retry.status,200);assert.deepEqual(retry.body.receipt,original);assert.equal(await raw(),before)
  assert.notEqual((await api(A,'/settings/runtime/sync')).instanceId,original.instanceId)
  report.evidence.restart={query:q,retry}
 })
 await check('Errors before the sole SET leave both configuration and receipts unchanged; multi-command Lua has no rollback',async()=>{
  const target=key+':failure',old=await init(target),body=runtimeRequest(old.snapshot),before=await redis(['GET',target])
  // Real ACL failure at the commit command, not a mock success path.
  await redis(['ACL','SETUSER','no-set','on','>isolated-secret','~'+target,'+get','+time','+eval'])
  const rejected=await lua(target,'write',body.expectedVersion,body,body.operationId,randomUUID(),{username:'no-set',password:'isolated-secret'})
  assert.equal(rejected.status,'rejected');assert.equal(await redis(['GET',target]),before)
  assert.equal((await lua(target,'operation','', '{}',body.operationId)).status,'unknown')
  // Deliberately inject a failure at the exact pre-SET boundary in a separate script variant.
  const injected=script.replace("local written = redis.pcall('SET', KEYS[1], encoded)","error('injected before sole commit command')\n    local written = redis.pcall('SET', KEYS[1], encoded)")
  await assert.rejects(()=>redis(['EVAL',injected,1,target,'write',body.expectedVersion,JSON.stringify(runtimeValues(body)),body.operationId,randomUUID()]),/injected before/)
  assert.equal(await redis(['GET',target]),before)
  // Counterexample: earlier commands survive a later WRONGTYPE error.
  const bad=key+':naive'
  await redis(['SET',bad,'original'])
  await assert.rejects(()=>redis(['EVAL',"redis.call('SET',KEYS[1],'updated');redis.call('HSET',KEYS[1],'receipt','missing')",1,bad]),/WRONGTYPE/)
  assert.equal(await redis(['GET',bad]),'updated')
  report.evidence.commandFailure={rejected,unchangedDocument:true,injectedBeforeCommit:true,naiveLuaAfterError:await redis(['GET',bad])}
  await redis(['DEL',target,bad]);await redis(['ACL','DELUSER','no-set'])
 })
 await check('History has stable keyset pagination under new commits and count trimming does not remove promised receipts',async()=>{
  const target=key+':pagination';let c=(await init(target)).snapshot
  let first
  for(let n=0;n<110;n++){const body=runtimeRequest(c);const r=await lua(target,'write',c.version,body,body.operationId);if(!first)first=body;c=r.snapshot}
  const page=await lua(target,'history','', '20'),ids=new Set(page.entries.map(r=>r.operationId)),boundary=page.nextCursor
  assert.equal(page.entries.length,20);assert.ok(boundary)
  const document=JSON.parse(await redis(['GET',target]));assert.equal(document.history.length,100);assert.equal(Object.keys(document.operations).length,110)
  assert.equal((await lua(target,'operation','','{}',first.operationId)).status,'committed')
  for(let n=0;n<5;n++){const body=runtimeRequest(c);c=(await lua(target,'write',c.version,body,body.operationId)).snapshot}
  let cursor=boundary,total=page.entries.length
  do{const p=await lua(target,'history',cursor,'20');for(const entry of p.entries){assert.ok(!ids.has(entry.operationId));assert.ok(rev(entry.after.version)<rev(boundary));ids.add(entry.operationId);total++}cursor=p.nextCursor}while(cursor)
  // Last five records were trimmed between pages, so a stable traversal can contain gaps.
  assert.equal(total,95)
  assert.equal((await lua(target,'operation','','{}',first.operationId)).status,'committed')
  report.evidence.pagination={firstPageVersions:page.entries.map(r=>r.after.version),cursor:boundary,totalReturned:total,
   concurrentNewCommits:5,noDuplicates:true,receiptSurvivedHistoryTrimming:true}
  await redis(['DEL',target])
 })
 await check('Receipt expiry, seven-day history expiry, capacity admission and cleanup remain bounded without sleeping',async()=>{
  const target=key+':retention';let c=(await init(target)).snapshot
  const first=runtimeRequest(c),r=await lua(target,'write',c.version,first,first.operationId);c=r.snapshot
  let doc=JSON.parse(await redis(['GET',target]))
  const now=Date.now(),expiredAt=now-86401000
  for(const receipt of [doc.operations[first.operationId],...doc.history]){receipt.recordedAt=expiredAt;receipt.expiresAt=expiredAt+86400000}
  // Test-only stored timestamps put records exactly past the deadline; production has no clock override.
  await redis(['SET',target,JSON.stringify(doc)])
  assert.equal((await lua(target,'operation','','{}',first.operationId)).status,'unknown')
  assert.equal((await lua(target,'history','','20')).entries.length,1)
  const next=runtimeRequest(c);c=(await lua(target,'write',c.version,next,next.operationId)).snapshot
  doc=JSON.parse(await redis(['GET',target]));assert.ok(!doc.operations[first.operationId]);assert.equal(doc.history.length,2)
  // Expire both record families, and verify read-side filtering before physical cleanup.
  for(const receipt of [...Object.values(doc.operations),...doc.history]){receipt.recordedAt=now-604801000;receipt.expiresAt=receipt.recordedAt+86400000}
  await redis(['SET',target,JSON.stringify(doc)])
  const oldHistory=await lua(target,'history','','20');assert.equal(Object.keys(oldHistory.entries).length,0)
  const cleaned=await lua(target,'write',c.version,c);c=cleaned.snapshot
  doc=JSON.parse(await redis(['GET',target]));assert.equal(doc.history.length,1);assert.equal(Object.keys(doc.operations).length,1)
  // Fill 512 active receipts via real serialized submissions; no premature eviction.
  let retryBody
  for(let n=1;n<512;n++){retryBody=runtimeRequest(c);const result=await lua(target,'write',c.version,retryBody,retryBody.operationId);assert.equal(result.status,'ok');c=result.snapshot}
  const full=await redis(['GET',target]),started=performance.now()
  const rejected=await lua(target,'write',c.version,c)
  assert.equal(rejected.status,'receipt-capacity');assert.equal(await redis(['GET',target]),full)
  const replay=await lua(target,'write',retryBody.expectedVersion,retryBody,retryBody.operationId)
  assert.equal(replay.status,'ok');assert.equal(replay.replayed,true)
  const checkTimes=[]
  for(let i=0;i<10;i++){const t=performance.now();assert.equal((await lua(target,'read')).status,'ok');checkTimes.push(performance.now()-t)}
  report.evidence.retention={receiptMs:86400000,historyMs:604800000,receiptCount:512,historyCount:100,
   expiredQuery:'unknown',expiredPhysicallyRemovedOnNextWrite:true,capacityResult:rejected,
   replayAtCapacity:true,documentBytes:Buffer.byteLength(full),boundedFullDocumentReadMs:checkTimes,capacityRoundTripMs:performance.now()-started}
  await redis(['DEL',target])
 })
 if(!backendOnly) await check('Actual browser: lost HTTP response, auth expiry, query old success, preserved draft and explicit conflict resubmission',async()=>{
  ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:uiPort,strictPort:true}})
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
  context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
  const page=await context.newPage(),errors=[],writes=[]
  page.on('pageerror',e=>errors.push(e.message))
  let loseNext=false,authExpired=false
  await page.route('**/api/**',async route=>{
   try{
   const r=route.request(),u=new URL(r.url()),path=u.pathname.slice(4),headers={...r.headers()}
   if(authExpired)headers.authorization='Bearer expired-for-isolated-test'
   if(path==='/settings/runtime'&&r.method()==='PUT')writes.push(JSON.parse(r.postData()))
   const response=await route.fetch({url:B.base+path+u.search,headers})
   if(loseNext&&path==='/settings/runtime'&&r.method()==='PUT'){
    loseNext=false;assert.equal(response.status(),200);await route.abort('failed');return
   }
   await route.fulfill({response})
   }catch(error){errors.push(error.message);await route.abort().catch(()=>{})}
  })
  await page.goto('http://127.0.0.1:'+ui.httpServer.address().port+'/settings')
  await page.locator('#admin-token').fill(token);await page.getByRole('button',{name:'连接',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  const rate=page.locator('#setting-replenishRate')
  await rate.fill('71');loseNext=true;await page.locator('.settings-save').click()
  await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('未收到可靠'))
  const lost=writes.at(-1),oldSuccess=await query(A,lost.operationId)
  assert.equal(oldSuccess.status,'committed')
  assert.equal(await page.getByLabel('操作 ID',{exact:true}).inputValue(),lost.operationId)
  authExpired=true;await page.locator('.settings-query-operation').click();await page.locator('#admin-token').waitFor()
  authExpired=false;await page.locator('#admin-token').fill(token);await page.getByRole('button',{name:'连接',exact:true}).click()
  await page.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  assert.equal(await page.getByLabel('操作 ID',{exact:true}).inputValue(),lost.operationId);assert.equal(await rate.inputValue(),'71')
  await rate.fill('73') // new edits made during confirmation must survive the old receipt
  const latest=await update({replenishRate:72,monitorWindowSeconds:45})
  await page.locator('.settings-refresh').click()
  await page.waitForFunction(v=>document.querySelector('[aria-label=\"存储已确认版本\"]')?.value===v,latest.version)
  const beforeWrites=writes.length
  await page.locator('.settings-query-operation').click()
  await page.waitForFunction(()=>document.querySelector('.settings-operation')?.textContent.includes('原提交已成功'))
  await page.waitForFunction(()=>document.querySelector('.settings-refresh')?.disabled===false)
  assert.equal(writes.length,beforeWrites);assert.equal(await rate.inputValue(),'73')
  assert.equal(await page.getByLabel('存储已确认版本',{exact:true}).inputValue(),latest.version)
  assert.match(await page.locator('.settings-operation').textContent(),new RegExp(oldSuccess.receipt.after.version))
  await page.screenshot({path:join(out,'old-receipt-current-baseline-1440.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390)
  await page.screenshot({path:join(out,'old-receipt-current-baseline-390.png'),fullPage:true})
  await page.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await page.locator('.settings-save').click()
  await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
  assert.notEqual(writes.at(-1).operationId,lost.operationId)
  // A second writer races the reviewed form. Conflict requires review AND a fresh ID.
  await rate.fill('74');await update({monitorWindowSeconds:55})
  await page.locator('.settings-save').click();await page.locator('.settings-version-conflict').waitFor()
  const conflictId=writes.at(-1).operationId
  await page.locator('.settings-refresh').click()
  await page.waitForFunction(()=>document.querySelector('.settings-refresh')?.disabled===false)
  assert.match(await page.locator('.settings-version-conflict').textContent(),/45 → 55/)
  await page.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await page.locator('.settings-save').click()
  await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
  assert.notEqual(writes.at(-1).operationId,conflictId);assert.equal(writes.at(-1).monitorWindowSeconds,55)
  assert.deepEqual(errors,[])
  report.evidence.browser={httpReplyLostOperation:lost,originalReceipt:oldSuccess.receipt,laterVersion:latest.version,
   writes,oldQueryDidNotRegressBaseline:true,noAutomaticWriteDuringQuery:true,draftSurvivedAuth:true,errors}
  await context.close();context=null;await browser.close();browser=null
 })
 report.notExecuted=backendOnly?['browser: HTTP reply loss, auth recovery and conflict UI']:[]
 report.passed=true
}catch(error){report.failure=error.stack;process.exitCode=1}
finally{
 if(context)await context.close()
 if(browser)await browser.close()
 if(ui)await new Promise(r=>ui.httpServer.close(r))
 proxy?.recover()
 for(const instance of instances){
  try{await stop(instance)}catch(error){report.cleanup[instance.label+'Error']=error.message;report.passed=false;process.exitCode=1
   if(instance.child.exitCode===null){const ended=new Promise(r=>instance.child.once('exit',r));instance.child.kill();await ended}}
  instance.log.end()
 }
 if(proxy){await proxy.close();report.cleanup.proxyClosed=true}
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString()
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
 console.log('Operations verification: '+join(out,'report.json'))
 if(!report.passed)console.error(report.failure)
}
