import { defineStore } from 'pinia'
import { computed, reactive, ref } from 'vue'
import { API_BASE, apiRequest, authState, errorMessage } from '../api'

export interface TrafficMetricsSnapshot {
  enabled?: boolean
  completedTotal?: number
  cancelled?: number
  errors?: number
  unknownStatus?: number
  latencyOverflow?: number
  timestamp: number
  windowSeconds: number
  requestCount: number
  qps: number
  avgLatencyMs: number
  p95LatencyMs: number
  status2xx: number
  status3xx: number
  status4xx: number
  status5xx: number
}
export interface AuditStatus {
  enabled: boolean
  accepting: boolean
  received: number
  persisted: number
  dropped: number
  droppedByReason: Record<string, number>
  uncertain: number
  queueDepth: number
  inFlight: number
  pending: number
  reservedBytes: number
  oldestAgeMs: number
  retries: number
  lastBatchSize: number
  lastBatchDurationMs: number
  lastSuccessAgeMs: number | null
  capacity: number
  maxReservedBytes: number
}
export interface TrafficData {
  eventId?: string
  rateLimitOutcome?: string
  rateLimitReason?: string
  rateLimitEvent?: string
  rateLimitAction?: string
  rateLimitExecution?: string
  rateLimitRejectionSource?: string
  reason?: string
  phase?: string
  outcome?: string
  timestamp: number
  method: string
  path: string
  statusCode: number
  durationMs: number
  clientIp: string
}
export interface RuntimeConfig {
  rateLimitEnabled: boolean
  replenishRate: number
  burstCapacity: number
  requestedTokens: number
  monitorWindowSeconds: number
  emitIntervalSeconds: number
}
export interface RouteRule {
  id: string
  path: string
  uri: string
  rewriteEnabled: boolean
  rewriteRegex: string | null
  rewriteReplacement: string | null
  circuitBreakerEnabled: boolean
  circuitBreakerName: string
  fallbackPath: string
}

import { isSnapshot, mergeSamples, readState } from '../overview/model'

