// Fixed before the experiment. A completed experiment is not necessarily a healthy capacity result.
export const capacityPlan=Object.freeze({rate:1000,shortSeconds:120,shortRepetitions:2,longSeconds:3600,
 warmup:[{name:'warm-100',rate:100,seconds:30},{name:'warm-500',rate:500,seconds:30},{name:'warm-1000',rate:1000,seconds:60}],
 confirmationSeconds:30,downshiftRate:100,downshiftSeconds:120,idleSeconds:600,sampleMs:2000,rssSampleMs:10000,
 generatorConnections:256,generatorTimeoutMs:8000,maxMissFraction:.01,p95Ms:50,p99Ms:100,scheduledP99Ms:150,
 workers:8,queueCapacity:128,decisionTimeoutMs:500,handoff:false,localFailurePolicy:'allow',redisFailurePolicy:'allow',
 note:'Single gateway, capacity profile, small HTTP responses, standalone Redis without persistence; no TLS or production SLA claim.'})
const valid=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0
const count=x=>Number.isSafeInteger(x)&&x>=0
const text=x=>typeof x==='string'&&x.length>0
export function assessCapacity(stage,plan=capacityPlan){
 const issues=[],r=stage.result,deltas=[],configurationFailures=[]
 const before=Array.isArray(stage.before)?stage.before:[],after=Array.isArray(stage.after)?stage.after:[],samples=Array.isArray(stage.samples)?stage.samples:[]
 const configurationFailure=(issue,where)=>{issues.push(issue);if(configurationFailures.length<20)configurationFailures.push({issue,where})}
 const checkConfiguration=(s,b,where)=>{
  if(!b||!text(b.label)||s?.label!==b.label){configurationFailure('unknown_sample_instance',where);return}
  const id=b.limiter?.instanceId
  if(!text(id)||[s.limiter,s.runtime,s.route].some(d=>d?.instanceId!==id))configurationFailure('instance_changed',where)
  for(const key of ['runtime','route']){
   const d=s[key],base=b[key],version=base?.adoptedVersion
   const observed=key==='runtime'?'lastConfirmedVersion':'lastObservedVersion',matches=key==='runtime'?'matchesLastConfirmation':'matchesLastObservation'
   if(!text(version)||d?.adoptedVersion!==version||d?.[observed]!==version||d?.status!=='ok'||d?.stale!==false||d?.lastCheckOutcome!=='ok'||d?.[matches]!==true||key==='runtime'&&d?.running!==true)
    configurationFailure('configuration_changed_or_stale',where+'.'+key)
   // A failed check that recovered between samples must not disappear from a healthy window.
   if(!count(base?.failures)||!count(d?.failures)||d.failures!==base.failures)configurationFailure('sync_failure_or_counter_reset',where+'.'+key)
  }
 }
 const delta=(before,after,name)=>{if(!valid(before)||!valid(after)||after<before){issues.push('missing_or_reset:'+name);return null}return after-before}
 const eq=(a,b,name)=>{if(!valid(a)||!valid(b)||a!==b)issues.push(name)}
 if(!r||!valid(r.offered)||r.offered===0||!valid(r.finished)||r.finished===0){return {healthy:false,issues:['empty_or_missing_load']}}
 eq(r.offered,r.issued+r.schedulerMisses+r.capacityMisses,'arrival_accounting');eq(r.issued,r.finished,'unfinished_requests')
 if(!valid(r.transportErrors)||r.transportErrors||r.statuses?.['200']!==r.finished)issues.push('http_or_transport')
 const miss=(r.schedulerMisses+r.capacityMisses)/r.offered
 if(!Number.isFinite(miss)||miss<0||miss>plan.maxMissFraction)issues.push('generator_gap')
 for(const [value,limit,name] of [[r.statusLatencyMs?.['200']?.p95,plan.p95Ms,'p95'],[r.statusLatencyMs?.['200']?.p99,plan.p99Ms,'p99'],[r.scheduledLatencyMs?.p99,plan.scheduledP99Ms,'scheduled_p99']])if(!valid(value)||value>limit)issues.push(name)
 if(stage.samplingErrors?.length||!samples.length)issues.push('sampling_missing_or_failed')
 eq(stage.upstreamReceived,r.finished,'upstream_accounting')
 // This capacity profile measures exactly one active gateway; aggregate response versions
 // cannot prove per-instance coverage for a multi-gateway experiment.
 if(before.length!==1||after.length!==1)issues.push('missing_or_non_single_instance_snapshots')
 const expectedRouteVersion=before[0]?.route?.adoptedVersion
 const versions=r.versions&&typeof r.versions==='object'&&!Array.isArray(r.versions)?Object.entries(r.versions):[]
 if(!versions.length||versions.some(([,n])=>!count(n)||n===0)||!count(r.finished)||versions.reduce((sum,[,n])=>sum+n,0)!==r.finished)issues.push('response_version_coverage')
 if(!text(expectedRouteVersion)||versions.some(([version])=>version!==expectedRouteVersion))issues.push('response_route_version')
 for(const b of before){
  if(!b){issues.push('missing_snapshots');continue}
  checkConfiguration(b,b,'before')
  const a=after.find(s=>s?.label===b.label);if(!a){issues.push('missing_after');continue}
  checkConfiguration(a,b,'after')
  const events={},actions={},executions={},outcomes={}
  for(const [key,target] of [['events',events],['actions',actions],['executions',executions]]){
   const keys={events:['allowed','disabled','limited','unfulfillable','local_unavailable','redis_unconfirmed','cancelled'],actions:['forward','reject','cancel'],executions:['not_sent','not_written','confirmed','unknown']}[key]
   for(const k of keys)target[k]=delta(b.limiter?.observations?.[key]?.[k],a.limiter?.observations?.[key]?.[k],key+'.'+k)
  }
  for(const k of ['redis_fail_open','local_fail_open','redis_rejected','local_rejected'])outcomes[k]=delta(b.limiter?.outcomes?.[k],a.limiter?.outcomes?.[k],'outcomes.'+k)
  const audit=Object.fromEntries(['received','persisted','dropped','uncertain'].map(k=>[k,delta(b.audit?.[k],a.audit?.[k],'audit.'+k)]))
  const completed=delta(b.monitor?.completedTotal,a.monitor?.completedTotal,'monitor.completedTotal')
  const cancelled=delta(b.life?.clientCancelled,a.life?.clientCancelled,'life.clientCancelled')
  const count=r.byTarget?.[stage.origins?.[b.label]]?.finished??r.finished
  for(const [value,name] of [[completed,'monitor'],[audit.received,'audit_received'],[audit.persisted,'audit_confirmed'],[events.allowed,'quota_allowed'],[actions.forward,'forward'],[executions.confirmed,'debit_confirmed']])eq(value,count,name+'_accounting')
  if(cancelled!==0)issues.push('client_cancelled')
  if(audit.dropped!==0||audit.uncertain!==0||a.audit?.pending!==0)issues.push('audit_not_confirmed')
  if(outcomes.local_fail_open!==0||outcomes.redis_fail_open!==0)issues.push('fault_forward')
  if(outcomes.local_rejected!==0||outcomes.redis_rejected!==0||actions.reject!==0)issues.push('protective_or_quota_rejection')
  if(executions.unknown!==0)issues.push('debit_unknown')
  if(events.disabled!==0)issues.push('limiter_bypassed')
  if(actions.cancel!==0||events.cancelled!==0)issues.push('limiter_cancelled')
  if(a.limiter?.transportState!=='healthy')issues.push('limiter_unhealthy')
  deltas.push({label:b.label,requests:count,completed,cancelled,audit,events,actions,executions,outcomes})
 }
 for(const [index,s] of samples.entries()){
  checkConfiguration(s,before.find(b=>b?.label===s?.label),'samples['+index+']')
  const l=s?.limiter,p=s?.proxy,a=s?.audit,j=s?.jvm
  if(!l||!p||!a||!j){issues.push('missing_resource_sample');continue}
  for(const [value,cap,name] of [[l.commandsInFlight,l.workers,'commands'],[l.queued,l.queueCapacity,'queue'],[l.openConnections,l.workers,'connections'],[l.retainedTasks,l.admissionCapacity,'admissions'],[l.scheduledTasks,l.admissionCapacity+2,'timers'],[a.pending,20000,'audit_pending'],[a.reservedBytes,16777216,'audit_bytes']])if(!valid(value)||!valid(cap)||value>cap)issues.push('resource_bound:'+name)
  // All 32 test routes share one upstream origin, so these per-origin bounds apply to the aggregate pool.
  for(const [key,limit] of [['total.connections',p.policy?.maxConnectionsPerOrigin],['pending.connections',p.policy?.maxPendingAcquiresPerOrigin]])if(!valid(p.pool?.[key])||!valid(limit)||p.pool[key]>limit)issues.push('resource_bound:proxy_'+key)
  for(const key of ['heapBytes','heapCommitted','directBytes','nonHeapBytes','threads'])if(!valid(j[key]))issues.push('missing_jvm:'+key)
  if(s.processMemory&&(!valid(s.processMemory.rssBytes)||!valid(s.processMemory.cgroupBytes)))issues.push('missing_rss')
 }
 if(!samples.some(s=>valid(s?.processMemory?.rssBytes)))issues.push('no_rss_samples')
 if(stage.eventCursorGaps?.length||stage.collectorTrimmed)issues.push('event_evidence_incomplete')
 return {healthy:issues.length===0,issues:[...new Set(issues)],configurationFailures,generatorMissFraction:miss,deltas,
  note:'Execution unknown is an independent dimension, never added to request totals; only confirmed allowed/forward decisions qualify as healthy.'}
}
