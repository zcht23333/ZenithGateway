import http from 'node:http'
import https from 'node:https'
import {createHistogram,performance,monitorEventLoopDelay} from 'node:perf_hooks'
import {setTimeout as delay} from 'node:timers/promises'

// A fixed-arrival driver with explicit missed slots. Error responses never count as useful throughput.
export async function capacityLoad({urls,durationSeconds,arrivalRate=0,connections=256,timeoutMs=8000,onStarted=()=>{}}){
 if(!Array.isArray(urls)||!urls.length||!Number.isFinite(durationSeconds)||durationSeconds<=0||
    !Number.isInteger(arrivalRate)||arrivalRate<0||!Number.isInteger(connections)||connections<1||
    !Number.isFinite(timeoutMs)||timeoutMs<=0)throw new Error('Invalid capacity load configuration')
 const targets=urls.map(value=>{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('Invalid load URL');return u})
 const agents=new Map(),hist=createHistogram(),scheduledHist=createHistogram(),classes=new Map()
 const statuses={},errors={},versions={},byTarget={},samples=[]
 let issued=0,finished=0,inFlight=0,peakInFlight=0,schedulerMisses=0,capacityMisses=0,bytes=0
 let previousFinished=0,previousCpu=process.cpuUsage(),previousAt=performance.now()
 const eventLoop=monitorEventLoopDelay({resolution:10});eventLoop.enable()
 const startedAt=new Date().toISOString(),start=performance.now(),deadline=start+durationSeconds*1000
 const latency=h=>({count:Number(h.count),p50:h.count?h.percentile(50)/1000:null,p95:h.count?h.percentile(95)/1000:null,p99:h.count?h.percentile(99)/1000:null,max:h.count?h.max/1000:null,mean:h.count?h.mean/1000:null})
 const sample=()=>{
  const now=performance.now(),cpu=process.cpuUsage(),seconds=(now-previousAt)/1000
  samples.push({seconds:(now-start)/1000,issued,finished,inFlight,requestsPerSecond:(finished-previousFinished)/seconds,
   cpuCores:(cpu.user+cpu.system-previousCpu.user-previousCpu.system)/(seconds*1e6),rss:process.memoryUsage().rss,
   schedulerMisses,capacityMisses,eventLoopP99Ms:eventLoop.percentile(99)/1e6})
  previousAt=now;previousCpu=cpu;previousFinished=finished;eventLoop.reset()
 }
 const ticker=setInterval(sample,1000)
 function request(plannedAt=performance.now()){
  const target=targets[issued%targets.length],key=target.origin
  const transport=target.protocol==='https:'?https:http
  if(!agents.has(key))agents.set(key,new transport.Agent({keepAlive:true,maxSockets:connections}))
  issued++;inFlight++;peakInFlight=Math.max(peakInFlight,inFlight)
  byTarget[key]??={issued:0,finished:0,statuses:{},transportErrors:0};byTarget[key].issued++
  const sent=performance.now()
  return new Promise(resolve=>{
   let done=false,timer
   const finish=(status,code)=>{
    if(done)return;done=true;clearTimeout(timer);inFlight--;finished++;byTarget[key].finished++
    const now=performance.now(),us=Math.max(1,Math.round((now-sent)*1000))
    hist.record(us);scheduledHist.record(Math.max(1,Math.round((now-plannedAt)*1000)))
    const category=status?String(status):'transport'
    if(!classes.has(category))classes.set(category,createHistogram());classes.get(category).record(us)
    if(status){statuses[status]=(statuses[status]||0)+1;byTarget[key].statuses[status]=(byTarget[key].statuses[status]||0)+1}
    else{errors[code||'unknown']=(errors[code||'unknown']||0)+1;byTarget[key].transportErrors++}
    resolve()
   }
   const req=transport.get(target,{agent:agents.get(key)},res=>{
    const version=res.headers['x-zenith-route-version']||'(absent)'
    versions[version]=(versions[version]||0)+1
    res.on('data',b=>bytes+=b.length);res.once('end',()=>finish(res.statusCode));res.once('aborted',()=>finish(0,'aborted'));res.once('error',e=>finish(0,e.code))
   })
   timer=setTimeout(()=>{const e=new Error('Load client absolute deadline');e.code='CLIENT_DEADLINE';req.destroy(e)},timeoutMs)
   req.once('error',e=>finish(0,e.code))
  })
 }
 let issuanceEndedAt
 try{
  onStarted({startedAt})
  if(arrivalRate){
   const offered=Math.floor(arrivalRate*durationSeconds),burstLimit=Math.max(1,Math.ceil(arrivalRate/100));let slot=0
   while(slot<offered){
    const due=Math.min(offered,Math.floor((performance.now()-start)*arrivalRate/1000))
    if(due-slot>burstLimit){schedulerMisses+=due-slot-burstLimit;slot=due-burstLimit}
    while(slot<due){const plannedAt=start+slot++*1000/arrivalRate;if(inFlight>=connections)capacityMisses++;else void request(plannedAt)}
    if(slot<offered)await delay(1)
   }
   issuanceEndedAt=performance.now()
   while(inFlight)await delay(2)
  }else{
   await Promise.all(Array.from({length:connections},async()=>{while(performance.now()<deadline)await request()}))
   issuanceEndedAt=deadline
  }
  sample()
  const elapsedSeconds=(performance.now()-start)/1000,transportErrors=Object.values(errors).reduce((a,b)=>a+b,0)
  return {startedAt,durationSeconds,elapsedSeconds,drainSeconds:Math.max(0,(performance.now()-issuanceEndedAt)/1000),
   urls,arrivalRate,connections,timeoutMs,offered:arrivalRate?Math.floor(arrivalRate*durationSeconds):issued,
   issued,finished,inFlight,peakInFlight,schedulerMisses,capacityMisses,statuses,transportErrors,errors,bytes,byTarget,versions,
   requestsPerSecond:finished/elapsedSeconds,successfulRequestsPerSecond:(statuses['200']||0)/elapsedSeconds,
   latencyMs:latency(hist),scheduledLatencyMs:latency(scheduledHist),statusLatencyMs:Object.fromEntries([...classes].map(([s,h])=>[s,latency(h)])),samples}
 }finally{clearInterval(ticker);eventLoop.disable();for(const a of agents.values())a.destroy()}
}
