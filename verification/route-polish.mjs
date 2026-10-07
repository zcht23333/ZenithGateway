import { chromium } from '../.dev/browser/node_modules/playwright/index.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root=fileURLToPath(new URL('..',import.meta.url));
const base=(process.env.ROUTE_CONSOLE_URL || 'http://127.0.0.1:15174').replace(/\/$/,'');
const out=join(root,'.dev/route-polish'), images=join(root,'docs/images'), media=join(root,'docs/media');
for(const dir of [out,images,media]) await mkdir(dir,{recursive:true});
const report={generatedAt:new Date().toISOString(),base,checks:[],layouts:[],screenshots:[],pageErrors:[],apiRequests:[],passed:false};
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined),headless:true});
const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
const page=await context.newPage();
page.setDefaultTimeout(6000);
function observe(p) {
  p.on('pageerror',e=>report.pageErrors.push(e.message));
  p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/')) report.apiRequests.push(r.url());});
}
observe(page);
const title=page.locator('.dispatch-route-identity h1');
const all=page.locator('.dispatch-directory-dialog[open]');
const longId='asia-pacific-enterprise-order-orchestration-and-settlement-service-v2';
const dockSearch=page.getByRole('searchbox',{name:'搜索路由',exact:true});
const allSearch=page.getByRole('searchbox',{name:'搜索全部路由',exact:true});
const allFilter=page.getByRole('combobox',{name:'筛选全部路由的处理规则',exact:true});
async function until(fn) {
  const end=Date.now()+5000;
  while(Date.now()<end) {if(await fn())return;await delay(30);}
  throw new Error('Condition timed out');
}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function scene(name='dense',width=1440){
  await page.setViewportSize({width,height:900});
  await page.goto(base+'/routes/preview?scenario='+name);
  await title.waitFor();
  await page.locator('.dispatch-route-card').first().waitFor();
  await delay(70);
}
async function open(){await page.getByRole('button',{name:'全部路由',exact:true}).click();await all.waitFor();}
async function choose(id){
  await all.getByRole('button',{name:'选择路由 '+id,exact:true}).click();
  await all.waitFor({state:'hidden'});
  await until(async()=>await title.textContent()===id);
  await delay(60);
}
async function capture(name){
  await page.mouse.move(5,5);
  await page.screenshot({path:join(images,name),fullPage:false,animations:'disabled'});
  report.screenshots.push({file:'docs/images/'+name,...page.viewportSize()});
}
async function geometry(){
  return page.evaluate(()=>Object.fromEntries(['.dispatch-route-identity h1','.dispatch-route-endpoints','.dispatch-map']
    .map(selector=>[selector,document.querySelector(selector).getBoundingClientRect().toJSON()])));
}
try {
  await check('Shared ID/Path/URI search and rule filters preserve the canvas until explicit selection',async()=>{
    await scene();
    await dockSearch.fill('ACCOUNT.INTERNAL');
    await open();
    assert.equal(await allSearch.inputValue(),'ACCOUNT.INTERNAL');
    assert.equal(await all.locator('tbody tr').count(),1);
    assert.equal(await title.textContent(),longId);
    await allSearch.fill('/assets');
    assert.equal(await dockSearch.inputValue(),'/assets');
    assert.equal(await all.locator('tbody tr').count(),1);
    await page.keyboard.press('Escape');
    await all.waitFor({state:'hidden'});
    assert.equal(await page.locator('.dispatch-all-open').evaluate(el=>el===document.activeElement),true);
    assert.equal(await title.textContent(),longId);
    await dockSearch.fill('');
    await page.getByRole('combobox',{name:'筛选处理规则',exact:true}).selectOption('plain');
    await open();
    assert.equal(await allFilter.inputValue(),'plain');
    assert.equal(await all.locator('tbody tr').count(),4);
    await allFilter.selectOption('rewrite');
    assert.equal(await page.getByRole('combobox',{name:'筛选处理规则',exact:true}).inputValue(),'rewrite');
    await allSearch.fill('nothing-matches');
    assert.equal(await all.locator('tbody tr').count(),0);
    assert.equal(await title.textContent(),longId);
    await all.getByRole('button',{name:'清除筛选',exact:true}).first().click();
    assert.equal(await all.locator('tbody tr').count(),32);
    assert.equal(await dockSearch.inputValue(),'');
    assert.equal(await allFilter.inputValue(),'all');
    await page.keyboard.press('Escape');
  });
  await check('All 32 complete IDs, paths and URI fields compare in rows without truncation',async()=>{
    await open();
    const rows=await all.locator('tbody tr').evaluateAll(els=>els.map(el=>({
      id:el.querySelector('strong').textContent,
      path:el.querySelectorAll('code')[0].textContent,
      uri:el.querySelectorAll('code')[1].textContent,
      ordinal:el.querySelector('td').textContent,
      clipped:[...el.querySelectorAll('strong,code')].some(n=>n.scrollWidth>n.clientWidth+1)
    })));
    assert.equal(rows.length,32);
    assert.equal(new Set(rows.map(r=>r.id)).size,32);
    assert.equal(rows.some(r=>r.clipped),false);
    assert.deepEqual(rows[2],{id:longId,path:'/api/enterprise/asia-pacific/orders-and-settlements/v2/**',uri:'http://enterprise-order-orchestration.ap-southeast.internal:8080',ordinal:'03',clipped:false});
    assert.equal(rows[31].ordinal,'32');
    const visible=await all.locator('tbody tr').evaluateAll(els=>{
      const b=document.querySelector('.dispatch-directory-scroll').getBoundingClientRect();
      return els.filter(el=>{const r=el.getBoundingClientRect();return r.top>=b.top+32 && r.bottom<=b.bottom;}).length;
    });
    report.visibleRowsAt1440=visible;
    assert.ok(visible>=9,'At least 9 complete rows should fit; got '+visible);
    await capture('routes-polish-directory-1440.png');
    await page.keyboard.press('Escape');
  });
  await check('Keyboard navigation waits for Enter; selection closes the directory and reveals its dock page',async()=>{
    await open();
    const first=all.locator('.dispatch-directory-select').first();
    await first.focus();
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dispatch-all-workflow-service');
    assert.equal(await title.textContent(),longId);
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dispatch-all-warehouse-service');
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'dispatch-all-account-service');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await until(async()=>await title.textContent()==='workflow-service');
    await all.waitFor({state:'hidden'});
    assert.equal(await page.getByRole('combobox',{name:'跳转页码'}).inputValue(),'6');
    assert.equal(await page.locator('.dispatch-route-card[aria-pressed=true]').count(),1);
    assert.equal(await title.evaluate(el=>el===document.activeElement),true);
    await open();
    await allSearch.fill('payment');
    await allSearch.press('Enter');
    await until(async()=>await title.textContent()==='payment-service');
    assert.equal(await page.locator('.dispatch-route-card[aria-pressed=true]').count(),1);
    assert.equal(await dockSearch.inputValue(),'payment');
  });
  await check('Long and short route switches keep the title, endpoint and path origins stable',async()=>{
    for(const width of [1440,960,768,390,320]){
      await scene('dense',width);
      const before=await geometry();
      await open();await choose('account-service');
      // Mobile selection intentionally scrolls the hero into view; compare document coordinates.
      await page.evaluate(()=>scrollTo(0,0));
      const after=await geometry();
      for(const key of Object.keys(before)){
        assert.ok(Math.abs(before[key].y-after[key].y)<1,'Vertical shift at '+width+' '+key+' '+JSON.stringify({before:before[key],after:after[key]}));
        assert.ok(Math.abs(before[key].x-after[key].x)<1,'Horizontal shift at '+width);
      }
      report.layouts.push({width,long:before,short:after});
      await open();await choose(longId);await page.evaluate(()=>scrollTo(0,0));
      const restored=await geometry();
      assert.ok(Math.abs(before['.dispatch-map'].y-restored['.dispatch-map'].y)<1);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    }
  });
  await check('Node rest/hover/selected states differ without permanent glow; closing restores context and focus',async()=>{
    await scene('normal');
    const node=page.locator('[data-kind=breaker]');
    const disc=node.locator('.dispatch-station-disc');
    await page.mouse.move(10,110);
    const rest=await disc.evaluate(el=>({bg:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow}));
    await node.hover();await delay(180);
    const hover=await disc.evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.notEqual(rest.bg,hover);assert.equal(rest.shadow,'none');
    await node.click();await delay(180);
    const selected=await disc.evaluate(el=>getComputedStyle(el).backgroundColor);
    assert.notEqual(selected,hover);
    assert.equal(await page.locator('.dispatch-selected-rail').count(),2);
    assert.equal(await page.locator('.dispatch-branch-rail.is-related').count(),1);
    assert.match(await page.locator('.dispatch-active-context').textContent(),/熔断保护.*503/);
    assert.equal(await node.getAttribute('aria-controls'),'dispatch-node-breaker');
    await page.getByRole('button',{name:'关闭节点详情',exact:true}).click();
    await page.locator('.dispatch-node-inspector').waitFor({state:'detached'});
    assert.equal(await page.locator('.dispatch-node-inspector').count(),0);
    assert.equal(await page.locator('.dispatch-selected-rail').count(),0);
    assert.equal(await page.locator('.dispatch-active-context').count(),0);
    assert.equal(await node.evaluate(el=>el===document.activeElement),true);
    await page.locator('[data-kind=entry]').click();
    assert.equal(await page.locator('.dispatch-selected-rail').count(),1);
    await open();await choose('payment-service');
    assert.equal(await page.locator('.dispatch-node-inspector').count(),0);
  });
  await check('Both conditional branches remain visible beside their expanded node at desktop widths',async()=>{
    for(const width of [1440,960,768]){
      await scene('normal',width);
      for(const kind of ['limit','breaker']){
        await page.locator('[data-kind='+kind+']').click();
        const panel=await page.locator('.dispatch-node-inspector').boundingBox();
        const branch=await page.locator('.dispatch-branch.is-related').boundingBox();
        const intersects=panel.x<branch.x+branch.width && panel.x+panel.width>branch.x && panel.y<branch.y+branch.height && panel.y+panel.height>branch.y;
        assert.equal(intersects,false,JSON.stringify({width,kind,panel,branch}));
        await page.getByRole('button',{name:'关闭节点详情',exact:true}).click();
    await page.locator('.dispatch-node-inspector').waitFor({state:'detached'});
      }
    }
  });
  await check('Full fields and new header copy controls retain exact URI/path values; cached directory remains read-only',async()=>{
    await scene();
    await page.getByRole('button',{name:'复制当前目标地址',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'http://enterprise-order-orchestration.ap-southeast.internal:8080');
    await page.getByRole('button',{name:'复制当前匹配路径',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'/api/enterprise/asia-pacific/orders-and-settlements/v2/**');
    await page.getByRole('button',{name:'查看与复制完整字段',exact:true}).click();
    await page.getByRole('button',{name:'复制全部 JSON',exact:true}).click();
    const data=JSON.parse(await page.evaluate(()=>navigator.clipboard.readText()));
    assert.equal(data.id,longId);assert.equal(Object.keys(data).length,9);
    await page.keyboard.press('Escape');
    await scene('exception');await open();
    assert.equal(await all.locator('.dispatch-directory-stale').textContent(),'缓存配置');
    await choose('payment-service');
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'重试读取',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isEnabled(),true);
  });
  await check('Expanded directory fits 320–1440px and mobile selection returns to the inline path inspector',async()=>{
    for(const width of [1440,960,768,390,320]){
      await scene('dense',width);await open();
      const bounds=await all.boundingBox();
      assert.ok(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=width+1 && bounds.y+bounds.height<=901,JSON.stringify({width,bounds}));
      assert.equal(await all.evaluate(el=>el.scrollWidth>el.clientWidth+1),false);
      assert.equal(await all.locator('code,strong').evaluateAll(els=>els.some(el=>el.scrollWidth>el.clientWidth+1)),false);
      if(width===390) await capture('routes-polish-directory-390.png');
      await choose(longId);
      if(width<=700){
        assert.match(await page.locator('.dispatch-dock').getAttribute('class'),/is-collapsed/);
        await page.locator('[data-kind=rewrite]').click();
        const panel=await page.locator('.dispatch-node-inspector.is-inline').boundingBox();
        const dock=await page.locator('.dispatch-dock').boundingBox();
        assert.ok(panel.y>=0 && panel.y+panel.height<=dock.y+1,JSON.stringify({width,panel,dock}));
        if(width===390) await capture('routes-polish-node-390.png');
      }
    }
  });
  await check('Final normal, dense and expanded-node screenshots capture actual 1440×900 first viewports',async()=>{
    for(const scenario of ['normal','dense']){
      await scene(scenario);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),900);
      await capture('routes-polish-'+scenario+'-1440.png');
    }
    await scene('normal');
    await page.locator('[data-kind=breaker]').click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight),900);
    await capture('routes-polish-node-1440.png');
    await scene('dense',960);await capture('routes-polish-dense-960.png');
  });
  await check('Preview remains isolated and produces no JavaScript errors',async()=>{
    assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.apiRequests,[]);
  });
  if(process.env.ROUTE_POLISH_RECORD!=='0'){
    const recording=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference',recordVideo:{dir:join(out,'raw-video'),size:{width:1440,height:900}}});
    const p=await recording.newPage();observe(p);
    const video=p.video();
    await p.goto(base+'/routes/preview?scenario=dense');
    await p.locator('.dispatch-route-identity h1').waitFor();
    await delay(1300);
    await p.getByRole('button',{name:'全部路由',exact:true}).click();await delay(1000);
    await p.getByRole('searchbox',{name:'搜索全部路由',exact:true}).pressSequentially('order-service',{delay:90});
    await delay(1200);
    await p.locator('.dispatch-directory-dialog[open]').getByRole('button',{name:'选择路由 order-service',exact:true}).click();
    await delay(1600);
    await p.locator('[data-kind=breaker]').click();await delay(3000);
    await p.getByRole('button',{name:'关闭节点详情',exact:true}).click();await delay(1100);
    await p.getByRole('button',{name:'全部路由',exact:true}).click();await delay(800);
    await p.getByRole('searchbox',{name:'搜索全部路由',exact:true}).fill('');
    await p.getByRole('searchbox',{name:'搜索全部路由',exact:true}).pressSequentially('payment',{delay:150});
    await delay(1000);
    await p.locator('.dispatch-directory-dialog[open]').getByRole('button',{name:'选择路由 payment-service',exact:true}).click();
    await delay(1800);
    assert.equal(await p.locator('.dispatch-route-identity h1').textContent(),'payment-service');
    await recording.close();
    await video.saveAs(join(media,'routes-polish-interaction.webm'));
    report.video={file:'docs/media/routes-polish-interaction.webm',width:1440,height:900,steps:['搜索 order-service','选择 order-service','打开熔断保护及 503 分支','关闭节点','搜索 payment 并切换 payment-service']};
    console.log('RECORDED '+report.video.file);
  }
  assert.deepEqual(report.pageErrors,[]);assert.deepEqual(report.apiRequests,[]);
  report.passed=true;
} catch(error) {
  report.failure=error.stack;
  await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  await writeFile(join(out,'browser-validation.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
