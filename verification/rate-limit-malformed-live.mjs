import assert from 'node:assert/strict'
import {environment} from './rate-limit-harness.mjs'

// Real HTTP and Redis format regression. All mutations stay in the harness-owned namespace.
const e=await environment({out:process.env.RATE_LIMIT_OUTPUT});let failure
const rawValues=['false','null','true','0','"text"','[]','{}']
e.report.boundaryCases=[]
try {
 const A=await e.start('A'),policyKey=e.ns+':policy',bucket=ip=>e.ns+':bucket:'+ip
 const diag=()=>e.api(A,'/settings/rate-limit/diagnostics')
 let validFence,validBucket
 await e.check('Truly missing policy and bucket initialize and debit once',async()=>{
  const ip='192.0.2.10',key=bucket(ip)
  await e.redis(['DEL',policyKey]);assert.equal(await e.redis(['EXISTS',policyKey,key]),0)
  const response=await e.hit(A,ip),d=await diag()
  validFence=await e.redis(['GET',policyKey]);validBucket=await e.redis(['GET',key])
  assert.equal(response.status,200);assert.equal(d.lastDecision.outcome,'allowed');assert.equal(d.lastDecision.execution,'confirmed')
  assert.equal(JSON.parse(validBucket).tokensMilli,19000);assert.deepEqual(JSON.parse(validBucket).policy,JSON.parse(validFence))
  e.report.evidence.missingBoth={response,lastDecision:d.lastDecision,fence:validFence,bucket:validBucket}
 })
 await e.check('Truly missing bucket initializes under the existing policy',async()=>{
  const ip='192.0.2.11',key=bucket(ip);assert.equal(await e.redis(['EXISTS',key]),0)
  const response=await e.hit(A,ip),d=await diag(),after=await e.redis(['GET',key])
  assert.equal(response.status,200);assert.equal(d.lastDecision.outcome,'allowed');assert.equal(d.lastDecision.execution,'confirmed')
  assert.equal(JSON.parse(after).tokensMilli,19000);assert.equal(await e.redis(['GET',policyKey]),validFence)
  e.report.evidence.missingBucket={response,lastDecision:d.lastDecision,bucket:after}
 })
 const invalid=async(kind,raw,ip,existingBucket)=>{
  const key=bucket(ip),before=await diag(),response=await e.hit(A,ip),after=await diag()
  const fenceAfter=await e.redis(['GET',policyKey]),bucketAfter=await e.redis(['GET',key]),decision=after.lastDecision
  assert.equal(response.status,200,'Compatible fail-open still reaches the upstream')
  assert.equal(response.body,'upstream:'+response.path.slice('/probe'.length))
  assert.equal(decision.outcome,'redis_fail_open');assert.equal(decision.reason,kind+'_invalid');assert.equal(decision.execution,'not_written')
  assert.equal(after.outcomes.redis_fail_open,before.outcomes.redis_fail_open+1);assert.equal(after.outcomes.allowed,before.outcomes.allowed)
  assert.equal(fenceAfter,kind==='policy'?raw:validFence)
  assert.equal(bucketAfter,kind==='bucket'?raw:existingBucket)
  e.report.boundaryCases.push({kind,raw,existingBucket,response,lastDecision:decision,fenceAfter,bucketAfter,
   failOpenDelta:after.outcomes.redis_fail_open-before.outcomes.redis_fail_open,correct:true})
 }
 for(const [index,raw] of rawValues.entries()) {
  await e.check('Invalid bucket '+raw+' remains stored and degrades explicitly',async()=>{
   const ip='192.0.2.'+(30+index);await e.redis(['SET',policyKey,validFence]);await e.redis(['SET',bucket(ip),raw])
   await invalid('bucket',raw,ip,raw)
  })
 }
 for(const [index,raw] of rawValues.entries()) {
  await e.check('Invalid policy '+raw+' preserves absent and existing buckets',async()=>{
   const ip='192.0.2.'+(60+index);assert.equal(await e.redis(['EXISTS',bucket(ip)]),0)
   await e.redis(['SET',policyKey,raw]);await invalid('policy',raw,ip,null)
   await e.redis(['SET',bucket(ip),validBucket]);await invalid('policy',raw,ip,validBucket)
  })
 }
 await e.check('Restoring the valid test fence returns a fresh client to normal quota decisions',async()=>{
  await e.redis(['SET',policyKey,validFence]);const response=await e.hit(A,'192.0.2.90'),d=await diag()
  assert.equal(response.status,200);assert.equal(d.lastDecision.outcome,'allowed');assert.equal(d.lastDecision.execution,'confirmed')
  assert.equal(d.lastDecision.tokensMilli,19000);e.report.evidence.recovery={response,lastDecision:d.lastDecision}
 })
 e.report.executionCompleted=true
} catch(error) {failure=error}
finally {await e.finish(failure)}
