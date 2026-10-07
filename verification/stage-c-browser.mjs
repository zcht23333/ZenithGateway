import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
const base=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15175'
const out='.dev/stage-c'
await mkdir(out,{recursive:true})
const browser=await chromium.launch({channel:'msedge',headless:true})
const report={startedAt:new Date().toISOString(),checks:[],errors:[],previewApi:[],passed:false}
async function fresh(width=1440,height=900){
 const ctx=await browser.newContext({viewport:{width,height},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']})
 const p=await ctx.newPage();p.setDefaultTimeout(7000)
 p.on('pageerror',e=>report.errors.push(e.message))
 p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))report.previewApi.push(new URL(r.url()).pathname)})
 return [ctx,p]
}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
try{
 await check('A delayed chart engine does not delay metrics or records; leaving before it arrives creates no orphan canvas',async()=>{
  const [ctx,p]=await fresh();let release
  await p.route('**/assets/chart-*.js',async r=>{await new Promise(resolve=>{release=resolve});await r.continue()})
  await p.goto(base+'/overview/preview',{waitUntil:'domcontentloaded'})
  await p.locator('.overview-engine-state').waitFor()
  assert.equal(await p.locator('[data-testid=qps]').textContent(),'2,486.20')
  assert.ok(await p.locator('.overview-record-table tbody tr').count()>0)
  await p.screenshot({path:'docs/images/stage-c-chart-loading-1440.png'})
  await p.getByRole('link',{name:'系统配置',exact:true}).click();await p.locator('#setting-replenishRate').waitFor()
  release();await p.waitForTimeout(350);assert.equal(await p.locator('canvas').count(),0)
  await p.getByRole('link',{name:'运行概览',exact:true}).click();await p.locator('.overview-chart canvas').waitFor()
  assert.equal(await p.locator('.overview-chart canvas').count(),1);await ctx.close()
 })
 await check('A failed chart import is explicit; explicit reload recovers while numbers and record copy remain usable',async()=>{
  const [ctx,p]=await fresh();let fail=true
  await p.route('**/assets/chart-*.js',r=>fail?r.abort('failed'):r.continue())
  await p.goto(base+'/overview/preview');await p.getByRole('button',{name:'重新载入页面'}).waitFor()
  assert.equal(await p.locator('[data-testid=p95]').textContent(),'34')
  await p.screenshot({path:'docs/images/stage-c-chart-failure-1440.png'})
  await p.setViewportSize({width:390,height:844});await p.waitForTimeout(100)
  const loadingBox=await p.locator('.overview-engine-state').boundingBox(),metricBox=await p.locator('.overview-current-metric.is-latency').boundingBox()
  assert.ok(loadingBox.y+loadingBox.height<=metricBox.y)
  await p.screenshot({path:'docs/images/stage-c-chart-failure-390.png',fullPage:true})
  await p.setViewportSize({width:1440,height:900})
  await p.locator('.overview-record-path button').first().click()
  const copy=p.getByRole('button',{name:'复制完整请求路径',exact:true})
  assert.equal(Math.round((await copy.boundingBox()).width),29)
  await copy.click();assert.ok((await p.evaluate(()=>navigator.clipboard.readText())).endsWith('/settlement-details'))
  await p.keyboard.press('Escape')
  fail=false;await p.getByRole('button',{name:'重新载入页面'}).click();await p.locator('.overview-chart canvas').waitFor()
  await ctx.close()
 })
 await check('Page chunk failure has a recoverable shell without a false configuration baseline',async()=>{
  const [ctx,p]=await fresh();let fail=true
  await p.route('**/assets/Settings-*.js',r=>fail?r.abort('failed'):r.continue())
  await p.goto(base+'/settings/preview');await p.getByRole('button',{name:'重新载入页面'}).waitFor()
  assert.equal(await p.locator('#setting-replenishRate').count(),0)
  fail=false;await p.getByRole('button',{name:'重新载入页面'}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
  await ctx.close()
 })
 await check('P95 overflow has its own labelled time lane, keyboard readout and readable phone layout',async()=>{
  const [ctx,p]=await fresh();await p.goto(base+'/overview/preview?scenario=overflow');await p.locator('.overview-chart canvas').waitFor()
  assert.match(await p.locator('.overview-overflow-lane').textContent(),/> 60,000 ms.*2 点/)
  const slider=p.getByRole('slider',{name:'查看趋势采样'});await slider.focus();await slider.press('End')
  assert.match(await p.locator('.overview-trend-readout').textContent(),/P95\s*> 60,000/)
  await slider.press('ArrowLeft');assert.doesNotMatch(await p.locator('.overview-trend-readout').textContent(),/> 60,000/)
  assert.equal(await p.locator('[data-testid=p95]').textContent(),'> 60,000')
  await p.setViewportSize({width:390,height:844});await p.waitForTimeout(100)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390)
  await p.screenshot({path:'docs/images/stage-c-p95-after-390.png',fullPage:true});await ctx.close()
 })
 await check('Mobile changed-count entry follows the draft, focuses the full review and disappears after restoring or saving',async()=>{
  const [ctx,p]=await fresh(390,844);await p.goto(base+'/settings/preview')
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
  const field=p.locator('#setting-replenishRate'),jump=p.locator('.settings-review-jump')
  assert.equal(await jump.count(),0)
  await field.fill('40');await p.locator('#setting-monitorWindowSeconds').fill('30')
  assert.match(await jump.textContent(),/已修改 2 项 · 查看变更/)
  assert.equal(await jump.evaluate(el=>getComputedStyle(el).position),'static')
  await p.evaluate(()=>document.activeElement?.blur())
  assert.equal(await jump.evaluate(el=>getComputedStyle(el).position),'sticky')
  await jump.click();assert.equal(await p.evaluate(()=>document.activeElement?.id),'settings-review-title')
  const title=await p.locator('#settings-review-title').boundingBox();assert.ok(title.y>=0&&title.y<422)
  assert.equal(await p.locator('.settings-difference').count(),2)
  await p.screenshot({path:'docs/images/stage-c-mobile-review-390.png'})
  await p.getByRole('button',{name:'恢复当前已确认值',exact:true}).click();assert.equal(await jump.count(),0)
  await field.fill('40');await p.evaluate(()=>document.activeElement?.blur());await jump.click()
  await p.locator('.settings-save').click();await p.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
  assert.equal(await jump.count(),0);await ctx.close()
 })
 await check('Typing and invalid errors remain unobstructed in a reduced viewport; all mobile navigation stays reachable',async()=>{
  const [ctx,p]=await fresh(390,480);await p.goto(base+'/settings/preview')
  await p.waitForFunction(()=>document.querySelector('#setting-replenishRate')?.value==='20')
  const field=p.locator('#setting-monitorWindowSeconds')
  await field.fill('0')
  await field.evaluate(el=>el.scrollIntoView({block:'center'}))
  assert.equal(await p.locator('.settings-review-jump').evaluate(el=>getComputedStyle(el).position),'static')
  const box=await field.boundingBox(),error=await p.locator('#monitorWindowSeconds-help').boundingBox()
  assert.ok(box.y>=0&&error.y+error.height<=480)
  assert.equal(await p.locator('.settings-save').isDisabled(),true)
  await p.screenshot({path:'docs/images/stage-c-mobile-input-390.png'})
  await field.fill('30');await p.evaluate(()=>document.activeElement?.blur())
  await p.locator('.settings-review-jump').click();await p.getByRole('button',{name:'恢复当前已确认值',exact:true}).click()
  await p.evaluate(()=>scrollTo(0,0));await p.getByRole('button',{name:'导航',exact:true}).click()
  assert.equal(await p.locator('.zenith-nav a:visible').count(),3)
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),390)
  await ctx.close()
 })
 assert.deepEqual(report.previewApi,[]);assert.deepEqual(report.errors,[]);report.passed=true
}finally{await browser.close();await writeFile(out+'/browser-validation.json',JSON.stringify(report,null,2)+'\n')}
