import http from 'node:http'
import https from 'node:https'
import { createHistogram, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

// arrivalRate=0 preserves the original closed-loop test. Fixed arrival never waits for capacity.
export async function runLoad({ url, durationSeconds, connections, arrivalRate = 0 }) {
  const target = new URL(url)
  const transport = target.protocol === 'https:' ? https : http
  const agent = new transport.Agent({ keepAlive: true, maxSockets: connections })
  const histogram = createHistogram()
  const scheduledHistogram = createHistogram()
  const statuses = {}
  let errors = 0, inFlight = 0, peakInFlight = 0, schedulerMisses = 0, capacityMisses = 0, issued = 0
  const start = performance.now()
  const deadline = start + durationSeconds * 1000
  function request(plannedAt = performance.now()) {
    issued++
    inFlight++
    peakInFlight = Math.max(peakInFlight, inFlight)
    const sent = performance.now()
    return new Promise(resolve => {
      let completed = false
      function finish(status) {
        if (completed) return
        completed = true
        inFlight--
        const now = performance.now()
        histogram.record(Math.max(1, Math.round((now - sent) * 1000)))
        scheduledHistogram.record(Math.max(1, Math.round((now - plannedAt) * 1000)))
        if (status) statuses[status] = (statuses[status] || 0) + 1
        else errors++
        resolve()
      }
      const req = transport.get(target, { agent }, response => {
        response.resume()
        response.once('end', () => finish(response.statusCode))
        response.once('error', () => finish(0))
        response.once('aborted', () => finish(0))
      })
      req.setTimeout(5000, () => req.destroy(new Error('request timeout')))
      req.once('error', () => finish(0))
    })
  }
  async function worker() {
    while (performance.now() < deadline) await request()
  }
  try {
    if (arrivalRate) {
      const offered = Math.floor(arrivalRate * durationSeconds)
      const burstLimit = Math.max(1, Math.ceil(arrivalRate / 100)) // Maximum 10 ms catch-up.
      let scheduled = 0
      while (scheduled < offered) {
        const now = performance.now()
        const due = Math.min(offered, Math.floor((now - start) * arrivalRate / 1000))
        if (due - scheduled > burstLimit) {
          schedulerMisses += due - scheduled - burstLimit
          scheduled = due - burstLimit
        }
        while (scheduled < due) {
          const plannedAt = start + scheduled++ * 1000 / arrivalRate
          if (inFlight >= connections) capacityMisses++
          else void request(plannedAt)
        }
        if (scheduled < offered) await delay(1)
      }
      while (inFlight) await delay(2)
    } else await Promise.all(Array.from({ length: connections }, worker))
    const elapsedSeconds = (performance.now() - start) / 1000
    const requests = Number(histogram.count)
    const latency = h => ({ average: h.mean / 1000, p50: h.percentile(50) / 1000,
      p95: h.percentile(95) / 1000, p99: h.percentile(99) / 1000, max: h.max / 1000 })
    return {
      elapsedSeconds, requests, issued, offered: arrivalRate ? Math.floor(arrivalRate * durationSeconds) : issued,
      requestsPerSecond: requests / elapsedSeconds, statuses, transportErrors: errors,
      arrivalRate, schedulerMisses, capacityMisses, peakInFlight,
      latencyMs: latency(histogram), scheduledLatencyMs: latency(scheduledHistogram)
    }
  } finally { agent.destroy() }
}
