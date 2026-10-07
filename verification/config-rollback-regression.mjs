// Serial isolated regressions: avoids CPU contention when measuring the 3-second sync target.
import {spawn} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {mkdir,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
const out=resolve('.dev/config-rollback/regression-'+randomUUID().slice(0,8));await mkdir(out,{recursive:true})
const report={startedAt:new Date().toISOString(),results:[],passed:false}
for(const [entry,environment] of [
 ['config-rollback-live.mjs',{CONFIG_ROLLBACK_OUTPUT:join(out,'rollback-live')}],
 ['config-sync-live.mjs',{CONFIG_SYNC_OUTPUT:join(out,'sync')}],
 ['config-operations-live.mjs',{CONFIG_OPERATIONS_OUTPUT:join(out,'operations')}],
 ['config-operations-regression.mjs',{}],
 ['config-operations-migration.mjs',{}],
 ['config-consistency-rollback.mjs',{}],
 ['config-operations-p2.mjs',{}]
]) {
 const log=createWriteStream(join(out,entry+'.log'))
 console.log('START '+entry)
 const child=spawn(process.execPath,['verification/'+entry],{windowsHide:true,env:{...process.env,...environment}})
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false})
 const exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)})
 await new Promise(r=>log.end(r))
 report.results.push({entry,exitCode,log:join(out,entry+'.log')});console.log('DONE '+entry+' '+exitCode)
 await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
 if(exitCode!==0){process.exitCode=1;break}
}
report.passed=report.results.length===7&&report.results.every(r=>r.exitCode===0);report.completedAt=new Date().toISOString()
await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n');console.log('Regression report: '+join(out,'report.json'))
