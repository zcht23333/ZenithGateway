import {withRouteVersion} from '../benchmarks/route-client.mjs'
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,readFile,writeFile,copyFile} from 'node:fs/promises'
import {randomBytes,randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import assert from 'node:assert/strict'
import {redisCommand} from '../benchmarks/redis.mjs'
import {faultProxy} from './runtime-config-fault-proxy.mjs'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'

// The original manual-confirmation fault matrix intentionally disables background adoption.
// Automatic multi-instance convergence is verified by config-sync-live.mjs.
const ui=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15175'
const token=randomBytes(24).toString('hex'),redisPassword=randomBytes(24).toString('hex')
const name='zenith-config-cas-'+randomBytes(5).toString('hex'),prefix='zg:config-cas:'+randomUUID(),key=prefix+':runtime'
const out=process.env.CONFIG_CONSISTENCY_OUTPUT||'.dev/config-consistency/run-'+randomUUID(),report={startedAt:new Date().toISOString(),isolated:true,redis:'7.4-alpine',checks:[],evidence:{},pageErrors:[],cleanup:{},passed:false}
const images=process.env.CONFIG_CONSISTENCY_IMAGES||out+'/images'
await mkdir(images,{recursive:true});await mkdir(out,{recursive:true});await mkdir('docs/images',{recursive:true});await mkdir('docs/media',{recursive:true})
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r))
const port=reserve.address().port;await new Promise(r=>reserve.close(r))
const upstream=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('isolated '+req.url)})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const base='http://127.0.0.1:'+port,script=await readFile('backend/src/main/resources/runtime-config.lua','utf8')
const fields=['rateLimitEnabled','replenishRate','burstCapacity','requestedTokens','monitorWindowSeconds','emitIntervalSeconds']
const values=config=>Object.fromEntries(fields.map(k=>[k,config[k]]))
const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:20,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
let redisPort,proxy,java,created=false,browser,context,baseline,log,starts=0
const command=args=>redisCommand(redisPort,args)
const stored=async()=>JSON.parse(await command(['GET',key]))
async function request(path,options={}) {
 const response=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(9000)})
 return {status:response.status,body:await response.json(),cacheControl:response.headers.get('cache-control')}
}
async function api(path='/settings/runtime',options={}){
 const result=await request(path,options);assert.equal(result.status,200,JSON.stringify(result));return result.body
}
const put=(config,patch={},expected=config.version)=>request('/settings/runtime',{method:'PUT',body:JSON.stringify({...values(config),...patch,expectedVersion:expected,operationId:randomUUID()})})
const lua=async(mode,expected='',candidate=initial,target=key)=>JSON.parse(await command(['EVAL',script,1,target,mode,expected,JSON.stringify(values(candidate)),randomUUID(),randomUUID()]))
async function check(label,fn){await fn();report.checks.push(label);console.log('PASS '+label)}
async function start(expectReady=true){
 starts++;log=createWriteStream(out+'/backend-live-'+starts+'.log')
 java=spawn(process.env.JAVA_HOME+'/bin/java.exe',['-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+proxy.port,'--spring.data.redis.username=config-test','--spring.data.redis.database=0',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+key,
  '--zenith.audit.enabled=false','--zenith.runtime.sync.enabled=false','--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown',
  '--spring.cloud.inetutils.default-hostname=isolated-test'],{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token,REDIS_PASSWORD:redisPassword}})
 java.stdout.pipe(log,{end:false});java.stderr.pipe(log,{end:false})
 const deadline=Date.now()+50000;let statuses=[]
 while(Date.now()<deadline&&java.exitCode===null){
  try{const r=await request('/actuator/health/readiness');statuses.push(r.status);if(r.status===200){assert.ok(expectReady);return}}catch{}
  await delay(150)
 }
 if(expectReady)throw new Error('Isolated backend did not become ready; see backend-live-'+starts+'.log')
 assert.notEqual(java.exitCode,0);assert.ok(!statuses.includes(200));report.evidence.invalidStartup={exitCode:java.exitCode,readinessStatuses:statuses}
}
async function stop(){
 if(java?.exitCode===null){
  try{await request('/actuator/shutdown',{method:'POST',body:'{}'})}catch{}
  const deadline=Date.now()+20000;while(java.exitCode===null&&Date.now()<deadline)await delay(100)
  if(java.exitCode===null)java.kill()
  if(java.exitCode===null)await once(java,'exit')
 }
 log?.end()
}
async function recoveredRead(){
 const deadline=Date.now()+10000
 while(Date.now()<deadline){const r=await request('/settings/runtime');if(r.status===200)return r.body;await delay(100)}
 throw new Error('Redis connection did not recover')
}
try {
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);created=true
 redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 await command(['ACL','SETUSER','config-test','on','>'+redisPassword,'~*','+@all'])
 proxy=await faultProxy(redisPort,key)
 await command(['SET',key,JSON.stringify(initial)]) // Real old six-field JSON, migrated on startup.
 await start();baseline=await api()
 await check('Legacy six-field JSON migrates on startup; GET and adopted expose one version and no-store',async()=>{
  assert.deepEqual(values(baseline),initial);assert.match(baseline.version,/:1$/)
  assert.equal((await stored()).schemaVersion,3);assert.equal(baseline.source,'redis');assert.equal(baseline.confirmation,'read')
  assert.deepEqual(baseline.adopted,{...initial,version:baseline.version})
  assert.equal((await api('/settings/runtime/adopted')).source,'local')
  assert.equal((await request('/settings/runtime')).cacheControl,'no-store')
  report.evidence.migration={legacy:initial,response:baseline,stored:await stored()}
 })
 await check('Missing versions and invalid fields are definitively rejected without storage changes',async()=>{
  const old=await request('/settings/runtime',{method:'PUT',body:JSON.stringify(initial)})
  assert.equal(old.status,428);assert.equal(old.body.outcome,'not-written')
  for(const patch of [{replenishRate:1.2},{monitorWindowSeconds:121},{rateLimitEnabled:'true'},{emitIntervalSeconds:null}]){
   const r=await put(baseline,patch);assert.equal(r.status,400);assert.equal(r.body.outcome,'not-written')
  }
  assert.equal((await stored()).version,baseline.version)
  const anonymous=await fetch(base+'/settings/runtime/adopted');assert.equal(anonymous.status,401)
 })
 await check('A window=30 succeeds; stale B rate=40 conflicts and cannot restore window=10',async()=>{
  const a=await api(),b=await api()
  const accepted=await put(a,{monitorWindowSeconds:30}),conflict=await put(b,{replenishRate:40})
  assert.equal(accepted.status,200);assert.equal(conflict.status,409)
  assert.equal(conflict.body.current.monitorWindowSeconds,30);assert.equal(conflict.body.outcome,'not-written')
  assert.equal((await stored()).monitorWindowSeconds,30);assert.equal((await stored()).replenishRate,20)
  report.evidence.sequential={aRead:a,bRead:b,accepted,conflict,stored:await stored()}
 })
 await check('Twelve independent same-version HTTP writers released by one gate produce exactly one commit',async()=>{
  const original=await api();let release;const gate=new Promise(resolve=>{release=resolve})
  const attempts=Array.from({length:12},(_,i)=>(async()=>{await gate;return put(original,{replenishRate:100+i})})())
  release();const results=await Promise.all(attempts)
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===409).length,11)
  const accepted=results.find(r=>r.status===200).body
  assert.equal(Number(accepted.version.split(':')[1]),Number(original.version.split(':')[1])+1)
  assert.equal((await stored()).version,accepted.version)
  report.evidence.concurrent={expectedVersion:original.version,statuses:results.map(r=>r.status),accepted}
 })
 await check('Concurrent API reads match complete snapshots in the real storage commit ledger',async()=>{
  const original=await api(),ledger=new Map([[original.version,values(original)]]),reads=[]
  let release;const gate=new Promise(r=>{release=r})
  const writer=(async()=>{await gate;let current=original;for(let i=0;i<24;i++){
   const next={...initial,rateLimitEnabled:i%2===0,replenishRate:40+i,burstCapacity:80+i,requestedTokens:1+i%3,monitorWindowSeconds:10+i,emitIntervalSeconds:1+i%4}
   const committed=await lua('write',current.version,next);assert.equal(committed.status,'ok')
   current=committed.snapshot;ledger.set(current.version,values(current))
  }})()
  const readers=Array.from({length:4},()=> (async()=>{await gate;for(let i=0;i<12;i++)reads.push(await api())})())
  release();await Promise.all([writer,...readers])
  for(const read of reads){assert.deepEqual(values(read),ledger.get(read.version));assert.deepEqual(values(read.adopted),ledger.get(read.adopted.version))}
  report.evidence.wholeReads={commits:24,reads:reads.length,distinctReadVersions:new Set(reads.map(r=>r.version)).size}
 })
 await check('Redis ACL rejection proves not-written and leaves both stored and local snapshots unchanged',async()=>{
  const before=await api();await command(['ACL','SETUSER','config-test','-set'])
  try{
   const r=await put(before,{replenishRate:77});assert.equal(r.status,503);assert.equal(r.body.outcome,'not-written')
   assert.equal(r.body.code,'CONFIG_STORAGE_REJECTED');assert.equal((await stored()).version,before.version)
   assert.equal((await api('/settings/runtime/adopted')).version,before.version)
   report.evidence.knownRejection=r
  }finally{await command(['ACL','SETUSER','config-test','+set'])}
 })
 for(const phase of ['before','after'])await check('Redis '+phase+'-execution reply fault is conservative; explicit storage read converges',async()=>{
  const before=await api(),reached=proxy.arm(phase),pending=put(before,{replenishRate:phase==='before'?78:79})
  const fault=await Promise.race([reached,delay(10000).then(()=>{throw new Error('Fault point not reached')})])
  const response=await pending;assert.equal(response.status,503);assert.equal(response.body.outcome,'unknown')
  const persisted=await stored(),local=await api('/settings/runtime/adopted')
  assert.equal(local.version,before.version)
  if(phase==='after'){
   const acknowledgement=JSON.parse(fault.redisReply);assert.equal(acknowledgement.status,'ok')
   assert.equal(persisted.version,acknowledgement.snapshot.version);assert.equal(persisted.replenishRate,79)
   assert.notEqual(persisted.version,local.version)
  }else assert.equal(persisted.version,before.version)
  const unavailable=await request('/settings/runtime');assert.equal(unavailable.status,503);assert.equal(unavailable.body.code,'CONFIG_READ_UNAVAILABLE')
  proxy.recover();const read=await recoveredRead()
  assert.equal(read.version,persisted.version);assert.equal(read.adopted.version,read.version)
  report.evidence[phase+'ExecutionFault']={fault,response,persisted,local,unavailable,read}
 })
 await check('A current storage read after a lost acknowledgement can see a later writer, without attributing the original request',async()=>{
  const before=await api(),reached=proxy.arm('after'),pending=put(before,{replenishRate:80})
  await reached;const uncertain=await pending;assert.equal(uncertain.body.outcome,'unknown')
  const originalCommit=await stored();const later=await lua('write',originalCommit.version,{...values(originalCommit),replenishRate:81})
  assert.equal(later.status,'ok');proxy.recover()
  const confirmed=await recoveredRead();assert.equal(confirmed.replenishRate,81);assert.equal(confirmed.confirmation,'read')
  report.evidence.interleavedConfirmation={uncertain,originalCommit,later:later.snapshot,read:confirmed}
 })

 await check('Concurrent missing-key initialization and legacy migration have one winner without overwriting values',async()=>{
  for(const legacy of [false,true]){
   const target=prefix+':init:'+legacy
   if(legacy)await command(['SET',target,JSON.stringify({...initial,replenishRate:37})])
   let release;const gate=new Promise(r=>{release=r})
   const attempts=Array.from({length:12},(_,i)=>(async()=>{await gate;return lua('init',randomUUID()+':1',{...initial,replenishRate:100+i},target)})())
   release();const results=await Promise.all(attempts)
   assert.ok(results.every(r=>r.status==='ok'))
   assert.equal(new Set(results.map(r=>r.snapshot.version)).size,1)
   if(legacy)assert.ok(results.every(r=>r.snapshot.replenishRate===37))
   report.evidence[legacy?'concurrentMigration':'concurrentInitialization']={clients:12,confirmed:results[0].snapshot}
   await command(['DEL',target])
  }
 })
 await check('Invalid legacy/schema/types/ranges and exhausted revisions are rejected unchanged',async()=>{
  const target=prefix+':invalid'
  for(const raw of ['{invalid','{"replenishRate":37}',JSON.stringify({...initial,monitorWindowSeconds:121}),
   JSON.stringify({...initial,schemaVersion:3,version:randomUUID()+':1'}),JSON.stringify({...initial,schemaVersion:1,version:randomUUID()+':01'})]){
   await command(['SET',target,raw]);assert.equal((await lua('init',randomUUID()+':1',initial,target)).status,'invalid')
   assert.equal(await command(['GET',target]),raw)
  }
  const max={...initial,schemaVersion:3,operations:{},history:[],version:randomUUID()+':9007199254740991'}
  await command(['SET',target,JSON.stringify(max)])
  assert.equal((await lua('write',max.version,initial,target)).status,'exhausted')
  assert.equal(JSON.parse(await command(['GET',target])).version,max.version)
  await command(['DEL',target])
 })
 await check('Online key loss never silently initializes and a new generation cannot replace a running local snapshot',async()=>{
  const original=await stored()
  await command(['DEL',key])
  assert.equal((await request('/settings/runtime')).body.code,'CONFIG_STORAGE_MISSING')
  assert.equal(await command(['EXISTS',key]),0)
  const foreign={...original,version:randomUUID()+':1'}
  await command(['SET',key,JSON.stringify(foreign)])
  const read=await request('/settings/runtime');assert.equal(read.body.code,'CONFIG_ADOPTION_FAILED')
  assert.equal(read.body.confirmed.version,foreign.version);assert.equal(read.body.adopted.version,original.version)
  await command(['SET',key,JSON.stringify(original)])
  assert.equal((await api()).version,original.version)
 })
 await check('A restarted gateway restores exactly the stored version and all six values',async()=>{
  const before=await api();await stop();await start()
  const after=await api();assert.equal(after.version,before.version);assert.deepEqual(values(after),values(before))
  report.evidence.restart={before,after}
 })
 const reset=await put(await api(),initial);assert.equal(reset.status,200)
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 const p=await context.newPage();p.setDefaultTimeout(8000);p.on('pageerror',error=>report.pageErrors.push(error.message))
 let puts=0,loseNext=false,readUnavailable=false,invalidAuth=false
 await p.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url()),path=url.pathname.slice(4)
  if(path==='/monitor/stream'){await route.continue({url:base+path+url.search});return}
  assert.ok(r.method()==='GET'||(path==='/settings/runtime'&&r.method()==='PUT'))
  if(path==='/settings/runtime'&&r.method()==='PUT')puts++
  if(readUnavailable&&path==='/settings/runtime'&&r.method()==='GET'){
   await route.fulfill({status:503,json:{code:'CONFIG_READ_UNAVAILABLE',message:'独立测试：存储读取不可用'}});return
  }
  const headers={...r.headers()};if(invalidAuth)headers.authorization='Bearer expired-test-token'
  const response=await route.fetch({url:base+path+url.search,headers})
  if(loseNext&&path==='/settings/runtime'&&r.method()==='PUT'){
   loseNext=false;assert.equal(response.status(),200);await route.abort('failed');return
  }
  await route.fulfill({response})
 })
 const field=k=>p.locator('#setting-'+k)
 const message=text=>p.waitForFunction(text=>document.querySelector('.settings-write-message')?.textContent.includes(text),text)
 async function screenshot(file){
  await p.evaluate(()=>{
   if(!document.querySelector('#isolation-label')){
    const el=document.createElement('div');el.id='isolation-label';el.textContent='独立测试环境 · 实际后端与 Redis 数据'
    Object.assign(el.style,{position:'fixed',bottom:'8px',left:'8px',zIndex:'999',background:'#17221a',color:'#c9ef86',padding:'6px 10px',fontSize:'12px',border:'1px solid #738443',borderRadius:'5px',pointerEvents:'none'});document.body.append(el)
   }
  })
  await p.screenshot({path:images+'/'+file,fullPage:true})
 }
 await check('Browser stale form preserves its draft and requires explicit conflict review before the second PUT',async()=>{
  await p.goto(ui+'/settings');await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  await field('replenishRate').fill('40')
  const a=await put(await api(),{monitorWindowSeconds:30});assert.equal(a.status,200)
  await p.locator('.settings-save').click();await p.locator('.settings-version-conflict').waitFor()
  assert.equal(await field('replenishRate').inputValue(),'40');assert.equal(await field('monitorWindowSeconds').inputValue(),'30')
  assert.equal(await p.locator('.settings-save').isDisabled(),true);assert.equal(puts,1)
  assert.match(await p.locator('.settings-remote-change').textContent(),/10 → 30/)
  await screenshot('config-consistency-conflict-1440.png')
  await p.setViewportSize({width:390,height:844})
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390)
  await screenshot('config-consistency-conflict-390.png')
  await p.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await p.locator('.settings-save').click();await message('保存已确认')
  assert.equal(puts,2);assert.equal((await stored()).replenishRate,40);assert.equal((await stored()).monitorWindowSeconds,30)
  await p.setViewportSize({width:1440,height:900});await p.evaluate(()=>scrollTo(0,0))
 })
 await check('HTTP success response loss preserves uncertainty through failed reads and reconciles without another PUT',async()=>{
  loseNext=true;await field('replenishRate').fill('44');await p.locator('.settings-save').click();await message('未收到可靠')
  const count=puts;assert.equal((await stored()).replenishRate,44)
  readUnavailable=true;await p.getByRole('button',{name:'读取服务端当前值',exact:true}).click();await p.locator('.settings-read-error').waitFor()
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await screenshot('config-consistency-unconfirmed-1440.png')
  readUnavailable=false;await p.getByRole('button',{name:'读取服务端当前值',exact:true}).click();await message('不能证明原提交')
  await p.locator('.settings-query-operation').click();await message('此前存储写入已确认')
  if(await p.locator('.settings-review-ack').count())await p.locator('.settings-review-ack').click()
  assert.equal(puts,count);assert.equal(await p.locator('.settings-difference').count(),0)
  report.evidence.httpReplyLoss={stored:await stored(),uiMessage:await p.locator('.settings-write-message').textContent(),additionalPuts:puts-count}
 })
 await check('Browser confirmation sees another real writer and requires fresh review while preserving the intended edit',async()=>{
  loseNext=true;await field('replenishRate').fill('45');await p.locator('.settings-save').click();await message('未收到可靠')
  const other=await put(await api(),{replenishRate:46,monitorWindowSeconds:40});assert.equal(other.status,200)
  const count=puts;await p.getByRole('button',{name:'读取服务端当前值',exact:true}).click();await message('不能证明原提交')
  assert.equal(await field('replenishRate').inputValue(),'45');assert.equal(await field('monitorWindowSeconds').inputValue(),'40')
  assert.equal(puts,count);assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await p.locator('.settings-query-operation').click();await message('此前存储写入已确认')
  await p.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await p.locator('.settings-save').click();await message('保存已确认')
  assert.equal((await stored()).replenishRate,45);assert.equal((await stored()).monitorWindowSeconds,40)
 })
 await check('Authentication expiry and rejected navigation retain the draft; reconnection reads and requires review',async()=>{
  await field('burstCapacity').fill('80')
  p.once('dialog',d=>d.dismiss());await p.getByRole('link',{name:'路由调度',exact:true}).click()
  assert.ok(p.url().endsWith('/settings'));assert.equal(await field('burstCapacity').inputValue(),'80')
  invalidAuth=true;await p.getByRole('button',{name:'重新读取',exact:true}).click();await p.locator('#admin-token').waitFor()
  invalidAuth=false;await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-burstCapacity')?.disabled===false)
  assert.equal(await field('burstCapacity').inputValue(),'80');assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await p.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click();await p.locator('.settings-save').click();await message('保存已确认')
  await screenshot('config-consistency-confirmed-1440.png')
 })
 await check('Overview and route navigation retain authentication; proxy traffic performs no runtime-config Redis reads',async()=>{
  await p.getByRole('link',{name:'运行概览',exact:true}).click();await p.locator('.overview-chart canvas').waitFor()
  await p.waitForFunction(()=>document.querySelector('.overview-window-context')?.textContent.includes('40'))
  await p.getByRole('link',{name:'路由调度',exact:true}).click();await p.locator('.dispatch-view').waitFor()
  const route=await request('/settings/routes',await withRouteVersion(()=>request('/settings/routes'),{method:'POST',body:JSON.stringify({id:'local-snapshot-test',path:'/local-snapshot-test/**',uri:'http://127.0.0.1:'+upstream.address().port,rewriteEnabled:false,circuitBreakerEnabled:false})}))
  assert.equal(route.status,201)
  const deadline=Date.now()+5000;let ready=false
  while(Date.now()<deadline){const response=await fetch(base+'/local-snapshot-test/probe');await response.text();if(response.status===200){ready=true;break}await delay(30)}
  assert.ok(ready)
  const start=proxy.events.length
  for(let i=0;i<5;i++){const response=await fetch(base+'/local-snapshot-test/probe');assert.equal(response.status,200);assert.match(await response.text(),/isolated/)}
  const events=proxy.events.slice(start)
  assert.equal(events.filter(e=>e.key===key).length,0)
  report.evidence.proxyHotPath={actualProxiedRequests:5,runtimeConfigurationQueries:0,redisCommands:events.map(e=>e.command)}
  assert.equal((await request('/settings/routes/local-snapshot-test',await withRouteVersion(()=>request('/settings/routes'),{method:'DELETE'}))).status,200)
 })
 await check('Warm management-operation costs are recorded separately from the proxy hot path',async()=>{
  const times={read:[],write:[]};let current=await api()
  for(let i=0;i<20;i++){
   let started=performance.now();current=await api();times.read.push(performance.now()-started)
   started=performance.now();const result=await put(current);assert.equal(result.status,200);current=result.body;times.write.push(performance.now()-started)
  }
  report.evidence.managementTiming=Object.fromEntries(Object.entries(times).map(([operation,ms])=>{
   ms.sort((a,b)=>a-b);return [operation,{samples:ms.length,medianMs:ms[10],p95Ms:ms[18],maxMs:ms[19]}]
  }))
 })
 await context.close();context=null;await browser.close();browser=null
 await check('Malformed persisted configuration refuses restart without overwriting storage or becoming ready',async()=>{
  await stop();const saved=await command(['GET',key]);await command(['SET',key,'{"monitorWindowSeconds":30}'])
  await start(false);assert.equal(await command(['GET',key]),'{"monitorWindowSeconds":30}')
  await stop();await command(['SET',key,saved]);await start()
 })
 assert.deepEqual(report.pageErrors,[]);report.passed=true
} catch(error) { report.failure=error.stack;throw error }
finally {
 if(context)await context.close()
 if(browser)await browser.close()
 proxy?.recover()
 if(java?.exitCode===null&&baseline){
  try{const current=await recoveredRead();const restored=await put(current,values(baseline));assert.equal(restored.status,200)
   assert.deepEqual(values(await stored()),values(baseline));report.cleanup.originalValuesRestored=true
  }catch(error){report.cleanup.restoreError=error.message}
 }
 await stop();report.cleanup.backendExitCode=java?.exitCode
 if(proxy)await proxy.close()
 upstream.closeAllConnections();await new Promise(r=>upstream.close(r))
 if(created){docker(['stop','--timeout','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString()
 await writeFile(out+'/live.json',JSON.stringify(report,null,2)+'\n')
 // Previous acceptance evidence is immutable; this run writes only its unique output directory.
}
