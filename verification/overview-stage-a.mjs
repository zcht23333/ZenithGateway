import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url));
const base=(process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15174').replace(/\/$/,'');
const out=join(root,'.dev/overview-stage-a'),images=join(root,'docs/images'),media=join(root,'docs/media');
for(const dir of [out,images,media])await mkdir(dir,{recursive:true});
const report={startedAt:new Date().toISOString(),checks:[],screenshots:[],layouts:[],errors:[],previewApi:[],passed:false};
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||(process.platform==='win32'?'msedge':undefined),headless:true});
const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
const p=await ctx.newPage();p.setDefaultTimeout(7000);
p.on('pageerror',e=>report.errors.push(e.message));
p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))report.previewApi.push(r.url());});
async function until(fn){const end=Date.now()+6000;while(Date.now()<end){if(await fn())return;await delay(30);}throw new Error('Condition timed out');}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function scene(name='normal',width=1440,height=900){
 await p.setViewportSize({width,height});await p.goto(base+'/overview/preview?scenario='+name);
 await p.locator('.overview-chart canvas').waitFor();await delay(80);
}
async function shot(name,fullPage=false){await p.mouse.move(0,0);await p.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur()});await p.screenshot({path:join(images,name),fullPage,animations:'disabled'});report.screenshots.push({file:'docs/images/'+name,...p.viewportSize(),fullPage});}
try{
 await check('Normal first viewport prioritises QPS, P95 and two aligned trends, followed by the audit summary',async()=>{
  await scene();
  assert.equal(await p.locator('[data-testid=qps]').textContent(),'2,486.20');
  assert.equal(await p.locator('[data-testid=p95]').textContent(),'34');
  assert.equal(await p.locator('#overview-audit-detail').count(),0);
  assert.match(await p.locator('.overview-window-context').textContent(),/10.*24,862/);
  const chart=await p.locator('.overview-trend-canvas').boundingBox(),audit=await p.locator('.overview-audit-summary').boundingBox();
  assert.ok(chart.y+chart.height<900);assert.ok(audit.y+audit.height<900);
  assert.equal(await p.getByText('实时请求流',{exact:true}).count(),0);
  assert.equal(await p.locator('.overview-chart').getAttribute('aria-label').then(s=>s.includes('120 个采样点')),true);
  await shot('overview-stage-a-normal-1440.png');
 });
 await check('Inspecting actual samples changes the readout without replacing current-window metrics',async()=>{
  const slider=p.getByRole('slider',{name:'查看趋势采样'}),current=await p.locator('[data-testid=qps]').textContent();
  await slider.focus();await slider.press('Home');
  await until(async()=>!(await p.getByRole('button',{name:'跟随最新',exact:true}).isDisabled()));
  const before=await p.locator('.overview-sample-time').textContent();
  await slider.press('ArrowRight');assert.notEqual(await p.locator('.overview-sample-time').textContent(),before);
  assert.equal(await p.locator('[data-testid=qps]').textContent(),current);
  await p.getByRole('button',{name:'跟随最新',exact:true}).click();
  assert.match(await p.locator('.overview-sample-time').textContent(),/最新采样/);
 });
 await check('Audit details separate process counters from current queue state and explain uncertain writes',async()=>{
  assert.match(await p.locator('.overview-audit-name').textContent(),/待写入已排空/);
  await p.getByRole('button',{name:'展开详情',exact:true}).click();
  const detail=p.locator('#overview-audit-detail');await detail.waitFor();
  assert.match(await detail.textContent(),/本次进程累计.*累计异常不等于此刻仍故障/s);
  assert.match(await detail.textContent(),/可能已经写入 Redis/);
  assert.match(await detail.textContent(),/累计丢弃原因：队列已满 8/);
  await p.getByRole('button',{name:'收起详情',exact:true}).click();
 });
 await check('Recent records expose full long paths, exact JSON, dates, cancellation and status zero',async()=>{
  assert.match(await p.locator('.overview-records header').textContent(),/40 条.*5 秒.*当前统计窗口/);
  assert.match(await p.locator('.overview-record-table').textContent(),/已取消 · 未形成 HTTP 状态/);
  assert.match(await p.locator('.overview-record-table').textContent(),/请求异常 · 未形成 HTTP 状态/);
  const times=await p.locator('.overview-record-time').allTextContents();
  assert.ok(new Set(times.map(t=>t.slice(0,10))).size>=2);
  await p.locator('.overview-record-path button').first().click();
  const dialog=p.locator('.overview-record-dialog[open]');await dialog.waitFor();
  await dialog.getByRole('button',{name:'复制完整请求路径',exact:true}).click();
  const path=await p.evaluate(()=>navigator.clipboard.readText());assert.ok(path.endsWith('/settlement-details'));assert.ok(path.length>130);
  await dialog.getByRole('button',{name:'复制审计记录 JSON',exact:true}).click();
  assert.equal(JSON.parse(await p.evaluate(()=>navigator.clipboard.readText())).path,path);
  assert.equal(await dialog.locator('code').evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
  await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
 });
 await check('Zero traffic, empty history, first loading, disabled monitoring and P95 overflow remain distinct',async()=>{
  await scene('zero');assert.equal(await p.locator('[data-testid=qps]').textContent(),'0.00');
  assert.ok(await p.locator('.overview-record-table tbody tr').count()>0);
  await scene('empty');assert.equal(await p.locator('[data-testid=qps]').textContent(),'0.00');
  assert.match(await p.locator('.overview-chart-empty').textContent(),/尚无历史采样/);
  assert.match(await p.locator('.overview-record-empty').textContent(),/暂无审计记录/);
  await shot('overview-stage-a-empty-1440.png');
  await scene('loading');assert.equal(await p.locator('[data-testid=qps]').textContent(),'—');
  assert.equal(await p.locator('[data-testid=p95]').textContent(),'—');
  assert.match(await p.locator('.overview-record-empty').textContent(),/正在读取/);
  await scene('disabled');assert.equal(await p.locator('[data-testid=qps]').textContent(),'—');
  assert.match(await p.locator('.overview-chart-empty').textContent(),/监控已关闭/);
  await scene('overflow');assert.equal(await p.locator('[data-testid=p95]').textContent(),'> 60,000');
  assert.match(await p.locator('.overview-trend-footnote').textContent(),/独立事件带.*不参与延迟纵轴.*P95 > 60,000 ms/);
  await shot('overview-stage-a-overflow-1440.png');
  await scene('gaps');await shot('overview-stage-a-gaps-1440.png');
 });
 await check('Partial failures retain timestamped old data and allow independent source recovery',async()=>{
  await scene('partial');
  assert.match(await p.locator('.overview-freshness').textContent(),/旧数据/);
  assert.match(await p.locator('.overview-records-read').textContent(),/旧记录/);
  assert.match(await p.locator('.overview-audit-name').textContent(),/待写入已排空/);
  await shot('overview-stage-a-partial-1440.png',true);
  await p.getByRole('button',{name:'重试历史采样',exact:true}).click();
  assert.equal(await p.getByRole('button',{name:'重试历史采样',exact:true}).count(),0);
  assert.match(await p.locator('.overview-freshness').textContent(),/旧数据/);
  await p.getByRole('button',{name:'重试流量更新',exact:true}).click();
  assert.match(await p.locator('.overview-freshness').textContent(),/窗口指标已更新/);
  assert.match(await p.locator('.overview-records-read').textContent(),/旧记录/);
  await p.getByRole('button',{name:'重试读取记录',exact:true}).click();
  assert.equal(await p.locator('.overview-record-error').count(),0);
  await scene('audit');assert.match(await p.locator('.overview-audit-name').textContent(),/已停止接收/);
  await shot('overview-stage-a-audit-1440.png');
 });
 await check('320–1440px layouts keep all three navigation destinations available and long records usable',async()=>{
  for(const width of [1440,960,700,390,320]){
   await scene('normal',width,width===390?844:900);
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),width);
   if(width<=700){
    await p.getByRole('button',{name:'导航',exact:true}).click();
    for(const name of ['运行概览','路由调度','系统配置'])assert.equal(await p.getByRole('navigation',{name:'主导航'}).getByRole('link',{name,exact:true}).isVisible(),true);
    await p.keyboard.press('Escape');
    assert.equal(await p.getByRole('button',{name:'导航',exact:true}).getAttribute('aria-expanded'),'false');
   }
   if(width===390){await shot('overview-stage-a-normal-390.png',true);await shot('overview-stage-a-first-screen-390.png');}
   await p.locator('.overview-record-path button').first().click();
   const dialog=p.locator('.overview-record-dialog[open]'),bounds=await dialog.boundingBox();
   assert.ok(bounds.x>=0&&bounds.x+bounds.width<=width+1);
   assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
   await p.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
   report.layouts.push({width,horizontalOverflow:false});
  }
 });
 await check('Explicit overview and route previews remain isolated from management APIs',async()=>{
  await scene('normal',390,844);
  await p.getByRole('button',{name:'导航',exact:true}).click();
  await p.getByRole('link',{name:'路由调度',exact:true}).click();
  await p.locator('.dispatch-route-identity h1').waitFor();
  assert.ok(p.url().includes('/routes/preview'));
  await p.getByRole('button',{name:'导航',exact:true}).click();
  await p.getByRole('link',{name:'运行概览',exact:true}).click();
  await p.locator('.overview-chart canvas').waitFor();
  assert.deepEqual(report.previewApi,[]);
 });

 const liveContext=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
 const live=await liveContext.newPage();live.setDefaultTimeout(7000);
 live.on('pageerror',e=>report.errors.push(e.message));
 const now=Date.now(),snap={timestamp:now,enabled:true,qps:0,requestCount:0,windowSeconds:10,p95LatencyMs:0,avgLatencyMs:0,status2xx:0,status3xx:0,status4xx:0,status5xx:0,cancelled:0,errors:0,unknownStatus:0};
 const audit={enabled:true,accepting:true,received:10,persisted:10,dropped:0,droppedByReason:{},uncertain:0,pending:0,queueDepth:0,inFlight:0,capacity:20000,reservedBytes:0,maxReservedBytes:16777216,oldestAgeMs:0,retries:0,lastBatchSize:10,lastBatchDurationMs:2,lastSuccessAgeMs:1000};
 const oldRecord={eventId:'browser-old',timestamp:now-86400000,method:'GET',path:'/yesterday/full-record',statusCode:0,outcome:'cancelled',durationMs:500,clientIp:'192.0.2.1'};
 const bodies={'/settings/runtime':{rateLimitEnabled:true,replenishRate:1200,burstCapacity:2400,requestedTokens:1,monitorWindowSeconds:10,emitIntervalSeconds:1},
  '/dashboard/snapshot':snap,'/dashboard/series':[],'/monitor/audit/recent':[oldRecord],'/monitor/audit/status':audit,'/settings/sse-token':{token:'browser-scope-ticket'},'/settings/routes':[]};
 const overrides=new Map(),counts=new Map();let writes=0;
 await live.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname.slice(4);counts.set(path,(counts.get(path)||0)+1);
  if(!['GET','HEAD','OPTIONS'].includes(r.request().method())){writes++;await r.abort();return;}
  const override=overrides.get(path);
  if(override?.delay)await delay(override.delay);
  await r.fulfill({status:override?.status??200,contentType:'application/json',body:JSON.stringify(override?.body??bodies[path]??{})}).catch(()=>{});
 });
 await live.addInitScript(()=>{
  window.__overviewSources=[];
  window.EventSource=class {
   callbacks={};closed=false;
   constructor(url){this.url=url;window.__overviewSources.push(this);setTimeout(()=>this.onopen?.(),25);}
   addEventListener(name,cb){this.callbacks[name]=cb;}
   close(){this.closed=true;}
  };
  window.__overviewEmit=payload=>window.__overviewSources.filter(s=>!s.closed).forEach(s=>s.callbacks.traffic?.({data:JSON.stringify(payload)}));
 });
 await check('Formal overview loads sources independently; unknown metrics stay dashes while audit records arrive',async()=>{
  overrides.set('/dashboard/snapshot',{status:503,body:{message:'isolated snapshot failure'}});
  overrides.set('/dashboard/series',{status:503,body:{message:'isolated history failure'}});
  overrides.set('/monitor/audit/status',{status:503,body:{message:'isolated audit status failure'}});
  await live.goto(base+'/');await live.locator('.overview-record-table').waitFor();
  assert.equal(await live.locator('[data-testid=qps]').textContent(),'—');
  assert.match(await live.locator('.overview-freshness').textContent(),/读取失败/);
  assert.match(await live.locator('.overview-audit-name').textContent(),/状态读取失败/);
  assert.match(await live.locator('.overview-record-table').textContent(),/已取消 · 未形成 HTTP 状态/);
  await live.evaluate(payload=>window.__overviewEmit(payload),{...snap,timestamp:Date.now(),qps:7,requestCount:70,p95LatencyMs:12});
  await until(async()=>await live.locator('[data-testid=qps]').textContent()==='7.00');
  assert.equal(await live.getByRole('button',{name:'重试历史采样',exact:true}).count(),1);
  assert.match(await live.locator('.overview-audit-name').textContent(),/状态读取失败/);
  overrides.delete('/dashboard/snapshot');overrides.delete('/dashboard/series');overrides.delete('/monitor/audit/status');
  await live.getByRole('button',{name:'重试历史采样',exact:true}).click();
  await live.getByRole('button',{name:'重试审计状态',exact:true}).click();
  await until(async()=>await live.locator('.overview-source-error').count()===0);
 });
 await check('A failed records refresh retains old records; other data stays readable and retry clears the error',async()=>{
  overrides.set('/monitor/audit/recent',{status:503,body:{message:'isolated records unavailable'}});
  await live.getByRole('button',{name:'刷新记录',exact:true}).click();
  await until(async()=>await live.locator('.overview-record-error').count()===1);
  assert.match(await live.locator('.overview-records-read').textContent(),/旧记录/);
  assert.equal(await live.locator('.overview-record-table tbody tr').count(),1);
  assert.equal(await live.locator('[data-testid=qps]').textContent(),'7.00');
  overrides.delete('/monitor/audit/recent');
  await live.getByRole('button',{name:'重试读取记录',exact:true}).click();
  await until(async()=>await live.locator('.overview-record-error').count()===0);
 });
 await check('An open but silent stream becomes stale; a new event and reconnect recover without clearing audits',async()=>{
  await live.evaluate(payload=>window.__overviewEmit(payload),{...snap,timestamp:Date.now()-30000,qps:0});
  // Older events cannot overwrite the latest snapshot; use an isolated old initial snapshot after reload.
  bodies['/dashboard/snapshot']={...snap,timestamp:Date.now()-30000};
  await live.reload();await live.locator('.overview-record-table').waitFor();
  await until(async()=>/旧数据/.test(await live.locator('.overview-freshness').textContent()));
  await live.evaluate(payload=>window.__overviewEmit(payload),{...snap,timestamp:Date.now(),qps:3,requestCount:30});
  await until(async()=>/窗口指标已更新/.test(await live.locator('.overview-freshness').textContent()));
  await live.evaluate(()=>window.__overviewSources.filter(s=>!s.closed).at(-1).onerror());
  await until(async()=>/旧数据/.test(await live.locator('.overview-freshness').textContent()));
  assert.equal(await live.locator('.overview-record-table tbody tr').count(),1);
  await live.getByRole('button',{name:'重试流量更新',exact:true}).click();
  await delay(100);
  await live.evaluate(payload=>window.__overviewEmit(payload),{...snap,timestamp:Date.now(),qps:4,requestCount:40});
  await until(async()=>await live.locator('[data-testid=qps]').textContent()==='4.00');
 });
 await check('Navigation and formal-to-preview transitions release subscriptions and record polling',async()=>{
  await live.getByRole('link',{name:'系统配置',exact:true}).click();await live.locator('form').waitFor();
  assert.equal(await live.evaluate(()=>window.__overviewSources.filter(s=>!s.closed).length),0);
  await live.getByRole('link',{name:'运行概览',exact:true}).click();await live.locator('.overview-chart canvas').waitFor();
  await until(async()=>await live.evaluate(()=>window.__overviewSources.filter(s=>!s.closed).length)===1);
  await live.evaluate(async()=>{await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/overview/preview');});
  await live.locator('.overview-demo-bar').waitFor();
  assert.equal(await live.evaluate(()=>window.__overviewSources.filter(s=>!s.closed).length),0);
  const requests=[...counts.values()].reduce((a,b)=>a+b,0);
  await delay(5200);
  assert.equal([...counts.values()].reduce((a,b)=>a+b,0),requests);
  assert.equal(writes,0);
 });
 await check('Non-preview URLs and expired credentials still require management authentication',async()=>{
  await live.evaluate(async()=>{await document.querySelector('#app').__vue_app__.config.globalProperties.$router.push('/');});
  await live.locator('.overview-record-table').waitFor();
  overrides.set('/monitor/audit/recent',{status:401,body:{}});
  await live.getByRole('button',{name:'刷新记录',exact:true}).click();
  await live.locator('#admin-token').waitFor();
  assert.equal(await live.locator('.overview-chart').count(),0);
  assert.equal(await live.evaluate(()=>window.__overviewSources.filter(s=>!s.closed).length),0);
  await live.goto(base+'/overview/preview-extra');
  assert.equal(await live.locator('.overview-demo-bar').count(),0);
 });
 await liveContext.close();
 report.mockedFormal={sourceFailuresInjected:true,managementWrites:writes,requests:Object.fromEntries(counts)};

 if(process.env.OVERVIEW_RECORD!=='0'){
  const recording=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference',recordVideo:{dir:join(out,'raw-video'),size:{width:1440,height:900}},permissions:['clipboard-read','clipboard-write']});
  const v=await recording.newPage(),video=v.video();
  v.on('pageerror',e=>report.errors.push(e.message));
  await v.goto(base+'/overview/preview');await v.locator('.overview-chart canvas').waitFor();await delay(1000);
  const chart=await v.locator('.overview-chart').boundingBox();
  await v.mouse.move(chart.x+chart.width*.72,chart.y+70);await delay(1400);
  await v.mouse.move(chart.x+chart.width*.5,chart.y+215);await delay(1200);
  await v.mouse.move(20,200);
  await v.getByRole('button',{name:'展开详情',exact:true}).click();
  await v.locator('#overview-audit-detail').scrollIntoViewIfNeeded();await delay(2800);
  await v.getByRole('button',{name:'收起详情',exact:true}).click();await delay(700);
  await v.locator('.overview-records').scrollIntoViewIfNeeded();await delay(1100);
  await v.locator('.overview-record-path button').first().click();await delay(3000);
  await v.getByRole('button',{name:'复制完整请求路径',exact:true}).click();await delay(1000);
  await v.getByRole('button',{name:'关闭完整记录',exact:true}).click();await delay(600);
  await recording.close();await video.saveAs(join(media,'overview-stage-a-interaction.webm'));
  report.recording='docs/media/overview-stage-a-interaction.webm';
  console.log('RECORDED '+report.recording);
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.previewApi,[]);
 report.passed=true;
}catch(error){report.failure=error.stack;await p.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await writeFile(join(out,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
