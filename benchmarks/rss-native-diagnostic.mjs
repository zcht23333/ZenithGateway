import assert from 'node:assert/strict'
import {rssPlan} from './rss-observation.mjs'

// Compare the SAME idle process immediately before/after one native trim.
// A shorter conditioning load is not a matched one-hour capacity comparison.
export const nativeDiagnosticPlan=Object.freeze({...rssPlan,longSeconds:600,idleSeconds:120,postTrimIdleSeconds:60,
 note:'Separate allocator-retention diagnostic: one native trim after the 600s load, downshift and idle. No forced GC, natural-stability or one-hour claim.'})

export async function controlledTrim({gateway,ownerId,drained,activeDriver,docker,report,save}) {
 assert(!activeDriver,'Native trim is forbidden with a load driver active')
 assert.equal(drained.length,1,'Diagnostic requires a single instance')
 const s=drained[0]
 assert(s.audit.pending===0&&s.limiter.retainedTasks===0&&s.limiter.commandsInFlight===0&&s.proxy.activeProxyRequests===0,'Native trim requires drained work')
 assert(!report.nativeTrim,'One intervention only; never retry unknown execution')
 const owner=await docker(['inspect','--format','{{index .Config.Labels "zenith.capacity-baseline.owner"}}',gateway.name],{timeout:5000})
 assert.equal(owner,ownerId,'Only this experiment\'s gateway may receive native trim')
 const record={kind:'explicit-native-trim',capacityEvidence:false,startedAt:new Date().toISOString(),command:['jcmd','1','System.trim_native_heap'],status:'issued'}
 report.nativeTrim=record;await save();const start=performance.now()
 try {
  record.response=await docker(['exec',gateway.name,'timeout','--kill-after=1s','5s',...record.command],{timeout:8000})
  assert(!/Unknown diagnostic|not supported|failed|Exception/i.test(record.response)&&/Trim native heap/i.test(record.response),'Native trim completion was not confirmed')
  record.status='command-confirmed'
 }catch(e){record.status='confirmation-failed';record.error=e.message;throw e}
 finally{record.elapsedMs=performance.now()-start;record.completedAt=new Date().toISOString();await save()}
 return record
}
