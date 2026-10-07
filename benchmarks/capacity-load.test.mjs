import {test} from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {capacityLoad} from './capacity-load.mjs'
const server=async(handler,fn)=>{const s=http.createServer(handler);await new Promise(r=>s.listen(0,'127.0.0.1',r));try{await fn('http://127.0.0.1:'+s.address().port)}finally{s.closeAllConnections();await new Promise(r=>s.close(r))}}
test('separates successful requests, expected HTTP rejection and transport failures',async()=>{
 let n=0;await server((req,res)=>{n++;if(n%3===0){req.socket.destroy();return}res.writeHead(n%3===1?200:429,{'x-zenith-route-version':'test:1'});res.end('x')},async url=>{
  const r=await capacityLoad({urls:[url],durationSeconds:.5,arrivalRate:60,connections:8})
  assert.equal(r.offered,r.issued+r.schedulerMisses+r.capacityMisses);assert.equal(r.issued,r.finished)
  assert.ok(r.statuses['200']>0&&r.statuses['429']>0&&r.transportErrors>0)
  assert.equal(r.finished,Object.values(r.statuses).reduce((a,b)=>a+b,0)+r.transportErrors)
  assert.equal(r.statusLatencyMs['200'].count,r.statuses['200'])
  assert.ok(r.successfulRequestsPerSecond<r.requestsPerSecond)
 })
})
test('keeps fixed-arrival misses visible when outstanding requests reach their cap',async()=>{
 await server((_req,res)=>setTimeout(()=>res.end('slow'),60),async url=>{
  const r=await capacityLoad({urls:[url],durationSeconds:.4,arrivalRate:200,connections:2})
  assert.ok(r.capacityMisses>0);assert.ok(r.peakInFlight<=2)
  assert.equal(r.offered,r.issued+r.schedulerMisses+r.capacityMisses);assert.equal(r.finished,r.issued);assert.equal(r.inFlight,0)
 })
})
test('absolute client deadline finishes a connection that never responds',async()=>{
 await server(()=>{},async url=>{
  const r=await capacityLoad({urls:[url],durationSeconds:.2,arrivalRate:20,connections:3,timeoutMs:60})
  assert.equal(r.transportErrors,r.issued);assert.equal(r.errors.CLIENT_DEADLINE,r.issued);assert.equal(r.inFlight,0)
 })
})
test('round-robin target accounting reconciles without combining their versions',async()=>{
 await server((_q,s)=>{s.setHeader('x-zenith-route-version','a:1');s.end('a')},async a=>await server((_q,s)=>{s.setHeader('x-zenith-route-version','b:2');s.end('b')},async b=>{
  const r=await capacityLoad({urls:[a,b],durationSeconds:.3,arrivalRate:40,connections:8})
  assert.equal(Object.values(r.byTarget).reduce((n,x)=>n+x.finished,0),r.finished)
  assert.ok(r.versions['a:1']>0&&r.versions['b:2']>0)
 }))
})
