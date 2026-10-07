import { after, afterEach, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

let server, api, useTrafficStore, createPinia, store
const originalFetch = globalThis.fetch
const originalEventSource = globalThis.EventSource
const snapshot = { timestamp: 1000, qps: 1, p95LatencyMs: 2, avgLatencyMs: 1, requestCount: 1, windowSeconds: 10 }
const respond = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
})
let tickets = 0
let opened = []
class FakeEventSource {
  closed = false
  listeners = {}
  constructor(url) { this.url = url; opened.push(this) }
  close() { this.closed = true }
  addEventListener(type, callback) { this.listeners[type] = callback }
}
function defaultFetch(url) {
  if (url.includes('sse-token')) return Promise.resolve(respond({ token: 'ticket-' + ++tickets }))
  if (url.includes('snapshot')) return Promise.resolve(respond(snapshot))
  if (url.includes('runtime')) return Promise.resolve(respond({ rateLimitEnabled: true }))
  return Promise.resolve(respond([]))
}

before(async () => {
  server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true }, appType: 'custom' })
  api = await server.ssrLoadModule('/src/api.ts')
  ;({ useTrafficStore } = await server.ssrLoadModule('/src/stores/traffic.ts'))
  ;({ createPinia } = await server.ssrLoadModule('pinia'))
})
beforeEach(async () => {
  globalThis.fetch = defaultFetch
  globalThis.EventSource = FakeEventSource
  opened = []
  tickets = 0
  await api.authenticate('runtime-secret')
  store = useTrafficStore(createPinia())
})
afterEach(() => {
  store.disconnectSse()
  api.logout()
})
after(async () => {
  globalThis.fetch = originalFetch
  globalThis.EventSource = originalEventSource
  await server.close()
})
const settle = async () => {
  for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve))
}

test('runtime credential is a header and is cleared by logout', async () => {
  let headers
  globalThis.fetch = async (_url, options) => { headers = options.headers; return respond({}) }
  await api.apiRequest('/settings/runtime')
  assert.equal(headers.get('Authorization'), 'Bearer runtime-secret')
  api.logout()
  await api.apiRequest('/settings/runtime')
  assert.equal(headers.get('Authorization'), null)
})
test('HTTP error does not overwrite a valid route list', async () => {
  store.routes = [{ id: 'existing' }]
  globalThis.fetch = async () => respond({ message: 'Bad route' }, 500)
  await assert.rejects(store.fetchRoutes(), /Bad route/)
  assert.deepEqual(store.routes.map(route => route.id), ['existing'])
})
test('route validation failures stop the save flow and preserve error fields', async () => {
  globalThis.fetch = async () => respond({ message: 'Invalid destination', field: 'uri' }, 400)
  await assert.rejects(store.saveRoute({}), error => error.status === 400 && error.field === 'uri')
})
test('401 expires the authenticated state', async () => {
  globalThis.fetch = async () => respond({}, 401)
  await assert.rejects(store.fetchConfig(), error => error.status === 401)
  assert.equal(api.authState.authenticated, false)
})
test('a failed REST request does not stop SSE; reconnect obtains a fresh ticket', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = (url, options) => url.includes('/series')
    ? Promise.resolve(respond({ message: 'Series unavailable' }, 503)) : defaultFetch(url, options)
  await store.bootstrap()
  await settle()
  assert.equal(opened.length, 1)
  assert.ok(store.error.includes('Series unavailable'))
  opened[0].onopen()
  assert.equal(store.connected, true)
  opened[0].onerror()
  assert.equal(store.connected, false)
  assert.equal(opened[0].closed, true)
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(opened.length, 2)
  assert.ok(opened[1].url.endsWith('ticket-2'))
  assert.ok(!opened[1].url.includes('runtime-secret'))
  store.disconnectSse()
  t.mock.timers.tick(30_000)
  await settle()
  assert.equal(opened.length, 2)
})
test('unmount during token request does not create an orphan SSE connection', async () => {
  let resolveTicket
  globalThis.fetch = (url, options) => url.includes('sse-token')
    ? new Promise(resolve => { resolveTicket = resolve }) : defaultFetch(url, options)
  await store.bootstrap()
  store.disconnectSse()
  resolveTicket(respond({ token: 'late-ticket' }))
  await settle()
  assert.equal(opened.length, 0)
})
test('malformed live data is ignored and duplicate snapshots are not appended', async () => {
  await store.bootstrap()
  await settle()
  opened[0].listeners.traffic({ data: '{broken' })
  assert.ok(store.streamError)
  opened[0].listeners.traffic({ data: JSON.stringify(snapshot) })
  opened[0].listeners.traffic({ data: JSON.stringify(snapshot) })
  assert.equal(store.series.length, 1)
})

test('audit status failure preserves prior status and does not stop live metrics', async () => {
  store.auditStatus = { received: 12, persisted: 12 }
  globalThis.fetch = (url, options) => url.includes('/audit/status')
    ? Promise.resolve(respond({ message: 'Audit unavailable' }, 503)) : defaultFetch(url, options)
  await store.bootstrap()
  await settle()
  assert.equal(store.auditStatus.persisted, 12)
  assert.ok(store.auditError.includes('Audit unavailable'))
  assert.equal(opened.length, 1)
  opened[0].listeners.traffic({ data: JSON.stringify(snapshot) })
  assert.equal(store.latest.requestCount, 1)
})

test('late audit status cannot update an unmounted dashboard', async () => {
  let resolveStatus
  globalThis.fetch = (url, options) => url.includes('/audit/status')
    ? new Promise(resolve => { resolveStatus = resolve }) : defaultFetch(url, options)
  const pending = store.bootstrap()
  store.disconnectSse()
  resolveStatus(respond({ received: 99, persisted: 99 }))
  await pending
  assert.equal(store.auditStatus, null)
})

test('audit polling recovers separately after a status failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let unavailable = true
  globalThis.fetch = (url, options) => url.includes('/audit/status')
    ? Promise.resolve(unavailable ? respond({ message: 'Temporarily unavailable' }, 503)
      : respond({ received: 20, persisted: 20 })) : defaultFetch(url, options)
  await store.bootstrap()
  await settle()
  assert.ok(store.auditError)
  unavailable = false
  t.mock.timers.tick(5000)
  await settle()
  assert.equal(store.auditError, '')
  assert.equal(store.auditStatus.persisted, 20)
})
