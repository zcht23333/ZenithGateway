import {after,afterEach,before,beforeEach,test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'vite'
let server,api,store,createPinia,useTrafficStore,model
const originalFetch=globalThis.fetch,originalEventSource=globalThis.EventSource
const sample=(timestamp=1000,extra={})=>({timestamp,windowSeconds:10,qps:2,requestCount:20,avgLatencyMs:2,p95LatencyMs:5,enabled:true,...extra})
const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})
const audit={enabled:true,accepting:true,received:100,persisted:80,dropped:15,uncertain:5,pending:0,queueDepth:0,inFlight:0}
let sources=[]
class FakeSource {listeners={};closed=false;constructor(url){this.url=url;sources.push(this)}close(){this.closed=true}addEventListener(name,cb){this.listeners[name]=cb}}
const defaultFetch=async url=>respond(url.includes('/runtime')?{}:url.includes('sse-token')?{token:'test-ticket'}:url.includes('/snapshot')?sample():url.includes('/status')?audit:[])
const settle=async()=>{for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve))}
before(async()=>{
 server=await createServer({configFile:false,optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false,ws:false},appType:'custom'})
 api=await server.ssrLoadModule('/src/api.ts')
 model=await server.ssrLoadModule('/src/overview/model.ts')
 ;({useTrafficStore}=await server.ssrLoadModule('/src/stores/traffic.ts'))
 ;({createPinia}=await server.ssrLoadModule('pinia'))
})
beforeEach(async()=>{globalThis.fetch=defaultFetch;globalThis.EventSource=FakeSource;sources=[];await api.authenticate('unit-credential');store=useTrafficStore(createPinia())})
afterEach(()=>{store.disconnectSse();api.logout()})
after(async()=>{globalThis.fetch=originalFetch;globalThis.EventSource=originalEventSource;await server.close()})

