import { chromium } from '../.dev/browser/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = (process.env.ROUTE_CONSOLE_URL || 'http://127.0.0.1:15174').replace(/\/$/, '');
const output = process.env.ROUTE_DISPATCH_OUTPUT || join(root, '.dev/route-dispatch');
const images = process.env.ROUTE_DISPATCH_IMAGES || join(root, 'docs/images');
await mkdir(output, { recursive: true });
await mkdir(images, { recursive: true });
const report = { generatedAt: new Date().toISOString(), base, checks: [], layouts: [], screenshots: [], pageErrors: [], apiRequests: [], passed: false };
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
page.on('pageerror', e => report.pageErrors.push(e.message));
page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) report.apiRequests.push(r.url()); });
page.setDefaultTimeout(6000);
const cards = page.locator('.dispatch-route-card');
const current = page.locator('.dispatch-route-identity h1');
const search = page.getByRole('searchbox', { name: '搜索路由' });
const stages = page.locator('.dispatch-station-button');
const full = page.locator('.dispatch-fields-dialog[open]');
const longId = 'asia-pacific-enterprise-order-orchestration-and-settlement-service-v2';
async function until(fn) {
  const end = Date.now() + 5000; let last;
  while (Date.now() < end) { try { if (await fn()) return; } catch(e) { last = e; } await delay(40); }
  throw last || new Error('Condition timed out');
}
async function check(name, fn) {
  await fn(); report.checks.push(name); console.log('PASS ' + name);
}
async function scene(name) {
  await page.goto(base + '/routes/preview?scenario=' + name);
  await current.waitFor();
  await until(async () => await cards.count() > 0);
}
async function stageKinds() { return stages.evaluateAll(els => els.map(el => el.dataset.kind)); }
async function select(id) { await page.locator('[id=' + JSON.stringify('dispatch-route-' + id) + ']').click(); await until(async () => await current.textContent() === id); }
async function screenshot(name) {
  await page.screenshot({ path: join(images, name), animations: 'disabled', fullPage: false });
  report.screenshots.push({ file: join(images, name), ...page.viewportSize(), fullPage: false });
}
async function layout() {
  return page.evaluate(() => ({
    width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight,
    cardCount: document.querySelectorAll('.dispatch-route-card').length,
    selectedVisible: !!document.querySelector('.dispatch-route-card[aria-pressed=true]'),
    dock: document.querySelector('.dispatch-dock').getBoundingClientRect().toJSON(),
    identityClipped: [...document.querySelectorAll('.dispatch-route-identity h1,.dispatch-current-path code')].some(el => el.scrollWidth > el.clientWidth + 1),
    cardLabelClipped: [...document.querySelectorAll('.dispatch-card-head strong,.dispatch-card-meta code,.dispatch-card-meta>span')].some(el => el.scrollWidth > el.clientWidth + 1),
    stationLabels: [...document.querySelectorAll('.dispatch-station-label')].map(el => ({ text: el.textContent, ...el.getBoundingClientRect().toJSON() }))
  }));
}
try {
  await check('Normal route exposes actual ordered stages and conditional 429/503 branches', async () => {
    await scene('normal');
    assert.equal(await current.textContent(), 'order-service');
    assert.equal(await cards.count(), 6);
    assert.deepEqual(await stageKinds(), ['entry','limit','breaker','rewrite','target']);
    assert.match(await page.locator('.dispatch-branch').allTextContents().then(a=>a.join(' ')), /429.*503/);
    assert.match(await page.locator('.dispatch-context-bar').textContent(), /演示数据/);
  });
  await check('Node expands in place, exposes complete rewrite example and fields, Escape restores focus', async () => {
    await page.locator('[data-kind=rewrite]').click();
    const panel = page.locator('.dispatch-node-inspector');
    await panel.waitFor();
    assert.deepEqual(await panel.locator('.dispatch-example code').allTextContents(), ['/api/orders/123','/123']);
    assert.match(await panel.textContent(), /按规则推导/);
    assert.match(await panel.textContent(), /\$\{segment\}/);
    const body = await panel.locator('.dispatch-inspector-body').evaluate(el=>({height:el.clientHeight,scrollHeight:el.scrollHeight}));
    assert.ok(body.scrollHeight <= body.height + 1, JSON.stringify(body));
    await panel.getByRole('button',{name:'复制替换目标',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()), '/${segment}');
    await page.keyboard.press('Escape');
    await panel.waitFor({state:'detached'});
    assert.equal(await panel.count(), 0);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dispatch-station-rewrite');
  });
  await check('Route switching removes unsupported stages and closes prior node panel', async () => {
    await page.locator('[data-kind=breaker]').click();
    assert.match(await page.locator('.dispatch-node-inspector').textContent(), /普通 HTTP 500 按原响应传递/);
    await screenshot('proxy-breaker-preview-1440.png');
    await select('public-assets');
    await page.locator('.dispatch-node-inspector').waitFor({state:'detached'});
    assert.deepEqual(await stageKinds(), ['entry','limit','target']);
    assert.equal(await page.locator('.dispatch-node-inspector').count(),0);
    assert.equal(await page.locator('.dispatch-branch').count(),1);
    await select('payment-service');
    assert.deepEqual(await stageKinds(), ['entry','limit','breaker','target']);
  });
  await check('Search and filters keep current route until explicit selection; locate restores its directory page', async () => {
    await search.fill('ACCOUNT.INTERNAL');
    assert.equal(await cards.count(),1);
    assert.equal(await current.textContent(),'payment-service');
    await search.press('Enter');
    await until(async()=>await current.textContent()==='account-service');
    await search.fill('does-not-exist');
    assert.equal(await cards.count(),0);
    assert.equal(await current.textContent(),'account-service');
    await page.getByRole('button',{name:'清除筛选',exact:true}).click();
    await page.getByRole('combobox',{name:'筛选处理规则'}).selectOption('plain');
    assert.equal(await cards.count(),1);
    assert.equal(await current.textContent(),'account-service');
    await page.getByRole('button',{name:'定位当前路由',exact:true}).click();
    assert.equal(await cards.count(),6);
    assert.equal(await page.getByRole('combobox',{name:'筛选处理规则'}).inputValue(),'all');
  });
  await check('32 routes paginate 6 per page, keep selection while browsing, and support keyboard selection across pages', async () => {
    await scene('dense');
    assert.equal(await current.textContent(),longId);
    assert.equal(await page.locator('.dispatch-directory-count').textContent(),'32');
    assert.equal(await cards.count(),6);
    await page.getByRole('button',{name:'下一页',exact:true}).click();
    assert.equal(await cards.first().locator('.dispatch-card-number').textContent(),'07');
    assert.equal(await current.textContent(),longId);
    await page.getByRole('combobox',{name:'跳转页码'}).selectOption('6');
    assert.equal(await cards.count(),2);
    assert.equal(await cards.first().locator('.dispatch-card-number').textContent(),'31');
    await page.getByRole('button',{name:'定位当前路由',exact:true}).click();
    assert.equal(await page.getByRole('combobox',{name:'跳转页码'}).inputValue(),'1');
    await cards.last().focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.dispatch-route-number span').textContent(),'07');
    assert.equal(await page.getByRole('combobox',{name:'跳转页码'}).inputValue(),'2');
    await page.keyboard.press('End');
    assert.equal(await page.locator('.dispatch-route-number span').textContent(),'32');
    await page.keyboard.press('Home');
    assert.equal(await page.locator('.dispatch-route-number span').textContent(),'01');
    await search.fill('/api/enterprise/asia-pacific');
    assert.equal(await cards.count(),1);
    assert.equal(await current.textContent(),'account-service');
    await search.press('Enter');
    await until(async()=>await current.textContent()===longId);
    await search.fill('');
  });
  await check('Long route fields are complete, selectable and copyable as text and JSON', async () => {
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    await full.waitFor();
    assert.equal(await full.locator('.dispatch-value').count(),9);
    assert.match(await full.textContent(),new RegExp(longId));
    await full.getByRole('button',{name:'复制路由 ID',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),longId);
    await full.getByRole('button',{name:'复制目标地址 · URI',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'http://enterprise-order-orchestration.ap-southeast.internal:8080');
    await full.getByRole('button',{name:'复制全部 JSON',exact:true}).click();
    const copied=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
    assert.equal(copied.id,longId);
    assert.equal(copied.rewriteReplacement,'/${segment}');
    assert.equal(copied.fallbackPath,'/fallback/default');
    assert.equal(await full.locator('.dispatch-value code').evaluateAll(els=>els.some(el=>el.scrollWidth>el.clientWidth+1)),false);
    await page.keyboard.press('Escape');
    assert.equal(await full.count(),0);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dispatch-fields-open');
  });
  await check('Configuration error is centralized, cached canvas remains, writes block, details and retry work', async () => {
    await scene('exception');
    assert.equal(await current.textContent(),'order-service');
    assert.equal(await stages.count(),5);
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'新建路由',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('.dispatch-config-state .is-error').count(),1);
    assert.equal(await cards.locator('.is-error,.is-warning').count(),0);
    await page.locator('.dispatch-config-state>button').first().click();
    assert.match(await page.locator('#dispatch-status-detail').textContent(),/HTTP 503/);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    assert.equal(await full.getByRole('button',{name:'删除路由',exact:true}).isDisabled(),true);
    assert.equal(await full.getByRole('button',{name:'复制全部 JSON',exact:true}).isEnabled(),true);
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'重试读取',exact:true}).click();
    assert.equal(await page.locator('.dispatch-config-state .is-error').count(),0);
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isEnabled(),true);
    await page.locator('.dispatch-global-summary').click();
    const metrics=await page.locator('#dispatch-metrics-detail').textContent();
    assert.match(metrics,/队列 112 条及写入中 16 条/);
    assert.match(metrics,/属于整个网关/);
    await page.keyboard.press('Escape');
  });
  await check('Preview create/edit/delete retains validation and generated-rule examples without live writes', async () => {
    await scene('normal');
    await page.getByRole('button',{name:'新建路由',exact:true}).click();
    const editor=page.locator('.orbit-editor[open]');
    await editor.locator('[name=id]').fill('preview-qa');
    await editor.locator('[name=path]').fill('//invalid');
    await editor.locator('[name=uri]').fill('http://qa.internal:8080');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    assert.match(await editor.locator('[role=alert]').textContent(),/匹配路径/);
    await editor.locator('[name=path]').fill('/qa/**');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await until(async()=>await current.textContent()==='preview-qa');
    assert.equal(await editor.count(),0);
    await page.locator('[data-kind=rewrite]').click();
    assert.deepEqual(await page.locator('.dispatch-example code').allTextContents(),['/qa/123','/123']);
    await page.getByRole('button',{name:'编辑路由',exact:true}).click();
    await editor.locator('[name=rewriteRegex]').fill('^/qa/(?<segment>[0-9]+)$');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await editor.waitFor({state:'detached'});
    assert.match(await page.locator('.dispatch-node-inspector').textContent(),/需在真实网关验证/);
    assert.equal(await page.locator('.dispatch-example').count(),0);
    await page.getByRole('button',{name:'编辑路由',exact:true}).click();
    await editor.getByText('启用路径重写',{exact:true}).click();
    assert.equal(await editor.locator('[name=rewriteEnabled]').isChecked(),false);
    await editor.getByText('启用熔断保护',{exact:true}).click();
    assert.equal(await editor.locator('[name=circuitBreakerEnabled]').isChecked(),false);
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await editor.waitFor({state:'detached'});
    assert.deepEqual(await stageKinds(),['entry','limit','target']);
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    await full.getByRole('button',{name:'删除路由',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await until(async()=>await current.textContent()!=='preview-qa');
    assert.equal(await page.locator('.dispatch-directory-count').textContent(),'6');
    await page.reload();
    await current.waitFor();
    assert.equal(await page.locator('.dispatch-directory-count').textContent(),'6');
  });
  await check('320–1440px layouts keep long names readable and directory responsive at 6/4/2 entries', async () => {
    for(const width of [1440,1280,1100,960,850,768,701,700,390,320]) {
      await page.setViewportSize({width,height:900});
      await scene('dense');
      await until(async()=>await cards.count()===(width>=1360?6:width>=760?4:2));
      const result=await layout();
      assert.equal(result.documentWidth,width,JSON.stringify(result));
      assert.equal(result.identityClipped,false,JSON.stringify(result));
      assert.equal(result.cardLabelClipped,false,JSON.stringify(result));
      assert.equal(result.selectedVisible,true,JSON.stringify(result));
      if(width>=960 || width<=700) assert.ok(result.dock.bottom<=901,'Directory below first viewport: '+width);
      report.layouts.push(result);
      // Every label must be visually separate from its neighbor on a horizontal map.
      if(width>700) for(let i=0;i<result.stationLabels.length-1;i++) {
        const a=result.stationLabels[i],b=result.stationLabels[i+1];
        assert.ok(a.right<=b.left+1 || a.bottom<=b.top+1 || b.bottom<=a.top+1,'Station labels overlap at '+width);
      }
    }
  });
  await check('Mobile paging keeps the selected route; selection and node expansion fold the directory', async () => {
    await page.setViewportSize({width:390,height:900});
    await scene('dense');
    assert.equal(await page.getByRole('combobox',{name:'跳转页码'}).inputValue(),'2');
    await page.getByRole('combobox',{name:'跳转页码'}).selectOption('16');
    assert.equal(await current.textContent(),longId);
    await page.getByRole('button',{name:'定位当前路由',exact:true}).click();
    await search.fill('asia-pacific');
    await cards.first().click();
    assert.match(await page.locator('.dispatch-dock').getAttribute('class'),/is-collapsed/);
    await until(async()=>{const b=await current.boundingBox();return b.y>=0&&b.y<160});
    await page.locator('[data-kind=rewrite]').click();
    const panel=page.locator('.dispatch-node-inspector.is-inline');
    await panel.waitFor();
    const bounds=await panel.boundingBox(),dock=await page.locator('.dispatch-dock').boundingBox();
    assert.ok(bounds.y>=0 && bounds.y+bounds.height<=dock.y+1,JSON.stringify({bounds,dock}));
    assert.match(await panel.textContent(),/按规则推导/);
    await screenshot('routes-dispatch-mobile-node-390.png');
    await panel.getByRole('button',{name:'关闭节点详情',exact:true}).click();
    await panel.waitFor({state:'detached'});
    assert.equal(await page.locator('.dispatch-node-inspector').count(),0);
    await page.getByRole('button',{name:'展开目录',exact:true}).click();
    await search.fill('payment');
    await cards.first().click();
    assert.equal(await current.textContent(),'payment-service');
    assert.deepEqual(await stageKinds(),['entry','limit','breaker','target']);
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    const modal=await full.boundingBox();
    assert.ok(modal.x>=0&&modal.x+modal.width<=390&&modal.y>=0&&modal.y+modal.height<=900,JSON.stringify(modal));
    assert.equal(await full.locator('.dispatch-value code').evaluateAll(els=>els.some(el=>el.scrollWidth>el.clientWidth+1)),false);
    await page.keyboard.press('Escape');
    await scene('exception');
    assert.equal((await layout()).documentWidth,390);
    await page.locator('.dispatch-config-state>button').first().click();
    const status=await page.locator('#dispatch-status-detail').boundingBox();
    assert.ok(status.x>=0&&status.x+status.width<=391,JSON.stringify(status));
  });
  await check('Scenario tabs switch fixtures, and clicking the current tab preserves selection',async()=>{
    await page.setViewportSize({width:1440,height:900});
    await scene('normal');
    const tabs=page.locator('.dispatch-scenarios');
    await tabs.getByRole('button',{name:'正常',exact:true}).click();
    assert.equal(await current.textContent(),'order-service');
    await tabs.getByRole('button',{name:'32 条 / 长名称',exact:true}).click();
    await until(async()=>await current.textContent()===longId);
    await select('billing-service');
    await tabs.getByRole('button',{name:'32 条 / 长名称',exact:true}).click();
    assert.equal(await current.textContent(),'billing-service');
    await tabs.getByRole('button',{name:'异常',exact:true}).click();
    await until(async()=>await page.locator('.dispatch-config-state .is-error').count()===1);
    assert.equal(await current.textContent(),'order-service');
    await tabs.getByRole('button',{name:'正常',exact:true}).click();
    await until(async()=>await page.locator('.dispatch-config-state .is-error').count()===0);
    await page.setViewportSize({width:390,height:900});
    await tabs.getByRole('button',{name:'32 条 / 长名称',exact:true}).click();
    await until(async()=>await current.textContent()===longId && await page.getByRole('combobox',{name:'跳转页码'}).inputValue()==='2');
    assert.equal(await page.locator('.dispatch-route-card[aria-pressed=true]').count(),1);
  });
  await check('Motion represents selection/expansion and honors reduced-motion preference',async()=>{
    await page.setViewportSize({width:1440,height:900});
    await scene('normal');
    assert.equal(await page.locator('.dispatch-track-content').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.equal(await page.locator('.dispatch-rail-svg animate').count(),0);
    await page.emulateMedia({reducedMotion:'no-preference'});
    await select('catalog-service');
    const animation=await page.locator('.dispatch-track-content').evaluate(el=>({name:getComputedStyle(el).animationName,count:getComputedStyle(el).animationIterationCount}));
    assert.equal(animation.name,'dispatch-select');
    assert.equal(animation.count,'1');
    await page.emulateMedia({reducedMotion:'reduce'});
  });
  await check('Normal, exception and 32-route browser screenshots fit a 1440×900 first viewport',async()=>{
    await page.setViewportSize({width:1440,height:900});
    for(const name of ['normal','exception','dense']) {
      await scene(name);
      const result=await layout();
      assert.equal(result.documentWidth,1440);
      assert.equal(result.documentHeight,900);
      await screenshot('routes-dispatch-'+name+'-1440.png');
    }
    await scene('normal');
    await page.locator('[data-kind=rewrite]').click();
    await page.locator('.dispatch-node-inspector').waitFor();
    await screenshot('routes-dispatch-rewrite-1440.png');
    await scene('exception');
    await page.locator('.dispatch-config-state>button').first().click();
    await screenshot('routes-dispatch-exception-detail-1440.png');
    await page.setViewportSize({width:960,height:900});
    await scene('dense');
    await screenshot('routes-dispatch-960.png');
    await page.setViewportSize({width:390,height:900});
    await scene('dense');
    await screenshot('routes-dispatch-390.png');
  });
  await check('Preview produces no JavaScript errors and makes no backend API requests',async()=>{
    assert.deepEqual(report.pageErrors,[]);
    assert.deepEqual(report.apiRequests,[]);
  });
  report.passed=true;
} catch(error) {
  report.failure=error.stack;
  await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await writeFile(join(output,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
