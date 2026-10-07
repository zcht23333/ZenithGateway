// Isolated consumer verification. Uses the accepted product JAR unchanged.
// node verification/limiter-monitoring-live.mjs [--out <fresh directory>]
// JAVA_HOME required. Docker images pinned/cached. Optional PLAYWRIGHT_MODULE for browser.
import assert from 'node:assert/strict'
import {environment,until} from './rate-limit-harness.mjs'
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {randomUUID,createHash} from 'node:crypto'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {setTimeout as delay} from 'node:timers/promises'
const flag=n=>process.argv[process.argv.indexOf(n)+1]
const out=resolve(process.argv.includes('--out')?flag('--out'):'.dev/limiter-monitoring-'+new Date().toISOString().replace(/[:.]/g,'-'))
await mkdir(out,{recursive:true})
// Exclusive marker prevents accidental reuse/overwrite of an earlier experiment.
await writeFile(join(out,'run-marker'),randomUUID(),{flag:'wx'})
const token=randomUUID(),password=randomUUID(),id=randomUUID().slice(0,8),network='zg-monitor-'+id
const promName=network+'-prometheus',grafName=network+'-grafana',owned=[]
const promImage='prom/prometheus:v3.13.3@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7'
const grafImage='grafana/grafana:13.1.6@sha256:d8276d620291d3aaae3e31dde6d63e6807afee49825f04e8aa7392bbe024216f'
const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']}).trim()
const e=await environment({out:join(out,'gateway'),extra:['--zenith.admin.metrics-token='+token,'--zenith.limiter.decision-timeout-ms=1500']})
const r=e.report;r.consumer={images:{promImage,grafImage},screenshots:[],queries:[],alertTimeline:[],phases:[],scrapes:[]}
const c=r.consumer,targets=[],instances=[]
c.sourceHashes={}
for(const file of ['observability/prometheus/alerts.yml','observability/grafana/dashboards/zenith.json','verification/limiter-monitoring-live.mjs','verification/rate-limit-harness.mjs','verification/rate-limit-fault-proxy.mjs'])c.sourceHashes[file]=createHash('sha256').update(await readFile(file)).digest('hex')
let failure,browser,prom,graf,watcher,watching=false,networkCreated=false
const privateDir=join(out,'private'),provision=join(out,'provisioning')
const dashboard=JSON.parse(await readFile('observability/grafana/dashboards/zenith.json','utf8'))
let ipIndex=1
const ip=()=> '192.0.2.'+(ipIndex++)
const diag=i=>e.api(i,'/settings/rate-limit/diagnostics')
const healthy=i=>until(i.label+' transport recovery',async()=>{const d=await diag(i);return d.transportState==='healthy'&&d.retainedTasks===0&&d.commandsInFlight===0&&d.availableDecisionPermits===d.admissionCapacity?d:false},12000)
async function query(expr){const d=await (await fetch(prom+'/api/v1/query?query='+encodeURIComponent(expr),{signal:AbortSignal.timeout(6000)})).json();assert.equal(d.status,'success',JSON.stringify(d));return d.data.result}
async function alerts(){const d=await (await fetch(prom+'/api/v1/alerts',{signal:AbortSignal.timeout(6000)})).json();return d.data.alerts}
const firing=(a,name,inst)=>a.some(x=>x.state==='firing'&&x.labels.alertname===name&&(!inst||x.labels.instance===inst))
async function capture(name){
 const row={name,at:new Date().toISOString(),instances:[]}
 for(const i of instances){
  const response=await fetch(i.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token}})
  assert.equal(response.status,200);const text=await response.text(),file=name+'-'+i.label+'.prom';await writeFile(join(out,file),text)
  row.instances.push({label:i.label,diagnostics:await diag(i),metrics:file})
 }
 row.alerts=await alerts();c.phases.push(row);return row
}
async function screenshot(name,instance='.*',y=0){
 const context=await browser.newContext({viewport:{width:1440,height:1000}})
 const page=await context.newPage(),errors=[]
 page.on('pageerror',err=>errors.push(err.message))
 // Real browser authentication; neither anonymous Grafana nor credentials in URLs.
 await page.goto(graf+'/login')
 await page.locator('input[name="user"]').fill('admin')
 await page.locator('input[name="password"]').fill(password)
 await page.getByRole('button',{name:/log in/i}).click()
 await page.waitForURL(url=>!url.pathname.includes('/login'),{timeout:20000})
 const queried=page.waitForResponse(r=>r.url().includes('/api/ds/query')&&r.ok(),{timeout:20000})
 await page.goto(graf+'/d/zenith-operations?orgId=1&from=now-5m&to=now&var-instance='+encodeURIComponent(instance==='.*'?'$__all':instance))
 await page.getByText(/^Monitoring data/).first().waitFor()
 const collapse=page.getByRole('button',{name:/Close (navigation|menu)/i});if(await collapse.count())await collapse.first().click()
 // Grafana keeps hidden loading-bar elements mounted; wait for rendered data below.
 // Browser must receive/render real datasource queries, not a screenshot of a loading skeleton.
 await page.waitForFunction(()=>document.body.innerText.includes('METRICS PRESENT')||document.body.innerText.includes('DECISIONS MISSING')||document.body.innerText.includes('SCRAPE FAILED'),{timeout:20000})
 await queried
 await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
 if(y){
  await page.getByText(/^Fault-action share/).first().evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}))
  await page.waitForFunction(()=>[...document.querySelectorAll('*')].some(el=>el.textContent==='Fault-action share · all limiter decisions'&&el.getBoundingClientRect().y<650&&el.getBoundingClientRect().y>-100))
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
 }
 await page.waitForLoadState('networkidle',{timeout:10000})
 await page.screenshot({path:join(out,name+'.png'),fullPage:false})
 const text=await page.locator('body').innerText();await writeFile(join(out,name+'-browser.txt'),text)
 assert(!/An error occurred within the plugin|Panel plugin not found|parse error at line/i.test(text))
 c.screenshots.push({name,instance,path:name+'.png',pageErrors:errors,text:name+'-browser.txt'})
 await context.close()
}
async function validateQueries(label,instance='.*'){
 const rows=[]
 for(const panel of dashboard.panels)for(const target of panel.targets||[]){
  const expr=target.expr.replaceAll('$instance',instance),result=await query(expr)
  if(label==='fault-actions'&&[3,8,11].includes(panel.id)){
   assert(result.length===2,'Latency query must preserve both live instances: '+panel.title)
   assert(result.every(x=>Number.isFinite(Number(x.value[1]))&&Number(x.value[1])>0),'Latency needs real nonzero samples')
  }
  rows.push({panel:panel.id,title:panel.title,ref:target.refId,expression:expr,result})
 }
 c.queries.push({label,instance,at:new Date().toISOString(),rows})
 return rows
}
async function configure(){
 const saved=await e.save(instances[0],{rateLimitEnabled:true,burstCapacity:10000,replenishRate:10000,requestedTokens:1})
 for(const i of instances)await e.adopted(i,saved.version)
}
try{
 const A=await e.start('A-allow'),B=await e.start('B-strict',{flags:['--zenith.limiter.local-failure-policy=reject','--zenith.limiter.redis-failure-policy=reject']})
 const C=await e.start('B-metrics-disabled',{flags:['--zenith.observability.enabled=false']})
 instances.push(A,B,C);await configure()
 for(const i of instances){i.metricInstance=i.label+':'+new URL(i.base).port;targets.push({targets:['host.docker.internal:'+new URL(i.base).port],labels:{instance:i.metricInstance}})}
 await mkdir(privateDir,{recursive:true});await mkdir(join(provision,'datasources'),{recursive:true});await mkdir(join(provision,'dashboards'),{recursive:true})
 await writeFile(join(privateDir,'metrics-token'),token);await writeFile(join(privateDir,'grafana-password'),password)
 const promConfig={global:{scrape_interval:'5s',evaluation_interval:'5s'},rule_files:['/etc/prometheus/alerts.yml'],scrape_configs:[{job_name:'zenith-gateway',metrics_path:'/actuator/prometheus',scrape_timeout:'3s',authorization:{type:'Bearer',credentials_file:'/run/secrets/metrics-token'},static_configs:targets}]}
 await writeFile(join(out,'prometheus.yml'),JSON.stringify(promConfig,null,2))
 await writeFile(join(provision,'datasources','prometheus.yml'),JSON.stringify({apiVersion:1,datasources:[{name:'Prometheus',type:'prometheus',uid:'zenith-prometheus',access:'proxy',url:'http://'+promName+':9090',isDefault:true,jsonData:{httpMethod:'POST',timeInterval:'5s'}}]}))
 await writeFile(join(provision,'dashboards','zenith.yml'),JSON.stringify({apiVersion:1,providers:[{name:'zenith',orgId:1,folder:'ZenithGateway',type:'file',disableDeletion:true,editable:false,options:{path:'/var/lib/grafana/dashboards'}}]}))
 docker(['network','create',network]);networkCreated=true
 docker(['run','--rm','-d','--pull=never','--name',promName,'--network',network,'-p','127.0.0.1::9090',
  '-v',out.replaceAll('\\','/')+'/prometheus.yml:/etc/prometheus/prometheus.yml:ro',
  '-v',resolve('observability/prometheus/alerts.yml').replaceAll('\\','/')+':/etc/prometheus/alerts.yml:ro',
  '-v',privateDir.replaceAll('\\','/')+':/run/secrets:ro',promImage]);owned.push(promName)
 prom='http://127.0.0.1:'+docker(['port',promName,'9090/tcp']).split(':').at(-1)
 await until('Prometheus ready',async()=>{try{return (await fetch(prom+'/-/ready')).ok}catch{return false}},40000)
 await until('all actual gateway scrapes available',async()=>{const q=await query('up{job="zenith-gateway"}');return q.length===3&&q.every(x=>x.value[1]==='1')},30000)
 docker(['run','--rm','-d','--pull=never','--name',grafName,'--network',network,'-p','127.0.0.1::3000',
  '-e','GF_SECURITY_ADMIN_PASSWORD__FILE=/run/secrets/grafana-password','-e','GF_USERS_ALLOW_SIGN_UP=false',
  '-e','GF_ANALYTICS_REPORTING_ENABLED=false','-e','GF_ANALYTICS_CHECK_FOR_UPDATES=false','-e','GF_PLUGINS_PREINSTALL_DISABLED=true',
  '-v',privateDir.replaceAll('\\','/')+':/run/secrets:ro','-v',provision.replaceAll('\\','/')+':/etc/grafana/provisioning:ro',
  '-v',resolve('observability/grafana/dashboards').replaceAll('\\','/')+':/var/lib/grafana/dashboards:ro',grafImage]);owned.push(grafName)
 graf='http://127.0.0.1:'+docker(['port',grafName,'3000/tcp']).split(':').at(-1)
 await until('Grafana ready',async()=>{try{return (await fetch(graf+'/api/health')).ok}catch{return false}},60000)
 c.endpoints={prom,graf,targets};await writeFile(join(out,'endpoints.json'),JSON.stringify(c.endpoints,null,2));c.resourceParameters={workers:2,queueCapacity:4,decisionTimeoutMs:1500,resultHandoff:false,scrapeSeconds:5,evaluationSeconds:5}
 const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE||'.dev/browser/node_modules/playwright/index.mjs')))
 browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true})
 watching=true;watcher=(async()=>{while(watching){try{c.alertTimeline.push({at:new Date().toISOString(),alerts:await alerts()})}catch(err){c.alertTimeline.push({error:err.message})}await delay(1000)}})()
 await e.check('Actual metric family, fixed tags, scoped scrape authentication and missing-family state',async()=>{
  assert.equal((await fetch(A.base+'/actuator/prometheus')).status,401)
  const rows=await query('zenith_ratelimit_decisions_total')
  assert.equal(rows.length,72);for(const row of rows)assert.deepEqual(Object.keys(row.metric).sort(),['__name__','action','application','event','execution','instance','job'])
  await capture('01-baseline');await validateQueries('baseline')
  await until('missing-family alert',async()=>firing(await alerts(),'ZenithRateLimitMetricsMissing',C.metricInstance),50000)
  assert(!firing(await alerts(),'ZenithRateLimitFailOpen'))
  await screenshot('01-baseline-all')
 })
 await e.check('Confirmed permit, explicit bypass and 429 create distinct facts without fault alerts',async()=>{
  for(const i of [A,B])assert.equal((await e.hit(i,ip())).status,200)
  let saved=await e.save(A,{rateLimitEnabled:false});for(const i of instances)await e.adopted(i,saved.version)
  for(const i of [A,B])assert.equal((await e.hit(i,ip())).status,200)
  saved=await e.save(A,{rateLimitEnabled:true,burstCapacity:1,requestedTokens:2});for(const i of instances)await e.adopted(i,saved.version)
  for(const i of [A,B])assert.equal((await e.hit(i,ip())).status,429)
  await configure();await capture('02-normal-bypass-quota')
 })
 await e.check('Executed Redis reply loss: same fact with forward/200 or reject/503, never retries or refunds',async()=>{
  c.lostReplies=[]
  for(let n=0;n<5;n++)await Promise.all([[A,e.proxyA,200],[B,e.proxyB,503]].map(async([i,p,status])=>{
   await healthy(i);const client=ip(),bucket=e.ns+':bucket:'+client;p.setMode('drop-reply',{one:true})
   const job=e.hit(i,client)
   await until('Redis captured executed decision',()=>p.held.some(x=>x.limiter&&x.reply&&x.keys.some(k=>k.includes(client))),3000)
   const frame=p.held.find(x=>x.limiter&&x.reply&&x.keys.some(k=>k.includes(client)))
   const state=await e.redis(['GET',frame.keys.find(k=>k!==e.ns+':policy')])
   const response=await job;assert.equal(response.status,status)
   assert.equal(JSON.parse(state).tokensMilli,9999000)
   assert.equal(p.events.filter(x=>x.limiter&&x.keys.includes(frame.keys.find(k=>k!==e.ns+':policy'))).length,1)
   assert.equal(e.arrivals.filter(x=>x.path===response.path.replace('/probe','')).length,status===200?1:0)
   c.lostReplies.push({instance:i.metricInstance,response,frame,bucketState:state})
   p.release();await healthy(i)
  }))
 })
 await e.check('Local admission saturation retains local fact and chosen policy without changing Redis-fault semantics',async()=>{
  c.localSaturation=[]
  await Promise.all([[A,e.proxyA,200],[B,e.proxyB,503]].map(async([i,p,status])=>{
   await healthy(i);p.setMode('hold-request')
   const pending=Array.from({length:6},()=>e.hit(i,ip()))
   const boundary=await until('six admission permits occupied',async()=>{const d=await diag(i);return d.availableDecisionPermits===0?d:false},1000)
   const response=await e.hit(i,ip());assert.equal(response.status,status)
   const stillRunning=await diag(i)
   c.localSaturation.push({instance:i.metricInstance,boundary,response,stillRunning})
   await Promise.all(pending);p.release();await healthy(i)
  }))
  await until('independent action and source alerts fire',async()=>{
   const a=await alerts()
   return [A,B].every(i=>['local_unavailable','redis_unconfirmed'].every(event=>a.some(x=>x.state==='firing'&&x.labels.instance===i.metricInstance&&x.labels.event===event&&x.labels.alertname===(i===A?'ZenithRateLimitFailOpen':'ZenithRateLimitProtectiveRejection'))))&&[A,B].every(i=>firing(a,'ZenithRateLimitDebitUncertain',i.metricInstance))
  },55000)
  const a=await alerts();assert(!firing(a,'ZenithRateLimitFailOpen',B.metricInstance));assert(!firing(a,'ZenithRateLimitProtectiveRejection',A.metricInstance))
  await capture('03-fault-actions');await validateQueries('fault-actions')
  await screenshot('03-allow-fault',A.metricInstance);await screenshot('04-strict-fault',B.metricInstance);await screenshot('04-strict-latency-final',B.metricInstance,1150)
 })
 await e.check('Recovery resolves trailing-window fault alerts and zero traffic has zero rates but no ratios',async()=>{
  await until('fault alerts resolved',async()=>!(await alerts()).some(x=>x.state==='firing'&&/ZenithRateLimit(FailOpen|ProtectiveRejection|DebitUncertain)/.test(x.labels.alertname)),100000)
  await until('one-minute decision rate genuinely zero',async()=>(await query('sum(rate(zenith_ratelimit_decisions_total[1m]))')).every(x=>Number(x.value[1])===0),80000)
  const q=await validateQueries('zero-traffic',A.metricInstance)
  for(const id of [20,21,22,23,24,25])assert(q.find(x=>x.panel===id).result.every(x=>Number(x.value[1])===0))
  for(const row of q.filter(x=>x.panel===27))assert.equal(row.result.length,0)
  await capture('05-recovered-zero');await screenshot('05-zero-traffic',A.metricInstance);await screenshot('06-zero-ratio',A.metricInstance,1250)
 })
 await e.check('Cancellation after dispatch counts unknown/cancel once without a non-cancelled uncertainty alert',async()=>{
  await healthy(A);const cancelledBefore=(await diag(A)).observations.events.cancelled;e.proxyA.setMode('hold-reply')
  const client=ip(),job=e.hit(A,client)
  await until('cancel after committed reply',()=>e.proxyA.held.some(x=>x.limiter&&x.reply&&x.keys.some(k=>k.includes(client))))
  job.abort();await job
  await until('cancel terminal accounting',async()=>(await diag(A)).observations.events.cancelled===cancelledBefore+1)
  e.proxyA.release();await healthy(A)
  await until('cancel unknown actually scraped',async()=>(await query('zenith_ratelimit_decisions_total{instance="'+A.metricInstance+'",action="cancel",execution="unknown"}')).some(x=>Number(x.value[1])===1),15000)
  assert(!firing(await alerts(),'ZenithRateLimitDebitUncertain',A.metricInstance));await capture('07-cancel-unknown')
 })
 await e.check('Successful scrape with missing metrics differs from a failed scrape and target filtering works',async()=>{
  const q=await validateQueries('missing-family',C.metricInstance)
  assert.equal(q.find(x=>x.panel===18).result[0].value[1],'2')
  assert.equal(q.find(x=>x.panel===20).result.length,0)
  await screenshot('08-missing-family',C.metricInstance)
  // Deliberately break only the scrape credential, never Redis or the gateway runtime.
  await writeFile(join(privateDir,'metrics-token'),'deliberately-invalid-'+randomUUID())
  await until('all failed scrapes fire unavailable',async()=>{const a=await alerts();return instances.every(i=>firing(a,'ZenithGatewayUnavailable',i.metricInstance))},60000)
  const failed=await validateQueries('scrape-failed',A.metricInstance)
  assert.equal(failed.find(x=>x.panel===18).result[0].value[1],'0')
  assert.equal(failed.find(x=>x.panel===20).result.length,0)
  assert(!firing(await alerts(),'ZenithRateLimitMetricsMissing'))
  await capture('09-scrape-failed');await screenshot('09-scrape-failed',A.metricInstance)
  await writeFile(join(privateDir,'metrics-token'),token)
  await until('scrapes recover',async()=>{const u=await query('up{job="zenith-gateway"}');return u.length===3&&u.every(x=>x.value[1]==='1')},20000)
  assert(!firing(await alerts(),'ZenithRateLimitFailOpen',B.metricInstance))
  await until('scrape alerts clear',async()=>!firing(await alerts(),'ZenithGatewayUnavailable'),15000)
  for(const i of [A,B])assert.equal((await e.hit(i,ip())).status,200)
  await capture('10-final-recovery')
 })
 await e.check('HTTP, actual upstream receipt, terminal diagnostics, raw Prometheus and final audit reconcile',async()=>{
  c.accounting=[]
  for(const i of [A,B]){
   const d=await diag(i);await until('audit drained',async()=>{const a=await e.api(i,'/monitor/audit/status');return a.pending===0&&a.received===a.persisted},15000)
   const audits=JSON.parse(await e.redis(['LRANGE',e.ns+':audit:'+i.label,'0','-1']).then(x=>JSON.stringify(x.map(v=>JSON.parse(v)))))
   const raw=await (await fetch(i.base+'/actuator/prometheus',{headers:{Authorization:'Bearer '+token}})).text()
   const lines=raw.split('\n').filter(x=>x.startsWith('zenith_ratelimit_decisions_total{'))
   const total=lines.reduce((n,x)=>n+Number(x.split(' ').at(-1)),0)
   assert.equal(total,d.decisionsCompleted);assert.equal(audits.length,total)
   for(const a of audits){const count=e.arrivals.filter(x=>x.path===a.path.replace('/probe','')).length;assert.equal(count,a.rateLimitAction==='forward'?1:0)}
   c.accounting.push({instance:i.metricInstance,diagnostics:d,metricTotal:total,audits,upstreamCount:audits.filter(a=>a.rateLimitAction==='forward').length})
  }
 })
 r.passed=true
}catch(error){failure=error}
finally{
 watching=false;if(watcher)await watcher
 if(browser){if(failure){for(const context of browser.contexts())for(const page of context.pages()){await page.screenshot({path:join(out,'browser-failure.png')}).catch(()=>{});await writeFile(join(out,'browser-failure.txt'),await page.locator('body').innerText().catch(()=>''))}}await browser.close()}
 e.proxyA.release();e.proxyB.release()
 for(const name of owned.reverse()){
  try{await writeFile(join(out,name+'.log'),docker(['logs',name]));docker(['rm','-f',name]);r.cleanup[name+'Removed']=true}catch(error){r.cleanup[name+'Error']=error.message;failure??=error}
 }
 if(networkCreated){try{docker(['network','rm',network]);r.cleanup.monitorNetworkRemoved=true}catch(error){failure??=error}}
 // Only exact secret files created by this run; preserve all evidence and other project resources.
 for(const name of ['metrics-token','grafana-password'])await rm(join(privateDir,name),{force:true})
 r.cleanup.ephemeralCredentialsRemoved=true
 await e.finish(failure)
 await writeFile(join(out,'validation.json'),JSON.stringify(r,null,2)+'\n')
 console.log('Monitoring evidence: '+out)
}
