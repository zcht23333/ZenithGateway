import {test} from 'node:test'
import assert from 'node:assert/strict'
import {assessCapacity} from './conservative-capacity-gates.mjs'

function fixture(){
 const observations={events:{allowed:0,disabled:0,limited:0,unfulfillable:0,local_unavailable:0,redis_unconfirmed:0,cancelled:0},actions:{forward:0,reject:0,cancel:0},executions:{not_sent:0,not_written:0,confirmed:0,unknown:0}}
 const b={label:'A',limiter:{instanceId:'test-a',observations,outcomes:{local_fail_open:0,redis_fail_open:0,local_rejected:0,redis_rejected:0},transportState:'healthy',commandsInFlight:0,workers:8,queued:0,queueCapacity:128,openConnections:8,retainedTasks:0,admissionCapacity:136,scheduledTasks:0},audit:{received:0,persisted:0,dropped:0,uncertain:0,pending:0,reservedBytes:0},monitor:{completedTotal:0},life:{clientCancelled:0},runtime:{adoptedVersion:'epoch:1',status:'ok'},route:{adoptedVersion:'route:32',status:'ok'},proxy:{pool:{'total.connections':10,'pending.connections':0},policy:{maxConnectionsPerOrigin:100,maxPendingAcquiresPerOrigin:100}},jvm:{heapBytes:100,heapCommitted:200,directBytes:20,nonHeapBytes:30,threads:70},processMemory:{rssBytes:600,cgroupBytes:800}}
 const a=structuredClone(b);a.limiter.observations.events.allowed=a.limiter.observations.actions.forward=a.limiter.observations.executions.confirmed=a.audit.received=a.audit.persisted=a.monitor.completedTotal=1000
 for(const s of [b,a]){
  Object.assign(s.runtime,{instanceId:'test-a',lastConfirmedVersion:'epoch:1',matchesLastConfirmation:true,running:true,stale:false,lastCheckOutcome:'ok',failures:0})
  Object.assign(s.route,{instanceId:'test-a',lastObservedVersion:'route:32',matchesLastObservation:true,stale:false,lastCheckOutcome:'ok',failures:0})
 }
 return {result:{offered:1000,issued:1000,finished:1000,schedulerMisses:0,capacityMisses:0,transportErrors:0,statuses:{200:1000},versions:{'route:32':1000},statusLatencyMs:{200:{p95:5,p99:10}},scheduledLatencyMs:{p99:12}},upstreamReceived:1000,before:[b],after:[a],samples:[structuredClone(a)],samplingErrors:[]}
}
test('only confirmed permitted requests with complete audit qualify as healthy',()=>{assert.equal(assessCapacity(fixture()).healthy,true)})
test('HTTP 200 cannot hide either kind of fault forwarding',()=>{
 for(const kind of ['local','redis']){const s=fixture();s.after[0].limiter.outcomes[kind+'_fail_open']=1;const r=assessCapacity(s);assert.equal(r.healthy,false);assert(r.issues.includes('fault_forward'))}
})
test('protection, quota rejection and transport interruption are unhealthy capacity outcomes',()=>{
 for(const status of ['503','429','transport']){const s=fixture();s.result.statuses[200]--;if(status==='transport')s.result.transportErrors++;else s.result.statuses[status]=1;assert(assessCapacity(s).issues.includes('http_or_transport'))}
})
test('unknown is checked independently even if HTTP and all other totals match',()=>{const s=fixture();s.after[0].limiter.observations.executions.unknown=1;assert(assessCapacity(s).issues.includes('debit_unknown'))})
test('missing metrics, reset counters and changed instance are not zero failures',()=>{
 const missing=fixture();delete missing.after[0].limiter.observations.executions.unknown;assert.equal(assessCapacity(missing).healthy,false)
 const reset=fixture();reset.before[0].limiter.observations.events.allowed=1001;assert(assessCapacity(reset).issues.includes('missing_or_reset:events.allowed'))
 const restart=fixture();restart.after[0].limiter.instanceId='new';assert(assessCapacity(restart).issues.includes('instance_changed'))
})
test('missing versions and stale adoption are not fixed-configuration evidence',()=>{
 const s=fixture();delete s.before[0].runtime.adoptedVersion;delete s.after[0].runtime.adoptedVersion;assert(assessCapacity(s).issues.includes('configuration_changed_or_stale'))
 const stale=fixture();stale.after[0].route.status='stale';assert.equal(assessCapacity(stale).healthy,false)
})
test('audit loss, cancellation and bypass fail even with identical HTTP totals',()=>{
 for(const f of [s=>s.after[0].audit.persisted--,s=>s.after[0].audit.uncertain++,s=>s.after[0].life.clientCancelled++,s=>s.after[0].limiter.observations.events.disabled++]){const s=fixture();f(s);assert.equal(assessCapacity(s).healthy,false)}
})
test('generator missed arrivals and scheduled latency have independent gates',()=>{
 const s=fixture();s.result.schedulerMisses=11;s.result.offered=1011;assert(assessCapacity(s).issues.includes('generator_gap'))
 const latency=fixture();latency.result.scheduledLatencyMs.p99=151;assert(assessCapacity(latency).issues.includes('scheduled_p99'))
})
test('resource overflow or incomplete observations cannot pass',()=>{
 const s=fixture();s.samples[0].limiter.queued=129;assert(assessCapacity(s).issues.includes('resource_bound:queue'))
 for(const f of [s=>s.samples=[],s=>delete s.samples[0].processMemory,s=>s.samplingErrors.push('timeout'),s=>s.eventCursorGaps=[{}]]){const s=fixture();f(s);assert.equal(assessCapacity(s).healthy,false)}
})
test('no traffic and upstream accounting discrepancy do not qualify',()=>{
 const s=fixture();s.result.finished=0;assert.equal(assessCapacity(s).healthy,false)
 const duplicate=fixture();duplicate.upstreamReceived++;assert(assessCapacity(duplicate).issues.includes('upstream_accounting'))
})

