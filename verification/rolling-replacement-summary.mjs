// A compact index of measured evidence. Raw per-request data remains in the artifact.
import {readFile,writeFile,appendFile} from 'node:fs/promises'
import {dirname,join} from 'node:path'
const read=async path=>{try{return JSON.parse(await readFile(path,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}}
const [buildPath,livePath]=process.argv.slice(2)
if(!buildPath||!livePath)throw new Error('Usage: rolling-replacement-summary.mjs <build-report.json> <live-report.json>')
const build=await read(buildPath),live=await read(livePath)
const summary={
 build:build?{passed:build.passed,source:{commit:build.source?.commit,dirty:build.source?.dirty,sha256:build.source?.sha256,files:build.source?.files?.length},
  steps:build.steps.map(s=>({name:s.name,passed:s.passed,result:s.result})),
  artifacts:build.artifacts,cleanupPassed:build.cleanup?.passed}:null,
 live:live?{passed:live.passed,error:live.error,startedAt:live.startedAt,completedAt:live.completedAt,jarSha256:live.jarSha256,entrySha256:live.entrySha256,
  host:live.host,plan:live.plan,images:live.images,containers:live.containers,cleanup:live.cleanup,
  checks:live.checks.map(c=>({name:c.name,drainMs:c.drain?.elapsedMs,
   cancellation:c.cancelObserved?{at:c.cancelObserved.at,drainElapsedMs:c.cancelObserved.life.drainElapsedMs,clientCancelled:c.cancelObserved.life.clientCancelled,deadlineTerminated:c.cancelObserved.life.deadlineTerminated,upstreamClosedAt:c.cancelObserved.upstream?.closedAt}:undefined})),
  processes:live.processes.map(i=>({label:i.label,instanceId:i.identity?.instanceId,stopElapsedMs:i.stopElapsedMs,exitCode:i.exit?.ExitCode,drainMs:i.drain?.elapsedMs})),
  windows:live.windows.map(w=>({name:w.name,fault:w.fault,rate:w.rate,seconds:w.seconds,weights:w.weights,healthy:w.assessment.healthy,reasons:w.assessment.reasons,
   issued:w.result.issued,finished:w.result.finished,offered:w.result.offered,schedulerMisses:w.result.schedulerMisses,capacityMisses:w.result.capacityMisses,
   statuses:w.result.statuses,latencyMs:w.result.latencyMs,assessment:w.assessment})),
  accounting:live.accounting?{normal:live.accounting.normal,allIngress:live.accounting.allIngress,allUpstream:live.accounting.allUpstream,allStoredAudits:live.accounting.allStoredAudits,haproxy:live.accounting.haproxy}:null,
  auditSettlement:live.auditSettlement,recording:live.recording}:null
}
const content=JSON.stringify(summary,null,2)+'\n'
console.log('ROLLING_SUMMARY_BEGIN\n'+content+'ROLLING_SUMMARY_END')
if(live)await writeFile(join(dirname(livePath),'summary.json'),content)
if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,'## Measured rolling-replacement evidence\n\n```json\n'+content+'```\n')
