import {readFile,writeFile,readdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
if(!process.argv[2])throw new Error('Usage: node benchmarks/conservative-capacity-report.mjs <experiment-directory>')
const dir=resolve(process.argv[2]),report=JSON.parse(await readFile(join(dir,'summary.json'),'utf8'))
const {assessCapacity}=await import(pathToFileURL(join(dir,'tools/conservative-capacity-gates.mjs')))
const median=rows=>{const v=rows.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?v[Math.floor(v.length/2)]:null},MiB=1048576
function trend(samples){
 const rows=samples.filter(s=>Number.isFinite(s.processMemory?.rssBytes)).map(s=>({t:Date.parse(s.at)/60000,rssMiB:s.processMemory.rssBytes/MiB,cgroupMiB:s.processMemory.cgroupBytes/MiB,heapMiB:s.jvm.heapBytes/MiB,directMiB:s.jvm.directBytes/MiB,nonHeapMiB:s.jvm.nonHeapBytes/MiB,threads:s.jvm.threads}))
 if(!rows.length)return {samples:0}
 const from=rows[0].t,last=rows.at(-1).t,first5=rows.filter(s=>s.t<from+5),last5=rows.filter(s=>s.t>=last-5),last20=rows.filter(s=>s.t>=last-20),slope=values=>{
  const n=values.length,x=values.reduce((a,s)=>a+s.t-from,0)/n,y=values.reduce((a,s)=>a+s.rssMiB,0)/n
  const top=values.reduce((a,s)=>a+(s.t-from-x)*(s.rssMiB-y),0),bottom=values.reduce((a,s)=>a+(s.t-from-x)**2,0);return bottom?top/bottom:null
 }
 const stats={};for(const key of ['rssMiB','cgroupMiB','heapMiB','directMiB','nonHeapMiB','threads'])stats[key]={first:rows[0][key],last:rows.at(-1)[key],min:Math.min(...rows.map(r=>r[key])),max:Math.max(...rows.map(r=>r[key])),first5minMedian:median(first5.map(r=>r[key])),last5minMedian:median(last5.map(r=>r[key]))}
 return {samples:rows.length,observedMinutes:last-from,stats,rssSlopeMiBPerMinute:slope(rows),last20minRssSlopeMiBPerMinute:slope(last20),note:'Regression describes this observed window, not a leak diagnosis. Short windows have overlapping first/last five-minute samples.'}
}
const stages=[]
for(const s of report.stages){
 const row={name:s.name,kind:s.kind,startedAt:s.driverStartedAt||s.startedAt,completedAt:s.completedAt,seconds:s.durationSeconds,memory:trend(s.samples),samplingErrors:s.samplingErrors}
 if(s.result){const r=s.result;row.assessment=assessCapacity(s);row.arrivals={offered:r.offered,issued:r.issued,finished:r.finished,misses:r.schedulerMisses+r.capacityMisses,schedulerMisses:r.schedulerMisses,capacityMisses:r.capacityMisses,successfulRps:r.successfulRequestsPerSecond,peakInFlight:r.peakInFlight,statuses:r.statuses,transportErrors:r.transportErrors};row.latency={http200:r.statusLatencyMs['200'],scheduled:r.scheduledLatencyMs};row.audit=s.accounting;row.upstream=s.upstreamReceived;row.versions=r.versions;row.firstFailures=r.firstFailures;row.peaks={};
 for(const [name,get] of Object.entries({commands:x=>x.limiter.commandsInFlight,queued:x=>x.limiter.queued,retained:x=>x.limiter.retainedTasks,pendingAudit:x=>x.audit.pending,pendingProxy:x=>x.proxy.pool['pending.connections'],connections:x=>x.proxy.pool['total.connections'],threads:x=>x.jvm.threads}))row.peaks[name]=Math.max(...s.samples.map(get))
 row.countedPeaks={scope:'Since JVM start, not reset per stage',before:{queue:s.before[0].limiter.peakQueued,commands:s.before[0].limiter.peakCommandsInFlight},after:{queue:s.after[0].limiter.peakQueued,commands:s.after[0].limiter.peakCommandsInFlight}};
 }
 stages.push(row)
}
const checkpoints=[]
for(const item of report.memoryCheckpoints||[]){
 const folder=join(dir,'memory-'+item.label),text=await readFile(join(folder,'A-VM-native_memory.txt'),'utf8'),rss=await readFile(join(folder,'A-smaps-rollup.txt'),'utf8'),groups={}
 for(const m of text.matchAll(/^-\s+(.+?)\s+\(reserved=(\d+)KB, committed=(\d+)KB\)/gm))groups[m[1].trim()]={reservedMiB:Number(m[2])/1024,committedMiB:Number(m[3])/1024}
 const total=text.match(/Total: reserved=(\d+)KB, committed=(\d+)KB/)
 checkpoints.push({label:item.label,startedAt:item.startedAt,rssMiB:Number(rss.match(/^Rss:\s+(\d+)/m)?.[1])/1024,anonymousMiB:Number(rss.match(/^Anonymous:\s+(\d+)/m)?.[1])/1024,nativeTotal:total?{reservedMiB:Number(total[1])/1024,committedMiB:Number(total[2])/1024}:null,groups})
}
const result={completedExperiment:report.passed,longValidated:report.longValidated,soakSkipped:report.soakSkipped,error:report.error,jar:report.jar,config:report.config,environment:report.environment,stages,checkpoints,cleanup:report.cleanup}
await writeFile(join(dir,'analysis.json'),JSON.stringify(result,null,2)+'\n')
const samples=report.stages.flatMap(s=>(s.samples||[]).map(x=>({stage:s.name,at:x.at,jvm:x.jvm,rss:x.processMemory,limiter:{commands:x.limiter.commandsInFlight,queued:x.limiter.queued,retained:x.limiter.retainedTasks},auditPending:x.audit.pending})))
await writeFile(join(dir,'memory-series.json'),JSON.stringify(samples)+'\n');console.log(JSON.stringify({longValidated:result.longValidated,stages:stages.map(({name,assessment,arrivals,memory})=>({name,healthy:assessment?.healthy,issues:assessment?.issues,arrivals,memory}))},null,2))
