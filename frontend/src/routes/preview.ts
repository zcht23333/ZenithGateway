import type { RouteRule, RuntimeConfig, TrafficMetricsSnapshot, AuditStatus } from '../stores/traffic'

export type PreviewScenario = 'normal' | 'exception' | 'dense'
export function previewScenario(value: unknown): PreviewScenario {
  return value === 'exception' || value === 'dense' ? value : 'normal'
}
function rule(id: string, prefix: string, host: string, rewrite = true, breaker = true): RouteRule {
  return { id, path: prefix + '/**', uri: 'http://' + host + ':8080',
    rewriteEnabled: rewrite, rewriteRegex: '^' + prefix + '/(?<segment>.*)$',
    rewriteReplacement: '/${segment}', circuitBreakerEnabled: breaker,
    circuitBreakerName: 'cb-' + id, fallbackPath: '/fallback/default' }
}
export function previewRoutes(scenario: PreviewScenario): RouteRule[] {
  const rows = [
    rule('account-service', '/api/accounts', 'account.internal'),
    rule('catalog-service', '/api/catalog', 'catalog.internal'),
    rule('inventory-service', '/api/inventory', 'inventory.internal'),
    rule('order-service', '/api/orders', 'order.internal'),
    rule('payment-service', '/api/payments', 'payment.internal', false, true),
    rule('public-assets', '/assets', 'static.internal', false, false),
  ]
  if (scenario === 'dense') {
    rows.unshift(rule('asia-pacific-enterprise-order-orchestration-and-settlement-service-v2',
      '/api/enterprise/asia-pacific/orders-and-settlements/v2',
      'enterprise-order-orchestration.ap-southeast.internal'))
    const names = ['analytics','billing','checkout','delivery','event','fulfillment','gateway',
      'identity','invoice','ledger','member','notification','partner','pricing','recommendation',
      'reporting','returns','search','shipment','subscription','support','tax','tracking','warehouse','workflow']
    rows.push(...names.map((name, index) => rule(name + '-service', '/api/' + name,
      name + '.internal', index % 3 !== 0, index % 4 !== 0)))
  }
  return rows.sort((a,b) => a.id.localeCompare(b.id))
}
export const previewConfig: RuntimeConfig = {
  rateLimitEnabled: true, replenishRate: 1200, burstCapacity: 2400, requestedTokens: 1,
  monitorWindowSeconds: 10, emitIntervalSeconds: 1
}
export const previewSnapshot: TrafficMetricsSnapshot = {
  timestamp: new Date('2026-09-24T14:32:20+08:00').getTime(), enabled: true,
  windowSeconds: 10, requestCount: 24862, qps: 2486.2, avgLatencyMs: 16,
  p95LatencyMs: 34, status2xx: 24862, status3xx: 0, status4xx: 0, status5xx: 0,
  completedTotal: 1940281, cancelled: 0, errors: 0, unknownStatus: 0
}
export const previewAudit: AuditStatus = {
  enabled: true, accepting: true, received: 1940281, persisted: 1940281, dropped: 0,
  droppedByReason: {}, uncertain: 0, queueDepth: 0, inFlight: 0, pending: 0,
  reservedBytes: 0, oldestAgeMs: 0, retries: 0, lastBatchSize: 64, lastBatchDurationMs: 2,
  lastSuccessAgeMs: 240, capacity: 20000, maxReservedBytes: 16777216
}
