import type { AuditStatus, TrafficData, TrafficMetricsSnapshot } from '../stores/traffic'
import { readState, type OverviewData } from './model'
export const overviewScenarios = [
  {id:'normal',label:'正常'}, {id:'zero',label:'真实零流量'}, {id:'empty',label:'无历史采样'},
  {id:'loading',label:'首次读取'}, {id:'partial',label:'局部失败 / 旧数据'},
  {id:'disabled',label:'监控关闭'}, {id:'audit',label:'审计停止接收'}, {id:'overflow',label:'P95 超范围'}, {id:'gaps',label:'采样缺口'}
]
export function overviewScenario(value: unknown) {
  return overviewScenarios.some(item => item.id === value) ? String(value) : 'normal'
}
export function overviewFixture(scenario: string): OverviewData & {now:number} {
  const now = Date.now()
  let timestamp = now
  const stamps: number[] = []
  for (let i = 119; i >= 0; i--) { stamps.unshift(timestamp); timestamp -= [1000,1000,2000,3000,1000][i % 5] }
  const series: TrafficMetricsSnapshot[] = stamps.map((timestamp,i) => {
    const requestCount = Math.round((1450 + i * 7 + Math.sin(i / 7) * 240 + Math.sin(i / 2.8) * 70 + 760 * Math.exp(-(((i - 79) / 7) ** 2))) * 10)
    const p95LatencyMs = Math.round(23 + 9 * (1 + Math.sin(i / 9)) + 68 * Math.exp(-(((i - 83) / 6) ** 2)))
    return {timestamp,enabled:true,windowSeconds:10,requestCount,qps:requestCount/10,p95LatencyMs,avgLatencyMs:p95LatencyMs*.54,
      status2xx:requestCount,status3xx:0,status4xx:0,status5xx:0,cancelled:0,errors:0,unknownStatus:0,latencyOverflow:0,completedTotal:1940281+i}
  })
  series[119] = {...series[119],requestCount:24862,qps:2486.2,p95LatencyMs:34,avgLatencyMs:18.4,status2xx:24862}
  const auditStatus: AuditStatus = {enabled:true,accepting:true,received:1940400,persisted:1940388,dropped:8,droppedByReason:{queue_full:8},uncertain:4,
    pending:0,queueDepth:0,inFlight:0,reservedBytes:0,oldestAgeMs:0,retries:3,lastBatchSize:64,lastBatchDurationMs:3,lastSuccessAgeMs:420,capacity:20000,maxReservedBytes:16777216}
  const logs: TrafficData[] = [
    {eventId:'demo-audit-001',timestamp:now-1200,method:'GET',path:'/api/enterprise/asia-pacific/orders-and-settlements/v2/accounts/enterprise-2026-annual-procurement/orders/202609250018/settlement-details',statusCode:200,durationMs:34,clientIp:'192.0.2.18',outcome:'completed'},
    {eventId:'demo-audit-002',timestamp:now-2800,method:'POST',path:'/api/orders',statusCode:201,durationMs:48,clientIp:'192.0.2.21',outcome:'completed'},
    {eventId:'demo-audit-003',timestamp:now-4300,method:'GET',path:'/api/catalog/items?page=2',statusCode:200,durationMs:16,clientIp:'192.0.2.25',outcome:'completed'},
    {eventId:'demo-audit-004',timestamp:now-6100,method:'POST',path:'/api/payments/confirm',statusCode:429,durationMs:4,clientIp:'192.0.2.21',outcome:'completed'},
    {eventId:'demo-audit-005',timestamp:now-9800,method:'GET',path:'/api/inventory/warehouse/east',statusCode:503,durationMs:2092,clientIp:'192.0.2.43',outcome:'completed'},
    {eventId:'demo-audit-006',timestamp:now-86400000,method:'GET',path:'/api/reports/export',statusCode:0,durationMs:835,clientIp:'192.0.2.55',outcome:'cancelled'},
    {eventId:'demo-audit-007',timestamp:now-86405000,method:'GET',path:'/api/ledger/reconciliation',statusCode:0,durationMs:3001,clientIp:'192.0.2.55',outcome:'error'}
  ]
  const state = (): ReturnType<typeof readState> => ({loading:false,error:'',loadedAt:now})
  const data: OverviewData & {now:number} = {now,latest:series[119],series,logs,auditStatus,snapshotState:state(),seriesState:state(),logsState:state(),auditState:state(),
    connected:true,streamConnecting:false,streamError:'',streamGaps:[]}
  if (['zero','empty','disabled'].includes(scenario)) {
    data.series = series.map(point => ({...point,enabled:scenario !== 'disabled',qps:0,requestCount:0,p95LatencyMs:0,avgLatencyMs:0,status2xx:0}))
    data.latest = data.series[119]
    data.logs = logs.map(log => ({...log,timestamp:log.timestamp-3600000}))
  }
  if (scenario === 'empty') { data.series = []; data.logs = [] }
  if (scenario === 'loading') {
    data.latest = null; data.series = []; data.logs = []; data.auditStatus = null; data.connected = false; data.streamConnecting = true
    for (const resource of [data.snapshotState,data.seriesState,data.logsState,data.auditState]) Object.assign(resource,{loading:true,loadedAt:null})
  }
  if (scenario === 'partial') {
    data.series = series.map(point => ({...point,timestamp:point.timestamp-35000}))
    data.latest = data.series[119]; data.connected = false; data.streamError = '指标订阅已中断，正在重连（演示）'
    data.snapshotState.loadedAt = now-35000
    data.logs = logs.map(log => ({...log,timestamp:log.timestamp-60000}))
    data.seriesState.error = '采样序列读取失败（演示 HTTP 503）'
    data.logsState = {loading:false,error:'最近审计记录读取失败（演示 HTTP 503）',loadedAt:now-60000}
  }
  if (scenario === 'audit') Object.assign(auditStatus,{accepting:false,pending:136,queueDepth:96,inFlight:40,oldestAgeMs:42000,reservedBytes:1048576,lastSuccessAgeMs:46000})
  if (scenario === 'overflow') {
    data.series[100] = {...data.series[100],p95LatencyMs:-1,latencyOverflow:2300}
    data.series[119] = {...data.series[119],p95LatencyMs:-1,latencyOverflow:2300}
    data.latest = data.series[119]
  }
  if (scenario === 'gaps') {
    data.series = series.filter((_,i) => i < 48 || i > 61).map((point,i) => ({...point,enabled:i < 76 || i > 81}))
    data.streamGaps = [data.series[26].timestamp]
  }
  return data
}
