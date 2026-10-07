import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {environment,until} from './rate-limit-harness.mjs'
const e=await environment({out:process.env.RATE_LIMIT_BASELINE_OUTPUT||'.dev/rate-limit-reliability/baseline-'+randomUUID().slice(0,8),jar:'.dev/rate-limit-reliability/before.jar',legacy:true});let failure
try{
 const A=await e.start('A'),B=await e.start('B')
 await e.check('Healthy legacy shared bucket is atomic at fixed configuration',async()=>{
  const start=await e.redis(['TIME']),rows=await Promise.all(Array.from({length:30},(_,i)=>e.hit(i%2?A:B))),end=await e.redis(['TIME'])
  const elapsed=(Number(end[0])-Number(start[0]))+(Number(end[1])-Number(start[1]))/1e6,allowed=rows.filter(r=>r.status===200).length
  assert.ok(allowed<=20+elapsed);e.report.evidence.shared={rows,elapsedSeconds:elapsed,allowed,bound:20+elapsed,state:await e.redis(['HGETALL','zg:rl:tb:192.0.2.1'])}
 })
 await e.check('Legacy time rollback script fixture demonstrates repeated refill',async()=>{
  const lua=await readFile('.dev/rate-limit-reliability/legacy-rate-limit.lua','utf8'),key=e.ns+':clock-fixture',rows=[]
  for(const time of [1000,2000,1000,2000])rows.push({time,allowed:await e.redis(['EVAL',lua,1,key,2,2,2,time,60]),state:await e.redis(['HGETALL',key])})
  assert.equal(rows.filter(x=>x.allowed===1).length*2,6);e.report.evidence.clock={layer:'Real Redis executes the unmodified legacy Lua with controlled time arguments; no host clock change',rows,spent:6,uniqueIntervalAllowance:4}
 })
 await e.check('Legacy Retry-After ignores actual deficit and impossible costs',async()=>{
  const c=await e.save(A,{burstCapacity:10,replenishRate:1,requestedTokens:10});await e.adopted(B,c.version)
  await e.hit(A,'192.0.2.2');const retry=await e.hit(B,'192.0.2.2');assert.equal(retry.headers['retry-after'],'1')
  await e.save(A,{burstCapacity:1,requestedTokens:2});const impossible=await e.hit(A,'192.0.2.3');assert.equal(impossible.headers['retry-after'],'1');e.report.evidence.retry={retry,impossible}
 })
 await e.check('Legacy timed-out decisions can remain on the wire and debit after fail-open',async()=>{
  await e.save(A,{burstCapacity:100,replenishRate:1,requestedTokens:1})
  e.proxyA.setMode('hold-request');const jobs=Array.from({length:12},()=>e.hit(A,'192.0.2.4'));await until('legacy commands captured',()=>e.proxyA.held.filter(x=>x.limiter).length===12)
  const rows=await Promise.all(jobs);assert.ok(rows.every(r=>r.status===200));const before=await e.redis(['EXISTS','zg:rl:tb:192.0.2.4']);e.proxyA.release()
  await until('late legacy debit',async()=>Number(await e.redis(['HGET','zg:rl:tb:192.0.2.4','tokens']))<=89)
  e.report.evidence.late={rows,before,after:await e.redis(['HGETALL','zg:rl:tb:192.0.2.4']),captured:12,peakPending:e.proxyA.peakPending}
 })
}catch(error){failure=error}finally{await e.finish(failure)}
