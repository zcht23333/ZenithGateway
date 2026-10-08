import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {buildBriefing,capacitySummary,readMember,printBriefing} from './interview-evidence.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const loadCapacity=async()=>JSON.parse(await readFile(join(root,'docs/evidence/showcase-20261008/capacity-summary.json'),'utf8'))

test('archived facts keep distinct package identities and unknown despite protective rejection',async()=>{
  const b=await buildBriefing()
  assert.equal(b.mode,'archived-evidence-only');assert.equal(b.newRequestsSent,0)
  assert.equal(b.verifiedFiles,407)
  assert.notEqual(b.candidate.jarSha256,b.functionalEvidence.jarSha256)
  assert.notEqual(b.candidate.jarSha256,b.capacity.jarSha256)
  assert.equal(new Set(b.config.duplicate.responses.map(r=>r.version)).size,1)
  assert.deepEqual(b.config.duplicate.responses.map(r=>r.replayed).sort(),[false,true])
  assert.deepEqual([...b.config.conflict.statuses].sort(),[200,409])
  assert.equal(b.config.replyLoss.unconfirmed.body.outcome,'unknown')
  assert.equal(b.config.replyLoss.query.status,'committed')
  assert.notEqual(b.config.replyLoss.query.receipt.after.version,b.config.replyLoss.laterVersion)
  assert.equal(b.config.restoredBehavior.receipt.after.rateLimitEnabled,false)
  const allow=b.limiter.examples['A-default'],reject=b.limiter.examples['B-strict']
  assert.equal(allow.execution,'unknown');assert.equal(reject.execution,'unknown')
  assert.equal(allow.upstreamReceived,1);assert.equal(reject.upstreamReceived,0)
  assert.equal(allow.status,200);assert.equal(reject.status,503)
  assert.equal(b.capacity.candidateHourTested,false);assert.equal(b.capacity.memoryStabilityProven,false)
  assert.equal(b.capacity.arrivals.misses,432)
  assert.equal(b.race.runs[0].observation.reportedPeak,2);assert.equal(b.race.runs[1].observation.reportedPeak,1)
  assert.equal(b.native.naturalStabilityProven,false)
  for(const section of ['all','config','limiter','capacity'])assert.match(printBriefing(b,section),/只读历史归档/)
})

test('another artifact cannot inherit the historical hour',async()=>{
  const c=await loadCapacity();c.jarSha256='9fea9e372eed9af431e6e0cd2a682b5ad824024cc293d1a9c4fb81812e5d071f'
  assert.throws(()=>capacitySummary(c),/cannot be attributed/)
})

test('failed, missing or short capacity observations cannot be displayed as a passing hour',async()=>{
  for(const mutation of [c=>{c.stages.find(s=>s.kind==='soak').healthy=false},c=>{c.longValidated=null},c=>{c.stages.find(s=>s.kind==='soak').seconds=60}]){
    const c=await loadCapacity();mutation(c);assert.throws(()=>capacitySummary(c),/Missing validated/)
  }
})

test('same-size evidence tampering fails before facts are presented',async t=>{
  const scratch=resolve(root,'.dev');await mkdir(scratch,{recursive:true})
  const temp=await mkdtemp(join(scratch,'interview-integrity-test-'))
  t.after(async()=>{assert.equal(dirname(resolve(temp)),scratch);await rm(temp,{recursive:true,force:true})})
  const original=Buffer.from('{"result":0}'),file=join(temp,'report.json'),manifest=join(temp,'manifest.json')
  await writeFile(file,original)
  await writeFile(manifest,JSON.stringify({files:[{file:'report.json',format:'json',bytes:original.length,sha256:createHash('sha256').update(original).digest('hex')}]}))
  assert.deepEqual(await readMember(manifest,'report.json'),{result:0})
  await writeFile(file,'{"result":1}')
  await assert.rejects(readMember(manifest,'report.json'),/hash mismatch/)
})
