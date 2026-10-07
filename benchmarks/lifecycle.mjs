import {withRouteVersion} from './route-client.mjs'
// Functional shutdown probes; run separately from performance measurements.
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { redisCommand } from './redis.mjs'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
const redisPort = Number(process.env.BENCH_REDIS_PORT || 16379)
const port = Number(process.env.BENCH_GATEWAY_PORT || 18081)
const token = randomBytes(32).toString('hex')
const runId = 'lifecycle-' + new Date().toISOString().replace(/[:.]/g, '-')
const directory = join(root, 'benchmarks/results', runId)
await mkdir(directory, { recursive: true })
const sockets = new Set()
let replyDelay = 0, child
function track(socket) {
  sockets.add(socket)
  socket.on('error', () => socket.destroy())
  socket.on('close', () => sockets.delete(socket))
}
const upstream = http.createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"ok":true}')
})
upstream.on('connection', track)
const proxy = net.createServer(client => {
  const redis = net.connect({ host: '127.0.0.1', port: redisPort })
  track(client); track(redis); client.pipe(redis)
  const timers = new Set()
  redis.on('data', chunk => {
    const timer = setTimeout(() => { timers.delete(timer); if (!client.destroyed) client.write(chunk) }, replyDelay)
    timers.add(timer)
  })
  client.on('close', () => { for (const timer of timers) clearTimeout(timer); redis.destroy() })
  redis.on('close', () => client.destroy())
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
async function api(path, options = {}) {
  const response = await fetch('http://127.0.0.1:' + port + path, {
    ...options, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) throw new Error(path + ': ' + response.status)
  return response.json()
}
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { try { if (await check()) return } catch {} await delay(50) }
  throw new Error('Probe timed out')
}
async function kill() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit
}
const report = { runId, results: [] }
try {
  await redisCommand(redisPort, ['PING'])
  for (const mode of ['graceful', 'forced', 'lost-ack']) {
    replyDelay = 0
    const key = 'zg:probe:audit:' + runId + ':' + mode
    const log = createWriteStream(join(directory, mode + '.log'))
    child = spawn(java, ['-Xms128m', '-Xmx256m', '-jar', join(root, 'backend/target/zg-1.0.0.jar'),
      '--server.address=127.0.0.1', '--server.port=' + port, '--spring.data.redis.host=127.0.0.1',
      '--spring.data.redis.port=' + redisPort, '--spring.data.redis.password=', '--spring.data.redis.database=0',
      '--zenith.audit.port=' + proxy.address().port, '--zenith.audit.batch-size=10',
      '--zenith.audit.command-timeout-ms=' + (mode === 'lost-ack' ? 1000 : 5000), '--zenith.audit.redis-key=' + key,
      '--zenith.audit.redis-max-entries=10000', '--zenith.rate-limit.enabled=false',
      '--zenith.route.redis-key=zg:probe:routes:' + runId + ':' + mode,
      '--zenith.runtime.redis-key=zg:probe:runtime:' + runId + ':' + mode,
      '--management.endpoint.shutdown.access=unrestricted',
      '--management.endpoints.web.exposure.include=health,shutdown'
    ], { cwd: root, windowsHide: true, env: { ...process.env, ZENITH_ADMIN_TOKEN: token } })
    child.stdout.pipe(log); child.stderr.pipe(log, { end: false })
    await until(async () => (await api('/actuator/health')).status === 'UP', 60000)
    await api('/settings/routes', await withRouteVersion(()=>api('/settings/routes'),{ method: 'POST', body: JSON.stringify({
      id: 'probe', path: '/probe/**', uri: 'http://127.0.0.1:' + upstream.address().port,
      rewriteEnabled: false, circuitBreakerEnabled: false
    }) }))
    await until(async () => (await api('/probe/ready')).ok)
    await until(async () => !(await api('/monitor/audit/status')).pending)

    if (mode === 'lost-ack') {
      const before = await api('/monitor/audit/status')
      replyDelay = 1500
      await api('/probe/lost-ack')
      // Observe the actual Redis commit through a separate direct connection.
      await until(async () => {
        const row = await redisCommand(redisPort, ['LINDEX', key, 0])
        return row && JSON.parse(row).path === '/probe/lost-ack'
      })
      // The already buffered reply remains delayed; new connections can recover immediately.
      replyDelay = 0
      await until(async () => !(await api('/monitor/audit/status')).pending)
      const after = await api('/monitor/audit/status')
      const rows = await redisCommand(redisPort, ['LRANGE', key, 0, -1])
      assert.ok(after.retries > before.retries, 'The missing TCP reply must trigger a real client retry')
      assert.equal(after.received, before.received + 1)
      assert.equal(after.persisted, after.received)
      assert.equal(after.dropped + after.uncertain, 0)
      assert.equal(rows.length, after.received)
      assert.equal(new Set(rows.map(row => JSON.parse(row).eventId)).size, rows.length)
      report.results.push({ mode, before, after, retained: rows.length, duplicateIds: 0 })
      await kill()
      log.end()
      await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
      console.log(mode + ': real lost reply recovered without duplicate records')
      continue
    }
    const visibilityMs = []
    if (mode === 'graceful') {
      for (let i = 0; i < 30; i++) {
        const path = '/probe/latency/' + i
        await api(path)
        const start = performance.now()
        while (true) {
          const row = await redisCommand(redisPort, ['LINDEX', key, 0])
          if (row && JSON.parse(row).path === path) break
          if (performance.now() - start > 2000) throw new Error('Low-traffic visibility timeout')
          await delay(1)
        }
        visibilityMs.push(performance.now() - start)
      }
      visibilityMs.sort((a, b) => a - b)
      report.lowTrafficVisibilityFromResponseMs = {
        samples: visibilityMs.length, p50: visibilityMs[14], p95: visibilityMs[28], max: visibilityMs[29]
      }
    }
    // Establish the connection before delaying replies. The List retains the entire probe.
    replyDelay = mode === 'graceful' ? 200 : 2000
    await Promise.all(Array.from({ length: 200 }, () => api('/probe/request')))
    const before = await api('/monitor/audit/status')
    assert.ok(before.pending > 0, 'Probe must have queued records before shutdown')
    if (mode === 'graceful') {
      const exited = once(child, 'exit')
      const start = Date.now()
      await api('/actuator/shutdown', { method: 'POST' })
      const force = setTimeout(() => child.kill('SIGKILL'), 15000)
      try { await exited } finally { clearTimeout(force) }
      assert.equal(child.signalCode, null, 'Graceful shutdown must exit normally')
      const rows = await redisCommand(redisPort, ['LRANGE', key, 0, -1])
      assert.equal(rows.length, before.received)
      assert.equal(new Set(rows.map(row => JSON.parse(row).eventId)).size, rows.length)
      report.results.push({ mode, before, retained: rows.length, durationMs: Date.now() - start, exitCode: child.exitCode })
    } else {
      await kill()
      await delay(100)
      const rows = await redisCommand(redisPort, ['LRANGE', key, 0, -1])
      assert.ok(rows.length < before.received, 'Forced termination must expose the in-memory durability boundary')
      report.results.push({ mode, before, retained: rows.length, unwrittenAfterKill: before.received - rows.length })
    }
    log.end()
    await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(mode + ': ' + JSON.stringify(report.results.at(-1)))
  }
  console.log('Report: ' + join(directory, 'summary.json'))
} finally {
  await kill()
  for (const socket of sockets) socket.destroy()
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))])
}
