import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {stabilityLoad} from './stability-load.mjs'
const server=async(handler,fn)=>{const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await fn('http://127.0.0.1:'+s.address().port)}finally{s.closeAllConnections();await new Promise(r=>s.close(r))}}
test('separates successful requests, expected HTTP rejection and transport failures',async()=>{
 let n=0;await server((req,res)=>{n++;if(n%3===0){req.socket.destroy();return}res.writeHead(n%3===1?200:429,{'x-zenith-route-version':'test:1'});res.end('x')},async url=>{
  const r=await stabilityLoad({urls:[url],durationSeconds:.5,arrivalRate:60,connections:8})
  assert.equal(r.offered,r.issued+r.schedulerMisses+r.capacityMisses);assert.equal(r.issued,r.finished)
  assert.ok(r.statuses['200']>0&&r.statuses['429']>0&&r.transportErrors>0)
  assert.equal(r.finished,Object.values(r.statuses).reduce((a,b)=>a+b,0)+r.transportErrors)
  assert.equal(r.statusLatencyMs['200'].count,r.statuses['200'])
  assert.ok(r.successfulRequestsPerSecond<r.requestsPerSecond)
 })
})
test('keeps fixed-arrival misses visible when outstanding requests reach their cap',async()=>{
 await server((_req,res)=>setTimeout(()=>res.end('slow'),60),async url=>{
  const r=await stabilityLoad({urls:[url],durationSeconds:.4,arrivalRate:200,connections:2})
  assert.ok(r.capacityMisses>0);assert.ok(r.peakInFlight<=2)
  assert.equal(r.offered,r.issued+r.schedulerMisses+r.capacityMisses);assert.equal(r.finished,r.issued);assert.equal(r.inFlight,0)
 })
})
test('absolute client deadline finishes a connection that never responds',async()=>{
 await server(()=>{},async url=>{
  const r=await stabilityLoad({urls:[url],durationSeconds:.2,arrivalRate:20,connections:3,timeoutMs:60})
  assert.equal(r.transportErrors,r.issued);assert.equal(r.errors.CLIENT_DEADLINE,r.issued);assert.equal(r.inFlight,0)
 })
})
test('round-robin target accounting reconciles without combining their versions',async()=>{
 await server((_q,s)=>{s.setHeader('x-zenith-route-version','a:1');s.end('a')},async a=>await server((_q,s)=>{s.setHeader('x-zenith-route-version','b:2');s.end('b')},async b=>{
  const r=await stabilityLoad({urls:[a,b],durationSeconds:.3,arrivalRate:40,connections:8})
  assert.equal(Object.values(r.byTarget).reduce((n,x)=>n+x.finished,0),r.finished)
  assert.ok(r.versions['a:1']>0&&r.versions['b:2']>0)
 }))
})

test('arrival steps share a driver and reconcile each segment',async()=>{
 await server((_q,s)=>s.end('ok'),async url=>{
  const r=await stabilityLoad({urls:[url],durationSeconds:.5,connections:8,arrivalPlan:[{name:'ramp',seconds:.2,rate:20},{name:'target',seconds:.3,rate:40}]})
  assert.equal(r.offered,16)
  for(const segment of Object.values(r.segmentStats)){
   assert.equal(segment.offered,segment.issued+segment.schedulerMisses+segment.capacityMisses)
   assert.equal(segment.issued,segment.finished)
  }
  assert.ok(r.segmentStats.ramp.finished>0&&r.segmentStats.target.finished>0)
  assert.equal(r.statuses['200'],r.finished)
 })
})
test('cold failures retain bounded reason and instance evidence',async()=>{
 await server((_q,s)=>{s.writeHead(503,{'content-type':'application/json'});s.end(JSON.stringify({reason:'proxy_pool_full'}))},async url=>{
  const r=await stabilityLoad({urls:[url],durationSeconds:.2,arrivalRate:30})
  assert.ok(r.firstFailures.length>0)
  assert.equal(r.firstFailures[0].status,503);assert.equal(JSON.parse(r.firstFailures[0].body).reason,'proxy_pool_full')
  assert.equal(r.firstFailures[0].target,url)
  assert.equal(r.samples.at(-1).statuses['503'],r.finished)
 })
})


test('raw callback receives every final result once, beyond bounded first-failure samples',async()=>{
 let n=0;const rows=[]
 await server((_q,s)=>{s.writeHead(++n%2?200:503);s.end('{"reason":"controlled"}')},async url=>{
  const r=await stabilityLoad({urls:[url+'/probe'],durationSeconds:.3,arrivalRate:600,connections:64,onResult:x=>rows.push(x)})
  assert.equal(rows.length,r.finished);assert.equal(rows.filter(x=>x.status===503).length,r.statuses['503'])
  assert(rows.every(x=>x.path==='/probe'));assert(rows.filter(x=>x.status===503).every(x=>JSON.parse(x.body).reason==='controlled'))
 })
})
