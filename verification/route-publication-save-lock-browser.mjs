import assert from 'node:assert/strict'
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import {join,resolve} from 'node:path'
import {writeFile} from 'node:fs/promises'
import {environment,reached,until} from './route-publication-harness.mjs'

const e=await environment()
let ui,browser,page,backend,failure,nextResponse
const pending=new Set(),writes=[],screenshots=[],pageErrors=[]
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const names=['id','path','uri','rewriteEnabled','rewriteRegex','rewriteReplacement','circuitBreakerEnabled','circuitBreakerName','fallbackPath']
const editor=()=>page.locator('.orbit-editor[open]'),field=name=>editor().locator('[name="'+name+'"]')
async function shot(name){
 const path=join(e.out,name+'.png')
 await editor().locator('.orbit-form-body').evaluate(el=>{el.scrollTop=0})
 await page.screenshot({path,fullPage:false,animations:'disabled'});screenshots.push(path)
}
async function open(create=false){
 const button=page.getByRole('button',{name:create?'新建路由':'编辑路由',exact:true})
 await until('editor available',()=>button.isEnabled());await button.click();await editor().waitFor()
}
async function values(){
 return editor().locator('input[name]').evaluateAll(inputs=>Object.fromEntries(inputs.map(input=>[input.name,input.type==='checkbox'?input.checked:input.value])))
}
async function unlocked(create=false){
 for(const name of names){
  assert.equal(await field(name).isEnabled(),true,name+' is enabled after the request completes')
  if(!['fallbackPath',...(create?[]:['id'])].includes(name))assert.equal(await field(name).isEditable(),true,name+' accepts edits')
 }
}
async function holdSave(){
 const gate={entered:deferred(),release:deferred()};nextResponse=gate;pending.add(gate)
 const count=writes.length
 await editor().getByRole('button',{name:'保存路由',exact:true}).click()
 const response=await reached(gate.entered.promise,'real backend response received before browser delivery')
 assert.equal(writes.length,count+1)
 await editor().getByRole('button',{name:'保存中…',exact:true}).waitFor()
 return {gate,response,count}
}
async function locked(){
 const controls={}
 for(const name of names){
  controls[name]={disabled:await field(name).isDisabled(),editable:await field(name).isEditable(),value:await field(name).inputValue()}
  assert.equal(controls[name].disabled,true,name+' must be locked for the entire pending save')
 }
 const before=await values()
 // Ordinary fill observes native disabled semantics, without forcing a DOM mutation.
 await assert.rejects(()=>field('path').fill('/typed-while-saving/**',{timeout:350}),/Timeout/)
 for(const name of ['rewriteEnabled','circuitBreakerEnabled']){
  const label=field(name).locator('..');await label.scrollIntoViewIfNeeded()
  const box=await label.boundingBox();assert.ok(box)
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2)
 }
 await page.keyboard.press('Enter')
 // Guard the handler as well as the button against a second submit event.
 await editor().locator('form').evaluate(form=>form.requestSubmit())
 assert.deepEqual(await values(),before)
 assert.equal(await editor().getByRole('button',{name:'关闭编辑',exact:true}).isDisabled(),true)
 assert.equal(await editor().getByRole('button',{name:'取消',exact:true}).isDisabled(),true)
 await page.keyboard.press('Escape');assert.equal(await editor().count(),1)
 return controls
}
async function release(h){
 h.gate.release.resolve();pending.delete(h.gate)
 await editor().waitFor({state:'hidden'})
 assert.equal(writes.length,h.count+1,'no automatic duplicate write')
}
try{
 ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:0}})
 const origin='http://127.0.0.1:'+ui.httpServer.address().port;e.uiOrigin=origin
 backend=await e.start('A')
 const seed={id:'save-lock-probe',path:'/probe/**',uri:e.uri(1),rewriteEnabled:true,rewriteRegex:'^/probe/(?<segment>.*)$',rewriteReplacement:'/${segment}',circuitBreakerEnabled:true,circuitBreakerName:'save-lock-probe',fallbackPath:'/fallback/default'}
 const initial=await e.publish(backend,(await e.read(backend)).version,seed);assert.equal(initial.status,201)
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true})
 page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'reduce'});page.setDefaultTimeout(10000)
 page.on('pageerror',error=>pageErrors.push(error.message))
 await page.route('**/api/**',async handle=>{
  const request=handle.request(),url=new URL(request.url()),path=url.pathname.replace(/^\/api/,'')
  try{
   const response=await handle.fetch({url:backend.base+path+url.search})
   if(path==='/settings/routes'&&request.method()==='POST'){
    const row={sent:JSON.parse(request.postData()),status:response.status(),body:await response.json(),receivedAt:new Date().toISOString()}
    writes.push(row)
    if(nextResponse){const gate=nextResponse;nextResponse=undefined;gate.entered.resolve(row);await gate.release.promise}
   }
   await handle.fulfill({response})
  }catch{await handle.abort().catch(()=>{})}
 })
 await page.goto(origin+'/routes');await page.locator('#admin-token').fill(e.token)
 await page.getByRole('button',{name:'连接',exact:true}).click();await page.getByRole('heading',{name:seed.id,exact:true}).waitFor()
 await e.check('Editing: all nine controls stay locked until a real 201 acknowledgement is delivered, then editing is available again',async()=>{
  await open();await unlocked();await field('uri').fill(e.uri(2))
  const h=await holdSave();assert.equal(h.response.status,201);assert.equal(h.response.body.outcome,'committed')
  const controls=await locked();await shot('edit-saving-locked-1440')
  const proof=await e.hit(backend);assert.equal(proof.body,'V2:/proof');assert.equal(proof.version,h.response.body.version)
  await release(h);await open();await unlocked()
  assert.equal(await field('path').inputValue(),'/probe/**');assert.equal(await field('uri').inputValue(),e.uri(2))
  await shot('edit-saved-unlocked-1440')
  e.report.evidence.edit={controls,response:h.response,forwarding:proof,writeCount:1}
  await editor().getByRole('button',{name:'关闭编辑',exact:true}).click();await editor().waitFor({state:'hidden'})
 })
 await e.check('Creation: the editable ID, both switches and every dependent field are frozen during the delayed success',async()=>{
  await open(true);await unlocked(true)
  await field('id').fill('save-lock-created');await field('path').fill('/created/**');await field('uri').fill(e.uri(1))
  const h=await holdSave();assert.equal(h.response.status,201);assert.equal(h.response.body.outcome,'committed')
  const controls=await locked();await page.setViewportSize({width:390,height:844});await shot('create-saving-locked-390')
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
  await page.setViewportSize({width:1440,height:900});await release(h)
  await page.getByRole('heading',{name:'save-lock-created',exact:true}).waitFor()
  const current=await e.read(backend);assert.equal(current.routes.find(r=>r.id==='save-lock-created').path,'/created/**')
  const proof=await e.hit(backend,'/created/proof');assert.equal(proof.body,'V1:/proof');assert.equal(proof.version,h.response.body.version)
  e.report.evidence.create={controls,response:h.response,forwarding:proof,writeCount:1}
 })
 await e.check('A delayed real validation rejection unlocks the controls, keeps the draft and reviewed version, and never retries automatically',async()=>{
  await open();await unlocked();await field('rewriteRegex').fill('[')
  const before=await e.read(backend),h=await holdSave();assert.equal(h.response.status,400)
  const controls=await locked();h.gate.release.resolve();pending.delete(h.gate)
  await until('rejected save is editable again',()=>field('path').isEditable())
  await unlocked();assert.equal(await field('rewriteRegex').inputValue(),'[')
  assert.equal(await editor().getByRole('button',{name:'保存路由',exact:true}).isEnabled(),true)
  assert.equal(writes.length,h.count+1);assert.equal((await e.read(backend)).version,before.version)
  await shot('rejected-draft-unlocked-1440')
  e.report.evidence.rejected={controls,response:h.response,unchangedVersion:before.version,retainedRegex:await field('rewriteRegex').inputValue(),writeCount:1}
  page.once('dialog',dialog=>dialog.accept());await editor().getByRole('button',{name:'关闭编辑',exact:true}).click();await editor().waitFor({state:'hidden'})
 })
 assert.deepEqual(pageErrors,[])
}catch(error){failure=error;if(page)await page.screenshot({path:join(e.out,'failure.png'),fullPage:false}).catch(()=>{})}
finally{
 for(const gate of pending)gate.release.resolve()
 await browser?.close();if(ui)await new Promise(r=>ui.httpServer.close(r))
 e.report.evidence.browser={production:true,isolated:true,screenshots,pageErrors,writes}
 e.report.cleanup.browserClosed=!!browser;e.report.cleanup.previewClosed=!!ui
 await writeFile(join(e.out,'writes.json'),JSON.stringify(writes,null,2)+'\n')
 await e.finish(failure)
}
