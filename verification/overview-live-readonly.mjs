import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const base=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:5173';
const report={startedAt:new Date().toISOString(),kind:'Read-only live backend verification',responses:[],pageErrors:[],writes:[],passed:false};
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
const page=await context.newPage();
page.on('pageerror',e=>report.pageErrors.push(e.message));
page.on('response',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/api/')||path==='/monitor/stream')report.responses.push({path,status:r.status(),contentType:r.headers()['content-type']});});
await page.route('**/api/**',async r=>{if(['GET','HEAD','OPTIONS'].includes(r.request().method())){
 const target=process.env.OVERVIEW_API_TARGET,url=new URL(r.request().url());
 if(!target)await r.continue();
 else if(url.pathname.endsWith('/monitor/stream'))await r.continue({url:target+url.pathname.slice(4)+url.search});
 else {const response=await r.fetch({url:target+url.pathname.slice(4)+url.search});await r.fulfill({response});}
 }else{report.writes.push(new URL(r.request().url()).pathname);await r.abort();}});
try{
 await page.goto(base+'/');
 await page.waitForTimeout(1000);
 if(await page.locator('#admin-token').isVisible()){
  assert.ok(process.env.ZENITH_ADMIN_TOKEN,'Management authentication is enabled; provide ZENITH_ADMIN_TOKEN in this process.');
  await page.locator('#admin-token').fill(process.env.ZENITH_ADMIN_TOKEN);
  await page.getByRole('button',{name:'连接',exact:true}).click();
 }
 await page.locator('.overview-chart canvas').waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-testid=qps]')?.textContent!=='—');
 const first=await page.locator('.overview-freshness time').textContent();
 await page.waitForFunction(first=>document.querySelector('.overview-freshness time')?.textContent!==first,first,{timeout:8000});
 assert.equal(await page.locator('.overview-demo-bar').count(),0);
 assert.equal(await page.locator('.overview-freshness.is-stale').count(),0);
 report.currentWindow={qps:await page.locator('[data-testid=qps]').textContent(),p95:await page.locator('[data-testid=p95]').textContent(),scope:await page.locator('.overview-window-context').textContent()};
 report.recordCount=await page.locator('.overview-record-table tbody tr').count();
 report.observedFreshSseUpdate=true;
 assert.ok(report.responses.some(r=>r.path.endsWith('/monitor/stream')&&r.status===200&&r.contentType?.includes('text/event-stream')));
 await page.screenshot({path:'docs/images/overview-stage-a-live-1440.png'});
 await page.getByRole('button',{name:'展开详情',exact:true}).click();
 assert.match(await page.locator('#overview-audit-detail').textContent(),/本次进程累计/);
 await page.getByRole('button',{name:'收起详情',exact:true}).click();
 if(report.recordCount){
  await page.locator('.overview-record-path button').first().click();
  await page.locator('.overview-record-dialog[open]').waitFor();await page.keyboard.press('Escape');
 }
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>scrollTo(0,0));
 await page.getByRole('button',{name:'导航',exact:true}).click();
 for(const name of ['运行概览','路由调度','系统配置'])assert.equal(await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name,exact:true}).isVisible(),true);
 await page.getByRole('link',{name:'系统配置',exact:true}).click();await page.locator('form').waitFor();
 await page.getByRole('button',{name:'导航',exact:true}).click();
 await page.getByRole('link',{name:'运行概览',exact:true}).click();await page.locator('.overview-chart canvas').waitFor();
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 await page.getByRole('button',{name:'断开管理连接',exact:true}).click();await page.locator('#admin-token').waitFor();
 assert.deepEqual(report.writes,[]);assert.deepEqual(report.pageErrors,[]);
 report.passed=true;
 console.log(JSON.stringify({passed:report.passed,currentWindow:report.currentWindow,recordCount:report.recordCount,observedFreshSseUpdate:report.observedFreshSseUpdate,writes:report.writes}));
}catch(error){report.failure=error.stack;throw error;}
finally{await writeFile('.dev/overview-stage-a/live-readonly.json',JSON.stringify(report,null,2)+'\n');await browser.close();}
