import test from 'node:test'
import assert from 'node:assert/strict'
import {assessStage} from './traffic-lifecycle-gates.mjs'
const plan={maxArrivalGapRatio:0.01,p95LimitMs:100,p99LimitMs:250},versions={runtime:'epoch:1',route:'routes:3'}
function fixture(){
 const state=()=>({life:{instanceId:'A',adoptedRuntimeVersion:versions.runtime,adoptedRouteVersion:versions.route,completed:0,clientCancelled:0,audit:{received:0,persisted:0,pending:0,uncertain:0,dropped:0}},
  limit:{outcomes:{allowed:0,limited:0,unfulfillable:0,local_rejected:0,redis_rejected:0,local_fail_open:0,redis_fail_open:0,cancelled:0},observations:{executions:{unknown:0}},redisFailurePolicy:'allow',queued:0,queueCapacity:64,commandsInFlight:0,workers:8,retainedTasks:0,admissionCapacity:72,availableDecisionPermits:72,activeWorkers:0},
  proxy:{pool:{'active.connections':0,'pending.connections':0},policy:{maxConnectionsPerOrigin:100,maxPendingAcquiresPerOrigin:100}},runtimeSync:{status:'ok'},routeSync:{status:'ok'}})
 const before=state(),after=state();after.life.completed=100;after.life.audit.received=100;after.life.audit.persisted=100;after.limit.outcomes.allowed=100
 return {before,after,samples:[],sampleErrors:[],result:{transportErrors:0,statuses:{200:100},schedulerMisses:0,capacityMisses:0,offered:100,finished:100,latencyMs:{p95:10,p99:20},versions:{[versions.route]:100}},metricsBefore:{requests:0,poolFull:0},metricsAfter:{requests:100,poolFull:0},upstreamBefore:0,upstreamAfter:100,declaredFault:false}
}
const assess=s=>assessStage(s,plan,versions)
test('all HTTP, policy, version, queue and audit conditions are needed to promote',()=>{assert.equal(assess(fixture()).healthy,true)})
test('declared strict Redis failure is expected 503 but blocks promotion and never expects upstream arrival',()=>{
 const s=fixture();s.declaredFault=true;s.after.limit.redisFailurePolicy='reject';s.after.limit.outcomes.allowed=0;s.after.limit.outcomes.redis_rejected=100;s.result.statuses={503:100};s.upstreamAfter=0
 const a=assess(s);assert.deepEqual(a.reasons,['protective_rejection']);assert.equal(a.unexpectedHttpResponses,0);assert.equal(a.expectedUpstream,0)
})
test('HTTP 200 alone cannot hide fault forwarding',()=>{const s=fixture();s.after.limit.outcomes.allowed=0;s.after.limit.outcomes.redis_fail_open=100;assert.deepEqual(assess(s).reasons,['fault_forward'])})
test('unknown overlaps the action and is not subtracted again from upstream counts',()=>{const s=fixture();s.after.limit.outcomes.allowed=0;s.after.limit.outcomes.redis_rejected=100;s.after.limit.observations.executions.unknown=100;s.declaredFault=true;s.after.limit.redisFailurePolicy='reject';s.result.statuses={503:100};s.upstreamAfter=0;const a=assess(s);assert.deepEqual(a.reasons,['protective_rejection','debit_unknown']);assert.equal(a.expectedUpstream,0)})
test('unexpected 503 in a healthy window stays a failure',()=>{const s=fixture();s.result.statuses={200:99,503:1};assert(assess(s).reasons.includes('unexpected_http_or_transport'))})
test('audit unknown, pending and discarded remain distinct from confirmed persistence',()=>{const s=fixture();Object.assign(s.after.life.audit,{persisted:70,pending:10,uncertain:10,dropped:10});assert.deepEqual(assess(s).reasons,['audit_not_fully_confirmed']);s.after.life.audit.received++;assert(assess(s).reasons.includes('audit_accounting_mismatch'))})
test('versions and sync freshness cannot be substituted with a successful response',()=>{const s=fixture();s.after.life.adoptedRuntimeVersion='epoch:2';s.after.routeSync.status='failed';assert.deepEqual(assess(s).reasons,['adopted_version_changed','sync_not_confirmed'])})
test('counter reset or instance replacement invalidates a comparison window',()=>{const s=fixture();s.before.limit.outcomes.allowed=200;s.after.life.instanceId='B';assert(assess(s).reasons.includes('instance_or_counter_changed'))})
test('queue, latency and generator gap boundaries remain strict',()=>{const s=fixture();s.result.latencyMs.p99=251;s.result.schedulerMisses=2;s.after.limit.queued=65;const a=assess(s);assert(a.reasons.includes('resource_bound'));assert(a.reasons.includes('latency'));assert(a.reasons.includes('arrival_gap'))})
test('two consecutive high queue samples prevent promotion even after the queue drains',()=>{const s=fixture();const high=structuredClone(s.after);high.limit.queued=50;s.samples=[high,high];assert.deepEqual(assess(s).reasons,['sustained_queue'])})
test('client cancellation is not a healthy terminal result',()=>{const s=fixture();s.after.life.clientCancelled=1;assert(assess(s).reasons.includes('client_cancelled'))})
