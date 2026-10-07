import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import {runtimeFixture,runtimeValues,runtimeReceipt} from './runtime-config-client.mjs'

// Production UI with explicitly isolated HTTP fixtures. No real gateway, Redis or write target.
const out=resolve('.dev/config-operations-p2/browser-'+randomUUID().slice(0,8))
await mkdir(out,{recursive:true})
const report={startedAt:new Date().toISOString(),data:'Isolated HTTP fixtures; production UI; no real gateway or Redis',
 checks:[],pageErrors:[],passed:false,cleanup:{contextsClosed:false,browserClosed:false,previewClosed:false}}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
async function bounded(promise,label) {
 let timer
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),7000)})])}
 finally{clearTimeout(timer)}
}
const reservation=createServer()
await new Promise(r=>reservation.listen(0,'127.0.0.1',r))
const port=reservation.address().port
await new Promise(r=>reservation.close(r))
let ui,browser
const contexts=new Set()
async function snapshot(page) {
 return page.evaluate(()=>({
  draft:document.querySelector('#setting-replenishRate')?.value ?? null,
  operationId:document.querySelector('[aria-label="操作 ID"]')?.value ?? null,
  currentVersion:document.querySelector('[aria-label="存储已确认版本"]')?.value ?? null,
  operationText:document.querySelector('.settings-operation')?.textContent ?? '',
  differences:document.querySelectorAll('.settings-difference').length,
  review:!!document.querySelector('.settings-version-conflict'),
  saveDisabled:document.querySelector('.settings-save')?.disabled ?? null,
  protectedDraft:(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})(),
  requests:window.__settingsRequests,
  overflow:document.documentElement.scrollWidth>innerWidth
 }))
}
async function flush(page) {await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
async function navigate(page,name) {
 const link=page.getByRole('link',{name,exact:true})
 if(!await link.isVisible())await page.getByRole('button',{name:'导航',exact:true}).click()
 await link.click()
}
async function ready(page,value) {
 await page.waitForFunction(value=>{
  const field=document.querySelector('#setting-replenishRate')
  return field && !field.disabled && field.value===value
 },value)
}
async function login(page) {
 await page.locator('#admin-token').fill('isolated-p2-fixture')
 await page.getByRole('button',{name:'连接',exact:true}).click()
}
async function screenshot(page,name) {
 await page.evaluate(()=>{
  const label=document.createElement('div')
  label.textContent='隔离验证 · HTTP 夹具 · 非真实 Redis'
  label.style.cssText='position:fixed;bottom:8px;right:8px;background:#161b17;color:#ddf5af;padding:7px 10px;font:12px sans-serif;z-index:99999;border:1px solid #718055;border-radius:4px'
  label.dataset.verification='true';document.body.append(label)
 })
 await page.screenshot({path:out+'/'+name+'.png',fullPage:true,animations:'disabled'})
 await page.locator('[data-verification]').evaluate(el=>el.remove())
 return name+'.png'
}
function assertDiscarded(state,current) {
 assert.equal(state.draft,String(current.replenishRate));assert.equal(state.operationId,null)
 assert.equal(state.currentVersion,current.version);assert.equal(state.differences,0)
 assert.equal(state.review,false);assert.equal(state.protectedDraft,false);assert.equal(state.saveDisabled,true)
 assert.equal(state.overflow,false)
}
async function scenario(mode,width=1440) {
 const ctx=await browser.newContext({viewport:{width,height:width<700?844:900},reducedMotion:'reduce'})
 contexts.add(ctx)
 const page=await ctx.newPage();page.setDefaultTimeout(7000)
 const evidence={name:mode,width,dialogs:[],requests:[],deliveries:[],passed:false}
 report.checks.push(evidence)
 let decision='accept',deferRead=false,revision=1
 const initial={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
 let remote=runtimeFixture(initial,revision),receipt
 const queryStarted=deferred(),queryReleased=deferred(),queryDelivered=deferred()
 const readStarted=deferred(),readReleased=deferred(),readDelivered=deferred()
 let queries=0,reads=0,writes=0
 page.on('pageerror',error=>report.pageErrors.push({scenario:mode,message:error.message}))
 page.on('dialog',async dialog=>{evidence.dialogs.push({message:dialog.message(),decision});await dialog[decision]()})
 await page.addInitScript(()=>{
  window.__settingsRequests=[]
  const original=window.fetch.bind(window)
  window.fetch=async(input,init)=>{
   const path=new URL(typeof input==='string'?input:input.url,location.href).pathname
   if(!path.startsWith('/api/settings/runtime'))return original(input,init)
   const entry={path,method:init?.method||'GET',startedAt:Date.now(),settled:false}
   window.__settingsRequests.push(entry)
   try {const response=await original(input,init);entry.status=response.status;return response}
   catch(error){entry.error=error.name;throw error}
   finally{entry.settled=true;entry.settledAt=Date.now()}
  }
 })
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname.slice(4)
  evidence.requests.push({path,method:req.method(),at:Date.now()})
  if(req.headers().authorization!=='Bearer isolated-p2-fixture')
   return route.fulfill({status:401,json:{message:'Isolated fixture requires authentication'}})
  if(path==='/settings/runtime/adopted')return route.fulfill({status:200,json:{...remote,source:'local'}})
  if(path==='/settings/runtime' && req.method()==='PUT') {
   writes++;const request=req.postDataJSON(),before={...remote}
   evidence.submitted=request;remote=runtimeFixture(runtimeValues(request),++revision)
   receipt=runtimeReceipt(request,before,remote)
   return route.abort('failed') // Model a committed write whose HTTP response was lost.
  }
  if(path.startsWith('/settings/runtime/operations/')) {
   queries++
   const result={status:'committed',receipt,adopted:{...remote}}
   if(queries>1)return route.fulfill({status:200,json:result})
   queryStarted.resolve();const answer=await queryReleased.promise
   try {
    await route.fulfill(answer==='401'?{status:401,json:{message:'Isolated expired credentials'}}:
     answer==='503'?{status:503,json:{message:'Isolated query unavailable'}}:{status:200,json:result})
    evidence.deliveries.push({kind:'receipt',answer,attemptedAt:Date.now()})
   } finally{queryDelivered.resolve()}
   return
  }
  if(path==='/settings/runtime') {
   reads++
   if(deferRead) {
    deferRead=false;const answer={...remote};readStarted.resolve();await readReleased.promise
    try{await route.fulfill({status:200,json:answer});evidence.deliveries.push({kind:'current',attemptedAt:Date.now()})}
    finally{readDelivered.resolve()}
    return
   }
   return route.fulfill({status:200,json:remote})
  }
  if(path==='/monitor/stream')return route.fulfill({status:200,contentType:'text/event-stream',body:': isolated fixture\n\n'})
  if(path==='/settings/sse-token')return route.fulfill({status:200,json:{token:'isolated-preview'}})
  return route.fulfill({status:200,json:[]})
 })
 try {
  await page.goto('http://127.0.0.1:'+port+'/settings');await login(page);await ready(page,'20')
  await page.locator('#setting-replenishRate').fill('40');await page.locator('.settings-save').click()
  await page.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('未收到可靠'))
  await page.locator('#setting-replenishRate').fill('43');await page.locator('.settings-query-operation').click()
  await bounded(queryStarted.promise,'query reached fixture')
  evidence.before=await snapshot(page)
  assert.equal(evidence.before.draft,'43');assert.equal(evidence.before.operationId,evidence.submitted.operationId)
  if(mode==='cancel-leave') {
   decision='dismiss';await navigate(page,'运行概览');assert.match(page.url(),/\/settings$/)
   assert.equal((await snapshot(page)).draft,'43')
   queryReleased.resolve('committed');await bounded(queryDelivered.promise,'kept query reply')
   await page.waitForFunction(()=>document.querySelector('.settings-operation')?.textContent.includes('原提交已成功'))
   await ready(page,'43')
   evidence.after=await snapshot(page)
   assert.equal(evidence.after.operationId,evidence.submitted.operationId);assert.equal(evidence.after.currentVersion,remote.version)
   assert.equal(evidence.after.review,true);assert.equal(evidence.after.protectedDraft,true)
   assert.equal(reads,2);assert.equal(queries,1)
   evidence.screenshot=await screenshot(page,'cancel-keeps-draft-1440')
  } else if(mode==='authentication-recovery') {
   queryReleased.resolve('401');await bounded(queryDelivered.promise,'authentication failure')
   await page.locator('#admin-token').waitFor()
   assert.match(await page.locator('.zenith-access-notice').innerText(),/暂存在当前页面内存/)
   assert.equal((await snapshot(page)).protectedDraft,true)
   await login(page);await ready(page,'43')
   assert.equal((await snapshot(page)).operationId,evidence.submitted.operationId)
   assert.equal(await page.locator('.settings-save').isDisabled(),true)
   await page.locator('.settings-query-operation').click()
   await page.waitForFunction(()=>document.querySelector('.settings-operation')?.textContent.includes('原提交已成功'))
   await ready(page,'43');evidence.after=await snapshot(page)
   assert.equal(evidence.after.currentVersion,remote.version);assert.equal(evidence.after.operationId,evidence.submitted.operationId)
   assert.equal(evidence.after.review,true);assert.equal(queries,2);assert.equal(reads,3)
   evidence.screenshot=await screenshot(page,'auth-recovery-keeps-draft-1440')
  } else {
   if(mode==='discard-during-follow-up-read') {
    deferRead=true;queryReleased.resolve('committed')
    await bounded(queryDelivered.promise,'receipt reply');await bounded(readStarted.promise,'follow-up read started')
   }
   if(mode==='disconnect-during-query') {
    if(!await page.getByRole('button',{name:'断开管理连接',exact:true}).isVisible())throw new Error('Disconnect control missing')
    await page.getByRole('button',{name:'断开管理连接',exact:true}).click();await page.locator('#admin-token').waitFor()
    assert.equal(await page.locator('.zenith-access-notice').count(),0)
   } else {
    await navigate(page,'运行概览');await page.waitForURL('http://127.0.0.1:'+port+'/')
   }
   assert.ok(evidence.dialogs.some(d=>d.decision==='accept' && d.message.includes('丢弃本页草稿')))
   evidence.afterLeaving=await snapshot(page);assert.equal(evidence.afterLeaving.protectedDraft,false)
   const readsAtLeave=reads
   if(mode==='discard-return-before-reply') {
    await navigate(page,'系统配置');await ready(page,'40');assertDiscarded(await snapshot(page),remote)
    await page.locator('#setting-replenishRate').fill('45')
   }
   if(mode==='discard-during-follow-up-read') {
    readReleased.resolve();await bounded(readDelivered.promise,'abandoned follow-up read reply')
   } else {
    queryReleased.resolve(mode==='discard-late-401'?'401':mode==='discard-late-503'?'503':'committed')
    await bounded(queryDelivered.promise,'abandoned query reply')
   }
   await page.waitForFunction(()=>window.__settingsRequests.filter(r=>r.path.includes('/operations/')).every(r=>r.settled))
   await flush(page)
   assert.equal(reads,readsAtLeave+(mode==='discard-return-before-reply'?1:0),'abandoned callbacks cannot trigger a new GET')
   if(mode==='disconnect-during-query')await login(page)
   else if(mode!=='discard-return-before-reply')await navigate(page,'系统配置')
   await ready(page,mode==='discard-return-before-reply'?'45':'40');evidence.after=await snapshot(page)
   if(mode==='discard-return-before-reply') {
    assert.equal(evidence.after.draft,'45');assert.equal(evidence.after.operationId,null);assert.equal(evidence.after.currentVersion,remote.version)
    assert.equal(evidence.after.differences,1);assert.equal(evidence.after.review,false)
   } else assertDiscarded(evidence.after,remote)
   assert.equal(reads,mode==='discard-during-follow-up-read'?3:2)
   assert.equal(queries,1)
   if(mode==='discard-late-success')evidence.screenshot=await screenshot(page,'discard-return-'+width)
  }
  assert.equal(writes,1,'query, navigation and authentication must not re-submit')
  evidence.counts={reads,writes,queries};evidence.passed=true
  console.log('PASS '+mode+' '+width+'px '+JSON.stringify(evidence.counts))
 } finally {
  queryReleased.resolve('committed');readReleased.resolve()
  await ctx.close();contexts.delete(ctx)
 }
}
try {
 ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port,strictPort:true}})
 report.origin='http://127.0.0.1:'+port
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 report.browser=browser.version()
 for(const mode of ['discard-late-success','discard-late-503','discard-late-401','discard-return-before-reply',
  'discard-during-follow-up-read','cancel-leave','authentication-recovery','disconnect-during-query'])await scenario(mode)
 await scenario('discard-late-success',390)
 assert.deepEqual(report.pageErrors,[])
 report.passed=true
} catch(error) {report.failure=error.stack;process.exitCode=1;console.error(error.stack)}
finally {
 for(const ctx of contexts)await ctx.close()
 report.cleanup.contextsClosed=true
 if(browser)await browser.close()
 report.cleanup.browserClosed=!browser || !browser.isConnected()
 if(ui)await new Promise((resolve,reject)=>ui.httpServer.close(error=>error?reject(error):resolve()))
 report.cleanup.previewClosed=!ui || !ui.httpServer.listening
 report.completedAt=new Date().toISOString()
 await writeFile(out+'/report.json',JSON.stringify(report,null,2)+'\n')
 console.log('Evidence: '+out+'/report.json')
}
