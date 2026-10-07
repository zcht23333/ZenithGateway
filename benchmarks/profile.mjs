import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const exec = promisify(execFile)
const root = resolve('.')
const output = resolve(process.env.PROFILE_OUTPUT || '.dev/third-round/profile')
const baseline = process.env.PROFILE_JFR_ONLY === 'true' && !process.env.PROFILE_BASELINE
 ? null : resolve(process.env.PROFILE_BASELINE || '.dev/third-round/baseline.jar')
const candidate = resolve(process.env.PROFILE_CANDIDATE || 'backend/target/zg-1.0.0.jar')
const config = 'benchmarks/profile.compose.yml'
const warmup = 45, duration = 60
const gc = process.env.PROFILE_GC || 'G1'
assert(['G1','Serial'].includes(gc), 'PROFILE_GC must be G1 or Serial')
await mkdir(output,{recursive:true})
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const report = { startedAt:new Date().toISOString(), baseline:baseline ? {path:baseline,sha256:await sha(baseline)} : null,
 candidate:{path:candidate,sha256:await sha(candidate)}, runs:[],
 workload:{warmupSeconds:warmup,measureSeconds:duration,connections:16,arrivalRate:0,
   gatewayCpuSet:'4-7',redisCpuSet:'0-1',upstreamCpuSet:'2-3',driverCpuSet:'8-11',
   heap:'-Xms256m -Xmx512m',activeProcessorCount:4,gc,
   note:'Docker Desktop Linux VM, disjoint logical CPU sets on one physical host; closed-loop capacity comparison. Not production sizing.'} }
async function docker(args, env={}) {
 const {stdout}=await exec('docker',args,{cwd:root,env:{...process.env,...env},windowsHide:true,
   timeout:240000,maxBuffer:16*1024*1024})
 return stdout.trim()
}
const compose=(args,env={})=>docker(['compose','-f',config,...args],env)
let interrupted=false
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{interrupted=true})
async function save(){await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2)+'\n')}
const order=process.env.PROFILE_JFR_ONLY === 'true' ? ['jfr-candidate']
 : process.env.PROFILE_COMPARISON_ONLY === 'true'
 ? ['baseline','candidate','candidate','baseline']
 : ['baseline','candidate','meters-disabled','meters-disabled','candidate','baseline','jfr-candidate']
try {
 report.docker=JSON.parse(await docker(['info','--format','{{json .}}']))
 report.docker={cpus:report.docker.NCPU,memoryBytes:report.docker.MemTotal,
   kernel:report.docker.KernelVersion,operatingSystem:report.docker.OperatingSystem}
 assert(report.docker.cpus>=12,'This fixed CPU layout needs at least twelve Docker CPUs')
 await compose(['up','-d','redis','upstream'])
 for(let index=0;index<order.length;index++){
   assert(!interrupted,'Profile interrupted')
   const mode=order[index], name=String(index+1).padStart(2,'0')+'-'+mode
   const env={PROFILE_JAR:mode==='baseline'?baseline:candidate,
     PROFILE_METRICS:mode==='meters-disabled'?'false':'true',PROFILE_GC:gc}
   console.log('Profiling '+name+': 45 s warmup, 60 s measurement')
   await compose(['up','-d','--force-recreate','gateway'],env)
   let container
   try {
     container=await compose(['ps','-q','gateway'],env)
     if(index===0)report.java=await docker(['exec',container,'java','--version'])
     const vmFlags=await docker(['exec',container,'jcmd','1','VM.flags'])
     assert(vmFlags.includes('-XX:+Use'+gc+'GC'),'Unexpected garbage collector')
     const warm=JSON.parse(await compose(['run','--rm','--no-deps','driver'],
       {...env,PROFILE_PHASE:'warmup',PROFILE_SECONDS:String(warmup)}))
     if(mode==='jfr-candidate')await docker(['exec',container,'jcmd','1','JFR.start','name=zenith','settings=profile','filename=/tmp/zenith.jfr','dumponexit=true'])
     const result=JSON.parse(await compose(['run','--rm','--no-deps','driver'],
       {...env,PROFILE_PHASE:'measure',PROFILE_SECONDS:String(duration)}))
     if(mode==='jfr-candidate'){
       await docker(['exec',container,'jcmd','1','JFR.stop','name=zenith','filename=/tmp/zenith.jfr'])
       await docker(['cp',container+':/tmp/zenith.jfr',join(output,'zenith.jfr')])
       report.jfr={file:'zenith.jfr',sha256:await sha(join(output,'zenith.jfr'))}
     }
     report.runs.push({name,mode,vmFlags,warmupRequests:warm.requests,...result})
     console.log(name+': '+result.requestsPerSecond.toFixed(1)+' req/s, P95 '+result.latencyMs.p95.toFixed(2)+' ms, confirmed='+result.audit.persisted)
     await save()
   } finally {
     if(container)await writeFile(join(output,name+'.log'),await docker(['logs',container]).catch(()=> 'Log unavailable'))
     await compose(['stop','gateway'],env)
   }
 }
 report.passed=true
} catch(error){report.error=error.message;process.exitCode=1;console.error('Profile failed: '+error.message)}
finally {
 await compose(['down','--remove-orphans']).catch(error=>{report.cleanupError=error.message;process.exitCode=1})
 report.finishedAt=new Date().toISOString()
 await save()
}
