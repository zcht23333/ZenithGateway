import {withRouteVersion} from '../benchmarks/route-client.mjs'
import {runtimeValues,runtimeRequest} from './runtime-config-client.mjs'
import {spawn,execFileSync} from 'node:child_process'
import {createServer} from 'node:http'
import {createWriteStream} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {once} from 'node:events'
import {chromium} from '../.dev/browser/node_modules/playwright/index.mjs'
import assert from 'node:assert/strict'
const ui=process.env.ROUTE_CONSOLE_URL||'http://127.0.0.1:15175'
const token=randomBytes(24).toString('hex'),name='zenith-showcase-'+randomBytes(5).toString('hex')
const prefix='zg:showcase:'+Date.now(),out='.dev/stage-c'
await mkdir(out+'/raw-video',{recursive:true})
const report={startedAt:new Date().toISOString(),isolated:true,ui,checks:[],pageErrors:[],requests:[],traffic:{attempted:0,statuses:{}},cleanup:{},passed:false}
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000}).trim()
const upstream=createServer((req,res)=>{
 const elapsed=(Date.now()-trafficStart)/1000
 const latency=22+Math.round(30*(1+Math.sin(elapsed/8)))+(req.url.includes('slow')?120:0)
 setTimeout(()=>{res.setHeader('Content-Type','application/json');res.statusCode=req.url.includes('failure')?500:200;res.end(JSON.stringify({environment:'isolated demo',path:req.url}))},latency)
})
await new Promise(r=>upstream.listen(0,'127.0.0.1',r))
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r))
const port=reserve.address().port;await new Promise(r=>reserve.close(r))
const base='http://127.0.0.1:'+port,log=createWriteStream(out+'/showcase-backend.log')
let java,created=false,browser,baseline,generating=false,trafficStart=Date.now(),trafficLoop
const flights=new Set()
async function api(path,options={}) {
 const response=await fetch(base+path,{...options,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},signal:AbortSignal.timeout(8000)})
 assert.ok(response.ok,'Isolated API '+path+' status '+response.status)
 return response.status===204?null:response.json()
}
const redisConfig=()=>JSON.parse(docker(['exec',name,'redis-cli','GET',prefix+':runtime']))
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
try{
 docker(['run','--rm','-d','--pull=never','--name',name,'-p','127.0.0.1::6379','redis:7.4-alpine','--appendonly','no','--save','']);created=true
 const redisPort=Number(docker(['port',name,'6379/tcp']).split(':').at(-1))
 java=spawn(process.env.JAVA_HOME+'/bin/java.exe',['-jar','backend/target/zg-1.0.0.jar','--server.address=127.0.0.1','--server.port='+port,
  '--spring.data.redis.host=127.0.0.1','--spring.data.redis.port='+redisPort,'--spring.data.redis.password=','--spring.data.redis.database=0',
  '--zenith.cors.allowed-origins[0]='+ui,'--zenith.route.redis-key='+prefix+':routes','--zenith.runtime.redis-key='+prefix+':runtime','--zenith.audit.redis-key='+prefix+':audit',
  '--management.endpoint.shutdown.access=unrestricted','--management.endpoints.web.exposure.include=health,info,metrics,shutdown'],{windowsHide:true,env:{...process.env,ZENITH_ADMIN_TOKEN:token}})
 java.stdout.pipe(log);java.stderr.pipe(log,{end:false})
 let ready=false;const deadline=Date.now()+60000
 while(Date.now()<deadline){try{if((await api('/actuator/health')).status==='UP'){ready=true;break}}catch{}await delay(300)}
 assert.ok(ready,'Isolated backend started')
 baseline=await api('/settings/runtime');report.baseline=baseline
 const serviceNames=['account','catalog','inventory','order','payment','public-assets']
 for(const id of serviceNames){
  const segment=id==='public-assets'?'assets':id+'s'
  await api('/settings/routes',await withRouteVersion(()=>api('/settings/routes'),{method:'POST',body:JSON.stringify({
   id:id.endsWith('assets')?id:id+'-service',path:'/demo/'+segment+'/**',uri:'http://127.0.0.1:'+upstream.address().port,
   rewriteEnabled:true,rewriteRegex:'^/demo/'+segment+'/(?<segment>.*)$',rewriteReplacement:'/'+String.fromCharCode(36)+'{segment}',
   circuitBreakerEnabled:id!=='public-assets',circuitBreakerName:'default',fallbackPath:'/fallback/default'
  })}))
 }
 report.routeCount=(await api('/settings/routes')).routes.length
 generating=true;trafficStart=Date.now()
 trafficLoop=(async()=>{
  while(generating){
   const elapsed=(Date.now()-trafficStart)/1000
   const rate=5+Math.round(5*(1+Math.sin(elapsed/9)))
   const index=++report.traffic.attempted
   const path='/demo/'+['orders','catalogs','accounts'][index%3]+'/'+(index%43===0?'failure':index%11===0?'slow':'items')+'/'+index
   const task=fetch(base+path,{signal:AbortSignal.timeout(4000)}).then(async r=>{report.traffic.statuses[r.status]=(report.traffic.statuses[r.status]||0)+1;await r.arrayBuffer()}).catch(()=>{report.traffic.networkErrors=(report.traffic.networkErrors||0)+1})
   flights.add(task);task.finally(()=>flights.delete(task))
   await delay(1000/rate)
  }
 })()
 console.log('Isolated gateway, Redis and six routes ready; warming actual traffic for 25 seconds.')
 await delay(25000)
 browser=await chromium.launch({channel:'msedge',headless:true})
 const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'no-preference',recordVideo:{dir:out+'/raw-video',size:{width:1440,height:900}}})
 // Recording-only caption: never supplies or changes application data.
 await ctx.addInitScript(()=>{
  window.addEventListener('DOMContentLoaded',()=>{
   const style=document.createElement('style')
   style.textContent='.stage-c-caption{box-sizing:border-box;height:30px;flex-shrink:0;display:flex;align-items:center;justify-content:space-between;padding:0 38px;background:#253222;border-bottom:1px solid #53633f;color:#d9e9b7;font:12px/1.4 "Segoe UI","Microsoft YaHei",sans-serif}.stage-c-caption strong{font-weight:500;color:#e4f6c3}'
   document.head.append(style)
   const bar=document.createElement('div');bar.className='stage-c-caption'
   const label=document.createElement('span');label.textContent='隔离演示数据 · 独立网关 / Redis · 真实测试请求'
   const phase=document.createElement('strong');phase.textContent='01 / 观察流量与延迟'
   bar.append(label,phase);document.body.prepend(bar)
   style.textContent+='.dispatch-view{min-height:calc(100dvh - 30px)!important}'

  })
 })
 const p=await ctx.newPage(),video=p.video();p.setDefaultTimeout(9000)
 p.on('pageerror',e=>report.pageErrors.push(e.message))
 let puts=0
 await p.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.slice(4)
  report.requests.push({method:request.method(),path})
  assert.ok(request.method()==='GET'||(path==='/settings/runtime'&&request.method()==='PUT'),'Unexpected browser management write')
  if(path==='/settings/runtime'&&request.method()==='PUT')puts++
  try{
   if(path==='/monitor/stream'){await route.continue({url:base+path+url.search});return}
   const response=await route.fetch({url:base+path+url.search});await route.fulfill({response})
  }catch{if(!p.isClosed())await route.abort().catch(()=>{})}
 })
 const started=Date.now(),steps=[]
 const at=async(seconds)=>{const remaining=started+seconds*1000-Date.now();if(remaining>0)await delay(remaining)}
 async function phase(text){steps.push({atSeconds:+((Date.now()-started)/1000).toFixed(1),text});await p.evaluate(text=>{window.__demoPhase=text;document.querySelectorAll('.stage-c-caption strong').forEach(el=>el.textContent=text)},text)}
 async function shot(name){await p.mouse.move(20,15);await p.evaluate(()=>document.activeElement?.blur());await p.screenshot({path:'docs/images/'+name})}
 await check('Actual authenticated overview receives nonzero traffic and audit records from the isolated backend',async()=>{
  await p.goto(ui+'/');await p.locator('#admin-token').fill(token);await p.getByRole('button',{name:'连接',exact:true}).click()
  await p.locator('.overview-chart canvas').waitFor()
  await p.waitForFunction(()=>Number(document.querySelector('[data-testid=qps]')?.textContent.replaceAll(',',''))>0)
  await p.locator('.overview-record-table tbody tr').first().waitFor()
  assert.equal(await p.locator('.overview-demo-bar').count(),0)
  await at(7);await shot('stage-c-product-overview-1440.png')
  const slider=p.getByRole('slider',{name:'查看趋势采样'})
  await slider.focus();await slider.press('Home');await at(10);await slider.press('ArrowRight')
  await at(12);await p.getByRole('button',{name:'跟随最新',exact:true}).click()
  await at(14);await p.getByRole('button',{name:'展开详情',exact:true}).click()
  await at(18);await p.getByRole('button',{name:'收起详情',exact:true}).click()
 })
 await check('Route directory search selects an actual route; rewrite and circuit branches expand in place',async()=>{
  await at(21);await p.getByRole('link',{name:'路由调度',exact:true}).click();await p.locator('.dispatch-route-identity h1').waitFor()
  await phase('02 / 检查入口、规则与目标')
  await at(24);await p.getByRole('button',{name:'全部路由',exact:true}).click()
  await p.getByRole('searchbox',{name:'搜索全部路由',exact:true}).pressSequentially('order',{delay:130})
  await at(28);await p.locator('.dispatch-directory-dialog[open]').getByRole('button',{name:'选择路由 order-service',exact:true}).click()
  await at(30);await p.getByRole('searchbox',{name:'搜索路由',exact:true}).fill('')
  await at(31);await p.locator('[data-kind=rewrite]').click()
  await at(35);await shot('stage-c-product-routes-1440.png')
  assert.equal(await p.locator('.dispatch-route-identity h1').textContent(),'order-service')
  await at(38);await p.getByRole('button',{name:'关闭节点详情',exact:true}).click()
  await at(40);await p.locator('[data-kind=breaker]').click()
  await at(44);await p.getByRole('button',{name:'关闭节点详情',exact:true}).click()
 })
 const changed={...baseline,monitorWindowSeconds:30,emitIntervalSeconds:2}
 await check('One real settings save updates the returned baseline and independently verified Redis value',async()=>{
  await at(46);await p.getByRole('link',{name:'系统配置',exact:true}).click()
  await p.waitForFunction(()=>document.querySelector('#setting-monitorWindowSeconds')?.disabled===false)
  await phase('03 / 当前 → 待保存 → 服务端确认')
  await at(48);await p.locator('#setting-monitorWindowSeconds').fill('30')
  await at(52);await p.locator('#setting-emitIntervalSeconds').fill('2')
  await at(54);await shot('stage-c-product-settings-1440.png')
  assert.equal(await p.locator('.settings-difference').count(),2)
  await at(57);await p.locator('.settings-save').click()
  await p.waitForFunction(()=>document.querySelector('.settings-write-message')?.textContent.includes('保存已确认'))
  assert.equal(puts,1);assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(changed));assert.deepEqual(runtimeValues(redisConfig()),runtimeValues(changed))
  report.confirmed=changed
  await at(60);await shot('stage-c-product-settings-confirmed-1440.png')
 })
 await check('Returning to overview confirms the new 30-second window through actual metrics, not a preview linkage',async()=>{
  await at(64);await p.getByRole('link',{name:'运行概览',exact:true}).click();await p.locator('.overview-chart canvas').waitFor()
  await phase('04 / 回到概览，确认 30 秒统计窗口')
  await p.waitForFunction(()=>/当前窗口\s*30\s*秒/.test(document.querySelector('.overview-window-context')?.textContent||''))
  await at(69);await shot('stage-c-product-overview-confirmed-1440.png')
  const snapshot=await api('/dashboard/snapshot')
  assert.equal(snapshot.windowSeconds,30);assert.equal(snapshot.qps,snapshot.requestCount/30)
  report.confirmedSnapshot=snapshot
  report.visibleWindow=await p.locator('.overview-window-context').textContent()
  await at(73);await p.locator('.overview-window-details>summary').click()
  await at(77);await p.locator('.overview-window-details>summary').click()
  await at(80)
 })
 report.recordedSteps=steps;report.recordedElapsedSeconds=(Date.now()-started)/1000
 await ctx.close();await video.saveAs('docs/media/stage-c-product-demo.webm')
 report.video={file:'docs/media/stage-c-product-demo.webm',width:1440,height:900,caption:'recording-only environment/action labels; no fixture metrics'}
 assert.deepEqual(report.pageErrors,[]);report.passed=true
}catch(error){report.failure=error.stack;throw error}
finally{
 generating=false;if(trafficLoop)await trafficLoop;await Promise.allSettled([...flights])
 if(browser)await browser.close()
 if(baseline&&java?.exitCode===null){try{await api('/settings/runtime',{method:'PUT',body:JSON.stringify(runtimeRequest(baseline,(await api('/settings/runtime')).version))});assert.deepEqual(runtimeValues(await api('/settings/runtime')),runtimeValues(baseline));assert.deepEqual(runtimeValues(redisConfig()),runtimeValues(baseline));report.cleanup.originalConfigurationRestored=true}catch(error){report.cleanup.restoreError=error.message}}
 if(java&&java.exitCode===null){try{await api('/actuator/shutdown',{method:'POST',body:'{}'});const deadline=Date.now()+25000;while(java.exitCode===null&&Date.now()<deadline)await delay(200);if(java.exitCode===null)java.kill()}catch{java.kill()}if(java.exitCode===null)await once(java,'exit');report.cleanup.backendExitCode=java.exitCode}
 log.end();upstream.closeAllConnections();await new Promise(r=>upstream.close(r));if(created){docker(['stop','--time','5',name]);report.cleanup.redisRemoved=true}
 report.completedAt=new Date().toISOString();await writeFile(out+'/showcase-validation.json',JSON.stringify(report,null,2)+'\n')
}
