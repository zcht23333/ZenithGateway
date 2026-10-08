// Read-only presentation of archived experiments. This never starts a gateway or sends traffic.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {gunzipSync} from 'node:zlib'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {verifyEvidence} from './showcase-evidence.mjs'

const root=fileURLToPath(new URL('..',import.meta.url))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
export const candidate={commit:'f1c6a19e88e16603d413c07a74b98bb965878482',jarSha256:'9fea9e372eed9af431e6e0cd2a682b5ad824024cc293d1a9c4fb81812e5d071f'}
const functional={commit:'c613940559c829e5aa466d04b9343c0241d5e3ae',jarSha256:'59205bff217fda345772357ddd151975c7d52ff23188f49a6a98c77822d66810',ciRun:37724149659}
const capacityJar='3f73c65c7c29933549878c570a6b5a8b7bd8bafad2e5333603eee1de089da838'

export async function readMember(manifestPath,name){
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'))
  const entry=manifest.files.find(f=>f.file===name)
  assert(entry,'Evidence member absent: '+name)
  assert(/^[A-Za-z0-9._/-]+$/.test(name)&&!name.startsWith('/')&&!name.split('/').some(x=>!x||x==='.'||x==='..'),'Invalid member path')
  const packed=await readFile(join(dirname(manifestPath),name))
  assert.equal(packed.length,entry.bytes,'Evidence size mismatch: '+name)
  assert.equal(sha(packed),entry.sha256,'Evidence hash mismatch: '+name)
  const raw=entry.format==='gzip'?gunzipSync(packed,{maxOutputLength:96*1024*1024}):packed
  if(entry.format==='gzip'){
    assert.equal(raw.length,entry.uncompressedBytes)
    assert.equal(sha(raw),entry.uncompressedSha256)
  }else assert.equal(entry.format,'json')
  return JSON.parse(raw)
}

export function capacitySummary(c){
  assert.equal(c.jarSha256,capacityJar,'Historical capacity cannot be attributed to a different JAR')
  const s=c.stages.find(x=>x.name===c.longValidated?.stage)
  assert(s&&s.kind==='soak'&&s.healthy===true&&s.seconds===3600,'Missing validated one-hour stage')
  assert.equal(c.longValidated.rate,1000)
  return {jarSha256:c.jarSha256,source:'docs/evidence/showcase-20261008/capacity-summary.json',
    rate:c.longValidated.rate,seconds:s.seconds,conditions:{gatewayLogicalCpus:c.config.cpuSets.gateway,gatewayMemory:c.config.gatewayMemoryLimit,heap:c.config.heap,directMemory:c.config.directMemoryLimit,routeCount:c.config.routeCount,redisPersistence:c.config.redisPersistence,resultHandoff:c.config.handoff,localPolicy:c.config.localFailurePolicy,redisPolicy:c.config.redisFailurePolicy},
    arrivals:s.arrivals,latency:s.latency,scheduledLatency:s.scheduledLatency,accounting:s.deltas,
    rss:s.memory,youngGcAfterHeapMiB:s.gc.afterMiB,resources:s.resources,
    memoryStabilityProven:c.memoryStabilityProven,earlier4000HourPassed:c.earlier4000HourPassed,
    candidateHourTested:false,capacityClaimTransferred:false}
}

