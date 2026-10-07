import {runtimeFixture,runtimeValues,runtimeFields,runtimeReceipt} from './runtime-config-client.mjs'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import {mkdir,writeFile,copyFile} from 'node:fs/promises'
import {setTimeout as delay} from 'node:timers/promises'
const base=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15174'
const out=process.env.SETTINGS_OUTPUT||'.dev/settings-stage-b/run-'+Date.now()
await mkdir(out,{recursive:true});await mkdir('docs/media',{recursive:true})
const report={startedAt:new Date().toISOString(),checks:[],screenshots:[],layouts:[],previewApi:[],pageErrors:[],passed:false}
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
const p=await ctx.newPage();p.setDefaultTimeout(6000)
let decision='accept',dialogs=[]
p.on('pageerror',e=>report.pageErrors.push(e.message))
p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))report.previewApi.push(r.url())})
p.on('dialog',async d=>{dialogs.push({type:d.type(),message:d.message()});await d[decision]()})
const field=(page,key)=>page.locator('#setting-'+key)
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
async function scene(name='normal',width=1440){await p.setViewportSize({width,height:width<700?844:900});await p.goto(base+'/settings/preview?scenario='+name);if(!['read-failure','loading'].includes(name))await field(p,'replenishRate').waitFor({state:'visible'});if(!['read-failure','loading'].includes(name))await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20');await delay(60)}
async function shot(page,name,fullPage=false){if(process.env.SETTINGS_CAPTURE==='0')return;await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0)});await page.screenshot({path:'docs/images/'+name,fullPage,animations:'disabled'});report.screenshots.push({file:'docs/images/'+name,...page.viewportSize(),fullPage})}
async function waitMessage(page,pattern){await page.waitForFunction(pattern=>new RegExp(pattern).test(document.querySelector('.settings-write-message')?.textContent||''),pattern)}
try{
 await check('Desktop first viewport exposes all six parameters, exact units, baseline and disabled no-change save',async()=>{
  await scene()
  assert.equal(await p.getByRole('switch',{name:'全局限流'}).getAttribute('aria-checked'),'true')
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  assert.match(await p.locator('.settings-parameter-area').textContent(),/令牌\/秒/)
  for(const key of ['replenishRate','burstCapacity','requestedTokens','monitorWindowSeconds','emitIntervalSeconds']){
   const box=await field(p,key).boundingBox();assert.ok(box.y+box.height<900,key+' is within first viewport')
  }
  await shot(p,'settings-stage-b-normal-1440.png')
 })
 await check('Changed fields alone form current-to-draft comparisons; raw invalid values stay visible and block saving',async()=>{
  await field(p,'replenishRate').fill('40');await field(p,'emitIntervalSeconds').fill('2')
  assert.equal(await p.locator('.settings-difference').count(),2)
  assert.match(await p.locator('.settings-differences').textContent(),/20.*40.*1.*2/s)
  await shot(p,'settings-stage-b-dirty-1440.png')
  for(const [key,value] of [['replenishRate',''],['burstCapacity','10001'],['requestedTokens','1.5'],['monitorWindowSeconds','abc'],['emitIntervalSeconds','0']])await field(p,key).fill(value)
  assert.equal(await p.locator('input[aria-invalid=true]').count(),5)
  assert.equal(await field(p,'requestedTokens').inputValue(),'1.5')
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await shot(p,'settings-stage-b-invalid-1440.png',true)
  await p.getByRole('button',{name:'恢复当前已确认值',exact:true}).click()
  assert.equal(await field(p,'replenishRate').inputValue(),'20');assert.equal(await p.locator('.settings-difference').count(),0)
 })
 await check('Saving freezes edits and repeat submissions; confirmed values become the baseline',async()=>{
  await field(p,'replenishRate').fill('40');await p.locator('.settings-save').click()
  assert.equal(await field(p,'replenishRate').isDisabled(),true)
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await waitMessage(p,'保存已确认')
  assert.equal(await p.locator('.settings-difference').count(),0)
  assert.match(await p.locator('.settings-field-meta').first().textContent(),/当前 40/)
  await shot(p,'settings-stage-b-saved-1440.png')
 })
 await check('First loading and failed reads expose no defaults; a local retry establishes the baseline',async()=>{
  await scene('loading')
  assert.equal(await field(p,'replenishRate').inputValue(),'')
  assert.equal(await field(p,'replenishRate').isDisabled(),true);assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await shot(p,'settings-stage-b-loading-1440.png')
  await scene('read-failure');await p.locator('.settings-read-error').waitFor()
  assert.equal(await field(p,'replenishRate').inputValue(),'')
  await shot(p,'settings-stage-b-read-failure-1440.png')
  await p.getByRole('button',{name:'重试读取配置',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
  assert.equal(await p.locator('.settings-read-error').count(),0)
 })
 await check('Explicit save rejection preserves editable differences and a subsequent save can succeed',async()=>{
  await scene('rejected');await field(p,'burstCapacity').fill('80');await p.locator('.settings-save').click()
  await waitMessage(p,'保存被拒绝');assert.equal(await field(p,'burstCapacity').inputValue(),'80')
  assert.equal(await p.locator('.settings-save').isDisabled(),false)
  await shot(p,'settings-stage-b-rejected-1440.png')
  await p.locator('.settings-save').click();await waitMessage(p,'保存已确认')
 })
 await check('A lost response requires a read first; matching server values reconcile without another write',async()=>{
  await scene('uncertain');await field(p,'replenishRate').fill('40');await p.locator('.settings-save').click()
  await waitMessage(p,'未收到可靠')
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  assert.equal(await p.getByRole('button',{name:'恢复当前已确认值',exact:true}).isDisabled(),true)
  await shot(p,'settings-stage-b-uncertain-1440.png')
  await p.locator('.settings-query-operation').click()
  await waitMessage(p,'此前存储写入已确认')
  assert.equal(await p.locator('.settings-difference').count(),0)
 })
 await check('A confirmed save survives a later read failure and its independent retry',async()=>{
  await scene('saved-read-failure');await field(p,'monitorWindowSeconds').fill('30');await p.locator('.settings-save').click()
  await waitMessage(p,'保存已确认')
  await p.getByRole('button',{name:'重新读取',exact:true}).click();await p.locator('.settings-read-error').waitFor()
  assert.match(await p.locator('.settings-read-error').textContent(),/保存已确认，重新读取失败/)
  assert.equal(await field(p,'monitorWindowSeconds').inputValue(),'30')
  await shot(p,'settings-stage-b-saved-read-failure-1440.png',true)
  await p.getByRole('button',{name:'重试读取配置',exact:true}).click();await p.locator('.settings-read-error').waitFor({state:'hidden'})
 })
 await check('Disabled limiting retains its values; impossible bucket combinations explain behavior without inventing validation',async()=>{
  await scene('disabled');assert.equal(await field(p,'replenishRate').isDisabled(),false)
  assert.match(await p.locator('.settings-group-note').first().textContent(),/参数仍保留/)
  await field(p,'burstCapacity').fill('1');await field(p,'requestedTokens').fill('2')
  await p.locator('.settings-combination-warning').waitFor();assert.equal(await p.locator('.settings-save').isDisabled(),false)
  await p.getByRole('button',{name:'恢复当前已确认值',exact:true}).click()
 })
 await check('Mobile and narrow layouts retain readable fields, summaries and all navigation destinations',async()=>{
  for(const width of [1440,1100,960,700,390,320]){
   await scene('normal',width)
   const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false)
   report.layouts.push({width,horizontalOverflow:overflow})
   if(width<=700){
    await p.getByRole('button',{name:'导航',exact:true}).click()
    for(const name of ['运行概览','路由调度','系统配置'])assert.equal(await p.getByRole('navigation',{name:'主导航'}).getByRole('link',{name,exact:true}).isVisible(),true)
    await p.keyboard.press('Escape')
   }
   if(width===390){await shot(p,'settings-stage-b-normal-390.png',true);await shot(p,'settings-stage-b-first-screen-390.png')}
  }
  await scene('read-failure',390);await p.locator('.settings-read-error').waitFor()
  await shot(p,'settings-stage-b-read-failure-390.png',true)
 })
 await check('Unsaved preview navigation and browser unloading are guarded; confirmed discard exits normally',async()=>{
  await scene();await field(p,'replenishRate').fill('41')
  const unload=await p.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented})
  assert.equal(unload,true)
  decision='dismiss';await p.getByRole('link',{name:'运行概览',exact:true}).click()
  assert.ok(p.url().includes('/settings/preview'));assert.equal(await field(p,'replenishRate').inputValue(),'41')
  decision='accept';await p.getByRole('link',{name:'运行概览',exact:true}).click();await p.locator('.overview-chart').waitFor()
  await p.getByRole('link',{name:'路由调度',exact:true}).click();await p.locator('.dispatch-map').waitFor()
  await p.getByRole('link',{name:'系统配置',exact:true}).click();await field(p,'replenishRate').waitFor()
  assert.deepEqual(report.previewApi,[])
 })
 const liveCtx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'})
 const live=await liveCtx.newPage();live.setDefaultTimeout(7000)
 live.on('pageerror',e=>report.pageErrors.push(e.message))
 let liveDecision='dismiss';live.on('dialog',d=>d[liveDecision]())
 let remote={rateLimitEnabled:true,replenishRate:20,burstCapacity:40,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1}
 let reads=0,writes=0,readFailure=false,writeMode='normal',delayWrite=0,deny=false,initialFailure=true
 let revision=1;const receipts=new Map()
 const bodies=[]
 await live.route('**/api/**',async r=>{
  const request=r.request(),path=new URL(request.url()).pathname
  if(!['/api/settings/runtime','/api/settings/runtime/adopted'].includes(path)&&!path.startsWith('/api/settings/runtime/operations/')){await r.fulfill({status:200,json:[]});return}
  if(request.headers().authorization!=='Bearer browser-stage-b'||deny){await r.fulfill({status:401,json:{message:'expired'}});return}
  if(path.startsWith('/api/settings/runtime/operations/')){const receipt=receipts.get(path.split('/').at(-1));await r.fulfill({status:200,json:receipt?{status:'committed',receipt,adopted:runtimeFixture(remote,revision)}:{status:'unknown'}});return}
   if(path.endsWith('/adopted')){await r.fulfill({status:200,json:{...runtimeFixture(remote,revision),source:'local'}});return}
  if(request.method()==='GET'){
   reads++
   if((initialFailure&&reads===1)||readFailure){readFailure=false;await r.fulfill({status:503,json:{message:'isolated read failure'}});return}
   await r.fulfill({status:200,json:runtimeFixture(remote,revision)});return
  }
  writes++;const body=request.postDataJSON();bodies.push(body)
  if(delayWrite)await delay(delayWrite)
  if(writeMode==='reject'){await r.fulfill({status:422,json:{message:'isolated validation rejection',field:'replenishRate'}});return}
  if(writeMode==='401'){deny=true;await r.fulfill({status:401,json:{message:'expired'}});return}
  if(writeMode==='500'){await r.fulfill({status:500,json:{message:'isolated write unavailable'}});return}
  if(body.expectedVersion!==runtimeFixture(remote,revision).version){await r.fulfill({status:409,json:{code:'CONFIG_VERSION_CONFLICT',outcome:'not-written',current:runtimeFixture(remote,revision),adopted:runtimeFixture(remote,revision)}});return}
  const before=runtimeFixture(remote,revision);remote=runtimeValues(body);revision++;const receipt=runtimeReceipt(body,before,runtimeFixture(remote,revision));receipts.set(body.operationId,receipt)
  if(writeMode==='lost'){await r.abort('failed');return}
  await r.fulfill({status:200,json:{...runtimeFixture(remote,revision,'committed'),receipt}})
 })
 async function login(){await live.locator('#admin-token').fill('browser-stage-b');await live.getByRole('button',{name:'连接',exact:true}).click();await live.locator('.settings-view').waitFor()}
 await check('Formal management authentication and initial source failure preserve an unknown baseline until retry',async()=>{
  await live.goto(base+'/settings/');await live.locator('#admin-token').waitFor();await login()
  await live.locator('.settings-read-error').waitFor()
  assert.equal(await field(live,'replenishRate').inputValue(),'')
  assert.equal(await live.locator('.settings-save').isDisabled(),true)
  await live.getByRole('button',{name:'重试读取配置',exact:true}).click()
  await live.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
  assert.equal(await live.locator('.settings-demo-bar').count(),0)
 })
 await check('Formal PUT sends six fields, expectedVersion and operationId once and validates its receipt without another GET',async()=>{
  await field(live,'replenishRate').fill('40');writeMode='normal';delayWrite=550
  const previousReads=reads,previousWrites=writes
  await live.locator('.settings-save').click()
  await live.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}));form.dispatchEvent(new Event('submit',{cancelable:true,bubbles:true}))})
  assert.equal(await field(live,'replenishRate').isDisabled(),true)
  await waitMessage(live,'保存已确认');assert.equal(writes,previousWrites+1);assert.equal(reads,previousReads)
  assert.equal(await field(live,'replenishRate').inputValue(),'40')
  assert.deepEqual(Object.keys(bodies.at(-1)).sort(),[...runtimeFields,'expectedVersion','operationId'].sort())
  delayWrite=0;writeMode='normal'
 })
 await check('Formal refresh retains edited fields while updating untouched server values',async()=>{
  await field(live,'replenishRate').fill('42');remote={...remote,replenishRate:30,burstCapacity:60};revision++
  await live.getByRole('button',{name:'重新读取',exact:true}).click()
  await live.waitForFunction(()=>document.querySelector('#setting-burstCapacity')?.value==='60')
  assert.equal(await field(live,'replenishRate').inputValue(),'42')
  assert.match(await live.locator('.settings-difference').textContent(),/30.*42/s)
  await live.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click()
 })
 await check('Formal rejected saves retain draft and inline server errors; network and 500 failures require reconciliation',async()=>{
  writeMode='reject';await live.locator('.settings-save').click();await waitMessage(live,'保存被拒绝')
  assert.match(await live.locator('.settings-field-error').textContent(),/isolated validation/)
  await field(live,'replenishRate').fill('43');writeMode='lost';await live.locator('.settings-save').click()
  await waitMessage(live,'未收到可靠');const before=writes
  await live.locator('.settings-query-operation').click();await waitMessage(live,'此前存储写入已确认');assert.equal(writes,before)
  await field(live,'replenishRate').fill('44');writeMode='500';await live.locator('.settings-save').click();await waitMessage(live,'未收到可靠')
  await live.getByRole('button',{name:'读取服务端当前值',exact:true}).click();await waitMessage(live,'不能证明原提交')
   await live.locator('.settings-query-operation').click();await live.waitForFunction(()=>document.querySelector('.settings-operation')?.textContent.includes('没有可用回执'));liveDecision='accept';await live.getByRole('button',{name:'结束确认，保留草稿',exact:true}).click();liveDecision='dismiss'
  assert.equal(await field(live,'replenishRate').inputValue(),'44');assert.equal(await live.locator('.settings-save').isDisabled(),true)
  await live.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click()
 })
 await check('Expired credentials preserve the draft in memory and re-authentication reads before enabling a save',async()=>{
  writeMode='401';await live.locator('.settings-save').click();await live.locator('#admin-token').waitFor()
  assert.match(await live.locator('.zenith-access-notice').textContent(),/暂存在当前页面内存/)
  assert.equal(await live.evaluate(()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}),true)
  deny=false;writeMode='normal';await login()
  await live.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  assert.equal(await field(live,'replenishRate').inputValue(),'44')
  assert.equal(await live.locator('.settings-save').isDisabled(),true)
  await live.getByRole('button',{name:'已核对，允许再次提交',exact:true}).click()
  await shot(live,'settings-stage-b-auth-restored-1440.png')
 })
 await check('Formal navigation, including trailing-slash settings URLs, and disconnect protect drafts; confirmed discard clears retained state',async()=>{
  liveDecision='dismiss';await live.getByRole('link',{name:'路由调度',exact:true}).click()
  assert.match(live.url(),/\/settings\/?$/);assert.equal(await field(live,'replenishRate').inputValue(),'44')
  await live.getByRole('button',{name:'断开管理连接',exact:true}).click()
  assert.equal(await live.locator('#admin-token').count(),0)
  liveDecision='accept';await live.getByRole('button',{name:'断开管理连接',exact:true}).click();await live.locator('#admin-token').waitFor()
  assert.equal(await live.locator('.zenith-access-notice').count(),0)
  await login();await live.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.disabled===false)
  assert.equal(await field(live,'replenishRate').inputValue(),String(remote.replenishRate))
  await live.getByRole('button',{name:'断开管理连接',exact:true}).click()
  await live.goto(base+'/settings/preview-extra');await live.locator('#admin-token').waitFor()
 })
 report.mockedFormal={reads,writes,bodies,sourceFailuresInjected:true,credentialPersistence:await live.evaluate(()=>({local:localStorage.length,session:sessionStorage.length}))}
 await liveCtx.close()
 if(process.env.SETTINGS_RECORD!=='0'){
  const recording=await browser.newContext({viewport:{width:1440,height:900},recordVideo:{dir:out+'/recordings',size:{width:1440,height:900}},reducedMotion:'reduce'})
  const videoPage=await recording.newPage();const video=videoPage.video()
  await videoPage.goto(base+'/settings/preview');await field(videoPage,'replenishRate').waitFor();await delay(1600)
  await field(videoPage,'replenishRate').click();await field(videoPage,'replenishRate').fill('40');await delay(2200)
  await field(videoPage,'monitorWindowSeconds').click();await field(videoPage,'monitorWindowSeconds').fill('30');await delay(1800)
  await videoPage.locator('.settings-review').hover();await delay(1200)
  await videoPage.locator('.settings-save').click();await waitMessage(videoPage,'保存已确认');await delay(2200)
  await videoPage.getByRole('button',{name:'重新读取',exact:true}).click();await delay(1500)
  await recording.close();await copyFile(await video.path(),'docs/media/settings-stage-b-interaction.webm')
  report.recording='docs/media/settings-stage-b-interaction.webm'
 }
 assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.previewApi,[])
 report.passed=true
}catch(error){report.failure=error.stack;await p.screenshot({path:out+'/failure.png',fullPage:true}).catch(()=>{});throw error}
finally{report.completedAt=new Date().toISOString();await writeFile(out+'/browser-validation.json',JSON.stringify(report,null,2)+'\n');await browser.close()}
