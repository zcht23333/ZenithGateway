import { defineStore } from 'pinia'

export interface TrafficMetricsSnapshot {
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

export interface TrafficData {
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
  rewriteRegex: string
  rewriteReplacement: string
  circuitBreakerEnabled: boolean
  circuitBreakerName: string
  fallbackPath: string
}

const API_BASE = 'http://localhost:8080'

// 管理 API 共享密钥 —— 与后端 ZENITH_ADMIN_TOKEN 一致
// 开发模式（未构建时）使用 Vite env；生产构建时通过 VITE_ADMIN_TOKEN 注入
const ADMIN_TOKEN = import.meta.env.VITE_ADMIN_TOKEN || ''

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json'
  }
  if (ADMIN_TOKEN) {
    headers['Authorization'] = `Bearer ${ADMIN_TOKEN}`
  }
  return headers
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      ...authHeaders(),
      ...(init?.headers || {})
    }
  })
  if (response.status === 401) {
    console.warn('Admin API returned 401 — check ZENITH_ADMIN_TOKEN')
  }
  return response
}

export const useTrafficStore = defineStore('traffic', {
  state: () => ({
    latest: null as TrafficMetricsSnapshot | null,
    series: [] as TrafficMetricsSnapshot[],
    logs: [] as TrafficData[],
    config: null as RuntimeConfig | null,
    routes: [] as RouteRule[],
    connected: false,
    source: null as EventSource | null
  }),
  actions: {
    async bootstrap() {
      await Promise.all([this.fetchSnapshot(), this.fetchSeries(), this.fetchLogs(), this.fetchConfig(), this.fetchRoutes()])
      await this.connectSse()
    },

    async connectSse() {
      if (this.source) {
        this.source.close()
      }
      this.source = null

      // 先从 REST API 获取作用域受限的 SSE token，避免主 admin token 在 URL 中泄露
      let sseToken = ''
      try {
        const tokenRes = await apiFetch('/settings/sse-token')
        if (tokenRes.ok) {
          const data = await tokenRes.json()
          sseToken = data.token || ''
        }
      } catch (_) {
        // 认证未启用时直接使用无 token 的 URL
      }

      const sseUrl = sseToken
        ? `${API_BASE}/monitor/stream?token=${encodeURIComponent(sseToken)}`
        : `${API_BASE}/monitor/stream`
      const source = new EventSource(sseUrl)
      source.addEventListener('traffic', (event) => {
        const messageEvent = event as MessageEvent
        this.pushSnapshot(JSON.parse(messageEvent.data) as TrafficMetricsSnapshot)
      })
      this.source = source
    },

    disconnectSse() {
      if (this.source) {
        this.source.close()
        this.source = null
      }
      this.connected = false
    },

    pushSnapshot(payload: TrafficMetricsSnapshot) {
      this.latest = payload
      this.series.push(payload)
      if (this.series.length > 120) {
        this.series.shift()
      }
    },

    async fetchSnapshot() {
      const response = await apiFetch('/dashboard/snapshot')
      this.latest = await response.json()
    },

    async fetchSeries() {
      const response = await apiFetch('/dashboard/series?size=120')
      this.series = await response.json()
    },

    async fetchLogs() {
      const response = await apiFetch('/monitor/audit/recent?size=40')
      this.logs = await response.json()
    },

    async fetchConfig() {
      const response = await apiFetch('/settings/runtime')
      this.config = await response.json()
    },

    async saveConfig(nextConfig: RuntimeConfig) {
      const response = await apiFetch('/settings/runtime', {
        method: 'PUT',
        body: JSON.stringify(nextConfig)
      })
      this.config = await response.json()
    },

    async fetchRoutes() {
      const response = await apiFetch('/settings/routes')
      this.routes = await response.json()
    },

    async saveRoute(route: RouteRule) {
      await apiFetch('/settings/routes', {
        method: 'POST',
        body: JSON.stringify(route)
      })
      await this.fetchRoutes()
    },

    async deleteRoute(id: string) {
      await apiFetch(`/settings/routes/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      await this.fetchRoutes()
    }
  }
})

