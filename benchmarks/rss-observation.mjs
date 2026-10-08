import {capacityPlan} from './conservative-capacity-gates.mjs'

// Opt-in diagnostics only: the accepted capacity workload and default runner are unchanged.
export const rssPlan = Object.freeze({...capacityPlan,
 memoryCheckpointMs:300000, diagnosticCommandTimeoutMs:8000,
 diagnosticCheckpointBudgetMs:20000, maximumCheckpoints:24,
 riskCgroupBytes:900*1048576, plateauTailMinutes:20, plateauMinimumMinutes:19,
 plateauSlopeMiBPerMinute:0.1, plateauMedianGrowthMiB:2,
 note:'RSS investigation: same full capacity plan; read-only checkpoints every five minutes during the soak and idle. No forced GC, trim or restart.'})

export function parseNmt(text) {
 const total=text.match(/Total: reserved=(\d+)KB, committed=(\d+)KB/)
 if(!total)throw Error('Missing NMT total')
 const groups={}
 for(const m of text.matchAll(/^-\s+(.+?)\s+\(reserved=(\d+)KB, committed=(\d+)KB\)/gm))
  groups[m[1].trim()]={reservedBytes:Number(m[2])*1024,committedBytes:Number(m[3])*1024}
 return {reservedBytes:Number(total[1])*1024,committedBytes:Number(total[2])*1024,groups}
}

export function parseMemoryStat(text) {
 return Object.fromEntries(text.trim().split(/\r?\n/).map(l=>l.trim().split(/\s+/)).filter(a=>a.length===2&&/^\d+$/.test(a[1])).map(([k,v])=>[k,Number(v)]))
}

// Each VMA belongs to exactly one category; never proportionally assign a partly overlapping VMA.
export function classifySmaps(text,heapInfo,codecache) {
 const heap=heapInfo.match(/heap[^\n]*\[(0x[\da-f]+),\s*(0x[\da-f]+)\)/i)
 if(!heap)throw Error('Missing Java heap address range')
 const ranges=[{name:'javaHeap',start:BigInt(heap[1]),end:BigInt(heap[2])},
  ...[...codecache.matchAll(/bounds \[(0x[\da-f]+),\s*(0x[\da-f]+),\s*(0x[\da-f]+)\]/gi)]
   .map(m=>({name:'codeHeap',start:BigInt(m[1]),end:BigInt(m[3])}))]
 if(ranges.length!==4)throw Error('Expected three G1-era HotSpot code heap ranges')
 const entries=[];let current
 for(const line of text.split(/\r?\n/)) {
  const header=line.match(/^([\da-f]+)-([\da-f]+)\s+([-rwxps]+)\s+[\da-f]+\s+[\da-f]+:[\da-f]+\s+\d+\s*(.*)$/i)
  if(header){current={start:BigInt('0x'+header[1]),end:BigInt('0x'+header[2]),path:header[4].trim(),fields:{}};entries.push(current)}
  else {const m=line.match(/^(\w+):\s+(\d+) kB/);if(m&&current)current.fields[m[1]]=Number(m[2])*1024}
 }
 if(!entries.length||entries.some(x=>!Number.isFinite(x.fields.Rss)))throw Error('Incomplete smaps')
 const groups={};let rssBytes=0,anonymousBytes=0
 for(const e of entries){
  const contained=ranges.find(r=>e.start>=r.start&&e.end<=r.end)
  const overlap=ranges.some(r=>e.start<r.end&&e.end>r.start)
  const category=contained?.name||(overlap?'ambiguous':e.path==='[heap]'?'nativeBrk':e.path.startsWith('[stack')?'stack':e.path.startsWith('/')?'fileMapping':!e.path?'otherAnonymous':'otherNamed')
  const row=groups[category]??={rssBytes:0,anonymousBytes:0,sizeBytes:0,mappings:0}
  row.rssBytes+=e.fields.Rss;row.anonymousBytes+=e.fields.Anonymous||0;row.sizeBytes+=Number(e.end-e.start);row.mappings++
  rssBytes+=e.fields.Rss;anonymousBytes+=e.fields.Anonymous||0
 }
 return {rssBytes,anonymousBytes,groups,mappings:entries.length,
  note:'Ranges from GC.heap_info and Compiler.codecache; otherAnonymous includes native allocators, metadata and stacks. NMT committed is not RSS.'}
}

export function parseGc(text) {
 const scale={K:1024,M:1048576,G:1073741824}
 return text.split(/\r?\n/).flatMap(line=>{
  const m=line.match(/^\[([^\]]+)\]\[([\d.]+)s\].*GC\((\d+)\) (Pause .+?) (\d+)([KMG])->(\d+)([KMG])\((\d+)([KMG])\) ([\d.]+)ms/)
  return m?[{at:new Date(m[1]).toISOString(),uptimeSeconds:Number(m[2]),id:Number(m[3]),kind:m[4],beforeBytes:Number(m[5])*scale[m[6]],afterBytes:Number(m[7])*scale[m[8]],committedBytes:Number(m[9])*scale[m[10]],pauseMs:Number(m[11])}]:[]
 })
}

export const median=values=>{const v=values.filter(Number.isFinite).sort((a,b)=>a-b);return v.length?(v[Math.floor((v.length-1)/2)]+v[Math.ceil((v.length-1)/2)])/2:null}
export function memoryTrend(samples) {
 const rows=samples.filter(x=>Number.isFinite(x.processMemory?.rssBytes)).map(s=>({minute:Date.parse(s.at)/60000,rss:s.processMemory.rssBytes/1048576}))
 if(rows.length<2)return {samples:rows.length,plateauScreenPassed:false,reason:'Insufficient RSS samples'}
 const last=rows.at(-1).minute,tail=rows.filter(x=>x.minute>=last-rssPlan.plateauTailMinutes),meanX=tail.reduce((s,x)=>s+x.minute-tail[0].minute,0)/tail.length,meanY=tail.reduce((s,x)=>s+x.rss,0)/tail.length
 const denominator=tail.reduce((s,x)=>s+(x.minute-tail[0].minute-meanX)**2,0)
 const slope=denominator?tail.reduce((s,x)=>s+(x.minute-tail[0].minute-meanX)*(x.rss-meanY),0)/denominator:null
 const growth=median(tail.filter(x=>x.minute>=last-5).map(x=>x.rss))-median(tail.filter(x=>x.minute<tail[0].minute+5).map(x=>x.rss))
 const minutes=last-tail[0].minute
 return {samples:rows.length,firstMiB:rows[0].rss,lastMiB:rows.at(-1).rss,deltaMiB:rows.at(-1).rss-rows[0].rss,
  tailMinutes:minutes,tailSlopeMiBPerMinute:slope,tailMedianGrowthMiB:growth,
  plateauScreenPassed:minutes>=rssPlan.plateauMinimumMinutes&&slope!==null&&slope<=rssPlan.plateauSlopeMiBPerMinute&&growth<=rssPlan.plateauMedianGrowthMiB,
  note:'Predeclared descriptive screen, not a proof of leak absence or long-term stability. Negative slopes also pass.'}
}

export function rssSafetyIssues(sample) {
 const issues=[]
 if(!sample)return ['Missing resource sample']
 if(sample.processMemory?.cgroupBytes>=rssPlan.riskCgroupBytes)issues.push('cgroup memory reached 900 MiB safety threshold')
 if(sample.limiter.peakCommandsInFlight>sample.limiter.workers)issues.push('Lifetime command peak exceeds workers')
 return issues
}
