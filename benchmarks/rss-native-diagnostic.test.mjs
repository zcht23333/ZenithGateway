import {test} from 'node:test'
import assert from 'node:assert/strict'
import {controlledTrim,nativeDiagnosticPlan} from './rss-native-diagnostic.mjs'
import {rssPlan} from './rss-observation.mjs'
const drained=[{audit:{pending:0},limiter:{retainedTasks:0,commandsInFlight:0},proxy:{activeProxyRequests:0}}]
const args=()=>({gateway:{name:'own-gateway'},ownerId:'owner',drained,activeDriver:null,report:{},save:async()=>{}})
test('native diagnostic preserves resources/rate and explicitly avoids a one-hour claim',()=>{
 for(const [k,v] of Object.entries(rssPlan))if(!['longSeconds','idleSeconds','note'].includes(k))assert.deepEqual(nativeDiagnosticPlan[k],v,k)
 assert.equal(nativeDiagnosticPlan.longSeconds,600);assert.match(nativeDiagnosticPlan.note,/No forced GC, natural-stability or one-hour claim/)
})
test('active work, a driver or foreign ownership forbid trim before dispatch',async()=>{
 for(const patch of [{activeDriver:'running'},{drained:[{...drained[0],audit:{pending:1}}]},{ownerId:'foreign'}]){
  let trimCalls=0;await assert.rejects(()=>controlledTrim({...args(),...patch,docker:async a=>{if(a[0]==='exec')trimCalls++;return 'owner'}}));assert.equal(trimCalls,0)
 }
})
test('intervention records confirmation, timing and non-capacity scope',async()=>{
 const a=args(),calls=[];const record=await controlledTrim({...a,docker:async(v,o)=>{calls.push({v,o});return v[0]==='inspect'?'owner':'1:\nTrim native heap: RSS+Swap: 500M->450M (-50M)'}})
 assert.equal(record.status,'command-confirmed');assert.equal(record.capacityEvidence,false);assert(record.elapsedMs>=0);assert.equal(calls[1].o.timeout,8000)
 assert.deepEqual(calls[1].v.slice(2),['timeout','--kill-after=1s','5s','jcmd','1','System.trim_native_heap'])
})
test('lost confirmation is preserved and cannot be automatically retried',async()=>{
 const a=args();let trimCalls=0;const docker=async v=>{if(v[0]==='inspect')return 'owner';trimCalls++;throw Error('reply lost')}
 await assert.rejects(()=>controlledTrim({...a,docker}),/reply lost/);assert.equal(a.report.nativeTrim.status,'confirmation-failed')
 await assert.rejects(()=>controlledTrim({...a,docker}),/never retry/);assert.equal(trimCalls,1)
})