export async function buildBriefing(){
  const historical=join(root,'docs/evidence/showcase-20261008/manifest.json')
  const release=join(root,'docs/evidence/showcase-candidate-20261008/manifest.json')
  const verified=[]
  for(const path of [historical,release])verified.push(await verifyEvidence(path))
  const file=name=>'ci-c4-release-extracted/'+name+'/report.json.gz'
  const operations=await readMember(release,file('config-operations'))
  const rollback=await readMember(release,file('config-rollback'))
  const policy=await readMember(release,file('limiter-policy'))
  for(const r of [operations,rollback,policy]){assert.equal(r.passed,true);assert.equal(r.jarSha256,functional.jarSha256)}
  const race=await readMember(historical,'counter-race.json')
  const capacity=capacitySummary(await readMember(historical,'capacity-summary.json'))
  const native=await readMember(historical,'native-comparison.json')
  assert.equal(native.jar.sha256,capacityJar)
  const duplicate=operations.evidence.concurrent,loss=operations.evidence.redisReplyLoss,conflict=rollback.evidence.conflict,business=rollback.evidence.business
  const config={source:'docs/evidence/showcase-candidate-20261008/'+file('config-operations'),rollbackSource:'docs/evidence/showcase-candidate-20261008/'+file('config-rollback'),
    duplicate:{operationId:duplicate.request.operationId,expectedVersion:duplicate.request.expectedVersion,responses:duplicate.responses.map(r=>({status:r.status,version:r.body.version,replayed:r.body.replayed}))},
    replyLoss:{operationId:loss.body.operationId,unconfirmed:loss.unconfirmed,query:loss.query,retry:loss.retry,laterVersion:loss.laterVersion},
    conflict:{expectedVersion:conflict.normal.expectedVersion,statuses:conflict.replies.map(r=>r.status)},
    restoredBehavior:{receipt:business.receipt,beforeHttp:business.beforeHttp,afterHttp:business.afterHttp,additionalConfigCommands:business.additionalConfigCommands,propagation:business.propagation}}
  const examples={}
  for(const label of ['A-default','B-strict']){
    const p=policy.evidence[label+'-lost-reply'].proof
    examples[label]={status:p.request.status,elapsedMs:p.request.elapsedMs,upstreamReceived:p.upstreamReceived,event:p.audit.rateLimitEvent,action:p.audit.rateLimitAction,execution:p.audit.rateLimitExecution,finalOutcome:p.audit.outcome,reason:p.audit.rateLimitReason}
  }
  const limiter={source:'docs/evidence/showcase-candidate-20261008/'+file('limiter-policy'),scope:'Replies lost after real Redis debit; each row is one archived request, not a capacity sample',examples,
    retired:Object.fromEntries(Object.entries(policy.evidence.accounting).map(([k,v])=>[k,{commands:v.diagnostics.commandsInFlight,peak:v.diagnostics.peakCommandsInFlight,queued:v.diagnostics.queued,retained:v.diagnostics.retainedTasks,permits:v.diagnostics.availableDecisionPermits,capacity:v.diagnostics.admissionCapacity}]))}
  return {mode:'archived-evidence-only',newRequestsSent:0,candidate,functionalEvidence:functional,
    verifiedFiles:verified.reduce((n,v)=>n+v.files,0),config,limiter,capacity,race,
    native:{source:'docs/evidence/showcase-20261008/native-comparison.json',jarSha256:native.jar.sha256,intervention:native.intervention.kind,deltaRssMiB:native.deltaRssMiB,otherAnonymousDeltaMiB:native.groups.otherAnonymous.deltaMiB,laterRssMiB:native.observedLaterRssMiB,hypothesisSupported:native.hypothesisSupported,naturalStabilityProven:native.naturalStabilityProven},
    limitations:['Offline archive reading, not live fault injection or a new benchmark.','C4 functional archive, accepted candidate and capacity JAR are separate identities.','No claim of long-term memory stability or a passing 4000 req/s hour.']}
}

