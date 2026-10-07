import {randomUUID} from 'node:crypto'
import { chromium } from '../.dev/browser/node_modules/playwright/index.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { redisCommand } from '../benchmarks/redis.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const out=process.env.ROUTE_DISPATCH_LIVE_OUTPUT || join(root,'.dev/route-dispatch-live');
await mkdir(out,{recursive:true});
const manifest=await readFile(join(root,'.dev/toolchains/manifest.json'),'utf8').then(JSON.parse).catch(()=>({}));
const javaHome=process.env.JAVA_HOME || manifest.java?.home;
const javaExecutable=javaHome ? join(javaHome,'bin',process.platform==='win32'?'java.exe':'java') : 'java';
const token=randomBytes(24).toString('hex');
const name='zenith-dispatch-test-'+randomBytes(5).toString('hex');
const prefix='zg:dispatch-test:'+Date.now();
const ui=(process.env.ROUTE_CONSOLE_URL || 'http://127.0.0.1:15174').replace(/\/$/,'');
const report={startedAt:new Date().toISOString(),checks:[],pageErrors:[],requestCounts:{},cleanup:{},passed:false};
const upstream=createServer((req,res)=>{
  if(req.url.includes('disconnect')) {req.socket.destroy();return;}
  res.statusCode=req.url.includes('http500')?500:200;
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({upstream:true,path:req.url}));
});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
const upstreamUri='http://127.0.0.1:'+upstream.address().port;
const reservation=createServer();
await new Promise(r=>reservation.listen(0,'127.0.0.1',r));
const backendPort=reservation.address().port;
await new Promise(r=>reservation.close(r));
const base='http://127.0.0.1:'+backendPort;
const log=createWriteStream(join(out,'backend.log'));
let dockerCreated=false,redisPort,java,browser,page,releaseRead;
const overrides=new Map();
let holdReads=null;
async function until(fn,ms=10000) {
  const end=Date.now()+ms;let last;
  while(Date.now()<end) {try{if(await fn())return;}catch(e){last=e;}await delay(80);}
  throw last||new Error('Condition timeout');
}
async function check(name,fn) {await fn();report.checks.push(name);console.log('PASS '+name);}
async function api(path,options={}) {
  const response=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000)});
  assert.ok(response.ok,path+': '+response.status);
  return response.status===204?null:response.json();
}
function docker(args) {return execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim();}
const errorResponse=message=>({status:503,body:{message}});
async function refresh() {
  const button=page.locator('.dispatch-status-refresh');
  await until(async()=>await button.isEnabled());
  await button.click();
  await until(async()=>await button.isEnabled());
}
async function login() {
  await page.locator('#admin-token').fill(token);
  await page.getByRole('button',{name:'连接',exact:true}).click();
  await page.locator('.dispatch-view').waitFor();
}
try {
  docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);
  dockerCreated=true;
  redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1));
  assert.ok(redisPort>0);
  await until(async()=>await redisCommand(redisPort,['PING'])==='PONG');
  java=spawn(javaExecutable,[
    '-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+backendPort,
    '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=','--spring.data.redis.database=0',
    '--zenith.cors.allowed-origins[0]='+ui,'--zenith.rate-limit.enabled=false',
    '--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+prefix+':runtime',
    '--zenith.audit.redis-key='+prefix+':audit',
    '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'
  ],{cwd:root,windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}});
  java.stdout.pipe(log);java.stderr.pipe(log,{end:false});
  await until(async()=>{assert.equal(java.exitCode,null);return(await api('/actuator/health')).status==='UP';},60000);
  console.log('Isolated backend and Redis ready.');
  browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL || (process.platform==='win32'?'msedge':undefined),headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce',permissions:['clipboard-read','clipboard-write']});
  page=await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/api/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace(/^\/api/,'');
    report.requestCounts[path]=(report.requestCounts[path]||0)+1;
    if(request.method()==='GET') {
      if(path==='/settings/routes'&&holdReads)await holdReads;
      const fault=overrides.get(path);
      if(fault)return route.fulfill({status:fault.status,contentType:'application/json',body:JSON.stringify(fault.body)});
    }
    try {
      const response=await route.fetch({url:base+path+url.search});
      await route.fulfill({response});
    } catch(error) {if(!page.isClosed())await route.abort().catch(()=>{});}
  });
  const current=page.locator('.dispatch-route-identity h1');
  const editor=page.locator('.orbit-editor[open]');
  const full=page.locator('.dispatch-fields-dialog[open]');
  const cards=page.locator('.dispatch-route-card');

  await check('Real authentication and delayed initial loading: no fake route, empty-state action or demo controls',async()=>{
    await page.goto(ui+'/routes');
    await page.locator('#admin-token').waitFor();
    await page.locator('#admin-token').fill('invalid-credential');
    await page.getByRole('button',{name:'连接',exact:true}).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.locator('.dispatch-view').count(),0);
    holdReads=new Promise(resolve=>{releaseRead=resolve;});
    await login();
    await page.getByRole('heading',{name:'正在读取路由配置',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'新建路由',exact:true}).count(),0);
    assert.equal(await page.locator('.dispatch-scenarios,.dispatch-demo').count(),0);
    assert.equal(await page.locator('.dispatch-directory-count').textContent(),'—');
    assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
    assert.equal(await page.locator('.dispatch-nav .is-active').getAttribute('href'),'/routes');
    holdReads=null;releaseRead();
    await page.getByRole('heading',{name:'创建第一条路由',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'新建路由',exact:true}).isEnabled(),true);
  });
  await check('Initial route-read failure is distinct from a confirmed empty directory and recovers',async()=>{
    await page.getByRole('button',{name:'断开管理连接',exact:true}).click();
    await page.locator('#admin-token').waitFor();
    overrides.set('/settings/routes',errorResponse('测试：首次读取不可用'));
    await login();
    await page.getByRole('heading',{name:'暂时无法读取路由',exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'新建路由',exact:true}).count(),0);
    assert.match(await page.locator('.dispatch-config-state').textContent(),/尚无路由配置/);
    overrides.delete('/settings/routes');
    await refresh();
    await page.getByRole('heading',{name:'创建第一条路由',exact:true}).waitFor();
  });
  await check('UI create uses server validation, persists to Redis and forwards a real rewritten request',async()=>{
    await page.getByRole('button',{name:'新建路由',exact:true}).click();
    assert.equal(await editor.locator('.orbit-form-preview').count(),0);
    await editor.locator('[name=id]').fill('dispatch-smoke');
    await editor.locator('[name=path]').fill('/dispatch/**');
    await editor.locator('[name=uri]').fill(upstreamUri);
    await editor.locator('[name=rewriteRegex]').fill('[');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await editor.locator('[role=alert]').waitFor();
    assert.match(await editor.locator('[role=alert]').textContent(),/regular expression/i);
    assert.equal(await editor.locator('[name=id]').inputValue(),'dispatch-smoke');
    assert.equal((await api('/settings/routes')).routes.length,0);
    await editor.locator('[name=rewriteRegex]').fill('');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await current.waitFor();
    assert.equal(await current.textContent(),'dispatch-smoke');
    const saved=(await api('/settings/routes')).routes[0];
    assert.equal(saved.id,'dispatch-smoke');assert.match(saved.rewriteRegex,/\\Q\/dispatch\\E/);
    assert.equal(JSON.parse(await redisCommand(redisPort,['GET',prefix+':routes'])).routes.length,1);
    await until(async()=>{const r=await fetch(base+'/dispatch/hello');return r.ok&&(await r.json()).path==='/hello';});
    await page.locator('[data-kind=rewrite]').click();
    assert.deepEqual(await page.locator('.dispatch-example code').allTextContents(),['/dispatch/123','/123']);
    assert.match(await page.locator('.station-limit').textContent(),/已关闭/);
    assert.equal(await page.locator('.dispatch-branch').count(),1);
  });
  await check('Editing updates forwarding, ordinary HTTP 500 passes through, and connection failure is classified as 502',async()=>{
    await page.getByRole('button',{name:'编辑路由',exact:true}).click();
    await editor.locator('[name=rewriteReplacement]').fill('/v2/${segment}');
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await editor.waitFor({state:'detached'});
    await until(async()=>{const r=await fetch(base+'/dispatch/hello');return r.ok&&(await r.json()).path==='/v2/hello';});
    assert.deepEqual(await page.locator('.dispatch-example code').allTextContents(),['/dispatch/123','/v2/123']);
    const ordinary=await fetch(base+'/dispatch/http500');
    assert.equal(ordinary.status,500);assert.equal((await ordinary.json()).upstream,true);
    const fallback=await fetch(base+'/dispatch/disconnect');
    assert.equal(fallback.status,502);await fallback.text();
    await page.getByRole('button',{name:'关闭节点详情',exact:true}).click();
  });
  await check('Runtime polling updates the actual token-bucket stage and conditional branch',async()=>{
    await api('/settings/runtime',{method:'PUT',body:JSON.stringify({operationId:randomUUID(),expectedVersion:(await api('/settings/runtime')).version,rateLimitEnabled:true,replenishRate:50,burstCapacity:100,requestedTokens:2,monitorWindowSeconds:10,emitIntervalSeconds:1})});
    await until(async()=>await page.locator('.dispatch-branch').count()===2,15000);
    await page.locator('[data-kind=limit]').click();
    const facts=page.locator('.dispatch-limit-facts');
    assert.match(await facts.textContent(),/50令牌\/s/);
    assert.match(await facts.textContent(),/每次消耗2/);
    await page.getByRole('button',{name:'关闭节点详情',exact:true}).click();
  });
  await check('Failed refresh keeps actual cached route and blocks writes, then retry restores editing',async()=>{
    overrides.set('/settings/routes',errorResponse('测试：配置读取暂不可用'));
    await refresh();
    assert.equal(await current.textContent(),'dispatch-smoke');
    assert.equal(await cards.count(),1);
    assert.match(await page.locator('.dispatch-config-state').textContent(),/使用缓存配置/);
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isDisabled(),true);
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    assert.equal(await full.getByRole('button',{name:'删除路由',exact:true}).isDisabled(),true);
    await full.getByRole('button',{name:'复制全部 JSON',exact:true}).click();
    assert.equal(JSON.parse(await page.evaluate(()=>navigator.clipboard.readText())).rewriteReplacement,'/v2/${segment}');
    await page.keyboard.press('Escape');
    overrides.delete('/settings/routes');
    await refresh();
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isEnabled(),true);
  });
  await check('Successful create followed by failed list refresh retains previous selection and reports both outcomes',async()=>{
    await page.getByRole('button',{name:'新建路由',exact:true}).click();
    await editor.locator('[name=id]').fill('secondary-route');
    await editor.locator('[name=path]').fill('/secondary/**');
    await editor.locator('[name=uri]').fill(upstreamUri);
    overrides.set('/settings/routes',errorResponse('测试：保存后刷新失败'));
    await editor.getByRole('button',{name:'保存路由',exact:true}).click();
    await editor.waitFor({state:'detached'});
    assert.equal(await current.textContent(),'dispatch-smoke');
    assert.match(await page.locator('.dispatch-toast.is-warning').textContent(),/存储已提交.*列表刷新失败/);
    assert.equal(await page.getByRole('combobox',{name:'跳转页码'}).inputValue(),'1');
    assert.equal((await api('/settings/routes')).routes.length,2);
    overrides.delete('/settings/routes');
    await refresh();
    assert.equal(await cards.count(),2);
    assert.equal(await current.textContent(),'dispatch-smoke');
    await cards.filter({hasText:'secondary-route'}).click();
    assert.equal(await current.textContent(),'secondary-route');
    await page.getByRole('button',{name:'关闭提示',exact:true}).click();
  });
  await check('Unavailable runtime/metrics/audit never appear healthy or as zero, and refresh recovers them',async()=>{
    overrides.set('/settings/runtime',errorResponse('测试：限流配置不可用'));
    overrides.set('/dashboard/snapshot',errorResponse('测试：指标不可用'));
    overrides.set('/monitor/audit/status',errorResponse('测试：审计状态不可用'));
    await refresh();
    assert.match(await page.locator('.dispatch-config-state').textContent(),/限流配置读取失败/);
    assert.match(await page.locator('.station-limit').textContent(),/配置未获取/);
    assert.equal(await page.locator('.dispatch-branch').count(),1);
    assert.deepEqual(await page.locator('.dispatch-inline-metric strong').allTextContents(),['—','—','—']);
    assert.equal(await page.getByRole('button',{name:'编辑路由',exact:true}).isEnabled(),true);
    await page.getByRole('button',{name:'查看网关全局指标',exact:true}).click();
    assert.match(await page.locator('#dispatch-metrics-detail').textContent(),/流量指标暂不可用.*审计状态暂不可用/s);
    await page.keyboard.press('Escape');
    overrides.clear();await refresh();
    assert.equal(await page.locator('.dispatch-config-state .is-error').count(),0);
    assert.equal(await page.locator('.dispatch-branch').count(),2);
  });
  await check('Disabled monitoring and latency overflow retain existing business semantics',async()=>{
    const snapshot=await api('/dashboard/snapshot');
    overrides.set('/dashboard/snapshot',{status:200,body:{...snapshot,enabled:false,qps:123,p95LatencyMs:456}});
    await refresh();
    assert.deepEqual((await page.locator('.dispatch-inline-metric strong').allTextContents()).slice(0,2),['—','—']);
    await page.getByRole('button',{name:'查看网关全局指标',exact:true}).click();
    assert.match(await page.locator('#dispatch-metrics-detail').textContent(),/监控统计已关闭/);
    await page.keyboard.press('Escape');
    overrides.set('/dashboard/snapshot',{status:200,body:{...snapshot,enabled:true,p95LatencyMs:-1}});
    await refresh();
    assert.equal(await page.locator('.dispatch-inline-metric strong').nth(1).textContent(),'> 60,000');
    overrides.clear();await refresh();
  });
  await check('Live navigation, narrow layout and copied fields remain connected to actual routes',async()=>{
    await page.locator('.dispatch-nav').getByRole('link',{name:'系统配置',exact:true}).click();
    await page.locator('form').first().waitFor();
    await page.locator('a[href="/routes"]').click();
    await current.waitFor();
    assert.equal(await current.textContent(),'dispatch-smoke');
    assert.equal(await cards.count(),2);
    await page.screenshot({path:process.env.ROUTE_DISPATCH_LIVE_IMAGE || join(root,'docs/images/routes-dispatch-live-1440.png'),fullPage:false,animations:'disabled'});
    await page.setViewportSize({width:390,height:900});
    await page.getByRole('button',{name:'查看网关全局指标',exact:true}).click();
    const panel=await page.locator('#dispatch-metrics-detail').boundingBox();
    assert.ok(panel.x>=0&&panel.x+panel.width<=390);
    await page.keyboard.press('Escape');
    await cards.filter({hasText:'secondary-route'}).click();
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    await full.getByRole('button',{name:'复制路由 ID',exact:true}).click();
    assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'secondary-route');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
    await page.setViewportSize({width:1440,height:900});
  });
  await check('Confirmed live deletion removes persisted and runtime routes; refresh failure is reported without losing context',async()=>{
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    await full.getByRole('button',{name:'删除路由',exact:true}).click();
    assert.equal(await page.locator('#dispatch-delete-title').textContent(),'删除这条路由？');
    assert.match(await page.locator('.orbit-delete').textContent(),/不再参与请求匹配/);
    overrides.set('/settings/routes',errorResponse('测试：删除后刷新失败'));
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.locator('.orbit-delete[open]').waitFor({state:'hidden'});
    assert.match(await page.locator('.dispatch-toast.is-warning').textContent(),/存储已提交.*列表刷新失败/);
    assert.equal(await current.textContent(),'secondary-route');
    assert.equal((await api('/settings/routes')).routes.length,1);
    overrides.clear();await refresh();
    assert.equal(await current.textContent(),'dispatch-smoke');
    await page.getByRole('button',{name:'查看与复制完整字段'}).click();
    await full.getByRole('button',{name:'删除路由',exact:true}).click();
    await page.getByRole('button',{name:'确认删除',exact:true}).click();
    await page.getByRole('heading',{name:'创建第一条路由',exact:true}).waitFor();
    assert.equal((await api('/settings/routes')).routes.length,0);
    await until(async()=>(await fetch(base+'/dispatch/hello')).status===404);
    assert.equal(JSON.parse(await redisCommand(redisPort,['GET',prefix+':routes'])).routes.length,0);
  });
  await check('Disconnect cancels polling; expired credentials return to login; preview remains isolated',async()=>{
    await page.getByRole('button',{name:'断开管理连接',exact:true}).click();
    await page.locator('#admin-token').waitFor();
    const before=JSON.stringify(report.requestCounts);
    await delay(5500);
    assert.equal(JSON.stringify(report.requestCounts),before);
    await login();
    await page.getByRole('heading',{name:'创建第一条路由',exact:true}).waitFor();
    overrides.set('/settings/routes',{status:401,body:{}});
    await page.locator('.dispatch-status-refresh').click();
    await page.locator('#admin-token').waitFor();
    assert.equal(await page.locator('.dispatch-view').count(),0);
    overrides.clear();
    const beforePreview=JSON.stringify(report.requestCounts);
    await page.goto(ui+'/routes/preview?scenario=dense');
    await page.locator('.dispatch-demo').waitFor();
    assert.equal(await page.locator('.dispatch-directory-count').textContent(),'32');
    assert.equal(await page.locator('.dispatch-disconnect').count(),0);
    await delay(5500);
    assert.equal(JSON.stringify(report.requestCounts),beforePreview);
    await page.goto(ui+'/routes');
    await page.locator('#admin-token').waitFor();
    assert.equal(await cards.count(),0);
    assert.deepEqual(report.pageErrors,[]);
  });
  report.browser=await browser.version();
  report.passed=true;
} catch(error) {
  report.failure=error.stack;
  await page?.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});
  throw error;
} finally {
  releaseRead?.();
  await browser?.close();
  if(java&&java.exitCode===null) {
    try {
      await api('/actuator/shutdown',{method:'POST',body:'{}'});
      await until(()=>java.exitCode!==null,25000);
      report.cleanup.backendExitCode=java.exitCode;
    } catch {
      java.kill();await once(java,'exit');report.cleanup.backendStopped=true;
    }
  }
  log.end();
  await new Promise(r=>upstream.close(r));
  if(dockerCreated) {
    docker(['stop','--time','5',name]);
    report.cleanup.testRedisRemoved=true;
  }
  report.completedAt=new Date().toISOString();
  await writeFile(join(out,'validation.json'),JSON.stringify(report,null,2)+'\n');
}
