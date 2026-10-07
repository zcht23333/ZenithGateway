import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {finishRecording} from './rolling-replacement-recording.mjs'
import {candidateGate,assessRollingWindow,reconcileRollingLedger,reconcileAuditSettlement,rollingPlan} from './rolling-replacement-core.mjs'
const versions={runtime:'runtime:2',route:'routes:3'}
function snapshot(n=0){return {ready:true,life:{instanceId:'A',phase:'ready',draining:false,adoptedRuntimeVersion:versions.runtime,adoptedRouteVersion:versions.route,admitted:n,completed:n,clientCancelled:0,audit:{received:n,persisted:n,pending:0,uncertain:0,dropped:0}},runtimeSync:{status:'ok'},routeSync:{status:'ok'},limit:{transportState:'healthy',outcomes:{},observations:{executions:{unknown:0}},queued:0,queueCapacity:64,commandsInFlight:0,workers:8,retainedTasks:0,admissionCapacity:72,availableDecisionPermits:72},proxy:{activeProxyRequests:0,policy:{maxConnectionsPerOrigin:100,maxPendingAcquiresPerOrigin:100}},poolFull:0}}
function window(){return {before:{A:snapshot()},after:{A:snapshot(20)},result:{offered:20,issued:20,finished:20,transportErrors:0,statuses:{200:20},versions:{[versions.route]:20},schedulerMisses:0,capacityMisses:0,latencyMs:{p95:20,p99:30}},upstreamCount:20}}
test('readiness alone cannot promote an instance with either local version behind',()=>{
 for(const key of ['adoptedRuntimeVersion','adoptedRouteVersion']){const s=snapshot();s.life[key]='previous';assert(!candidateGate(s,versions).allowed)}
 assert(candidateGate(snapshot(),versions).allowed)
})
test('missing diagnostics and failed synchronization prevent promotion',()=>{
 assert(!candidateGate(null,versions).allowed)
 const s=snapshot();s.routeSync.status='failed';assert(!candidateGate(s,versions).allowed)
 s.routeSync.status='ok';s.limit.transportState='recovering';assert(!candidateGate(s,versions).allowed)
})
test('an unused limiter can enter bounded initial traffic but cannot pass a healthy promotion window',()=>{
 const s=snapshot();s.limit.transportState='unchecked'
 assert(!candidateGate(s,versions).allowed);assert(candidateGate(s,versions,{initialTraffic:true}).allowed)
 s.limit.transportState='degraded';assert(!candidateGate(s,versions,{initialTraffic:true}).allowed)
})
test('a complete healthy window reconciles entry, instances, upstream and audit',()=>{
 const s=window(),result=assessRollingWindow(s,rollingPlan,versions);assert(result.healthy);assert.equal(result.completed,20);assert.equal(result.audit,20)
})
test('fault forwarding with HTTP 200 stops promotion',()=>{
 const s=window();s.after.A.limit.outcomes.redis_fail_open=2
 const r=assessRollingWindow(s,rollingPlan,versions);assert(!r.healthy);assert(r.reasons.includes('fault_forward'))
})
test('unknown debit is independent of HTTP success and cannot disappear into the total',()=>{
 const s=window();s.after.A.limit.observations.executions.unknown=1
 const r=assessRollingWindow(s,rollingPlan,versions);assert(r.reasons.includes('debit_unknown'));assert.equal(r.completed,20)
})
test('rejection, pool saturation and queue bounds are unhealthy even with complete accounting',()=>{
 const s=window();s.after.A.limit.outcomes.local_rejected=1;s.after.A.poolFull=1;s.after.A.limit.queued=65
 const r=assessRollingWindow(s,rollingPlan,versions);for(const key of ['protection_or_quota_rejection','proxy_pool_full','resource_bound'])assert(r.reasons.includes(key))
})
test('audit unknown or dropped cannot be called fully confirmed',()=>{
 const s=window();s.after.A.life.audit.persisted=19;s.after.A.life.audit.uncertain=1
 assert(assessRollingWindow(s,rollingPlan,versions).reasons.includes('audit_not_fully_confirmed'))
})
test('counter reset, missing counters or instance replacement invalidate the window',()=>{
 for(const mutate of [s=>{s.before.A.life.completed=21},s=>{delete s.after.A.poolFull},s=>{s.after.A.life.instanceId='new-JVM'}]){const s=window();mutate(s);assert(!assessRollingWindow(s,rollingPlan,versions).healthy)}
})
test('failed observations, traffic gaps and tail latency prevent escalation',()=>{
 const s=window();s.sampleErrors=['unavailable'];s.result.schedulerMisses=2;s.result.latencyMs.p99=800
 const r=assessRollingWindow(s,rollingPlan,versions);for(const key of ['sampling_failed','arrival_gap','latency'])assert(r.reasons.includes(key))
})
const ingress=[{path:'/probe/quick/x',status:200,termination:'complete'}],upstream=[{path:'/quick/x',instance:'a'}],audit=[{path:'/probe/quick/x',instance:'a',outcome:'completed'}]
test('ledger joins the rewritten path by unique suffix and checks the actual selected instance',()=>{
 assert(reconcileRollingLedger(ingress,upstream,audit).passed)
 assert(!reconcileRollingLedger(ingress,upstream,[{...audit[0],instance:'b'}]).passed)
})
test('ledger rejects duplicates, unissued execution and missing audit rows',()=>{
 assert(!reconcileRollingLedger(ingress,[...upstream,...upstream],audit).passed)
 assert(!reconcileRollingLedger(ingress,[...upstream,{path:'/quick/unissued',instance:'a'}],audit).passed)
 assert(!reconcileRollingLedger(ingress,upstream,[]).passed)
})
test('a cancelled partial response is never represented as a healthy completed response',()=>{
 assert(!reconcileRollingLedger(ingress,upstream,[{...audit[0],outcome:'cancelled'}]).passed)
 const s=window();s.after.A.life.clientCancelled=1;assert(assessRollingWindow(s,rollingPlan,versions).reasons.includes('client_cancelled'))
})
test('missing arrival, tail latency, version coverage or resource observations cannot be healthy',()=>{
 for(const change of [s=>delete s.result.offered,s=>delete s.result.latencyMs.p99,s=>s.result.versions={},s=>delete s.after.A.limit.commandsInFlight]){
  const s=window();change(s);assert(!assessRollingWindow(s,rollingPlan,versions).healthy)
 }
})
test('audit reconciliation permits unknown rows to be stored or absent but never assumes either',()=>{
 const s={received:10,persisted:6,pending:0,uncertain:3,dropped:1}
 for(const stored of [6,7,8,9])assert(reconcileAuditSettlement(s,stored).passed)
 for(const stored of [5,10])assert(!reconcileAuditSettlement(s,stored).passed)
 assert.equal(reconcileAuditSettlement(s,7).unknownStored,1)
})
test('audit settlement cannot conceal missing terminal counts or an unclosed writer',()=>{
 assert(!reconcileAuditSettlement({received:10,persisted:8,pending:1,uncertain:1,dropped:0},8).passed)
 assert(!reconcileAuditSettlement({received:10,persisted:8,pending:0,uncertain:1,dropped:0},8).passed)
})
test('a failed browser launch cannot leave its real loopback listener running',async()=>{
 const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{await finishRecording({server},{});assert.equal(server.listening,false)}finally{server.close()}
})
test('a failed final frame still closes the browser, context and real recording listener',async()=>{
 const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let contextClosed=false,browserClosed=false
 try{
  await assert.rejects(finishRecording({server,page:{waitForFunction:async()=>{throw new Error('frame unavailable')},video:()=>null},context:{close:async()=>{contextClosed=true}},browser:{close:async()=>{browserClosed=true}}},{}),/frame unavailable/)
  assert(contextClosed&&browserClosed);assert.equal(server.listening,false)
 }finally{server.close()}
})
