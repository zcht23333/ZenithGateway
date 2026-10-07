import {withRouteVersion} from './route-client.mjs'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import { runLoad } from './load.mjs'
import { redisCommand } from './redis.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const jar = resolve(process.env.BENCH_JAR || join(root, 'backend/target/zg-1.0.0.jar'))
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
function setting(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid ' + name)
  return value
}
const durationSeconds = setting('BENCH_DURATION_SECONDS', 30, 1, 600)
const warmupSeconds = setting('BENCH_WARMUP_SECONDS', 15, 1, 120)
const arrivalRate = setting('BENCH_ARRIVAL_RATE', 0, 0, 100000)
const repetitions = setting('BENCH_REPETITIONS', 3, 1, 10)
const connections = setting('BENCH_CONNECTIONS', arrivalRate ? 256 : 16, 1, 1000)
const redisPort = setting('BENCH_REDIS_PORT', 16379, 1, 65535)
const gatewayPort = setting('BENCH_GATEWAY_PORT', 18080, 1, 65535)
const redisDelayMs = setting('BENCH_REDIS_DELAY_MS', 50, 0, 2000)
const base = 'http://127.0.0.1:' + gatewayPort
const token = randomBytes(32).toString('hex')
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const outputDir = join(root, 'benchmarks/results', runId)
const scenarios = [
  { name: 'rate-limit-monitor', rateLimit: true, monitorEnabled: true, auditEnabled: false },
  { name: 'rate-limit-audit', rateLimit: true, monitorEnabled: true, auditEnabled: true },
  { name: 'forward-only', rateLimit: false, monitorEnabled: false, auditEnabled: false },
  { name: 'rate-limit', rateLimit: true, monitorEnabled: false, auditEnabled: false },
  { name: 'audit-delay', rateLimit: true, monitorEnabled: true, auditEnabled: true, auditDelayed: true },
  { name: 'redis-delay', rateLimit: true, monitorEnabled: true, auditEnabled: true, delayed: true },
  { name: 'audit-disconnect', rateLimit: true, monitorEnabled: true, auditEnabled: true, auditFault: true }
].filter(item => !process.env.BENCH_SCENARIOS || process.env.BENCH_SCENARIOS.split(',').includes(item.name))
if (!scenarios.length) throw new Error('No matching scenarios')
if (arrivalRate > 10000 && scenarios.some(scenario => scenario.rateLimit))
  throw new Error('BENCH_ARRIVAL_RATE exceeds the enabled limiter rate (10000 requests/s); reduce the offered load')
if (!existsSync(jar)) throw new Error('Build the backend JAR first: ' + jar)
await mkdir(outputDir, { recursive: true })

