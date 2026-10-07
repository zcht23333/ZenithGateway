// Release checks are deliberately serial: their convergence deadlines assume no competing test JVMs.
export const images = {
 redis: 'redis:7.4.11-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
 prometheus: 'prom/prometheus:v3.13.3@sha256:6976aa8a60fec930796ce5772b8d12da7a318a5daa8d40d69c5c7819a05eeed7',
 node: 'node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6',
 jdk: 'mcr.microsoft.com/openjdk/jdk@sha256:69e7c7cc0b5365e40718d70759f77b7c4b16e86ddaacfdf499d1c4807ba592d5'
}
const check = (id, entry, output, cleanup, extra = {}) => ({id, entry, output, cleanup, timeoutMs: 300000, ...extra})
export const releaseChecks = [
 check('config-sync', 'config-sync-live.mjs', 'CONFIG_SYNC_OUTPUT', ['redisRemoved','proxyClosed','upstreamClosed']),
 check('config-operations', 'config-operations-live.mjs', 'CONFIG_OPERATIONS_OUTPUT', ['redisRemoved','proxyClosed'], {backendOnly:true}),
 check('config-rollback', 'config-rollback-live.mjs', 'CONFIG_ROLLBACK_OUTPUT', ['redisRemoved','proxyClosed','proxyBClosed','upstreamClosed'], {backendOnly:true}),
 check('route-publication', 'route-publication-live.mjs', 'ROUTE_PUBLICATION_OUTPUT', ['redisRemoved','AProxyClosed','BProxyClosed','upstreamsClosed']),
 check('proxy-resilience', 'proxy-resilience-live.mjs', 'PROXY_RESILIENCE_OUTPUT', ['redisRemoved','upstreamClosed','httpsUpstreamClosed','privateTlsKeyRemoved']),
 check('rate-limit', 'rate-limit-reliability-live.mjs', 'RATE_LIMIT_OUTPUT', ['redisRemoved','proxyAClosed','proxyBClosed','upstreamClosed']),
 check('rate-limit-malformed', 'rate-limit-malformed-live.mjs', 'RATE_LIMIT_OUTPUT', ['redisRemoved','proxyAClosed','proxyBClosed','upstreamClosed']),
 check('limiter-policy', 'limiter-failure-policy-live.mjs', 'RATE_LIMIT_POLICY_OUTPUT', ['redisRemoved','proxyAClosed','proxyBClosed','upstreamClosed'], {timeoutMs:420000}),
 ...['functional','signal'].map(mode => check('lifecycle-'+mode, 'traffic-lifecycle-live.mjs', null,
  ['namedGatewayClientsAbsent','ownedContainersAbsent','ownedVolumesAbsent','networkAbsent','credentialsRemoved'], {mode, timeoutMs:420000}))
]
export const toolTests = ['benchmarks/capacity-load.test.mjs','benchmarks/stability-load.test.mjs',
 'verification/traffic-lifecycle-gates.test.mjs','verification/acceptance.test.mjs']
export function requiredImages(tier) {
 if (!['commit','release'].includes(tier)) throw new Error('tier must be commit or release')
 return tier === 'release' ? Object.values(images) : [images.redis, images.prometheus]
}
export function validateLiveReport(report, check, jarSha256) {
 if (report.passed !== true) throw new Error('Live check did not pass: '+check.id)
 if (report.jarSha256 !== jarSha256) throw new Error('Live check used a different JAR: '+check.id)
 if (!Array.isArray(report.checks) || !report.checks.length) throw new Error('No executed checks: '+check.id)
 for (const key of check.cleanup) if (report.cleanup?.[key] !== true) throw new Error('Unconfirmed cleanup '+key+': '+check.id)
 for (const [key,value] of Object.entries(report.cleanup || {})) {
  if (/Error$/.test(key) && value) throw new Error('Cleanup error '+key+': '+value)
  if (/ExitCode$/.test(key) && value === null) throw new Error('Process not confirmed exited: '+key)
 }
 return {checks:report.checks.length, jarSha256:report.jarSha256, cleanup:report.cleanup,
  notExecuted:report.notExecuted || []}
}
