import type { AuditStatus, TrafficData, TrafficMetricsSnapshot } from '../stores/traffic'

export interface ReadState { loading: boolean; error: string; loadedAt: number | null }
export const readState = (): ReadState => ({ loading:false, error:'', loadedAt:null })
export interface OverviewData {
  latest: TrafficMetricsSnapshot | null
  series: TrafficMetricsSnapshot[]
  logs: TrafficData[]
  auditStatus: AuditStatus | null
  snapshotState: ReadState
  seriesState: ReadState
  logsState: ReadState
  auditState: ReadState
  connected: boolean
  streamConnecting: boolean
  streamError: string
  streamGaps: number[]
}
export function isSnapshot(value: unknown): value is TrafficMetricsSnapshot {
  if (!value || typeof value !== 'object') return false
  const p = value as TrafficMetricsSnapshot
  return [p.timestamp,p.qps,p.avgLatencyMs,p.requestCount,p.windowSeconds,p.p95LatencyMs]
    .every(n => typeof n === 'number' && Number.isFinite(n)) &&
    p.timestamp >= 0 && p.qps >= 0 && p.requestCount >= 0 && p.avgLatencyMs >= 0 &&
    p.windowSeconds > 0 && (p.p95LatencyMs >= 0 || p.p95LatencyMs === -1)
}
export function mergeSamples(old: TrafficMetricsSnapshot[], incoming: TrafficMetricsSnapshot[]) {
  const points = new Map(old.map(point => [point.timestamp,point]))
  for (const point of incoming) if (isSnapshot(point)) points.set(point.timestamp,point)
  return [...points.values()].sort((a,b) => a.timestamp - b.timestamp).slice(-120)
}
export function buildTrend(points: TrafficMetricsSnapshot[], interruptions: number[] = []) {
  const samples = mergeSamples([],points)
  const qps: [number,number|null][] = [], p95: [number,number|null][] = [], overflow: number[] = []
  let previous: TrafficMetricsSnapshot | undefined
  for (const point of samples) {
    // The server emits every 1–5 seconds. Leave a gap beyond 6 seconds, or after
    // a known subscription interruption; synthetic nulls are never samples.
    if (previous && (point.timestamp - previous.timestamp > 6000 ||
      interruptions.some(time => time >= previous!.timestamp && time < point.timestamp))) {
      const missing = (previous.timestamp + point.timestamp) / 2
      qps.push([missing,null]); p95.push([missing,null])
    }
    const enabled = point.enabled !== false
    qps.push([point.timestamp,enabled ? point.qps : null])
    p95.push([point.timestamp,enabled && point.p95LatencyMs >= 0 ? point.p95LatencyMs : null])
    if (enabled && point.p95LatencyMs === -1) overflow.push(point.timestamp)
    previous = point
  }
  return { samples, qps, p95, overflow }
}
export function number(value: number | null | undefined, digits = 0) {
  return value == null || !Number.isFinite(value) ? '—' :
    value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})
}
export function axisNumber(value: number) {
  const scaled = value >= 1000 ? value / 1000 : value
  return scaled.toLocaleString('en-US',{maximumSignificantDigits:3}) + (value >= 1000 ? 'k' : '')
}
export function timeLabel(timestamp: number | null | undefined, date = false) {
  if (timestamp == null || !Number.isFinite(timestamp)) return '—'
  return new Date(timestamp).toLocaleString('zh-CN',date
    ? {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}
    : {hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false})
}
export function latencyLabel(point: TrafficMetricsSnapshot | null) {
  if (!point || point.enabled === false) return '—'
  return point.p95LatencyMs === -1 ? '> 60,000' : number(point.p95LatencyMs)
}
export function auditLabel(status: AuditStatus | null) {
  return !status ? '尚未读取状态' : !status.enabled ? '审计已关闭' :
    !status.accepting ? '已停止接收' : status.pending > 0 ? '正在等待写入' : '待写入已排空'
}
export function recordResult(record: TrafficData) {
  const executionNote = record.rateLimitExecution === 'unknown' ? ' · 扣费结果未知' : ''
  if (record.outcome === 'cancelled') return (record.statusCode > 0 ? '已取消 · HTTP ' + record.statusCode : '已取消 · 未形成 HTTP 状态') + executionNote
  if (!record.statusCode) return record.outcome === 'error' ? '请求异常 · 未形成 HTTP 状态' : '未形成 HTTP 状态'
  const reasons:Record<string,string>={upstream_connect_error:'连接错误',upstream_connect_timeout:'建连超时',upstream_headers_timeout:'响应头超时',upstream_read_idle:'响应读取停顿',proxy_total_timeout:'总时限',upstream_disconnect:'上游断连',circuit_open:'熔断拒绝',proxy_pool_timeout:'连接池等待超时',proxy_pool_full:'连接池已满',upstream_tls_error:'TLS 错误',upstream_tls_timeout:'TLS 超时',proxy_internal_error:'代理异常'}
  const limitNote: Record<string,string> = {redis_rejected:'额度未确认 · 已拒绝',local_rejected:'限流资源不足 · 已拒绝',redis_fail_open:'限流故障放行',local_fail_open:'限流资源不足放行',unfulfillable:'请求成本超过容量',limited:'额度不足'}
  return 'HTTP ' + record.statusCode + (record.reason && reasons[record.reason] ? ' · '+reasons[record.reason]+(record.outcome==='error'?' · 已中断':'') : '') + (limitNote[record.rateLimitOutcome || ''] ? ' · '+limitNote[record.rateLimitOutcome || ''] : '') + executionNote
}
