import { defineStore } from 'pinia'

export interface TrafficMetricsSnapshot {
  timestamp: number
  windowSeconds: number
  requestCount: number
  qps: number
  avgLatencyMs: number
  p95LatencyMs: number
  status2xx: number
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
  requestsPerWindow: number
  rateLimitWindowSeconds: number
  monitorWindowSeconds: number
  emitIntervalSeconds: number
}

const API_BASE = 'http://localhost:8080'

export const useTrafficStore = defineStore('traffic', {
  state: () => ({
    latest: null as TrafficMetricsSnapshot | null,
    series: [] as TrafficMetricsSnapshot[],
    logs: [] as TrafficData[],
    config: null as RuntimeConfig | null,
    connected: false,
    source: null as EventSource | null
  }),
  actions: {
    async bootstrap() {
      await Promise.all([this.fetchSnapshot(), this.fetchSeries(), this.fetchLogs(), this.fetchConfig()])
      this.connectSse()
    },

    connectSse() {
      if (this.source) {
        this.source.close()
      }

      const source = new EventSource(`${API_BASE}/monitor/stream`)
      source.onopen = () => {
        this.connected = true
      }
      source.onerror = () => {
        this.connected = false
      }
      source.addEventListener('traffic', (event) => {
        const messageEvent = event as MessageEvent
        this.pushSnapshot(JSON.parse(messageEvent.data) as TrafficMetricsSnapshot)
      })

      source.onmessage = (event) => {
        this.pushSnapshot(JSON.parse(event.data) as TrafficMetricsSnapshot)
      }
      this.source = source
    },

    pushSnapshot(payload: TrafficMetricsSnapshot) {
      this.latest = payload
      this.series.push(payload)
      if (this.series.length > 120) {
        this.series.shift()
      }
    },

    async fetchSnapshot() {
      const response = await fetch(`${API_BASE}/dashboard/snapshot`)
      this.latest = await response.json()
    },

    async fetchSeries() {
      const response = await fetch(`${API_BASE}/dashboard/series?size=120`)
      this.series = await response.json()
    },

    async fetchLogs() {
      const response = await fetch(`${API_BASE}/monitor/audit/recent?size=40`)
      this.logs = await response.json()
    },

    async fetchConfig() {
      const response = await fetch(`${API_BASE}/settings/runtime`)
      this.config = await response.json()
    },

    async saveConfig(nextConfig: RuntimeConfig) {
      const response = await fetch(`${API_BASE}/settings/runtime`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(nextConfig)
      })
      this.config = await response.json()
    }
  }
})