function assertNoRateLimiting(result, phase) {
  if (result.statuses['429']) throw new Error(phase + ': HTTP 429 invalidates this performance sample; reduce connections or arrival rate within the configured 10000 requests/s limit')
}
async function api(path, options = {}) {
  const response = await fetch(base + path, {
    ...options, signal: AbortSignal.timeout(10000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }
  })
  if (!response.ok) throw new Error(path + ': HTTP ' + response.status)
  return response.json()
}
async function waitReady(check, child) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Gateway exited; see scenario log')
    try { if (await check()) return } catch {}
    await delay(200)
  }
  throw new Error('Gateway readiness timed out; see scenario log')
}
async function metric(name) {
  const response = await fetch(base + '/actuator/metrics/' + name, {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(2000)
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error('Metric unavailable: ' + name)
  const data = await response.json()
  return data.measurements.reduce((sum, measurement) => sum + measurement.value, 0)
}
async function drain() {
  const deadline = Date.now() + 30000
  let status
  do {
    await delay(50)
    status = await api('/monitor/audit/status')
    if (!status.pending) return status
  } while (Date.now() < deadline)
  throw new Error('Audit did not drain: ' + JSON.stringify(status))
}
async function scripts() {
  const info = await redisCommand(redisPort, ['INFO', 'commandstats'])
  return Object.fromEntries(['eval', 'evalsha', 'lpush', 'ltrim'].map(command => {
    const match = info.match(new RegExp('cmdstat_' + command + ':calls=(\\d+)'))
    return [command, match ? Number(match[1]) : 0]
  }))
}
const sockets = new Set(), proxySockets = new Set()
let proxyDelay = 0, disconnected = false
function track(socket, proxy = false) {
  sockets.add(socket)
  if (proxy) proxySockets.add(socket)
  socket.on('close', () => { sockets.delete(socket); proxySockets.delete(socket) })
  socket.on('error', () => socket.destroy())
}
const proxy = net.createServer(client => {
  if (disconnected) { client.destroy(); return }
  const upstream = net.connect({ host: '127.0.0.1', port: redisPort })
  track(client, true); track(upstream, true)
  const pending = new Set()
  let pendingBytes = 0
  client.pipe(upstream)
  upstream.on('data', chunk => {
    if (!proxyDelay) { if (!client.write(chunk)) upstream.pause(); return }
    pendingBytes += chunk.length
    if (pendingBytes >= 1024 * 1024) upstream.pause()
    const timer = setTimeout(() => {
      pending.delete(timer); pendingBytes -= chunk.length
      if (client.destroyed) return
      if (!client.write(chunk)) upstream.pause()
      else if (pendingBytes < 1024 * 1024) upstream.resume()
    }, proxyDelay)
    pending.add(timer)
  })
  client.on('drain', () => { if (pendingBytes < 1024 * 1024) upstream.resume() })
  client.on('close', () => {
    for (const timer of pending) clearTimeout(timer)
    pending.clear(); upstream.destroy()
  })
  upstream.on('close', () => client.destroy())
})
const upstream = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end('{"ok":true}')
})
upstream.on('connection', socket => track(socket))
await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve) })
let gateway
const report = {
  runId, environment: { platform: os.platform(), release: os.release(), node: process.version,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryBytes: os.totalmem() },
  workload: { durationSeconds, warmupSeconds, connections, redisDelayMs, arrivalRate, repetitions,
    closedLoop: !arrivalRate, jvm: '-Xms256m -Xmx512m',
    note: 'Generator, upstream and gateway share one host. Redis retains only the newest 5000 events; full accounting uses acknowledgements.' },
  scenarios: []
}
async function stopGateway() {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) return
  const child = gateway, finished = once(child, 'exit')
  child.kill()
  const force = setTimeout(() => child.kill('SIGKILL'), 7000)
  try { await finished } finally { clearTimeout(force) }
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await stopGateway()
    for (const socket of sockets) socket.destroy()
    proxy.close(); upstream.close(); process.exit(130)
  })
}
async function measure(scenario, auditKey) {
  const before = await drain()
  const monitorBefore = (await api('/dashboard/snapshot')).completedTotal
  const scriptsBefore = await scripts()
  let sampling = true
  const samples = [], samplingErrors = []
  const sampler = (async () => {
    while (sampling) {
      try {
        const [cpu, heap, audit] = await Promise.all([
          metric('process.cpu.usage'), metric('jvm.memory.used?tag=area:heap'), api('/monitor/audit/status')])
        samples.push({ cpu, heapBytes: heap, audit })
        if (samples.length % 60 === 0) console.log('Progress ' + scenario.name + ': received=' +
          (audit.received - before.received) + ', pending=' + audit.pending + ', dropped=' +
          (audit.dropped - before.dropped) + ', uncertain=' + (audit.uncertain - before.uncertain))
      } catch (error) { samplingErrors.push(error.message) }
      await delay(1000)
    }
  })()
  const timers = []
  if (scenario.auditFault) {
    timers.push(setTimeout(() => {
      disconnected = true
      for (const socket of proxySockets) socket.destroy()
    }, durationSeconds * 200))
    timers.push(setTimeout(() => { disconnected = false }, durationSeconds * 600))
  }
  let result
  try { result = await runLoad({ url: base + '/bench/hello', durationSeconds, connections, arrivalRate }) }
  finally {
    for (const timer of timers) clearTimeout(timer)
    disconnected = false; sampling = false; await sampler
  }
  const after = await drain()
  const monitorAfter = (await api('/dashboard/snapshot')).completedTotal
  const scriptsAfter = await scripts()
  const counterNames = ['received', 'persisted', 'dropped', 'uncertain', 'retries']
  const counters = Object.fromEntries(counterNames.map(key => [key, after[key] - before[key]]))
  const rows = scenario.auditEnabled ? await redisCommand(redisPort, ['LRANGE', auditKey, 0, -1]) : []
  const ids = rows.map(row => JSON.parse(row).eventId)
  const reconciliationGap = counters.received - counters.persisted - counters.dropped - counters.uncertain
  const monitorGap = scenario.monitorEnabled ? monitorAfter - monitorBefore - result.requests : null
  const auditGap = scenario.auditEnabled ? counters.received - result.requests : null
  return { ...result,
    cpuFractionAverage: samples.reduce((sum, item) => sum + (item.cpu || 0), 0) / Math.max(1, samples.length),
    heapBytesPeakSampled: Math.max(0, ...samples.map(item => item.heapBytes || 0)),
    pendingPeakSampled: Math.max(0, ...samples.map(item => item.audit.pending)),
    reservedBytesPeakSampled: Math.max(0, ...samples.map(item => item.audit.reservedBytes)),
    oldestAgeMsPeakSampled: Math.max(0, ...samples.map(item => item.audit.oldestAgeMs)),
    audit: counters, monitorCompleted: monitorAfter - monitorBefore, monitorGap, auditGap, reconciliationGap,
    retainedRows: rows.length, duplicateRetainedIds: ids.length - new Set(ids).size,
    redisCommands: Object.fromEntries(Object.keys(scriptsBefore).map(key => [key, scriptsAfter[key] - scriptsBefore[key]])),
    finalAudit: after, resourceSamples: samples.length, samplingErrors, samples
  }
}
try {
  await redisCommand(redisPort, ['PING'])
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    const order = repetition % 2 ? scenarios : [...scenarios].reverse()
    for (const scenario of order) {
      console.log('Starting ' + scenario.name + ' repetition ' + repetition)
      proxyDelay = scenario.delayed || scenario.auditDelayed ? redisDelayMs : 0
      disconnected = false
      const keySuffix = runId + ':' + scenario.name + ':' + repetition
      const auditKey = 'zg:benchmark:audit:' + keySuffix
      const runtimeKey = 'zg:benchmark:runtime:' + keySuffix
      if (await redisCommand(redisPort, ['EXISTS', runtimeKey])) throw new Error('Expected a fresh runtime configuration key')
      const log = createWriteStream(join(outputDir, scenario.name + '-' + repetition + '.log'))
      gateway = spawn(java, ['-Xms256m', '-Xmx512m', '-jar', jar,
        '--server.address=127.0.0.1', '--server.port=' + gatewayPort,
        '--spring.data.redis.host=127.0.0.1', '--spring.data.redis.password=', '--spring.data.redis.database=0',
        '--spring.data.redis.port=' + (scenario.delayed ? proxy.address().port : redisPort),
        '--zenith.audit.port=' + (scenario.delayed || scenario.auditDelayed || scenario.auditFault ? proxy.address().port : redisPort),
        '--zenith.rate-limit.enabled=' + scenario.rateLimit,
        '--zenith.rate-limit.replenish-rate=10000', '--zenith.rate-limit.burst-capacity=10000',
        '--zenith.monitor.enabled=' + scenario.monitorEnabled, '--zenith.audit.enabled=' + scenario.auditEnabled,
        '--zenith.audit.buffer-size=' + (scenario.auditFault ? 256 : 20000),
        '--zenith.audit.redis-key=' + auditKey, '--zenith.route.redis-key=zg:benchmark:routes:' + keySuffix,
        '--zenith.runtime.redis-key=' + runtimeKey
      ], { cwd: root, windowsHide: true, env: { ...process.env, ZENITH_ADMIN_TOKEN: token, SPRING_PROFILES_ACTIVE: 'benchmark' } })
      gateway.stdout.pipe(log); gateway.stderr.pipe(log, { end: false })
      let spawnError
      gateway.once('error', error => { spawnError = error })
      try {
        await waitReady(async () => {
          if (spawnError) throw spawnError
          const health = await api('/actuator/health'); await api('/settings/runtime')
          return health.status === 'UP'
        }, gateway)
        const coldStart = { runtimeKey, missingBeforeStart: true, confirmed: await api('/settings/runtime') }
        await api('/settings/routes', await withRouteVersion(()=>api('/settings/routes'),{ method: 'POST', body: JSON.stringify({
          id: 'benchmark', path: '/bench/**', uri: 'http://127.0.0.1:' + upstream.address().port,
          rewriteEnabled: false, circuitBreakerEnabled: false
        }) }))
        await waitReady(async () => (await api('/bench/hello')).ok === true, gateway)
        const warmup = await runLoad({ url: base + '/bench/hello', durationSeconds: warmupSeconds, connections, arrivalRate })
        await writeFile(join(outputDir, scenario.name + '-' + repetition + '-warmup.json'), JSON.stringify({coldStart,warmup}, null, 2) + '\n')
        assertNoRateLimiting(warmup, scenario.name + ' warmup')
        await drain()
        const result = await measure(scenario, auditKey)
        report.scenarios.push({ ...scenario, repetition, coldStart, warmup, ...result })
        await writeFile(join(outputDir, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
        assertNoRateLimiting(result, scenario.name + ' measurement')
        console.log(scenario.name + ': ' + result.requestsPerSecond.toFixed(1) + ' req/s, P95 ' +
          result.latencyMs.p95.toFixed(2) + ' ms, audit=' + JSON.stringify(result.audit) +
          ', monitorGap=' + result.monitorGap + ', reconciliationGap=' + result.reconciliationGap)
        if (result.reconciliationGap || result.monitorGap || result.auditGap || result.duplicateRetainedIds)
          throw new Error('Accounting assertion failed; inspect report')
      } finally { await stopGateway(); log.end() }
    }
  }
  console.log('Report: ' + join(outputDir, 'summary.json'))
} finally {
  await stopGateway()
  for (const socket of sockets) socket.destroy()
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))])
}