test('a single response from a different route version fails even with stable endpoints',()=>{
 const s=fixture();s.result.versions={'route:32':999,'route:33':1}
 assert(assessCapacity(s).issues.includes('response_route_version'))
})
test('response versions must cover every finished request with positive integer counts',()=>{
 for(const versions of [undefined,{},[],{'route:32':999},{'route:32':1001},{'route:32':-1},{'route:32':'1000'},{'route:32':999.5},{'route:32':1000,unexpected:0}]){
  const s=fixture();s.result.versions=versions;assert(assessCapacity(s).issues.includes('response_version_coverage'),JSON.stringify(versions))
 }
 const absent=fixture();absent.result.versions={'(absent)':1000};assert.equal(assessCapacity(absent).healthy,false)
})
test('intermediate runtime or route version changes fail even after reverting before the endpoint',()=>{
 for(const key of ['runtime','route']){
  const s=fixture();s.samples[0][key].adoptedVersion='another-epoch:1'
  assert.equal(s.before[0][key].adoptedVersion,s.after[0][key].adoptedVersion)
  assert(assessCapacity(s).issues.includes('configuration_changed_or_stale'))
 }
})
test('each intermediate sync status is checked after the instance has recovered',()=>{
 for(const key of ['runtime','route'])for(const status of ['failed','stale','pending','not_checked',undefined]){
  const s=fixture();s.samples[0][key].status=status;assert.equal(s.after[0][key].status,'ok')
  const result=assessCapacity(s);assert.equal(result.healthy,false);assert(result.configurationFailures.some(f=>f.where==='samples[0].'+key))
 }
})
test('missing sample diagnostics and unrecognized instance labels fail closed',()=>{
 for(const mutate of [s=>delete s.samples[0].runtime,s=>delete s.samples[0].route,s=>s.samples[0]=null,s=>s.samples[0].label='B',s=>delete s.samples[0].label]){
  const s=fixture();mutate(s);assert.equal(assessCapacity(s).healthy,false)
 }
})
test('each diagnostic source must retain the same instance identity throughout the window',()=>{
 for(const location of ['before','samples','after'])for(const key of ['limiter','runtime','route']){
  const s=fixture();s[location][0][key].instanceId='restarted';assert(assessCapacity(s).issues.includes('instance_changed'))
 }
})
test('stored observation and adopted versions must agree with the fixed baseline',()=>{
 for(const [key,field] of [['runtime','lastConfirmedVersion'],['route','lastObservedVersion']]){
  const s=fixture();s.samples[0][key][field]='new-storage:44';assert.equal(assessCapacity(s).healthy,false)
 }
})
test('stale, failed, mismatched and stopped sync diagnostics cannot be hidden by status ok',()=>{
 for(const [key,field,value] of [['runtime','stale',true],['route','stale',true],['runtime','running',false],['runtime','lastCheckOutcome','failed'],['route','lastCheckOutcome','failed'],['runtime','matchesLastConfirmation',false],['route','matchesLastObservation',false]]){
  const s=fixture();s.samples[0][key][field]=value;assert.equal(assessCapacity(s).healthy,false)
 }
})
test('an unhealthy initial snapshot cannot become a healthy window just by recovering',()=>{
 for(const key of ['runtime','route']){const s=fixture();s.before[0][key].status='failed';assert.equal(assessCapacity(s).healthy,false)}
})
test('sync failure increments and resets between samples remain visible after recovery',()=>{
 for(const key of ['runtime','route'])for(const failures of [1,undefined,-1]){
  const s=fixture();s.samples[0][key].failures=failures;assert(assessCapacity(s).issues.includes('sync_failure_or_counter_reset'))
 }
 const s=fixture();s.before[0].runtime.failures=1;assert.equal(assessCapacity(s).healthy,false)
})
test('one-instance capacity evidence cannot be silently reused for multiple active gateways',()=>{
 const s=fixture();s.before.push(structuredClone(s.before[0]));s.after.push(structuredClone(s.after[0]));assert.equal(assessCapacity(s).healthy,false)
})
