import assert from 'node:assert/strict'
import {preview} from '../frontend/node_modules/vite/dist/node/index.js'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import {join,resolve} from 'node:path'
import {writeFile} from 'node:fs/promises'
import {environment,until,reached} from './route-publication-harness.mjs'
const e=await environment();let ui,browser,page,failure,backend,holdRead,holdDiagnostic,diagnosticArm,denyNextWrite=false
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const screenshots=[],browserRequests=[],pageErrors=[]
const route=(uri,extra={})=>({id:'orders-service',path:'/probe/**',uri,rewriteEnabled:false,circuitBreakerEnabled:false,...extra})
const editor=()=>page.locator('.orbit-editor[open]'),field=name=>editor().locator('[name="'+name+'"]')
async function shot(name){const path=join(e.out,name+'.png');await page.screenshot({path,fullPage:false,animations:'disabled'});screenshots.push(path)}
async function login(){await page.locator('#admin-token').fill(e.token);await page.getByRole('button',{name:'连接',exact:true}).click();await page.locator('.dispatch-view').waitFor()}
async function refresh(){await until('refresh available',()=>page.locator('.dispatch-status-refresh').isEnabled());await page.locator('.dispatch-status-refresh').click();await until('refresh complete',()=>page.locator('.dispatch-status-refresh').isEnabled())}
async function open(){await page.getByRole('button',{name:'编辑路由',exact:true}).click();await editor().waitFor()}
async function save(){await editor().getByRole('button',{name:'保存路由',exact:true}).click()}
async function discard(){const accept=d=>d.accept().catch(()=>{});page.once('dialog',accept);try{await editor().getByRole('button',{name:'关闭编辑',exact:true}).click();await editor().waitFor({state:'hidden'})}finally{page.off('dialog',accept)}}
const writes=()=>browserRequests.filter(r=>r.method==='POST'&&r.path==='/settings/routes').length
async function assertDraftEditable(){
 for(const name of ['path','uri'])assert.equal(await field(name).isEditable(),true,name+' unlocks after save completes')
 for(const name of ['rewriteEnabled','circuitBreakerEnabled'])assert.equal(await field(name).isEnabled(),true,name+' unlocks after save completes')
}
try{
 ui=await preview({root:resolve('frontend'),configFile:false,preview:{host:'127.0.0.1',port:0}});const base='http://127.0.0.1:'+ui.httpServer.address().port;e.uiOrigin=base
 const [A,B]=await Promise.all([e.start('A'),e.start('B')]);backend=A
 const initial=await e.read(A);const first=await e.publish(A,initial.version,route(e.uri(1)));assert.equal(first.status,201);await e.adopted(B,first.body.version,'V1:')
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true})
 const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});page=await context.newPage();page.setDefaultTimeout(10000);page.on('pageerror',x=>pageErrors.push(x.message))
 await page.route('**/api/**',async handle=>{
  const r=handle.request(),url=new URL(r.url()),path=url.pathname.replace(/^\/api/,'');browserRequests.push({method:r.method(),path,body:r.postData(),at:new Date().toISOString()})
  if(denyNextWrite&&r.method()==='POST'&&path==='/settings/routes'){denyNextWrite=false;await handle.fulfill({status:401,contentType:'application/json',body:'{}'});return}
  try{
   const response=await handle.fetch({url:backend.base+path+url.search})
   if(diagnosticArm&&r.method()==='POST'&&path==='/settings/routes'){holdDiagnostic=diagnosticArm;diagnosticArm=null}
   if(holdDiagnostic&&r.method()==='GET'&&path==='/settings/routes/diagnostics'){const h=holdDiagnostic;holdDiagnostic=null;h.entered.resolve();await h.release.promise}
   if(holdRead&&r.method()==='GET'&&path==='/settings/routes') {const h=holdRead;holdRead=null;h.entered.resolve();await h.release.promise}
   await handle.fulfill({response})
  }catch{await handle.abort().catch(()=>{})}
 })
 await e.check('Production page authenticates and shows real storage/adopted versions verified by forwarding',async()=>{
  await page.goto(base+'/routes');await login();await page.getByRole('heading',{name:'orders-service',exact:true}).waitFor();await page.locator('.route-publication-strip').getByText('本实例已生效',{exact:true}).waitFor();await shot('normal-1440');assert.equal((await e.hit(A)).version,first.body.version)
 })
 await e.check('Real concurrent edit retains draft and reviewed baseline across reads; review is separate from submission',async()=>{
  await open();await field('uri').fill(e.uri(2));const external=await e.publish(B,(await e.read(B)).version,route(e.uri(1),{circuitBreakerEnabled:true}));assert.equal(external.status,201)
  await save();await editor().getByRole('heading',{name:'版本冲突 · 核对后再次发布'}).waitFor();assert.equal(await field('uri').inputValue(),e.uri(2));assert.match(await editor().locator('.route-publication-review').textContent(),new RegExp(first.body.version));assert.equal(await editor().getByRole('button',{name:'保存路由',exact:true}).isDisabled(),true);await assertDraftEditable();await shot('conflict-1440')
  const count=writes();await editor().getByRole('button',{name:'重新读取当前状态'}).click();await editor().getByRole('button',{name:'已核对，使用此版本'}).waitFor();assert.match(await editor().locator('.route-publication-review').textContent(),new RegExp(first.body.version));assert.equal(writes(),count)
  await editor().getByRole('button',{name:'已核对，使用此版本'}).click();assert.equal(writes(),count);await save();await editor().waitFor({state:'hidden'});assert.equal(writes(),count+1);const now=await e.read(A);await e.adopted(A,now.version,'V2:');await e.adopted(B,now.version,'V2:')
 })
 await e.check('A late post-commit diagnostic refresh cannot close or replace a newly opened draft',async()=>{
  await open();await field('uri').fill(e.uri(1));const gate={entered:deferred(),release:deferred()};diagnosticArm=gate;const count=writes();await save();await reached(gate.entered.promise,'post-commit local diagnostic held');await editor().waitFor({state:'hidden'});await until('edit available after route list refresh',()=>page.getByRole('button',{name:'编辑路由',exact:true}).isEnabled());await open();await field('path').fill('/after-commit-draft/**');gate.release.resolve();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await field('path').inputValue(),'/after-commit-draft/**');assert.equal(writes(),count+1);await discard()
 })
 await e.check('Cancelling explicit discard keeps the form; Escape never bypasses the leave decision',async()=>{
  await open();await field('path').fill('/draft/**');page.once('dialog',d=>d.dismiss());await page.keyboard.press('Escape');assert.equal(await editor().count(),1);assert.equal(await field('path').inputValue(),'/draft/**');await discard();await open();assert.equal(await field('path').inputValue(),'/probe/**');await discard()
 })
 await e.check('Browser Back cancellation protects the draft; confirmed navigation discards it and Forward does not resurrect it',async()=>{
  await page.locator('a[href="/settings"]').click();await page.locator('#setting-replenishRate').waitFor();await page.locator('a[href="/routes"]').click();await page.getByRole('heading',{name:'orders-service',exact:true}).waitFor();await open();await field('path').fill('/leave-draft/**')
  page.once('dialog',d=>d.dismiss());await page.goBack();await until('cancelled back returned to routes',()=>page.url().endsWith('/routes'));assert.equal(await field('path').inputValue(),'/leave-draft/**')
  page.once('dialog',d=>d.accept());await page.goBack();await page.locator('#setting-replenishRate').waitFor();await page.goForward();await page.getByRole('heading',{name:'orders-service',exact:true}).waitFor();assert.equal(await editor().count(),0);await open();assert.equal(await field('path').inputValue(),'/probe/**');await discard()
 })
 await e.check('Authentication expiry preserves the draft and baseline through component unmount and requires explicit review',async()=>{
  await open();await field('path').fill('/auth-draft/**');denyNextWrite=true;const count=writes();await save();await page.locator('#admin-token').waitFor();await login();await editor().waitFor();assert.equal(await field('path').inputValue(),'/auth-draft/**');assert.equal(writes(),count+1);assert.equal(await editor().getByRole('button',{name:'保存路由',exact:true}).isDisabled(),true);await assertDraftEditable();await shot('authentication-draft')
  await editor().getByRole('button',{name:'重新读取当前状态'}).click();await until('auth review ready',()=>editor().getByRole('button',{name:'已核对，使用此版本'}).isEnabled());await editor().getByRole('button',{name:'已核对，使用此版本'}).click();assert.equal(writes(),count+1);await discard()
 })
 await e.check('Explicit discard invalidates a held real read; its late response cannot replace a new draft',async()=>{
  await open();await field('path').fill('/abandoned/**');const external=await e.publish(B,(await e.read(B)).version,route(e.uri(1)));assert.equal(external.status,201);await save();await editor().getByRole('heading',{name:'版本冲突 · 核对后再次发布'}).waitFor()
  const gate={entered:deferred(),release:deferred()};holdRead=gate;await editor().getByRole('button',{name:'重新读取当前状态'}).click();await reached(gate.entered.promise,'real route read held')
  await discard();await open();await field('path').fill('/new-draft/**');const count=writes();gate.release.resolve();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await field('path').inputValue(),'/new-draft/**');assert.equal(await editor().locator('.route-publication-review').count(),0);assert.equal(writes(),count);await discard()
 })
 await e.check('Redis acknowledgement loss is shown as unknown without automatic write; observing equal current values is not attributed to the original request',async()=>{
  await refresh();await open();await field('uri').fill(e.uri(2));e.proxyA.dropNextWriteReply();const count=writes();await save();await editor().getByRole('heading',{name:'结果未知 · 重新核对当前状态'}).waitFor();assert.equal(writes(),count+1);assert.equal(await editor().getByRole('button',{name:'保存路由',exact:true}).isDisabled(),true);await assertDraftEditable();await shot('unknown-1440')
  await editor().getByRole('button',{name:'重新读取当前状态'}).click();await until('unknown review ready',()=>editor().getByRole('button',{name:'已核对，使用此版本'}).isEnabled());assert.equal(await field('uri').inputValue(),e.uri(2));assert.match(await editor().textContent(),/不能证明原提交/);assert.equal(writes(),count+1);await discard();e.proxyA.release()
 })
 await e.check('Real build failure displays confirmed storage separately from the route actually forwarding, and recovers automatically',async()=>{
  await e.stop(B);const broken=await e.start('B',{disableRewrite:true});backend=broken
  const c=await e.read(A),next=await e.publish(A,c.version,route(e.uri(1),{rewriteEnabled:true,rewriteRegex:'^/probe/(?<segment>.*)$',rewriteReplacement:'/${segment}'}));assert.equal(next.status,201)
  await until('actual build failure',async()=>{const d=await e.diag(broken);return d.status==='failed'&&d.lastObservedVersion===next.body.version});await refresh();await page.locator('.route-publication-strip').getByText('保留有效路由 · 同步异常',{exact:true}).waitFor();await page.getByText('同步详情',{exact:true}).click();await shot('pending-build-1440');const response=await e.hit(broken);assert.equal(response.body,'V2:/probe/proof');assert.notEqual(response.version,next.body.version)
  const fixed=await e.publish(A,next.body.version,route(e.uri(1)));assert.equal(fixed.status,201);await e.adopted(broken,fixed.body.version,'V1:');await refresh();await page.locator('.route-publication-strip').getByText('本实例已生效',{exact:true}).waitFor();await page.getByText('同步详情',{exact:true}).click()
  await page.setViewportSize({width:390,height:844});await shot('normal-390');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.setViewportSize({width:1440,height:900})
 })
 await e.check('Preview remains explicitly isolated; dense directory interaction never accesses real APIs',async()=>{
  await page.goto(base+'/routes/preview?scenario=dense');await page.getByRole('button',{name:'全部路由',exact:false}).waitFor();const count=browserRequests.length;await page.getByRole('button',{name:'全部路由',exact:false}).click();assert.match(await page.locator('#dispatch-all-routes').textContent(),/32/);assert.equal(browserRequests.length,count);await shot('preview-dense');assert.deepEqual(pageErrors,[])
 })
}catch(error){failure=error;if(page)await shot('failure').catch(()=>{})}
finally{
 holdRead?.release.resolve();holdDiagnostic?.release.resolve();diagnosticArm?.release.resolve();await browser?.close();if(ui)await new Promise(r=>ui.httpServer.close(r));e.report.evidence.browser={screenshots,pageErrors,requests:browserRequests,production:true,isolated:true};e.report.cleanup.browserClosed=!!browser;e.report.cleanup.previewClosed=!!ui;await writeFile(join(e.out,'browser-requests.json'),JSON.stringify(browserRequests,null,2));await e.finish(failure)
}