export const useTrafficStore = defineStore('traffic', () => {
  const latest = ref<TrafficMetricsSnapshot | null>(null)
  const series = ref<TrafficMetricsSnapshot[]>([])
  const logs = ref<TrafficData[]>([])
  const config = ref<RuntimeConfig | null>(null)
  const routes = ref<RouteRule[]>([])
  const auditStatus = ref<AuditStatus | null>(null)
  const snapshotState = reactive(readState()), seriesState = reactive(readState())
  const logsState = reactive(readState()), auditState = reactive(readState())
  const states = { snapshot:snapshotState, series:seriesState, logs:logsState, audit:auditState }
  type Source = keyof typeof states
  const error = computed(() => [snapshotState.error,seriesState.error].filter(Boolean).join('；'))
  const logsError = computed(() => logsState.error), auditError = computed(() => auditState.error)
  const connected = ref(false), streamConnecting = ref(false), streamError = ref('')
  const streamGaps = ref<number[]>([])
  let source: EventSource | null = null, ticketController: AbortController | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const timers = new Map<string,ReturnType<typeof setTimeout>>()
  const controllers = new Map<Source,AbortController>()
  const pending = new Map<Source,Promise<void>>()
  let generation = 0, active = false, failures = 0

  function current(version: number) { return active && version === generation }
  function markGap() {
    if (latest.value) streamGaps.value = [...new Set([...streamGaps.value,latest.value.timestamp])].slice(-120)
  }
  function disconnectSse() {
    active = false; generation++
    source?.close(); source = null
    ticketController?.abort(); ticketController = undefined
    clearTimeout(reconnectTimer)
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const controller of controllers.values()) controller.abort()
    controllers.clear(); pending.clear()
    for (const state of Object.values(states)) state.loading = false
    connected.value = false; streamConnecting.value = false
  }
  function read<T>(key: Source, path: string, apply: (data:T) => void, version = generation): Promise<void> {
    if (pending.has(key)) return pending.get(key)!
    const state = states[key], controller = new AbortController()
    controllers.set(key,controller); state.loading = true
    const task = (async () => {
      try {
        const data = await apiRequest<T>(path,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
        if (version !== generation) return
        apply(data); state.error = ''; state.loadedAt = Date.now()
      } catch (failure) {
        if (version === generation) state.error = errorMessage(failure)
        throw failure
      } finally {
        if (controllers.get(key) === controller) {
          controllers.delete(key); pending.delete(key); state.loading = false
        }
      }
    })()
    pending.set(key,task)
    return task
  }
  function fetchSnapshot() {
    return read<TrafficMetricsSnapshot>('snapshot','/dashboard/snapshot',data => {
      if (!isSnapshot(data)) throw new Error('快照格式无效，请重试读取')
      if (!latest.value || data.timestamp >= latest.value.timestamp) latest.value = data
    })
  }
  function fetchSeries() {
    return read<TrafficMetricsSnapshot[]>('series','/dashboard/series?size=120',data => {
      if (!Array.isArray(data) || data.some(point => !isSnapshot(point))) throw new Error('采样序列格式无效，请重试读取')
      series.value = mergeSamples(data,series.value)
      // A complete history read can fill gaps previously caused by the subscription.
      if (data.length) streamGaps.value = streamGaps.value.filter(time => time < data[0].timestamp || time >= data[data.length - 1].timestamp)
    })
  }
  function fetchLogs() {
    return read<TrafficData[]>('logs','/monitor/audit/recent?size=40',data => {
      if (!Array.isArray(data)) throw new Error('审计记录格式无效，请重试读取')
      logs.value = data.slice(0,40)
    })
  }
  function fetchAuditStatus(version = generation) {
    return read<AuditStatus>('audit','/monitor/audit/status',data => { auditStatus.value = data },version)
  }
  function schedulePoll(key: 'logs'|'audit'|'recovery', version: number) {
    clearTimeout(timers.get(key))
    timers.set(key,setTimeout(() => {
      if (!current(version) || !authState.authenticated) return
      if (key === 'recovery') {
        if (snapshotState.error) void fetchSnapshot().catch(() => {})
        if (seriesState.error) void fetchSeries().catch(() => {})
        schedulePoll(key,version)
      } else {
        const request = key === 'logs' ? fetchLogs() : fetchAuditStatus(version)
        void request.catch(() => {}).finally(() => { if (current(version)) schedulePoll(key,version) })
      }
    },5000))
  }
  async function bootstrap() {
    disconnectSse(); active = true; failures = 0; streamError.value = ''
    const version = generation
    // Independent reads: neither a slow history request nor Redis can delay SSE.
    const requests = [fetchSnapshot(),fetchSeries(),fetchLogs(),fetchAuditStatus(version)]
    if (authState.authenticated) {
      void connectSse(version)
      for (const key of ['logs','audit','recovery'] as const) schedulePoll(key,version)
    }
    await Promise.allSettled(requests)
  }
  function scheduleReconnect(version: number) {
    if (!current(version) || !authState.authenticated) return
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => void connectSse(version),Math.min(30000,1000 * 2 ** Math.min(failures++,5)))
  }
  async function connectSse(version = generation) {
    if (!current(version) || !authState.authenticated) return
    clearTimeout(reconnectTimer)
    source?.close(); source = null; connected.value = false; streamConnecting.value = true
    ticketController?.abort()
    const controller = new AbortController()
    ticketController = controller
    try {
      const ticket = await apiRequest<{token:string}>('/settings/sse-token',{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
      if (!current(version) || ticketController !== controller || !authState.authenticated) return
      const connection = new EventSource(API_BASE + '/monitor/stream?token=' + encodeURIComponent(ticket.token))
      source = connection
      connection.onopen = () => {
        if (!current(version) || source !== connection) return
        connected.value = true; streamConnecting.value = false; failures = 0; streamError.value = ''
      }
      connection.addEventListener('traffic',event => {
        if (!current(version) || source !== connection) return
        try {
          const snapshot: unknown = JSON.parse((event as MessageEvent).data)
          if (!isSnapshot(snapshot)) throw new Error('invalid snapshot')
          pushSnapshot(snapshot); streamError.value = ''
        } catch {
          markGap(); streamError.value = '收到无效监控数据，等待下一次更新'
        }
      })
      connection.onerror = () => {
        connection.close()
        if (!current(version) || source !== connection) return
        source = null; connected.value = false; streamConnecting.value = false
        markGap(); streamError.value = '指标订阅已中断，正在重连'
        scheduleReconnect(version)
      }
    } catch (failure) {
      if (!current(version) || ticketController !== controller) return
      streamConnecting.value = false; streamError.value = errorMessage(failure)
      scheduleReconnect(version)
    }
  }
  function pushSnapshot(payload: TrafficMetricsSnapshot) {
    if (!isSnapshot(payload)) return
    if (!latest.value || payload.timestamp >= latest.value.timestamp) {
      latest.value = payload; snapshotState.loadedAt = Date.now(); snapshotState.error = ''
    }
    series.value = mergeSamples(series.value,[payload])
  }
  async function retry(source: 'snapshot'|'series'|'logs'|'audit'|'stream') {
    if (!active || !authState.authenticated) return
    try {
      if (source === 'stream') await connectSse()
      else await ({snapshot:fetchSnapshot,series:fetchSeries,logs:fetchLogs,audit:fetchAuditStatus}[source])()
    } catch { /* Each source owns its error and retained data. */ }
  }
  async function fetchConfig() {
    config.value = await apiRequest<RuntimeConfig>('/settings/runtime')
  }
  async function fetchRoutes() {
    const result = await apiRequest<{version:string;routes:RouteRule[]}>('/settings/routes')
    if(!result.version||!Array.isArray(result.routes))throw new Error('需要版本化路由响应')
    routes.value = result.routes
  }
  async function saveRoute(route: RouteRule, expectedVersion: string) {
    await apiRequest('/settings/routes', { method: 'POST', body: JSON.stringify({expectedVersion,route}) })
    await fetchRoutes()
  }
  async function deleteRoute(id: string, expectedVersion: string) {
    await apiRequest(`/settings/routes/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({expectedVersion}) })
    await fetchRoutes()
  }
  return { latest, series, logs, config, routes, connected, error, streamError, logsError, auditStatus, auditError,
    snapshotState, seriesState, logsState, auditState, streamConnecting, streamGaps, retry,
    fetchAuditStatus, bootstrap, connectSse, disconnectSse, pushSnapshot, fetchSnapshot, fetchSeries,
    fetchLogs, fetchConfig, fetchRoutes, saveRoute, deleteRoute }
})
