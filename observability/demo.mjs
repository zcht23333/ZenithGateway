import {withRouteVersion} from '../benchmarks/route-client.mjs'
import {runtimeRequest} from '../verification/runtime-config-client.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { runLoad } from '../benchmarks/load.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const gateway = 'http://127.0.0.1:18083'
const prometheus = 'http://127.0.0.1:19090'
const grafana = 'http://127.0.0.1:13000'
const secret = name => readFile(new URL('../.dev/observability/secrets/' + name, import.meta.url), 'utf8')
const [admin, metrics, password] = await Promise.all(['admin-token','metrics-token','grafana-password'].map(secret))
const id = 'observability-demo-' + Date.now()
const report = { startedAt: new Date().toISOString(), phases: [], alertTimeline: [], checks: {} }
const output = new URL('../.dev/third-round/observability-result.json', import.meta.url)
await mkdir(new URL('../.dev/third-round/', import.meta.url), { recursive: true })
let paused = false, original, routeCreated = false, watching = true, interrupted = false
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  interrupted = true
  if (paused) { compose('unpause','redis'); paused = false }
})
function compose(...args) {
  execFileSync('docker', ['compose','-f','observability/compose.yml',...args],
    { cwd: root, stdio: 'pipe', timeout: 30000, windowsHide: true })
}
async function request(base, path, token, options = {}) {
  return fetch(base + path, { ...options, signal: AbortSignal.timeout(10000),
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type':'application/json', ...options.headers } })
}
async function api(path, options) {
  const r = await request(gateway, path, admin, options)
  assert(r.ok, path + ': HTTP ' + r.status)
  return r.json()
}
async function query(expression) {
  const r = await fetch(prometheus + '/api/v1/query?query=' + encodeURIComponent(expression))
  const data = await r.json()
  assert.equal(data.status, 'success')
  return data.data.result
}
async function alerts() {
  const data = await (await fetch(prometheus + '/api/v1/alerts')).json()
  return data.data.alerts.filter(a => a.state === 'firing').map(a => a.labels.alertname).sort()
}
async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await delay(1000) }
  throw new Error('Timed out waiting for demo verification')
}
let watcher
try {
  await until(async () => (await request(gateway, '/actuator/health/readiness')).ok)
  assert.equal((await request(gateway, '/actuator/prometheus')).status, 401)
  assert.equal((await request(gateway, '/actuator/prometheus', metrics)).status, 200)
  assert.equal((await request(gateway, '/settings/runtime', metrics)).status, 401)
  const dashboardResponse = await request(grafana, '/api/dashboards/uid/zenith-operations', null,
    { headers: { Authorization:'Basic ' + Buffer.from('admin:' + password).toString('base64') } })
  assert(dashboardResponse.ok, 'Grafana provisioned dashboard unavailable')
  const dashboard = (await dashboardResponse.json()).dashboard
  report.checks.dashboardPanels = dashboard.panels.length
  report.checks.scopedAuthentication = true
  await until(async () => (await query('up{job="zenith-gateway"}')).some(v => v.value[1] === '1'))
  original = await api('/settings/runtime')
  await api('/settings/runtime', { method:'PUT', body:JSON.stringify({ ...runtimeRequest(original), rateLimitEnabled:true,
    replenishRate:10000, burstCapacity:10000, requestedTokens:1 }) })
  await api('/settings/routes', await withRouteVersion(() => api('/settings/routes'), { method:'POST', body:JSON.stringify({ id, path:'/' + id + '/**',
    uri:'http://upstream:8081', rewriteEnabled:false, circuitBreakerEnabled:false }) }))
  routeCreated = true
  const probeBaseline = (await api('/monitor/audit/status')).received
  let probeRequests = 0
  await until(async () => {
    const response = await request(gateway, '/' + id + '/hello')
    await response.arrayBuffer()
    if (response.status === 200) probeRequests++
    return response.status === 200
  })
  await until(async () => {
    const status = await api('/monitor/audit/status')
    if (status.received < probeBaseline + probeRequests || status.pending) return false
    report.before = status
    return true
  })
  watcher = (async () => {
    while (watching) {
      try { report.alertTimeline.push({ at:new Date().toISOString(), firing:await alerts() }) }
      catch { report.alertPollFailures = (report.alertPollFailures || 0) + 1 }
      await delay(2000)
    }
  })()
  const load = async (name, durationSeconds) => {
    console.log('Demo: ' + name)
    const result = await runLoad({ url:gateway + '/' + id + '/hello', durationSeconds, connections:128, arrivalRate:120 })
    report.phases.push({ name, ...result })
    console.log(name + ': completed=' + result.requests + ', errors=' + result.transportErrors)
    assert(!interrupted, 'Demo interrupted; Redis resumed and settings will be restored')
  }
  await load('healthy', 25)
  compose('pause', 'redis'); paused = true
  try { await load('redis-paused', 40) }
  finally { compose('unpause', 'redis'); paused = false }
  await load('recovered', 30)
  await until(async () => !(await api('/monitor/audit/status')).pending, 45000)
  const expectedAlerts = ['ZenithAuditUncertain','ZenithRateLimitFailOpen']
  for (const name of expectedAlerts)
    assert(report.alertTimeline.some(row => row.firing.includes(name)), 'Expected alert did not fire: ' + name)
  await until(async () => !(await alerts()).length, 120000)
  report.after = await api('/monitor/audit/status')
  report.auditDelta = Object.fromEntries(['received','persisted','dropped','uncertain'].map(k => [k,report.after[k]-report.before[k]]))
  const { received, persisted, dropped, uncertain } = report.auditDelta
  assert.equal(received, persisted + dropped + uncertain, 'Audit accounting mismatch')
  assert.equal(received, report.phases.reduce((sum, phase) => sum + phase.requests, 0), 'HTTP/audit count mismatch')
  for (const phase of report.phases) {
    assert.equal(phase.transportErrors, 0)
    assert.equal(phase.statuses['200'], phase.requests)
  }
  report.checks.alertsFired = [...new Set(report.alertTimeline.flatMap(row => row.firing))]
  report.checks.alertsCleared = true
  report.checks.reconciled = true
  report.checks.dashboardQueries = []
  for (const panel of dashboard.panels) for (const target of panel.targets || []) {
    const rows = await query(target.expr.replaceAll('$instance', '.*'))
    report.checks.dashboardQueries.push({ panel:panel.title, series:rows.length })
    // Ratios/latency can legitimately be empty after traffic stops; syntax is checked by the API.
  }
  report.passed = true
  console.log('Demo passed: scoped authentication, provisioned dashboard, alerts fired/recovered, audit reconciled.')
} catch (error) {
  report.error = error.message
  process.exitCode = 1
  console.error('Demo failed: ' + error.message)
} finally {
  if (paused) compose('unpause','redis')
  watching = false
  if (watcher) await watcher
  try {
    if (routeCreated) await api('/settings/routes/' + id, await withRouteVersion(() => api('/settings/routes'), { method:'DELETE' }))
    if (original) await api('/settings/runtime', { method:'PUT', body:JSON.stringify(runtimeRequest(original,(await api('/settings/runtime')).version)) })
    report.restored = true
  } catch (error) { report.restoreError = error.message; process.exitCode = 1 }
  report.finishedAt = new Date().toISOString()
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
}
