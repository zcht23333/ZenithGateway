// Pure promotion decision; fixed thresholds come from the pre-recorded plan.
// Expected fault responses remain unhealthy, but are never called unexpected HTTP errors.
export function assessStage(s,plan,versions){
 const {result:r,before:b,after:a,samples=[],sampleErrors=[],metricsBefore:m0,metricsAfter:m1}=s
 const delta=(x,y)=>Object.fromEntries(Object.keys(y).map(k=>[k,(y[k]||0)-(x[k]||0)]))
 const d=delta(b.limit.outcomes,a.limit.outcomes),blocked=[]
 const expectedStatus=s.declaredFault&&a.limit.redisFailurePolicy==='reject'?503:200
 const unexpected=r.transportErrors+Object.entries(r.statuses).filter(([status])=>Number(status)!==expectedStatus).reduce((n,[,v])=>n+v,0)
 const protective=(d.local_rejected||0)+(d.redis_rejected||0),quota=(d.limited||0)+(d.unfulfillable||0)
 const faults=(d.local_fail_open||0)+(d.redis_fail_open||0)
 if(unexpected)blocked.push('unexpected_http_or_transport')
 if((r.schedulerMisses+r.capacityMisses)/r.offered>plan.maxArrivalGapRatio)blocked.push('arrival_gap')
 if(r.latencyMs.p95>plan.p95LimitMs||r.latencyMs.p99>plan.p99LimitMs)blocked.push('latency')
 if(faults)blocked.push('fault_forward')
 if(protective)blocked.push('protective_rejection')
 if(quota)blocked.push('quota_rejection')
 if(a.limit.observations.executions.unknown>b.limit.observations.executions.unknown)blocked.push('debit_unknown')
 if(a.life.clientCancelled>b.life.clientCancelled||d.cancelled>0)blocked.push('client_cancelled')
 const a0=b.life.audit,a1=a.life.audit
 if(a1.received-a0.received!==r.finished||a1.received!==a1.persisted+a1.pending+a1.uncertain+a1.dropped)blocked.push('audit_accounting_mismatch')
 if(a1.pending||a1.persisted-a0.persisted!==r.finished||a1.dropped!==a0.dropped||a1.uncertain!==a0.uncertain)blocked.push('audit_not_fully_confirmed')
 const expectedUpstream=r.finished-protective-quota
 if(a.life.completed-b.life.completed!==r.finished||m1.requests-m0.requests!==r.finished)blocked.push('terminal_accounting_mismatch')
 if(s.upstreamAfter-s.upstreamBefore!==expectedUpstream)blocked.push('upstream_accounting_mismatch')
 if(Object.keys(r.versions).some(v=>v!==versions.route))blocked.push('route_response_version')
 for(const current of [b,a])if(current.life.adoptedRuntimeVersion!==versions.runtime||current.life.adoptedRouteVersion!==versions.route)blocked.push('adopted_version_changed')
 if(a.runtimeSync.status!=='ok'||a.routeSync.status!=='ok')blocked.push('sync_not_confirmed')
 if(b.life.instanceId!==a.life.instanceId||Object.values(d).some(x=>x<0)||m1.requests<m0.requests)blocked.push('instance_or_counter_changed')
 if(m1.poolFull!==m0.poolFull)blocked.push('proxy_pool_full')
 if(sampleErrors.length)blocked.push('sampling_failed')
 let high=0
 for(const current of [...samples,a]){
  const l=current.limit,p=current.proxy
  if(l.queued>l.queueCapacity||l.commandsInFlight>l.workers||l.retainedTasks>l.admissionCapacity||l.availableDecisionPermits<0||l.activeWorkers>l.workers||p.pool['active.connections']>p.policy.maxConnectionsPerOrigin||p.pool['pending.connections']>p.policy.maxPendingAcquiresPerOrigin)blocked.push('resource_bound')
  high=l.queued>l.queueCapacity*0.75?high+1:0;if(high>=2)blocked.push('sustained_queue')
 }
 const reasons=[...new Set(blocked)]
 return {healthy:reasons.length===0,reasons,expectedHttpStatus:expectedStatus,unexpectedHttpResponses:unexpected,
  protectiveRejections:protective,faultForwards:faults,quotaRejections:quota,expectedUpstream,actualUpstream:s.upstreamAfter-s.upstreamBefore,
  auditReceived:a1.received-a0.received,auditConfirmed:a1.persisted-a0.persisted,auditPending:a1.pending,auditUnknown:a1.uncertain-a0.uncertain,auditDropped:a1.dropped-a0.dropped}
}
