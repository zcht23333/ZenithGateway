import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {recordCapacityShutdown,shutdownBudgets} from './conservative-capacity-shutdown.mjs'

const normalState=()=>({Status:'exited',Running:false,Dead:false,Restarting:false,OOMKilled:false,ExitCode:0,Error:'',FinishedAt:'2026-10-07T00:00:00Z'})
async function run({wait='0',state=normalState(),waitError,inspectError,ackError,passed=true}={}){
 const report={passed,cleanup:{}},calls=[]
 const docker=async(args,options)=>{
  calls.push({args,options})
  if(args[0]==='wait'){if(waitError)throw new Error(waitError);return wait}
  assert.equal(args[0],'inspect');if(inspectError)throw new Error(inspectError);return JSON.stringify(state)
 }
 const result=await recordCapacityShutdown({label:'A',name:'owned-gateway'},{report,docker,requestShutdown:async()=>{if(ackError)throw new Error(ackError)}})
 return {result,report,calls}
}
test('acknowledged shutdown requires matching wait and inspected normal exit zero',async()=>{
 const {result,report,calls}=await run();assert.equal(result.graceful,true);assert.equal(report.passed,true);assert.equal(report.cleanup.AGraceful,true)
 assert.equal(report.cleanup.AShutdown.wait.exitCode,0);assert.deepEqual(report.cleanup.AShutdown.inspection.state,normalState())
 assert.equal(calls[0].options.timeout,shutdownBudgets.waitMs);assert.equal(calls[1].options.timeout,shutdownBudgets.inspectMs)
})
test('successful docker wait CLI with container exit 23 or 137 fails the entire experiment',async()=>{
 for(const code of [23,137]){const state=normalState();state.ExitCode=code;const {report,result}=await run({wait:String(code),state});assert.equal(report.passed,false);assert.equal(report.cleanup.AGraceful,false);assert.equal(result.wait.exitCode,code);assert.equal(result.inspection.state.ExitCode,code)}
})
test('OOM, daemon error, running, restarting and dead states are not graceful exit evidence',async()=>{
 for(const patch of [{OOMKilled:true},{Error:'runtime error'},{Running:true},{Restarting:true},{Dead:true},{Status:'created'},{FinishedAt:'0001-01-01T00:00:00Z'}]){
  const {result}=await run({state:{...normalState(),...patch}});assert.equal(result.graceful,false,JSON.stringify(patch))
 }
})
test('missing or malformed wait exit output never defaults to zero',async()=>{
 for(const wait of ['', '0\n23', 'unknown','-1','256','0.0']){const {result}=await run({wait});assert.equal(result.graceful,false);assert.equal(result.wait.exitCode,null)}
})
test('wait timeout retains subsequent inspect evidence but cannot claim normal completion',async()=>{
 const {result,report}=await run({waitError:'controlled timeout'});assert.equal(result.graceful,false);assert.equal(result.wait.error,'controlled timeout');assert.equal(result.inspection.state.ExitCode,0);assert.equal(report.passed,false)
})
test('inspect failure keeps wait result and fails instead of assuming normal container state',async()=>{
 const {result}=await run({inspectError:'container unavailable'});assert.equal(result.graceful,false);assert.equal(result.wait.exitCode,0);assert.equal(result.inspection.error,'container unavailable')
})
test('contradictory exit observations or missing inspect fields fail closed',async()=>{
 for(const state of [{...normalState(),ExitCode:23},{ExitCode:0},null]){const {result}=await run({state});assert.equal(result.graceful,false)}
})
test('management shutdown failure is preserved without an unbounded wait',async()=>{
 const {result,calls}=await run({ackError:'HTTP 401'});assert.equal(result.graceful,false);assert.equal(result.acknowledgementError,'HTTP 401');assert.deepEqual(calls.map(x=>x.args[0]),['inspect'])
})
test('normal cleanup cannot turn a previously failed experiment into a pass',async()=>{
 const {report}=await run({passed:false});assert.equal(report.cleanup.AGraceful,true);assert.equal(report.passed,false)
})
test('actual runner cleanup branch propagates failed exit, saves evidence and still collects logs',async()=>{
 const source=await readFile(new URL('./conservative-capacity.mjs',import.meta.url),'utf8')
 const begin=source.indexOf('for(const g of gateways){',source.lastIndexOf('finally{')),end=source.indexOf('if(redisPort)',begin)
 assert(begin>0&&end>begin)
 const fragment=source.slice(begin,end),AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
 const report={passed:true,cleanup:{}},processState={exitCode:0},events=[]
 await new AsyncFunction('api','docker','report','gateways','writeFile','join','out','process','recordCapacityShutdown','save',fragment)(
  async()=>({}),async args=>args[0]==='wait'?'23':args[0]==='inspect'?JSON.stringify({...normalState(),ExitCode:23}):'failure log',
  report,[{label:'A',name:'owned-gateway'}],async(path,data)=>events.push({path,data}),(a,b)=>a+'/'+b,'fixture',processState,recordCapacityShutdown,async()=>events.push({saved:true}))
 assert.equal(processState.exitCode,1);assert.equal(report.passed,false);assert.equal(report.cleanup.AGraceful,false)
 assert.equal(report.cleanup.AShutdown.wait.exitCode,23);assert(events.some(e=>e.saved));assert(events.some(e=>e.data==='failure log'))
})
