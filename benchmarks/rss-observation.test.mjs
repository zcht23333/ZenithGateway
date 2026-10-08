import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {rssPlan,parseNmt,parseMemoryStat,classifySmaps,parseGc,memoryTrend,rssSafetyIssues} from './rss-observation.mjs'
import {collectRssCheckpoint} from './rss-checkpoint.mjs'
import {capacityPlan} from './conservative-capacity-gates.mjs'

test('RSS mode keeps every existing capacity workload/resource/health parameter',()=>{
 for(const [key,value] of Object.entries(capacityPlan))if(key!=='note')assert.deepEqual(rssPlan[key],value,key)
 assert.equal(rssPlan.longSeconds,3600);assert.equal(rssPlan.idleSeconds,600)
})
test('NMT distinguishes reservation and commitment, missing data is not zero',()=>{
 const x=parseNmt('Total: reserved=800KB, committed=400KB\n- Java Heap (reserved=512KB, committed=256KB)\n- Object Monitors (reserved=12KB, committed=12KB)')
 assert.equal(x.committedBytes,409600);assert.equal(x.groups['Java Heap'].reservedBytes,524288);assert.equal(x.groups['Object Monitors'].committedBytes,12288)
 assert.throws(()=>parseNmt('unavailable'),/Missing/)
})
const heap='garbage-first heap total 4K [0x1000, 0x2000)'
const code='bounds [0x3000, 0x4000, 0x5000]\nbounds [0x6000, 0x7000, 0x8000]\nbounds [0x9000, 0xa000, 0xb000]'
const vma=(a,b,rss,path='')=>`${a}-${b} rw-p 00000000 00:00 0 ${path}\nRss: ${rss} kB\nAnonymous: ${rss} kB\n`
test('smaps partitions physical RSS and treats [heap] as native brk, not Java heap',()=>{
 const x=classifySmaps(vma('1000','2000',4)+vma('3000','5000',4)+vma('c000','d000',4,'[heap]')+vma('e000','f000',4,'/lib/libc.so'),heap,code)
 assert.equal(x.rssBytes,16384);assert.equal(x.groups.javaHeap.rssBytes,4096);assert.equal(x.groups.codeHeap.rssBytes,4096);assert.equal(x.groups.nativeBrk.rssBytes,4096)
 assert.equal(Object.values(x.groups).reduce((n,x)=>n+x.rssBytes,0),x.rssBytes)
})
test('partial mapping overlap is explicit, never silently interpolated',()=>{
 const x=classifySmaps(vma('1800','2800',4),heap,code);assert.equal(x.groups.ambiguous.rssBytes,4096);assert.equal(x.groups.javaHeap,undefined)
 assert.throws(()=>classifySmaps('',heap,code),/Incomplete/);assert.throws(()=>classifySmaps(vma('1000','2000',4),'missing',code),/Missing/)
})
test('GC parser keeps young, mixed and full collections distinct and preserves natural post-GC occupancy',()=>{
 const text=['Pause Young (Normal) (G1 Evacuation Pause)','Pause Young (Mixed) (G1 Evacuation Pause)','Pause Full (G1 Compaction Pause)'].map((kind,i)=>`[2026-10-07T09:38:46.885+0000][${i+1}.632s][info][gc] GC(${i}) ${kind} 192M->40M(256M) 1.850ms`).join('\n')
 const rows=parseGc(text);assert.equal(rows.length,3);assert.equal(rows[0].afterBytes,40*1048576);assert.equal(rows[2].kind,'Pause Full (G1 Compaction Pause)');assert.equal(rows[0].at,'2026-10-07T09:38:46.885Z')
 assert.deepEqual(parseGc('[info] Safepoint'),[])
})
const series=(minutes,slope)=>Array.from({length:minutes*6+1},(_,n)=>({at:new Date(1800000000000+n*10000).toISOString(),processMemory:{rssBytes:(550+slope*n/6)*1048576}}))
test('short/empty/absent RSS cannot pass plateau screen',()=>{
 assert.equal(memoryTrend([]).plateauScreenPassed,false);assert.equal(memoryTrend(series(10,0)).plateauScreenPassed,false)
 assert.equal(memoryTrend([{at:'2026-01-01',jvm:{heapBytes:1}}]).samples,0)
})
test('predeclared tail screen rejects ongoing rise but allows a flat/decreasing observed tail',()=>{
 const rising=memoryTrend(series(60,.4)),flat=memoryTrend(series(60,0)),falling=memoryTrend(series(60,-.4))
 assert.equal(rising.plateauScreenPassed,false);assert(Math.abs(rising.tailSlopeMiBPerMinute-.4)<1e-6)
 assert.equal(flat.plateauScreenPassed,true);assert.equal(falling.plateauScreenPassed,true)
})
test('memory.current fields remain bytes and safety check includes lifetime peak',()=>{
 assert.deepEqual(parseMemoryStat('anon 123\nfile 456\nkernel 789\ninvalid'),{anon:123,file:456,kernel:789})
 assert.equal(rssSafetyIssues({limiter:{peakCommandsInFlight:9,workers:8},processMemory:{cgroupBytes:950*1048576}}).length,2)
 assert.deepEqual(rssSafetyIssues({limiter:{peakCommandsInFlight:8,workers:8},processMemory:{cgroupBytes:600*1048576}}),[])
})
test('checkpoint records every read-only action time, limits exec lifespan and saves raw output',async()=>{
 const out=await mkdtemp(join(tmpdir(),'zg-rss-checkpoint-'));const calls=[]
 try{
  const result=await collectRssCheckpoint({label:'test',out,gateways:[{label:'A',name:'owned'}],docker:async(args,options)=>{calls.push({args,options});return 'raw evidence'}})
  assert.equal(result.error,undefined);assert.equal(result.commands.length,10)
  for(const c of result.commands){assert(Number.isFinite(c.elapsedMs));assert(c.startedAt&&c.completedAt);assert.equal(await readFile(join(out,'memory-test',c.file),'utf8'),'raw evidence')}
  for(const c of calls){assert.deepEqual(c.args.slice(2,5),['timeout','--kill-after=1s','5s']);assert.equal(c.options.timeout,8000);assert(!c.args.some(x=>/GC.run|heap_dump|class_histogram|trim/.test(x)))}
 }finally{await rm(out,{recursive:true,force:true})}
})
test('diagnostic failure is preserved and stops further diagnostics',async()=>{
 const out=await mkdtemp(join(tmpdir(),'zg-rss-checkpoint-'));let calls=0
 try{
  const result=await collectRssCheckpoint({label:'failed',out,gateways:[{label:'A',name:'owned'}],docker:async()=>{calls++;throw Error('controlled timeout')}})
  assert.equal(calls,1);assert.equal(result.error,'controlled timeout');assert.equal(JSON.parse(await readFile(join(out,'memory-failed/timing.json'))).commands[0].error,'controlled timeout')
 }finally{await rm(out,{recursive:true,force:true})}
})
