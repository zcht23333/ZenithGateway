import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {rssPlan} from './rss-observation.mjs'

// Serial, bounded, read-only diagnostics. The in-container timeout also bounds an
// exec whose Docker CLI is interrupted; no GC.run, histogram, heap dump or trim.
export async function collectRssCheckpoint({label,out,gateways,docker,baseline=false}) {
 const dir=join(out,'memory-'+label);await mkdir(dir)
 const item={label,startedAt:new Date().toISOString(),output:dir,commands:[],kind:'read-only'}
 const start=performance.now()
 try {
  for(const g of gateways){
   const commands=[
    ['VM-native_memory',['jcmd','1','VM.native_memory','summary','scale=KB']],
    ['GC-heap_info',['jcmd','1','GC.heap_info']],
    ['Compiler-codecache',['jcmd','1','Compiler.codecache']],
    ['smaps',['cat','/proc/1/smaps']],['smaps-rollup',['cat','/proc/1/smaps_rollup']],
    ['status',['cat','/proc/1/status']],['cgroup-memory',['cat','/sys/fs/cgroup/memory.stat']],
    ['cgroup-events',['cat','/sys/fs/cgroup/memory.events']],
    ['cgroup-current',['cat','/sys/fs/cgroup/memory.current']],
    [baseline?'native-baseline':'native-diff',['jcmd','1','VM.native_memory',baseline?'baseline':'summary.diff',...(baseline?[]:['scale=KB'])]]]
   for(const [name,args] of commands){
    if(performance.now()-start>=rssPlan.diagnosticCheckpointBudgetMs)throw Error('RSS checkpoint exceeded 20s budget')
    const entry={label:g.label,command:args,startedAt:new Date().toISOString(),file:g.label+'-'+name+'.txt'},t=performance.now();item.commands.push(entry)
    try{
     const value=await docker(['exec',g.name,'timeout','--kill-after=1s','5s',...args],{timeout:rssPlan.diagnosticCommandTimeoutMs})
     if(/Unknown diagnostic command|Native memory tracking is not enabled/.test(value))throw Error(value)
     await writeFile(join(dir,entry.file),value)
    }catch(e){entry.error=e.message;throw e}
    finally{entry.completedAt=new Date().toISOString();entry.elapsedMs=performance.now()-t}
   }
  }
  if(performance.now()-start>rssPlan.diagnosticCheckpointBudgetMs)throw Error('RSS checkpoint exceeded 20s budget')
 }catch(e){item.error=e.message}
 finally{item.completedAt=new Date().toISOString();item.elapsedMs=performance.now()-start;await writeFile(join(dir,'timing.json'),JSON.stringify(item,null,2)+'\n')}
 return item
}
