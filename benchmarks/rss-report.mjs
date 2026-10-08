// Read evidence without changing it. Output must be a new directory.
import assert from 'node:assert/strict'
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises'
import {resolve,join,relative} from 'node:path'
import {createHash} from 'node:crypto'
import {parseNmt,classifySmaps,parseMemoryStat,parseGc,memoryTrend,median,rssPlan} from './rss-observation.mjs'
import {assessCapacity} from './conservative-capacity-gates.mjs'
const [sourceArg,outArg]=process.argv.slice(2)
if(!sourceArg||!outArg)throw Error('Usage: node benchmarks/rss-report.mjs <experiment-directory> <NEW-analysis-directory>')
const source=resolve(sourceArg),out=resolve(outArg)
assert(out!==source&&!out.startsWith(source+'/')&&!out.startsWith(source+'\\'),'Analysis output must be outside raw experiment')
const report=JSON.parse(await readFile(join(source,'summary.json'),'utf8')),MiB=1048576
await mkdir(out,{recursive:false})
const files=(await readdir(source)).filter(f=>/^gc-A\.log(?:\.\d+)?$/.test(f)),rawGc=await Promise.all(files.map(f=>readFile(join(source,f),'utf8')))
const gc=rawGc.flatMap(parseGc).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at))
const safepoints=rawGc.flatMap(t=>t.split(/\r?\n/).flatMap(l=>{const m=l.match(/^\[([^\]]+)\].*Safepoint "([^"]+)".*Total: (\d+) ns/);return m?[{at:new Date(m[1]).toISOString(),reason:m[2],ms:Number(m[3])/1e6}]:[]}))
const gcStats=rows=>({events:rows.length,kinds:Object.fromEntries([...new Set(rows.map(x=>x.kind))].map(k=>[k,rows.filter(x=>x.kind===k).length])),
 afterMiB:stats(rows.filter(g=>/Pause Young|Pause Full/.test(g.kind)).map(g=>g.afterBytes/MiB)),pauseMs:stats(rows.map(g=>g.pauseMs))})
function stats(values){const v=values.filter(Number.isFinite);return v.length?{first:v[0],last:v.at(-1),min:Math.min(...v),max:Math.max(...v),median:median(v)}:null}
const series=report.stages.flatMap(s=>(s.samples||[]).map(x=>({stage:s.name,at:x.at,jvm:x.jvm,processMemory:x.processMemory,
 resources:{commands:x.limiter.commandsInFlight,commandPeak:x.limiter.peakCommandsInFlight,queued:x.limiter.queued,retained:x.limiter.retainedTasks,
  activeWorkers:x.limiter.activeWorkers,connections:x.proxy.pool['total.connections'],pendingConnections:x.proxy.pool['pending.connections'],auditPending:x.audit.pending}})))
const stages=report.stages.map(s=>{
 const start=Date.parse(s.driverStartedAt||s.startedAt),end=Date.parse(s.completedAt),rows=gc.filter(x=>Date.parse(x.at)>=start&&Date.parse(x.at)<=end)
 const result={name:s.name,kind:s.kind,from:new Date(start).toISOString(),to:Number.isFinite(end)?new Date(end).toISOString():null,seconds:s.durationSeconds,
  memory:memoryTrend(s.samples),gc:gcStats(rows),samplingErrors:s.samplingErrors,resources:{},jvm:{}}
 result.sampleGapMs=stats(s.samples.slice(1).map((x,i)=>Date.parse(x.at)-Date.parse(s.samples[i].at)))
 const rssRows=s.samples.filter(x=>x.processMemory);result.rssSampleGapMs=stats(rssRows.slice(1).map((x,i)=>Date.parse(x.at)-Date.parse(rssRows[i].at)))
 for(const key of Object.keys(series[0]?.resources||{}))result.resources[key]=stats(series.filter(x=>x.stage===s.name).map(x=>x.resources[key]))
 for(const key of ['heapBytes','heapCommitted','directBytes','nonHeapBytes','threads','openFiles'])result.jvm[key]=stats(s.samples.map(x=>x.jvm[key]))
 const poolRows=s.samples.flatMap(x=>x.jvm.memoryPools||[])
 result.memoryPools=Object.fromEntries([...new Set(poolRows.map(x=>x.name+x.tags))].map(key=>[key,stats(poolRows.filter(x=>x.name+x.tags===key).map(x=>x.value))]))
 if(s.result){const r=s.result;Object.assign(result,{assessment:assessCapacity(s),rssSafetyIssues:s.rssSafetyIssues||[],arrivals:{offered:r.offered,issued:r.issued,finished:r.finished,misses:r.schedulerMisses+r.capacityMisses,successfulRps:r.successfulRequestsPerSecond,statuses:r.statuses,transportErrors:r.transportErrors,peakInFlight:r.peakInFlight},latency:r.statusLatencyMs['200'],scheduledLatency:r.scheduledLatencyMs,versions:r.versions,accounting:s.accounting,upstreamReceived:s.upstreamReceived,firstFailures:r.firstFailures})}
 return result
})
const checkpoints=[]
for(const cp of report.memoryCheckpoints||[]){
 const dir=join(source,'memory-'+cp.label),read=n=>readFile(join(dir,'A-'+n+'.txt'),'utf8')
 const entry={label:cp.label,at:cp.startedAt,completedAt:cp.completedAt,elapsedMs:cp.elapsedMs??Date.parse(cp.completedAt)-Date.parse(cp.startedAt),commands:cp.commands}
 try{Object.assign(entry,{nmt:parseNmt(await read('VM-native_memory')),smaps:classifySmaps(await read('smaps'),await read('GC-heap_info'),await read('Compiler-codecache')),cgroup:parseMemoryStat(await read('cgroup-memory'))})}catch(e){entry.error=e.message}
 checkpoints.push(entry)
}
const soak=report.stages.find(s=>s.kind==='soak'),bins=[]
if(soak){const start=Date.parse(soak.driverStartedAt),end=start+soak.durationSeconds*1000;
 for(let at=start;at<end;at+=600000){const rows=gc.filter(x=>Date.parse(x.at)>=at&&Date.parse(x.at)<at+600000);bins.push({from:new Date(at).toISOString(),minute:(at-start)/60000,gc:gcStats(rows),memory:memoryTrend(soak.samples.filter(s=>Date.parse(s.at)>=at&&Date.parse(s.at)<at+600000))})}}
const diagnosticSafepoints=safepoints.filter(s=>/Heap|Code|Diagnostic|Print|VM_Operation/.test(s.reason))
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex')
const analysis={schemaVersion:1,generatedAt:new Date().toISOString(),source,sourceSummarySha256:await sha(join(source,'summary.json')),
 tools:await Promise.all(['rss-report.mjs','rss-observation.mjs','conservative-capacity-gates.mjs'].map(async name=>({name,sha256:await sha(new URL(name,import.meta.url))}))),
 jar:report.jar,mode:report.mode,config:report.config,completedProtocol:report.passed,longValidated:report.longValidated,diagnosticLoadValidated:report.diagnosticLoadValidated,
 nativeTrim:report.nativeTrim,nativeHeapInfo:report.nativeHeapInfo,error:report.error,soakSkipped:report.soakSkipped,
 memoryCriteria:rssPlan,stages,checkpoints,bins,
 diagnostics:{checkpoints:checkpoints.length,checkpointElapsedMs:stats(checkpoints.map(x=>x.elapsedMs)),totalCheckpointWallMs:checkpoints.reduce((n,x)=>n+x.elapsedMs,0),errors:checkpoints.filter(x=>x.error),
  commands:checkpoints.flatMap(x=>x.commands||[]).length,safepointsByReason:Object.fromEntries([...new Set(safepoints.map(x=>x.reason))].map(k=>[k,{count:safepoints.filter(x=>x.reason===k).length,ms:stats(safepoints.filter(x=>x.reason===k).map(x=>x.ms))}])),diagnosticSafepoints},
 finalSnapshots:report.finalSnapshots,finalControls:report.finalControls,cleanup:report.cleanup,
 caveats:['NMT committed, Java used, process RSS and cgroup memory overlap; they must not be added.','Young-GC after-use includes old-generation objects that may be dead but not collected.','smaps and jcmd observations are sequential, not atomic; VMA groups attribute locations, not object/allocator ownership.','Sampled peaks cannot exclude sub-sample peaks; lifetime counters are reported separately.','Descriptive plateau criteria cover only the observed tail, not future stability.']}
await writeFile(join(out,'analysis.json'),JSON.stringify(analysis,null,2)+'\n')
await writeFile(join(out,'series.json'),JSON.stringify(series)+'\n')
await writeFile(join(out,'gc.json'),JSON.stringify(gc)+'\n')
await writeFile(join(out,'safepoints.json'),JSON.stringify(safepoints)+'\n')
console.log(JSON.stringify({out:relative(process.cwd(),out),jar:analysis.jar.sha256,longValidated:analysis.longValidated,stages:stages.map(s=>({name:s.name,healthy:s.assessment?.healthy,memory:s.memory,gc:s.gc})),diagnostics:{...analysis.diagnostics,diagnosticSafepoints:undefined}},null,2))
