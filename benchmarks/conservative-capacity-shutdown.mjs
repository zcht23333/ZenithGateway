// The Docker CLI can succeed while the container it waited for exits unsuccessfully.
// Keep both observations, including failures, before the caller removes owned resources.
export const shutdownBudgets=Object.freeze({waitMs:45000,inspectMs:5000})

export async function recordCapacityShutdown(g,{requestShutdown,docker,report}){
 const evidence={container:g.name,startedAt:new Date().toISOString(),acknowledged:false,
  wait:{timeoutMs:shutdownBudgets.waitMs,exitCode:null},inspection:{timeoutMs:shutdownBudgets.inspectMs,state:null},graceful:false,issues:[]}
 try{await requestShutdown();evidence.acknowledged=true}
 catch(e){evidence.acknowledgementError=e.message;evidence.issues.push('shutdown_not_acknowledged')}
 if(evidence.acknowledged){
  try{
   const stdout=await docker(['wait',g.name],{timeout:shutdownBudgets.waitMs});evidence.wait.stdout=stdout
   // Exactly one container: empty/multiple/malformed exit values are not evidence of exit 0.
   const value=stdout.trim()
   if(!/^(0|[1-9]\d{0,2})$/.test(value)||Number(value)>255)evidence.issues.push('invalid_wait_exit_code')
   else{evidence.wait.exitCode=Number(value);if(evidence.wait.exitCode!==0)evidence.issues.push('nonzero_exit')}
  }catch(e){evidence.wait.error=e.message;evidence.issues.push('wait_failed_or_timed_out')}
 }
 try{
  const stdout=await docker(['inspect','--format','{{json .State}}',g.name],{timeout:shutdownBudgets.inspectMs});evidence.inspection.stdout=stdout
  const state=JSON.parse(stdout);evidence.inspection.state=state
  if(!state||state.Status!=='exited'||state.Running!==false||state.Dead!==false||state.Restarting!==false||state.OOMKilled!==false||state.Error!==''||!Number.isInteger(state.ExitCode)||state.ExitCode!==0||!Number.isFinite(Date.parse(state.FinishedAt))||Date.parse(state.FinishedAt)<=0)
   evidence.issues.push('container_exit_not_normal')
  if(state?.ExitCode!==evidence.wait.exitCode)evidence.issues.push('exit_observations_disagree')
 }catch(e){evidence.inspection.error=e.message;evidence.issues.push('inspect_failed')}
 evidence.completedAt=new Date().toISOString();evidence.graceful=evidence.issues.length===0
 report.cleanup??={};report.cleanup[g.label+'Shutdown']=evidence;report.cleanup[g.label+'Graceful']=evidence.graceful
 if(!evidence.graceful){report.cleanup[g.label+'ShutdownError']=evidence.issues.join(', ');report.passed=false}
 return evidence
}