test('numeric presentation distinguishes missing, actual zero, disabled and overflow',()=>{
 assert.equal(model.number(undefined),'—');assert.equal(model.number(0,2),'0.00')
 assert.equal(model.axisNumber(0.1),'0.1');assert.equal(model.axisNumber(0.002),'0.002')
 assert.equal(model.axisNumber(1500),'1.5k')
 assert.equal(model.latencyLabel(null),'—');assert.equal(model.latencyLabel(sample(1000,{enabled:false})),'—')
 assert.equal(model.latencyLabel(sample(1000,{p95LatencyMs:-1})),'> 60,000')
 assert.equal(model.isSnapshot(sample(1000,{p95LatencyMs:-2})),false)
})
test('time-based trends retain irregular spacing and gaps; overflow and disabled samples never become zero',()=>{
 const points=[sample(1000),sample(3000),sample(8000),sample(16000),sample(17000,{p95LatencyMs:-1}),sample(18000,{enabled:false}),sample(19000)]
 const trend=model.buildTrend(points,[3000])
 assert.deepEqual(trend.samples.map(p=>p.timestamp),[1000,3000,8000,16000,17000,18000,19000])
 assert.deepEqual(trend.qps.filter(p=>p[1]===null).map(p=>p[0]),[5500,12000,18000])
 assert.ok(trend.p95.some(p=>p[0]===17000&&p[1]===null))
 assert.deepEqual(trend.overflow,[17000])
})
test('series deduplication preserves actual timestamps and caps at 120 samples',()=>{
 const points=Array.from({length:130},(_,i)=>sample(i*1000))
 const result=model.mergeSamples(points,[sample(129000,{qps:3}),sample(1000)])
 assert.equal(result.length,120);assert.equal(result[0].timestamp,10000);assert.equal(result[119].qps,3)
})
test('historical audit loss is not a present failure; unknown and cancelled HTTP outcomes remain explicit',()=>{
 assert.equal(model.auditLabel(audit),'待写入已排空')
 assert.equal(model.auditLabel({...audit,pending:3}),'正在等待写入')
 assert.equal(model.auditLabel({...audit,accepting:false}),'已停止接收')
 assert.equal(model.recordResult({statusCode:0,outcome:'cancelled'}),'已取消 · 未形成 HTTP 状态')
 assert.equal(model.recordResult({statusCode:0,outcome:'error'}),'请求异常 · 未形成 HTTP 状态')
})
test('slow history cannot delay initial SSE or independent audit reads',async()=>{
 let release
 globalThis.fetch=url=>url.includes('/series')?new Promise(resolve=>{release=resolve}):defaultFetch(url)
 const boot=store.bootstrap();await settle()
 assert.equal(sources.length,1);assert.equal(store.seriesState.loading,true)
 assert.equal(store.auditStatus.persisted,80);assert.equal(store.logsState.error,'')
 release(respond([]));await boot;assert.equal(store.seriesState.loading,false)
})
test('late REST snapshot cannot replace a newer SSE value, and history merge preserves live samples',async()=>{
 let releaseSnapshot,releaseSeries
 globalThis.fetch=url=>url.includes('/snapshot')?new Promise(resolve=>{releaseSnapshot=resolve}):url.includes('/series')?new Promise(resolve=>{releaseSeries=resolve}):defaultFetch(url)
 const boot=store.bootstrap();await settle()
 sources[0].listeners.traffic({data:JSON.stringify(sample(5000,{qps:9}))})
 releaseSnapshot(respond(sample(1000)));releaseSeries(respond([sample(1000),sample(3000)]));await boot
 assert.equal(store.latest.timestamp,5000);assert.equal(store.latest.qps,9)
 assert.deepEqual(store.series.map(p=>p.timestamp),[1000,3000,5000])
})
test('leaving the page prevents every late source from replacing cached values',async()=>{
 const deferred=new Map()
 globalThis.fetch=url=>url.includes('sse-token')?defaultFetch(url):new Promise(resolve=>deferred.set(url,resolve))
 const boot=store.bootstrap();store.disconnectSse()
 for(const[url,resolve]of deferred)resolve(respond(url.includes('/snapshot')?sample():url.includes('/series')?[sample()]:url.includes('/status')?audit:[{path:'/late'}]))
 await boot;await settle()
 assert.equal(store.latest,null);assert.deepEqual(store.series,[]);assert.deepEqual(store.logs,[]);assert.equal(store.auditStatus,null)
 for(const state of [store.snapshotState,store.seriesState,store.logsState,store.auditState])assert.equal(state.loading,false)
})
test('initial record failure stays local and polling clears its own error after recovery',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let failed=true
 globalThis.fetch=url=>url.includes('/recent')?Promise.resolve(failed?respond({message:'records offline'},503):respond([{path:'/recovered'}])):defaultFetch(url)
 await store.bootstrap();await settle()
 assert.equal(store.logsState.loadedAt,null);assert.match(store.logsError,/records offline/)
 assert.equal(store.error,'');assert.equal(store.auditError,'')
 failed=false;t.mock.timers.tick(5000);await settle()
 assert.equal(store.logsError,'');assert.equal(store.logs[0].path,'/recovered');assert.ok(store.logsState.loadedAt)
})
test('SSE recovery does not claim failed history was loaded; retry repairs only that source',async()=>{
 let failed=true
 globalThis.fetch=url=>url.includes('/series')?Promise.resolve(failed?respond({message:'history offline'},503):respond([sample(500)])):defaultFetch(url)
 await store.bootstrap();await settle()
 sources[0].listeners.traffic({data:JSON.stringify(sample(2000))})
 assert.equal(store.latest.timestamp,2000);assert.match(store.seriesState.error,/history offline/)
 failed=false;await store.retry('series')
 assert.equal(store.seriesState.error,'');assert.ok(store.series.some(p=>p.timestamp===2000))
})
test('repeated bootstrap closes the prior stream and leaves one active connection',async()=>{
 await store.bootstrap();await settle();await store.bootstrap();await settle()
 assert.equal(sources.length,2);assert.equal(sources[0].closed,true);assert.equal(sources[1].closed,false)
 store.disconnectSse();assert.equal(sources[1].closed,true)
})