export function printBriefing(b,section='all'){
  const lines=['ZenithGateway 面试证据速查','模式：只读历史归档；本次未发送代理请求、未连接 Redis。',
    '展示候选：'+b.candidate.commit+' / JAR '+b.candidate.jarSha256,
    '功能原始记录：'+b.functionalEvidence.commit+' / JAR '+b.functionalEvidence.jarSha256,
    '两份证据清单：'+b.verifiedFiles+' 个成员校验通过。']
  if(section==='all'||section==='config'){
    const d=b.config.duplicate,l=b.config.replyLoss,r=b.config.restoredBehavior
    lines.push('\n配置一致性与恢复','同一 operationId：'+d.operationId,'提交基于：'+d.expectedVersion)
    d.responses.forEach(r=>lines.push('响应 '+r.status+' / version='+r.version+' / replayed='+r.replayed))
    lines.push('不同操作竞争同一版本：HTTP '+b.config.conflict.statuses.join(' / '),
      '丢回复入口：HTTP '+l.unconfirmed.status+' / '+l.unconfirmed.body.outcome+'；按 ID 查询：'+l.query.status+' / '+l.query.receipt.after.version,
      '之后已提交：'+l.laterVersion+'；原样重试仍返回：'+l.retry.body.version+' / replayed='+l.retry.body.replayed,
      '恢复来源：'+r.receipt.source.version+'；恢复前：'+r.receipt.before.version+'；新版本：'+r.receipt.after.version,
      '恢复后的限流开关：'+r.receipt.after.rateLimitEnabled+'；另一实例实际 HTTP '+r.beforeHttp+' → '+r.afterHttp+'；额外运行配置查询 '+r.additionalConfigCommands,
      '详细原始字段：使用 --case config --json 查看；查询旧回执不会使当前版本回退。',
      '证据：'+b.config.source,'恢复与真实业务效果：'+b.config.rollbackSource)
  }
  if(section==='all'||section==='limiter'){
    lines.push('\n限流已扣费但回复丢失')
    for(const [name,p] of Object.entries(b.limiter.examples))lines.push(name+': HTTP '+p.status+' | '+p.event+' / '+p.action+' / '+p.execution+' | 上游接收 '+p.upstreamReceived+' | 最终 '+p.finalOutcome)
    lines.push('unknown 是扣费维度；保护性 503 不能证明 Redis 未扣费。','退出前业务资源：'+JSON.stringify(b.limiter.retired),'证据：'+b.limiter.source)
  }
  if(section==='all'||section==='capacity'){
    const c=b.capacity
    lines.push('\n历史容量与内存','容量 JAR：'+c.jarSha256,'1000 req/s × '+c.seconds+' s；4 个逻辑 CPU、1 GiB、小 HTTP 响应；32 路由，无 TLS，Redis 无持久化。',
      '实际 HTTP 200：'+c.arrivals.statuses['200']+'；计划到达缺口：'+c.arrivals.misses+'；P95/P99：'+c.latency.p95+'/'+c.latency.p99+' ms；最大：'+c.latency.max+' ms',
      'RSS：'+c.rss.firstMiB.toFixed(2)+' → '+c.rss.lastMiB.toFixed(2)+' MiB；末段斜率 '+c.rss.tailSlopeMiBPerMinute.toFixed(3)+' MiB/min',
      '年轻代 GC 后堆占用：'+c.youngGcAfterHeapMiB.first+' → '+c.youngGcAfterHeapMiB.last+' MiB',
      '受控命令计数：'+b.race.runs.map(r=>r.label+' 当前/峰值 '+r.observation.reportedInFlight+'/'+r.observation.reportedPeak).join('；'),
      '单独 trim 诊断 RSS 变化：'+b.native.deltaRssMiB.toFixed(2)+' MiB；不证明自然稳定。',
      '当前候选未追加一小时；长期内存稳定性仍未证明；4000 req/s 一小时未通过。','证据：'+c.source)
  }
  return lines.join('\n')+'\n'
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);let section='all',json=false
  if(args.length===1&&args[0]==='--help')console.log('node verification/interview-evidence.mjs [--case all|config|limiter|capacity] [--json]\nRead-only archived evidence. Does not start services or run load.')
  else {
    for(let i=0;i<args.length;i++)if(args[i]==='--case')section=args[++i];else if(args[i]==='--json')json=true;else throw Error('Unknown argument; use --help')
    assert(['all','config','limiter','capacity'].includes(section),'Invalid case; use --help')
    const b=await buildBriefing()
    console.log(json?JSON.stringify(section==='all'?b:{mode:b.mode,newRequestsSent:b.newRequestsSent,candidate:b.candidate,functionalEvidence:b.functionalEvidence,verifiedFiles:b.verifiedFiles,[section]:b[section],...(section==='capacity'?{race:b.race,native:b.native}:{}),limitations:b.limitations},null,2):printBriefing(b,section))
  }
}
