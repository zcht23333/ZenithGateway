// Deployment-controller decisions for the isolated HAProxy experiment, not a product autoscaler.
export const rollingPlan=Object.freeze({
 rate:50,windowSeconds:5,warmRate:10,warmSeconds:5,rampWeights:[5,20,50],maxWindows:3,
 maxArrivalGapRatio:0.02,p95LimitMs:250,p99LimitMs:750,sampleEveryMs:500,
 readinessMs:60000,recoveryMs:20000,auditSettleMs:15000,requestMs:8000,
 requestDrainMs:2000,cancellationSettleMs:1000,auditDrainMs:1000,drainObserveMs:12000,exitMs:45000,
 generatorConnections:64,gatewayCpus:2,gatewayMemory:'1g',handoff:false,
 scope:'Short functional rolling-replacement windows; not a capacity certification'
})
const count=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0
export function candidateGate(s,versions,{initialTraffic=false}={}){
 const reasons=[]
 if(!s?.ready||s.life?.draining)reasons.push('not_ready')
 if(!s?.life?.instanceId)reasons.push('missing_instance_identity')
 if(s?.life?.adoptedRuntimeVersion!==versions.runtime)reasons.push('runtime_version_not_adopted')
 if(s?.life?.adoptedRouteVersion!==versions.route)reasons.push('route_version_not_adopted')
 if(s?.runtimeSync?.status!=='ok'||s?.routeSync?.status!=='ok')reasons.push('sync_not_confirmed')
 if(s?.limit?.transportState!=='healthy'&&!(initialTraffic&&s?.limit?.transportState==='unchecked'))reasons.push('limiter_not_healthy')
 return {allowed:reasons.length===0,reasons}
}
export function assessRollingWindow({before,after,samples=[],sampleErrors=[],result,upstreamCount},plan=rollingPlan,versions){
 const reasons=[],details={}
 if(!result||!count(result.finished)||result.finished<=0||result.finished!==result.issued)reasons.push('incomplete_window')
 if(result?.transportErrors||result?.statuses?.['200']!==result?.finished)reasons.push('http_or_transport')
 if(!count(result?.offered)||result.offered===0||!count(result?.schedulerMisses)||!count(result?.capacityMisses)||(result.schedulerMisses+result.capacityMisses)/result.offered>plan.maxArrivalGapRatio)reasons.push('arrival_gap')
 if(!count(result?.latencyMs?.p95)||!count(result?.latencyMs?.p99)||result.latencyMs.p95>plan.p95LimitMs||result.latencyMs.p99>plan.p99LimitMs)reasons.push('latency')
 if(!result?.versions||Object.values(result.versions).reduce((a,b)=>a+b,0)!==result.finished||Object.keys(result.versions).some(v=>v!==versions.route))reasons.push('route_response_version')
 if(sampleErrors.length)reasons.push('sampling_failed')
 let admitted=0,completed=0,audit=0,unknown=0,faults=0,rejected=0,poolFull=0
 for(const [id,b] of Object.entries(before)){
  const a=after[id]
  if(!a||b.life.instanceId!==a.life.instanceId){reasons.push('instance_changed');continue}
  reasons.push(...candidateGate(a,versions).reasons)
  const diff=(x,y)=>{if(!count(x)||!count(y)||y<x){reasons.push('missing_or_reset_counter');return 0}return y-x}
  const d={admitted:diff(b.life.admitted,a.life.admitted),completed:diff(b.life.completed,a.life.completed),
   auditReceived:diff(b.life.audit.received,a.life.audit.received),auditConfirmed:diff(b.life.audit.persisted,a.life.audit.persisted),
   auditUnknown:diff(b.life.audit.uncertain,a.life.audit.uncertain),auditDropped:diff(b.life.audit.dropped,a.life.audit.dropped),
   cancelled:diff(b.life.clientCancelled,a.life.clientCancelled),
   debitUnknown:diff(b.limit.observations.executions.unknown,a.limit.observations.executions.unknown)}
  const outcome=name=>diff(b.limit.outcomes[name]??0,a.limit.outcomes[name]??0)
  d.faultForward=outcome('local_fail_open')+outcome('redis_fail_open')
  d.protective=outcome('local_rejected')+outcome('redis_rejected')
  d.quota=outcome('limited')+outcome('unfulfillable')
  d.poolFull=diff(b.poolFull,a.poolFull)
  if(d.auditReceived!==d.completed||d.auditConfirmed!==d.completed||d.auditUnknown||d.auditDropped||a.life.audit.pending)reasons.push('audit_not_fully_confirmed')
  if(d.cancelled)reasons.push('client_cancelled')
  admitted+=d.admitted;completed+=d.completed;audit+=d.auditConfirmed;unknown+=d.debitUnknown;faults+=d.faultForward;rejected+=d.protective+d.quota;poolFull+=d.poolFull
  details[id]=d
  for(const s of [...samples.map(x=>x[id]).filter(Boolean),a]){
   const l=s.limit,p=s.proxy
   if([l.queued,l.queueCapacity,l.commandsInFlight,l.workers,l.retainedTasks,l.admissionCapacity,l.availableDecisionPermits,p.activeProxyRequests,p.policy.maxConnectionsPerOrigin,p.policy.maxPendingAcquiresPerOrigin].some(v=>!count(v))||l.queued>l.queueCapacity||l.commandsInFlight>l.workers||l.retainedTasks>l.admissionCapacity||p.activeProxyRequests>p.policy.maxConnectionsPerOrigin+p.policy.maxPendingAcquiresPerOrigin)reasons.push('resource_bound')
  }
 }
 if(admitted!==result?.finished||completed!==result?.finished||audit!==result?.finished)reasons.push('terminal_or_audit_accounting')
 if(upstreamCount!==result?.finished)reasons.push('upstream_accounting')
 if(unknown)reasons.push('debit_unknown')
 if(faults)reasons.push('fault_forward')
 if(rejected)reasons.push('protection_or_quota_rejection')
 if(poolFull)reasons.push('proxy_pool_full')
 return {healthy:reasons.length===0,reasons:[...new Set(reasons)],details,admitted,completed,audit,unknown,faults,rejected,poolFull,upstreamCount}
}
export function reconcileRollingLedger(ingress,upstream,audits){
 const errors=[],counts={ingress:ingress.length,upstream:upstream.length,audit:audits.length},index=rows=>{
  const map=new Map();for(const row of rows){const id=row.path.split('/').at(-1);if(map.has(id))errors.push('duplicate:'+id);map.set(id,row)}return map
 }
 const i=index(ingress),u=index(upstream),a=index(audits)
 for(const [id,row] of i){
  if(!u.has(id))errors.push('no_upstream:'+id)
  if(!a.has(id))errors.push('no_audit:'+id)
  if(u.has(id)&&a.has(id)&&u.get(id).instance!==a.get(id).instance)errors.push('instance_mismatch:'+id)
  if(row.termination==='complete'&&row.status===200&&a.has(id)&&a.get(id).outcome!=='completed')errors.push('terminal_mismatch:'+id)
 }
 for(const id of [...u.keys(),...a.keys()])if(!i.has(id))errors.push('unissued:'+id)
 return {passed:errors.length===0,counts,errors:[...new Set(errors)]}
}
// Unknown settlement can be present or absent in Redis. Never count it as confirmed or lost by assumption.
export function reconcileAuditSettlement({received,persisted,pending,uncertain,dropped},stored){
 const errors=[]
 if([received,persisted,pending,uncertain,dropped,stored].some(v=>!count(v)))errors.push('missing_counter')
 if(received!==persisted+pending+uncertain+dropped)errors.push('settlement_total')
 if(pending!==0)errors.push('pending_at_exit')
 if(stored<persisted||stored>persisted+uncertain)errors.push('storage_outside_confirmed_unknown_bounds')
 return {passed:errors.length===0,errors,received,persisted,pending,uncertain,dropped,stored,
  unknownStored:stored-persisted,absent:received-stored}
}