test('overflow timestamps never supply an invented numeric latency or bridge missing intervals',()=>{
 const data=model.buildTrend([sample(1000,{p95LatencyMs:31}),sample(2000,{p95LatencyMs:-1}),sample(3000,{p95LatencyMs:52}),sample(4000,{p95LatencyMs:-1})])
 assert.deepEqual(data.p95,[[1000,31],[2000,null],[3000,52],[4000,null]])
 assert.deepEqual(data.overflow,[2000,4000])
 const onlyOverflow=model.buildTrend([sample(1000,{p95LatencyMs:-1}),sample(2000,{enabled:false,p95LatencyMs:-1})])
 assert.deepEqual(onlyOverflow.overflow,[1000]);assert.ok(onlyOverflow.p95.every(p=>p[1]===null))
 assert.equal(onlyOverflow.samples[0].p95LatencyMs,-1)
})
test('chart separates categorical overflow markers from the numeric P95 scale and aligns actual timestamps',async()=>{
 const {createOptions}=await server.ssrLoadModule('/src/overview/chart.ts')
 const data=model.buildTrend([sample(1000,{p95LatencyMs:34}),sample(2000,{p95LatencyMs:-1}),sample(5000,{p95LatencyMs:75})])
 for(const compact of [false,true]){
  const option=createOptions(data,compact)
  assert.equal(option.yAxis[1].max,undefined)
  assert.deepEqual(option.series[1].data,[[1000,34],[2000,null],[5000,75]])
  assert.equal(option.series[1].connectNulls,false)
  assert.equal(option.series[2].yAxisIndex,2);assert.equal(option.yAxis[2].show,false)
  assert.equal(option.xAxis[1].min,option.xAxis[2].min)
  assert.equal(option.xAxis[1].max,option.xAxis[2].max)
  const tooltip=option.tooltip.formatter([{value:[2000,0.5]}])
  assert.match(tooltip,/> 60,000 ms/);assert.doesNotMatch(tooltip,/0\.5 ms/)
 }
 assert.equal(createOptions(model.buildTrend([sample()]),false).series.length,2)
 assert.equal(createOptions(model.buildTrend([sample(1000,{p95LatencyMs:-1})]),false).yAxis[1].axisLabel.show,false)
 assert.equal(createOptions(model.buildTrend([sample(1000,{p95LatencyMs:0})]),false).yAxis[1].axisLabel.show,true)
})

test('proxy interruption keeps the committed status and exposes its actual failure reason',()=>{
 assert.equal(model.recordResult({statusCode:200,outcome:'error',reason:'upstream_read_idle'}),'HTTP 200 · 响应读取停顿 · 已中断')
 assert.equal(model.recordResult({statusCode:504,outcome:'http_error',reason:'upstream_headers_timeout'}),'HTTP 504 · 响应头超时')
 assert.equal(model.recordResult({statusCode:500,outcome:'http_error',reason:'upstream_5xx'}),'HTTP 500')
})

test('quota failures stay visible independently of successful upstream responses',()=>{
 assert.equal(model.recordResult({statusCode:200,outcome:'completed',rateLimitOutcome:'redis_fail_open'}),'HTTP 200 · 限流故障放行')
 assert.equal(model.recordResult({statusCode:200,outcome:'completed',rateLimitOutcome:'local_fail_open'}),'HTTP 200 · 限流资源不足放行')
 assert.equal(model.recordResult({statusCode:429,outcome:'completed',rateLimitOutcome:'unfulfillable'}),'HTTP 429 · 请求成本超过容量')
 assert.equal(model.recordResult({statusCode:200,outcome:'completed'}),'HTTP 200')
})

test('limiter protective rejection and lost-reply uncertainty remain distinct from HTTP outcome',()=>{
 const unknown=model.recordResult({statusCode:503,outcome:'http_error',rateLimitOutcome:'redis_rejected',rateLimitExecution:'unknown'})
 assert.match(unknown,/HTTP 503/);assert.match(unknown,/额度未确认/);assert.match(unknown,/扣费结果未知/)
 const local=model.recordResult({statusCode:503,outcome:'http_error',rateLimitOutcome:'local_rejected',rateLimitExecution:'not_sent'})
 assert.match(local,/资源不足/);assert.doesNotMatch(local,/扣费结果未知/)
 assert.match(model.recordResult({statusCode:0,outcome:'cancelled',rateLimitExecution:'unknown'}),/扣费结果未知/)
 assert.match(model.recordResult({statusCode:200,outcome:'completed',rateLimitOutcome:'redis_fail_open',rateLimitExecution:'unknown'}),/放行/)
})
