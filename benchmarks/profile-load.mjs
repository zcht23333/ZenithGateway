import {withRouteVersion} from './route-client.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { runLoad } from './load.mjs'
const token = (await readFile('/run/secrets/admin-token','utf8')).trim()
async function api(path, options = {}) {
  const r = await fetch('http://gateway:8080' + path, { ...options, signal:AbortSignal.timeout(5000),
    headers:{ Authorization:'Bearer ' + token, 'Content-Type':'application/json' } })
  assert(r.ok, path + ' HTTP ' + r.status)
  return r.json()
}
async function drain() {
  for (let i=0;i<300;i++) { const s=await api('/monitor/audit/status'); if(!s.pending)return s; await delay(100) }
  throw new Error('Audit drain timed out')
}
if(process.env.PROFILE_PHASE === 'warmup') {
  let ready=false
  for(let i=0;i<120;i++){
    try { await api('/settings/runtime'); ready=true; break } catch { await delay(500) }
  }
  assert(ready, 'Gateway startup timed out')
  await api('/settings/routes',await withRouteVersion(()=>api('/settings/routes'),{method:'POST',body:JSON.stringify({id:'profile',path:'/profile/**',
    uri:'http://upstream:8081',rewriteEnabled:false,circuitBreakerEnabled:false})}))
  await delay(1000)
}
const before=await drain()
const monitorBefore=(await api('/dashboard/snapshot')).completedTotal
const start=Date.now()
const load=await runLoad({url:'http://gateway:8080/profile/hello',
  durationSeconds:Number(process.env.PROFILE_SECONDS || 60), connections:16})
const after=await drain()
const monitorAfter=(await api('/dashboard/snapshot')).completedTotal
const audit=Object.fromEntries(['received','persisted','dropped','uncertain'].map(k=>[k,after[k]-before[k]]))
assert.equal(load.statuses['429'] || 0,0,'HTTP 429 invalidates this profile sample; reduce offered load within the configured 10000 requests/s limit')
assert.equal(load.transportErrors,0)
assert.equal(load.statuses['200'],load.requests)
assert.equal(audit.received,load.requests)
assert.equal(monitorAfter-monitorBefore,load.requests)
assert.equal(audit.received,audit.persisted+audit.dropped+audit.uncertain)
assert.equal(audit.dropped+audit.uncertain,0)
console.log(JSON.stringify({startedAt:new Date(start).toISOString(),...load,audit,finalPending:after.pending}))
